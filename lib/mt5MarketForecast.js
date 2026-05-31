'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { query } = require('../config/database');
const {
  verifyAccount,
  listUserCalendarAccounts
} = require('./mt5CalendarPerformance');

const APP_ROOT = process.env.APP_ROOT || '/root/trading-avelqua';
function resolveForecastScript() {
  const candidates = [
    path.join(APP_ROOT, 'scripts', 'mt5_market_forecast.py'),
    path.join(__dirname, '..', 'scripts', 'mt5_market_forecast.py'),
    path.join(__dirname, '..', '..', 'scripts', 'mt5_market_forecast.py')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
const FORECAST_SCRIPT = resolveForecastScript();
const FORECAST_HORIZON_DEFAULT = 30;
const FORECAST_HORIZONS = [15, 30];
const CACHE_TTL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.MT5_FORECAST_CACHE_MS || 6 * 60 * 60 * 1000)
);
const REFRESH_COOLDOWN_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.MT5_FORECAST_COOLDOWN_MS || 60 * 60 * 1000)
);
const PYTHON_BIN = process.env.MT5_FORECAST_PYTHON || 'python3';
const FORECAST_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.MT5_FORECAST_TIMEOUT_MS || 65000)
);

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function positiveMoney(v) {
  const n = num(v, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function resolveOpenAiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const rows = await query(
    `
    SELECT openai_api_key
    FROM news_settings
    ORDER BY id ASC
    LIMIT 1
    `
  ).catch(() => ({ rows: [] }));
  const key = String(rows.rows?.[0]?.openai_api_key || '').trim();
  return key || '';
}

async function resolveOpenAiModel() {
  if (process.env.OPENAI_INTEL_MODEL) return process.env.OPENAI_INTEL_MODEL;
  if (process.env.OPENAI_MODEL) return process.env.OPENAI_MODEL;
  const rows = await query(
    `
    SELECT openai_model
    FROM news_settings
    ORDER BY id ASC
    LIMIT 1
    `
  ).catch(() => ({ rows: [] }));
  const model = String(rows.rows?.[0]?.openai_model || '').trim();
  return model || 'gpt-4.1-mini';
}

function isAiFallbackForecast(payload) {
  const analysis = payload?.analysis || {};
  const summary = String(analysis.summary_th || '');
  const market = String(analysis.market_view_th || '');
  return (
    market.includes('ไม่สามารถเรียก OpenAI') ||
    market === 'ไม่สามารถเรียก' ||
    summary.includes('AI ไม่พร้อม') ||
    summary.includes('ยังไม่ได้ตั้งค่า OpenAI API Key')
  );
}

function normalizeHorizon(v) {
  const n = Number(v);
  return n === 15 ? 15 : 30;
}

async function ensureForecastTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS vps_system.mt5_login_forecasts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      mt5_account_id BIGINT NOT NULL,
      mt5_login TEXT,
      horizon_days INT NOT NULL DEFAULT 30,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      model TEXT,
      generated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP
    )
  `).catch(() => {});
  await query(`
    ALTER TABLE vps_system.mt5_login_forecasts
    ADD COLUMN IF NOT EXISTS horizon_days INT NOT NULL DEFAULT 30
  `).catch(() => {});
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mt5_login_forecasts_account_horizon
    ON vps_system.mt5_login_forecasts (mt5_account_id, horizon_days)
  `).catch(() => {});
  await query(`
    ALTER TABLE vps_system.mt5_login_forecasts
    DROP CONSTRAINT IF EXISTS mt5_login_forecasts_mt5_account_id_key
  `).catch(() => {});
  await query(`
    DELETE FROM vps_system.mt5_login_forecasts
    WHERE payload->'analysis'->>'market_view_th' LIKE '%ไม่สามารถเรียก%'
       OR payload->'analysis'->>'summary_th' LIKE '%AI ไม่พร้อม%'
       OR payload->'analysis'->>'summary_th' LIKE '%ยังไม่ได้ตั้งค่า OpenAI API Key%'
  `).catch(() => {});
}

async function gatherForecastContext(userId, accountId, horizonDays = FORECAST_HORIZON_DEFAULT) {
  const horizon = normalizeHorizon(horizonDays);
  const acc = await verifyAccount(userId, accountId);
  if (!acc) return null;

  const historyRows = await query(
    `
    SELECT day_key::text AS day_key, pnl, opening_equity, closing_equity, is_finalized
    FROM vps_system.mt5_daily_pnl
    WHERE user_id = $1
      AND mt5_account_id = $2
      AND day_key >= (CURRENT_DATE - INTERVAL '120 days')
    ORDER BY day_key ASC
    `,
    [userId, accountId]
  );

  const instRows = await query(
    `
    SELECT bi.status, bi.profit, bi.mt5_equity, bi.mt5_balance, bi.started_at,
           bc.display_name AS bot_name, bc.bot_code
    FROM vps_system.bot_instances bi
    LEFT JOIN vps_system.bot_catalog bc ON bc.id = bi.bot_id
    WHERE bi.user_id = $1
      AND bi.mt5_account_id = $2
      AND LOWER(TRIM(COALESCE(bi.status, ''))) <> 'deleted'
    ORDER BY bi.started_at DESC NULLS LAST
    LIMIT 5
    `,
    [userId, accountId]
  );

  const intelRows = await query(
    `
    SELECT direction, buy_percent, sell_percent, technical_summary, news_summary, risk_summary, created_at
    FROM vps_system.intel_reports
    WHERE UPPER(symbol) = 'XAUUSD'
    ORDER BY created_at DESC
    LIMIT 1
    `
  ).catch(() => ({ rows: [] }));

  const equity = positiveMoney(acc.last_equity) ?? positiveMoney(acc.last_balance) ?? 0;
  const latestInst = instRows.rows?.[0] || null;
  const intel = intelRows.rows?.[0] || null;

  return {
    mt5_login: String(acc.mt5_login || '').trim(),
    mt5_account_id: Number(accountId),
    port_slot: num(acc.port_slot, 0) || null,
    symbol: 'XAUUSD',
    current_equity: equity,
    horizon_days: horizon,
    daily_history: (historyRows.rows || []).map((row) => ({
      day_key: String(row.day_key).slice(0, 10),
      pnl: num(row.pnl, 0),
      opening_equity: num(row.opening_equity, 0),
      closing_equity: num(row.closing_equity, 0),
      finalized: !!row.is_finalized
    })),
    bot_runs: (instRows.rows || []).map((row) => ({
      status: String(row.status || ''),
      profit: num(row.profit, 0),
      bot_name: String(row.bot_name || row.bot_code || '').trim(),
      started_at: row.started_at
    })),
    latest_bot: latestInst
      ? {
          status: String(latestInst.status || ''),
          profit: num(latestInst.profit, 0),
          bot_name: String(latestInst.bot_name || latestInst.bot_code || '').trim()
        }
      : null,
    intel: intel
      ? {
          direction: intel.direction,
          buy_percent: num(intel.buy_percent, 50),
          sell_percent: num(intel.sell_percent, 50),
          technical_summary: String(intel.technical_summary || '').slice(0, 500),
          news_summary: String(intel.news_summary || '').slice(0, 500)
        }
      : null
  };
}

function runPythonForecast(context, apiKey, model) {
  return new Promise((resolve, reject) => {
    const payload = {
      ...context,
      openai_api_key: apiKey,
      model: model || process.env.OPENAI_INTEL_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini'
    };
    const child = spawn(PYTHON_BIN, [FORECAST_SCRIPT], {
      cwd: APP_ROOT,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('python forecast timeout'));
    }, FORECAST_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (code !== 0 && !parsed.ok) {
          reject(new Error(parsed.message || stderr || `python exit ${code}`));
          return;
        }
        if (!parsed.ok) {
          reject(new Error(parsed.message || 'forecast_failed'));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(new Error(stderr || stdout || err.message));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function saveForecast(userId, accountId, login, payload, model, horizonDays = FORECAST_HORIZON_DEFAULT) {
  if (isAiFallbackForecast(payload)) return;
  const horizon = normalizeHorizon(horizonDays);
  const expiresAt = new Date(Date.now() + CACHE_TTL_MS);
  await query(
    `
    INSERT INTO vps_system.mt5_login_forecasts (
      user_id, mt5_account_id, mt5_login, horizon_days, payload, model, generated_at, expires_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), $7)
    ON CONFLICT (mt5_account_id, horizon_days) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      mt5_login = EXCLUDED.mt5_login,
      horizon_days = EXCLUDED.horizon_days,
      payload = EXCLUDED.payload,
      model = EXCLUDED.model,
      generated_at = NOW(),
      expires_at = EXCLUDED.expires_at
    `,
    [userId, accountId, login, horizon, payload, model, expiresAt]
  );
}

async function loadCachedForecast(userId, accountId, horizonDays = FORECAST_HORIZON_DEFAULT) {
  const horizon = normalizeHorizon(horizonDays);
  const rows = await query(
    `
    SELECT payload, model, generated_at, expires_at, horizon_days
    FROM vps_system.mt5_login_forecasts
    WHERE user_id = $1 AND mt5_account_id = $2 AND horizon_days = $3
    LIMIT 1
    `,
    [userId, accountId, horizon]
  );
  const row = rows.rows?.[0];
  if (!row) return null;
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const aiFailed = isAiFallbackForecast(row.payload);
  return {
    payload: row.payload,
    model: row.model,
    generated_at: row.generated_at,
    expires_at: row.expires_at,
    aiFailed,
    stale: aiFailed || (expiresAt > 0 && expiresAt < Date.now())
  };
}

async function fetchForecastForAccount(userId, accountId, { refresh = false, horizonDays = FORECAST_HORIZON_DEFAULT } = {}) {
  await ensureForecastTable();
  const uid = num(userId, 0);
  const horizon = normalizeHorizon(horizonDays);
  let aid = num(accountId, 0);
  const accounts = await listUserCalendarAccounts(uid);
  if (!aid && accounts.length) aid = accounts[0].id;
  if (!aid) {
    return {
      ok: true,
      accounts,
      accountId: null,
      message: 'no_account'
    };
  }

  const acc = await verifyAccount(uid, aid);
  if (!acc) return { ok: false, message: 'account_not_found' };

  const cached = await loadCachedForecast(uid, aid, horizon);
  const generatedAt = cached?.generated_at ? new Date(cached.generated_at).getTime() : 0;
  const cooldownLeftMs = Math.max(0, REFRESH_COOLDOWN_MS - (Date.now() - generatedAt));

  if (!refresh && cached?.payload && !cached.stale) {
    return {
      ok: true,
      accounts,
      accountId: aid,
      mt5Login: String(acc.mt5_login || '').trim(),
      cached: true,
      refreshCooldownSec: Math.ceil(cooldownLeftMs / 1000),
      horizonDays: horizon,
      forecast: cached.payload,
      generatedAt: cached.generated_at,
      model: cached.model
    };
  }

  if (refresh && cooldownLeftMs > 0 && cached?.payload && !cached.aiFailed) {
    return {
      ok: true,
      accounts,
      accountId: aid,
      mt5Login: String(acc.mt5_login || '').trim(),
      cached: true,
      refreshBlocked: true,
      refreshCooldownSec: Math.ceil(cooldownLeftMs / 1000),
      horizonDays: horizon,
      forecast: cached.payload,
      generatedAt: cached.generated_at,
      model: cached.model,
      message: 'cooldown'
    };
  }

  const context = await gatherForecastContext(uid, aid, horizon);
  if (!context) return { ok: false, message: 'account_not_found' };

  const apiKey = await resolveOpenAiKey();
  const model = await resolveOpenAiModel();
  const forecast = await runPythonForecast(context, apiKey, model);
  await saveForecast(uid, aid, context.mt5_login, forecast, model, horizon);

  return {
    ok: true,
    accounts,
    accountId: aid,
    mt5Login: context.mt5_login,
    horizonDays: horizon,
    cached: false,
    refreshCooldownSec: Math.ceil(REFRESH_COOLDOWN_MS / 1000),
    forecast,
    generatedAt: new Date().toISOString(),
    model
  };
}

module.exports = {
  FORECAST_HORIZON_DEFAULT,
  FORECAST_HORIZONS,
  normalizeHorizon,
  ensureForecastTable,
  gatherForecastContext,
  fetchForecastForAccount
};
