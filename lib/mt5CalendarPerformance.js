'use strict';

const { query } = require('../config/database');
const {
  dayKeyBangkok,
  formatThaiDateTime,
  formatThaiTime,
  formatThaiDayLabel
} = require('./mt5ThaiTime');
const { SNAPSHOT_INTERVAL_SEC } = require('./mt5EquityChart');

const HISTORY_PAGE_SIZE = 10;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function roundMoney(v) {
  return Number(num(v, 0).toFixed(2));
}

function positiveMoney(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function dayBoundsBangkok(dayKey) {
  const key = String(dayKey || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const today = dayKeyBangkok(new Date());
    return dayBoundsBangkok(today);
  }
  const start = new Date(`${key}T00:00:00+07:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { dayKey: key, start, end };
}

function monthMeta(yearMonth) {
  const raw = String(yearMonth || '').trim();
  const m = /^(\d{4})-(\d{2})$/.exec(raw) || /^(\d{4})-(\d{2})-\d{2}$/.exec(raw);
  const y = m ? Number(m[1]) : new Date().getFullYear();
  const mo = m ? Number(m[2]) : new Date().getMonth() + 1;
  const monthKey = `${y}-${String(mo).padStart(2, '0')}`;
  const firstDay = `${monthKey}-01`;
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lastDay = `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
  return { year: y, month: mo, monthKey, firstDay, lastDay, daysInMonth };
}

async function ensureDailyPnlTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.mt5_daily_pnl (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      mt5_account_id BIGINT NOT NULL,
      mt5_login TEXT,
      day_key DATE NOT NULL,
      opening_equity NUMERIC,
      closing_equity NUMERIC,
      pnl NUMERIC NOT NULL DEFAULT 0,
      snapshot_count INT NOT NULL DEFAULT 0,
      is_finalized BOOLEAN NOT NULL DEFAULT FALSE,
      last_snapshot_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (mt5_account_id, day_key)
    )
  `).catch(() => {});
  await query(`
    CREATE INDEX IF NOT EXISTS idx_mt5_daily_pnl_user_account_day
    ON vps_system.mt5_daily_pnl (user_id, mt5_account_id, day_key DESC)
  `).catch(() => {});
}

async function verifyAccount(userId, accountId) {
  const uid = num(userId, 0);
  const aid = num(accountId, 0);
  if (!uid || !aid) return null;
  const rows = await query(
    `
    SELECT id, mt5_login, last_equity, last_balance, port_slot
    FROM vps_system.mt5_accounts
    WHERE user_id = $1 AND id = $2
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    LIMIT 1
    `,
    [uid, aid]
  );
  return rows.rows?.[0] || null;
}

async function listUserCalendarAccounts(userId) {
  const uid = num(userId, 0);
  if (!uid) return [];
  const rows = await query(
    `
    SELECT id, mt5_login, port_slot, last_equity, last_balance, status
    FROM vps_system.mt5_accounts
    WHERE user_id = $1
      AND mt5_login IS NOT NULL
      AND TRIM(mt5_login) <> ''
      AND LOWER(TRIM(COALESCE(status, ''))) NOT IN ('deleted', 'expired')
    ORDER BY port_slot ASC NULLS LAST, id ASC
    `,
    [uid]
  );
  return (rows.rows || []).map((row) => ({
    id: Number(row.id),
    mt5_login: String(row.mt5_login || '').trim(),
    port_slot: num(row.port_slot, 0) || null,
    last_equity: positiveMoney(row.last_equity),
    last_balance: positiveMoney(row.last_balance),
    status: String(row.status || '').trim()
  }));
}

async function getLiveEquity(userId, accountId) {
  const uid = num(userId, 0);
  const aid = num(accountId, 0);
  if (!uid || !aid) return null;

  const active = await query(
    `
    SELECT bi.mt5_equity, bi.mt5_balance, bi.last_agent_ping, bi.last_heartbeat
    FROM vps_system.bot_instances bi
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND LOWER(TRIM(COALESCE(bi.status, ''))) IN ('running', 'pending', 'restarting', 'connecting', 'starting')
    ORDER BY bi.started_at DESC NULLS LAST, bi.id DESC
    LIMIT 1
    `,
    [uid, aid]
  );
  const inst = active.rows?.[0];
  const instEq = positiveMoney(inst?.mt5_equity) ?? positiveMoney(inst?.mt5_balance);
  if (instEq != null) return instEq;

  const acc = await verifyAccount(uid, aid);
  return positiveMoney(acc?.last_equity) ?? positiveMoney(acc?.last_balance);
}

async function getOpeningEquityForDay(userId, accountId, dayKey) {
  const uid = num(userId, 0);
  const aid = num(accountId, 0);
  const { start } = dayBoundsBangkok(dayKey);

  const before = await query(
    `
    SELECT el.equity
    FROM vps_system.mt5_equity_logs el
    INNER JOIN vps_system.bot_instances bi ON bi.id = el.instance_id
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND el.created_at < $3
    ORDER BY el.created_at DESC, el.id DESC
    LIMIT 1
    `,
    [uid, aid, start]
  );
  const eqBefore = positiveMoney(before.rows?.[0]?.equity);
  if (eqBefore != null) return eqBefore;

  const prev = await query(
    `
    SELECT closing_equity
    FROM vps_system.mt5_daily_pnl
    WHERE mt5_account_id = $1
      AND user_id = $2
      AND day_key < $3::date
      AND is_finalized = TRUE
    ORDER BY day_key DESC
    LIMIT 1
    `,
    [aid, uid, dayKey]
  );
  const prevClose = positiveMoney(prev.rows?.[0]?.closing_equity);
  if (prevClose != null) return prevClose;

  const firstInDay = await query(
    `
    SELECT el.equity
    FROM vps_system.mt5_equity_logs el
    INNER JOIN vps_system.bot_instances bi ON bi.id = el.instance_id
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND el.created_at >= $3
      AND el.created_at < $4
    ORDER BY el.created_at ASC, el.id ASC
    LIMIT 1
    `,
    [uid, aid, start, dayBoundsBangkok(dayKey).end]
  );
  const firstEq = positiveMoney(firstInDay.rows?.[0]?.equity);
  if (firstEq != null) return firstEq;

  return (await getLiveEquity(uid, aid)) ?? 0;
}

async function computeDayFromLogs(userId, accountId, dayKey) {
  const uid = num(userId, 0);
  const aid = num(accountId, 0);
  const { start, end } = dayBoundsBangkok(dayKey);

  const stats = await query(
    `
    SELECT
      COUNT(*)::int AS snapshot_count,
      MIN(el.equity) AS min_equity,
      MAX(el.equity) AS max_equity,
      (ARRAY_AGG(el.equity ORDER BY el.created_at ASC, el.id ASC))[1] AS first_equity,
      (ARRAY_AGG(el.equity ORDER BY el.created_at DESC, el.id DESC))[1] AS last_equity,
      MAX(el.created_at) AS last_at
    FROM vps_system.mt5_equity_logs el
    INNER JOIN vps_system.bot_instances bi ON bi.id = el.instance_id
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND el.created_at >= $3
      AND el.created_at < $4
    `,
    [uid, aid, start, end]
  );

  const row = stats.rows?.[0];
  const count = num(row?.snapshot_count, 0);
  if (count <= 0) return null;

  const opening = positiveMoney(row.first_equity) ?? 0;
  const closing = positiveMoney(row.last_equity) ?? opening;
  return {
    opening_equity: opening,
    closing_equity: closing,
    pnl: roundMoney(closing - opening),
    snapshot_count: count,
    last_snapshot_at: row.last_at || null
  };
}

async function upsertDailyRow(userId, accountId, login, dayKey, payload) {
  const opening = roundMoney(payload.opening_equity);
  const closing = roundMoney(payload.closing_equity);
  const pnl = roundMoney(payload.pnl != null ? payload.pnl : closing - opening);
  await query(
    `
    INSERT INTO vps_system.mt5_daily_pnl (
      user_id, mt5_account_id, mt5_login, day_key,
      opening_equity, closing_equity, pnl, snapshot_count,
      is_finalized, last_snapshot_at, updated_at
    )
    VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, NOW())
    ON CONFLICT (mt5_account_id, day_key) DO UPDATE SET
      mt5_login = EXCLUDED.mt5_login,
      opening_equity = COALESCE(vps_system.mt5_daily_pnl.opening_equity, EXCLUDED.opening_equity),
      closing_equity = EXCLUDED.closing_equity,
      pnl = EXCLUDED.pnl,
      snapshot_count = GREATEST(vps_system.mt5_daily_pnl.snapshot_count, EXCLUDED.snapshot_count),
      is_finalized = CASE
        WHEN vps_system.mt5_daily_pnl.is_finalized THEN TRUE
        ELSE EXCLUDED.is_finalized
      END,
      last_snapshot_at = COALESCE(EXCLUDED.last_snapshot_at, vps_system.mt5_daily_pnl.last_snapshot_at),
      updated_at = NOW()
    `,
    [
      userId,
      accountId,
      login || null,
      dayKey,
      opening,
      closing,
      pnl,
      num(payload.snapshot_count, 0),
      !!payload.is_finalized,
      payload.last_snapshot_at || null
    ]
  );
}

async function finalizePastDays(userId, accountId, login) {
  const todayKey = dayKeyBangkok(new Date());
  const pending = await query(
    `
    SELECT day_key::text AS day_key
    FROM vps_system.mt5_daily_pnl
    WHERE user_id = $1
      AND mt5_account_id = $2
      AND day_key < $3::date
      AND is_finalized = FALSE
    ORDER BY day_key ASC
    `,
    [userId, accountId, todayKey]
  );

  for (const row of pending.rows || []) {
    const dayKey = String(row.day_key).slice(0, 10);
    const fromLogs = await computeDayFromLogs(userId, accountId, dayKey);
    const opening = fromLogs
      ? fromLogs.opening_equity
      : await getOpeningEquityForDay(userId, accountId, dayKey);
    const closing = fromLogs
      ? fromLogs.closing_equity
      : opening;
    await upsertDailyRow(userId, accountId, login, dayKey, {
      opening_equity: opening,
      closing_equity: closing,
      pnl: roundMoney(closing - opening),
      snapshot_count: fromLogs?.snapshot_count || 0,
      is_finalized: true,
      last_snapshot_at: fromLogs?.last_snapshot_at || null
    });
    await query(
      `
      UPDATE vps_system.mt5_daily_pnl
      SET is_finalized = TRUE, updated_at = NOW()
      WHERE user_id = $1 AND mt5_account_id = $2 AND day_key = $3::date
      `,
      [userId, accountId, dayKey]
    );
  }
}

async function syncTodayRow(userId, accountId, login) {
  const todayKey = dayKeyBangkok(new Date());
  const existing = await query(
    `
    SELECT opening_equity, closing_equity, pnl, is_finalized
    FROM vps_system.mt5_daily_pnl
    WHERE user_id = $1 AND mt5_account_id = $2 AND day_key = $3::date
    LIMIT 1
    `,
    [userId, accountId, todayKey]
  );

  const fromLogs = await computeDayFromLogs(userId, accountId, todayKey);
  const liveEq = (await getLiveEquity(userId, accountId))
    ?? positiveMoney(fromLogs?.last_equity)
    ?? positiveMoney(existing.rows?.[0]?.closing_equity)
    ?? 0;

  let opening = positiveMoney(existing.rows?.[0]?.opening_equity);
  if (opening == null) {
    opening = fromLogs
      ? fromLogs.opening_equity
      : await getOpeningEquityForDay(userId, accountId, todayKey);
  }

  const closing = liveEq > 0 ? liveEq : (fromLogs?.closing_equity ?? opening);
  await upsertDailyRow(userId, accountId, login, todayKey, {
    opening_equity: opening,
    closing_equity: closing,
    pnl: roundMoney(closing - opening),
    snapshot_count: fromLogs?.snapshot_count || 0,
    is_finalized: false,
    last_snapshot_at: fromLogs?.last_snapshot_at || new Date()
  });
}

async function backfillMonthDays(userId, accountId, login, meta) {
  const todayKey = dayKeyBangkok(new Date());
  const stored = await query(
    `
    SELECT day_key::text AS day_key
    FROM vps_system.mt5_daily_pnl
    WHERE user_id = $1
      AND mt5_account_id = $2
      AND day_key >= $3::date
      AND day_key <= $4::date
    `,
    [userId, accountId, meta.firstDay, meta.lastDay]
  );
  const have = new Set((stored.rows || []).map((r) => String(r.day_key).slice(0, 10)));

  for (let d = 1; d <= meta.daysInMonth; d += 1) {
    const dayKey = `${meta.monthKey}-${String(d).padStart(2, '0')}`;
    if (dayKey >= todayKey || have.has(dayKey)) continue;

    const fromLogs = await computeDayFromLogs(userId, accountId, dayKey);
    if (!fromLogs) continue;

    await upsertDailyRow(userId, accountId, login, dayKey, {
      opening_equity: fromLogs.opening_equity,
      closing_equity: fromLogs.closing_equity,
      pnl: fromLogs.pnl,
      snapshot_count: fromLogs.snapshot_count,
      is_finalized: true,
      last_snapshot_at: fromLogs.last_snapshot_at
    });
    await query(
      `
      UPDATE vps_system.mt5_daily_pnl
      SET is_finalized = TRUE
      WHERE user_id = $1 AND mt5_account_id = $2 AND day_key = $3::date
      `,
      [userId, accountId, dayKey]
    );
  }
}

async function fetchMonthDays(userId, accountId, meta) {
  const rows = await query(
    `
    SELECT
      day_key::text AS day_key,
      opening_equity,
      closing_equity,
      pnl,
      snapshot_count,
      is_finalized,
      last_snapshot_at
    FROM vps_system.mt5_daily_pnl
    WHERE user_id = $1
      AND mt5_account_id = $2
      AND day_key >= $3::date
      AND day_key <= $4::date
    ORDER BY day_key ASC
    `,
    [userId, accountId, meta.firstDay, meta.lastDay]
  );
  const map = new Map();
  for (const row of rows.rows || []) {
    const key = String(row.day_key).slice(0, 10);
    map.set(key, {
      dayKey: key,
      label: formatThaiDayLabel(key),
      openingEquity: roundMoney(row.opening_equity),
      closingEquity: roundMoney(row.closing_equity),
      pnl: roundMoney(row.pnl),
      snapshotCount: num(row.snapshot_count, 0),
      isFinalized: !!row.is_finalized,
      isToday: key === dayKeyBangkok(new Date()),
      live: key === dayKeyBangkok(new Date()) && !row.is_finalized
    });
  }
  return map;
}

function buildCalendarGrid(meta, dayMap, todayKey) {
  const firstDow = new Date(`${meta.firstDay}T12:00:00+07:00`).getUTCDay();
  const cells = [];
  for (let i = 0; i < firstDow; i += 1) {
    cells.push({ empty: true });
  }
  let monthTotal = 0;
  let profitDays = 0;
  let lossDays = 0;
  for (let d = 1; d <= meta.daysInMonth; d += 1) {
    const dayKey = `${meta.monthKey}-${String(d).padStart(2, '0')}`;
    const data = dayMap.get(dayKey);
    const pnl = data ? data.pnl : null;
    if (pnl != null && pnl !== 0) {
      monthTotal += pnl;
      if (pnl > 0) profitDays += 1;
      if (pnl < 0) lossDays += 1;
    }
    cells.push({
      empty: false,
      day: d,
      dayKey,
      label: formatThaiDayLabel(dayKey),
      pnl,
      hasData: !!data,
      isToday: dayKey === todayKey,
      isFuture: dayKey > todayKey,
      live: !!(data && data.live),
      finalized: !!(data && data.isFinalized)
    });
  }
  return { cells, monthTotal: roundMoney(monthTotal), profitDays, lossDays };
}

async function fetchSnapshotHistory(userId, accountId, dayKey, page) {
  const uid = num(userId, 0);
  const aid = num(accountId, 0);
  const pg = Math.max(1, num(page, 1));
  const lim = HISTORY_PAGE_SIZE;
  const off = (pg - 1) * lim;
  const { start, end } = dayBoundsBangkok(dayKey);
  const todayKey = dayKeyBangkok(new Date());
  const isToday = dayKey === todayKey;

  const opening = await getOpeningEquityForDay(uid, aid, dayKey);

  const countRows = await query(
    `
    SELECT COUNT(*)::int AS total
    FROM vps_system.mt5_equity_logs el
    INNER JOIN vps_system.bot_instances bi ON bi.id = el.instance_id
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND el.created_at >= $3
      AND el.created_at < $4
    `,
    [uid, aid, start, end]
  );
  let total = num(countRows.rows?.[0]?.total, 0);

  if (isToday) {
    const liveEq = await getLiveEquity(uid, aid);
    if (liveEq != null) total = Math.max(total, 1);
  }

  const logRows = await query(
    `
    SELECT el.equity, el.created_at
    FROM vps_system.mt5_equity_logs el
    INNER JOIN vps_system.bot_instances bi ON bi.id = el.instance_id
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND el.created_at >= $3
      AND el.created_at < $4
    ORDER BY el.created_at DESC, el.id DESC
    LIMIT $5 OFFSET $6
    `,
    [uid, aid, start, end, lim, off]
  );

  let rows = (logRows.rows || []).map((row, idx) => {
    const equity = roundMoney(row.equity);
    const pnl = roundMoney(equity - opening);
    return {
      at: row.created_at,
      time: formatThaiTime(row.created_at),
      datetime: formatThaiDateTime(row.created_at),
      equity,
      pnl,
      profit: pnl > 0 ? pnl : 0,
      loss: pnl < 0 ? Math.abs(pnl) : 0,
      live: false,
      isLatest: pg === 1 && idx === 0
    };
  });

  if (isToday && pg === 1) {
    const liveEq = await getLiveEquity(uid, aid);
    if (liveEq != null) {
      const pnl = roundMoney(liveEq - opening);
      const liveRow = {
        at: new Date().toISOString(),
        time: formatThaiTime(new Date()),
        datetime: formatThaiDateTime(new Date()),
        equity: roundMoney(liveEq),
        pnl,
        profit: pnl > 0 ? pnl : 0,
        loss: pnl < 0 ? Math.abs(pnl) : 0,
        live: true,
        isLatest: true
      };
      const first = rows[0];
      if (!first || Math.abs(num(first.equity) - liveEq) > 0.009) {
        rows = [liveRow, ...rows.filter((r) => !r.live)].slice(0, lim);
      } else {
        rows[0] = { ...first, ...liveRow, at: first.at };
      }
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / lim));
  return {
    rows,
    openingEquity: roundMoney(opening),
    total,
    page: pg,
    pageSize: lim,
    pageCount
  };
}

async function fetchCalendarPerformance(userId, { accountId, month, day, historyPage } = {}) {
  await ensureDailyPnlTable();
  const uid = num(userId, 0);
  if (!uid) return { ok: false, message: 'unauthorized' };

  let accounts = await listUserCalendarAccounts(uid);
  let aid = num(accountId, 0);
  if (!aid && accounts.length) aid = accounts[0].id;
  if (!aid) {
    return {
      ok: true,
      accounts,
      accountId: null,
      month: monthMeta(month).monthKey,
      selectedDay: dayKeyBangkok(new Date()),
      calendar: { cells: [], monthTotal: 0, profitDays: 0, lossDays: 0 },
      history: { rows: [], total: 0, page: 1, pageSize: HISTORY_PAGE_SIZE, pageCount: 1 },
      refreshSec: SNAPSHOT_INTERVAL_SEC,
      message: 'no_account'
    };
  }

  const acc = await verifyAccount(uid, aid);
  if (!acc) return { ok: false, message: 'account_not_found' };

  const login = String(acc.mt5_login || '').trim();
  const meta = monthMeta(month);
  const todayKey = dayKeyBangkok(new Date());
  const selectedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '').trim())
    ? String(day).trim()
    : todayKey;

  await finalizePastDays(uid, aid, login);
  await syncTodayRow(uid, aid, login);
  await backfillMonthDays(uid, aid, login, meta);

  const dayMap = await fetchMonthDays(uid, aid, meta);
  const calendar = buildCalendarGrid(meta, dayMap, todayKey);
  const history = await fetchSnapshotHistory(uid, aid, selectedDay, historyPage);

  const selectedDayData = dayMap.get(selectedDay) || null;

  return {
    ok: true,
    accounts,
    accountId: aid,
    mt5Login: login,
    portSlot: num(acc.port_slot, 0) || null,
    month: meta.monthKey,
    monthLabel: new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: 'long'
    }).format(new Date(`${meta.firstDay}T12:00:00+07:00`)),
    year: meta.year,
    monthNumber: meta.month,
    daysInMonth: meta.daysInMonth,
    todayKey,
    selectedDay,
    selectedDayLabel: formatThaiDayLabel(selectedDay),
    selectedDayPnl: selectedDayData ? selectedDayData.pnl : null,
    calendar,
    history,
    refreshSec: SNAPSHOT_INTERVAL_SEC
  };
}

module.exports = {
  HISTORY_PAGE_SIZE,
  ensureDailyPnlTable,
  listUserCalendarAccounts,
  fetchCalendarPerformance,
  dayBoundsBangkok,
  monthMeta
};
