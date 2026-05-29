'use strict';

const { query } = require('../config/database');

const SNAPSHOT_INTERVAL_MINUTES = Number(process.env.MT5_EQUITY_SNAPSHOT_MINUTES || 30);

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function positiveMoney(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function ensureStartEquityColumn() {
  await query(`
    ALTER TABLE vps_system.bot_instances
    ADD COLUMN IF NOT EXISTS start_equity NUMERIC
  `).catch(() => {});
}

async function ensureStartEquity(instanceId, equity) {
  const iid = num(instanceId, 0);
  const eqVal = positiveMoney(equity);
  if (!iid || eqVal == null) return;
  await ensureStartEquityColumn();
  await query(
    `
    UPDATE vps_system.bot_instances
    SET start_equity = COALESCE(start_equity, $2::numeric),
        updated_at = NOW()
    WHERE id = $1
      AND start_equity IS NULL
    `,
    [iid, eqVal]
  ).catch(() => {});
}

/**
 * บันทึก Equity ทุก 30 นาที (จุดแรกบันทึกทันทีเมื่อเริ่มรัน)
 */
async function recordEquityLog(instanceId, equity) {
  const iid = num(instanceId, 0);
  const eqVal = positiveMoney(equity);
  if (!iid || eqVal == null) return false;

  await ensureStartEquity(iid, eqVal);

  const recent = await query(
    `
    SELECT COUNT(*)::int AS c
    FROM vps_system.mt5_equity_logs
    WHERE instance_id = $1
    `,
    [iid]
  ).catch(() => ({ rows: [{ c: 0 }] }));

  const hasAny = num(recent.rows?.[0]?.c, 0) > 0;
  if (hasAny) {
    const ins = await query(
      `
      INSERT INTO vps_system.mt5_equity_logs (instance_id, equity, created_at)
      SELECT $1, $2::numeric, NOW()
      WHERE NOT EXISTS (
        SELECT 1
        FROM vps_system.mt5_equity_logs
        WHERE instance_id = $1
          AND created_at > NOW() - ($3::text || ' minutes')::interval
      )
      RETURNING id
      `,
      [iid, eqVal, String(SNAPSHOT_INTERVAL_MINUTES)]
    ).catch(() => ({ rows: [] }));
    return !!ins.rows?.[0];
  }

  const first = await query(
    `
    INSERT INTO vps_system.mt5_equity_logs (instance_id, equity, created_at)
    VALUES ($1, $2::numeric, NOW())
    RETURNING id
    `,
    [iid, eqVal]
  ).catch(() => ({ rows: [] }));
  return !!first.rows?.[0];
}

/**
 * บันทึก Balance/Equity/Profit ครั้งแรกทันทีเมื่อรันสำเร็จ (snapshot แรก + อัปเดต instance)
 */
async function seedInstanceLiveMetrics(instanceId, balance, equity) {
  const iid = num(instanceId, 0);
  const bal = positiveMoney(balance);
  const eq = positiveMoney(equity) ?? bal;
  if (!iid || eq == null) return false;

  let profit = null;
  if (bal != null && eq != null) {
    profit = Math.round((eq - bal) * 100) / 100;
  }

  await query(
    `
    UPDATE vps_system.bot_instances
    SET mt5_balance = COALESCE($2::numeric, mt5_balance),
        mt5_equity = COALESCE($3::numeric, mt5_equity),
        start_equity = COALESCE(start_equity, $3::numeric),
        profit = COALESCE($4::numeric, profit),
        last_agent_ping = NOW(),
        last_heartbeat = NOW(),
        updated_at = NOW()
    WHERE id = $1
    `,
    [iid, bal, eq, profit]
  ).catch(() => {});

  await recordEquityLog(iid, eq);
  return true;
}

async function fetchEquityChartForInstance(instanceId, userId) {
  const iid = num(instanceId, 0);
  const uid = num(userId, 0);
  if (!iid || !uid) return { ok: false, message: 'invalid' };

  await ensureStartEquityColumn();

  const instRows = await query(
    `
    SELECT bi.id, bi.start_equity, bi.mt5_equity, bi.mt5_balance, bi.started_at, bi.status
    FROM vps_system.bot_instances bi
    WHERE bi.id = $1 AND bi.user_id = $2
    LIMIT 1
    `,
    [iid, uid]
  );
  const inst = instRows.rows?.[0];
  if (!inst) return { ok: false, message: 'not_found' };

  const logRows = await query(
    `
    SELECT equity, created_at
    FROM vps_system.mt5_equity_logs
    WHERE instance_id = $1
    ORDER BY created_at ASC, id ASC
    LIMIT 336
    `,
    [iid]
  );

  let startEquity = num(inst.start_equity, 0);
  if (startEquity <= 0 && logRows.rows?.[0]) {
    startEquity = num(logRows.rows[0].equity, 0);
  }
  if (startEquity <= 0) {
    startEquity = num(inst.mt5_equity, 0) || num(inst.mt5_balance, 0);
  }

  const points = (logRows.rows || []).map((row) => {
    const equity = num(row.equity, 0);
    const pnl = Number((equity - startEquity).toFixed(2));
    return {
      equity,
      pnl,
      profit: pnl > 0 ? pnl : 0,
      loss: pnl < 0 ? Math.abs(pnl) : 0,
      at: row.created_at
    };
  });

  const currentEquity = num(inst.mt5_equity, 0) || (points.length ? points[points.length - 1].equity : 0);
  const currentPnl = Number((currentEquity - startEquity).toFixed(2));

  if (currentEquity > 0) {
    const last = points[points.length - 1];
    const lastEq = last ? last.equity : 0;
    if (!last || Math.abs(lastEq - currentEquity) > 0.009) {
      points.push({
        equity: currentEquity,
        pnl: currentPnl,
        profit: currentPnl > 0 ? currentPnl : 0,
        loss: currentPnl < 0 ? Math.abs(currentPnl) : 0,
        at: new Date().toISOString(),
        live: true
      });
    }
  }

  const days = groupPointsByDay(points);

  return {
    ok: true,
    startEquity: Number(startEquity.toFixed(2)),
    currentEquity: Number(currentEquity.toFixed(2)),
    currentPnl,
    intervalMinutes: SNAPSHOT_INTERVAL_MINUTES,
    profitSeries: points.map((p) => p.profit),
    lossSeries: points.map((p) => p.loss),
    pnlSeries: points.map((p) => p.pnl),
    points,
    days
  };
}

const {
  dayKeyBangkok,
  formatThaiDayLabel,
  formatThaiTime
} = require('./mt5ThaiTime');

function dayKeyFromDate(d) {
  return dayKeyBangkok(d);
}

function formatDayLabel(dayKey) {
  return formatThaiDayLabel(dayKey);
}

function formatTimeLabel(at) {
  return formatThaiTime(at);
}

function groupPointsByDay(points) {
  const map = new Map();
  for (const p of points || []) {
    const key = dayKeyFromDate(p.at);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { dayKey: key, label: formatDayLabel(key), rows: [] });
    }
    map.get(key).rows.push({
      at: p.at,
      time: formatTimeLabel(p.at),
      equity: num(p.equity, 0),
      profit: num(p.profit, 0),
      loss: num(p.loss, 0),
      pnl: num(p.pnl, 0),
      live: !!p.live
    });
  }
  return Array.from(map.values())
    .map((day) => {
      const rows = day.rows;
      const last = rows[rows.length - 1];
      const maxProfit = rows.reduce((m, r) => Math.max(m, r.profit), 0);
      const maxLoss = rows.reduce((m, r) => Math.max(m, r.loss), 0);
      return {
        ...day,
        rowCount: rows.length,
        endPnl: last ? last.pnl : 0,
        maxProfit: Number(maxProfit.toFixed(2)),
        maxLoss: Number(maxLoss.toFixed(2))
      };
    })
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey));
}

module.exports = {
  SNAPSHOT_INTERVAL_MINUTES,
  ensureStartEquityColumn,
  ensureStartEquity,
  recordEquityLog,
  seedInstanceLiveMetrics,
  fetchEquityChartForInstance,
  groupPointsByDay
};
