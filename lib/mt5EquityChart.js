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

  return {
    ok: true,
    startEquity: Number(startEquity.toFixed(2)),
    currentEquity: Number(currentEquity.toFixed(2)),
    currentPnl,
    intervalMinutes: SNAPSHOT_INTERVAL_MINUTES,
    profitSeries: points.map((p) => p.profit),
    lossSeries: points.map((p) => p.loss),
    pnlSeries: points.map((p) => p.pnl),
    points
  };
}

module.exports = {
  SNAPSHOT_INTERVAL_MINUTES,
  ensureStartEquityColumn,
  ensureStartEquity,
  recordEquityLog,
  fetchEquityChartForInstance
};
