require('dotenv').config();

const cookieParser = require('cookie-parser');
const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const { injectUser } = require('./middleware/requireAuth');
const { appUserLocals } = require('./middleware/appUserLocals');
const { languageMiddleware, normalizeLocale, localeCache, reloadLocaleCache } = require('./services/i18n');
const { query, repairVpsAgentCommandSequences } = require('./config/database');
const { findById, findByEmail, findByGoogleId, createUser } = require('./repositories/usersRepo');

const app = express();
app.use('/agent', express.static('/root/trading-avelqua/public/agent'));

const PORT = Number(process.env.PORT || 3061);

const { syncNewsNow } = require('./services/newsSyncService');

setInterval(async () => {
  try {
    const result = await query(`SELECT * FROM news_settings WHERE id = 1 LIMIT 1`);
    const settings = result.rows[0];
    if (settings?.auto_update_enabled) {
      await syncNewsNow();
    }
  } catch (error) {
    console.error('auto news sync error:', error);
  }
}, 15 * 60 * 1000);

// MT5 expiry enforcer: auto stop BOT + close MT5 when package/coupon/port expires.
// Runs in-process so it works even if user doesn't open the MT5 page.
const { runMt5ExpiryEnforcerOnce } = require('./lib/mt5ExpiryEnforcer');
let mt5ExpiryEnforcerRunning = false;
const MT5_EXPIRY_ENFORCER_ENABLED =
  String(process.env.MT5_EXPIRY_ENFORCER_ENABLED || 'true').toLowerCase() !== 'false';
const MT5_EXPIRY_ENFORCER_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.MT5_EXPIRY_ENFORCER_INTERVAL_MS || 60 * 1000)
);

if (MT5_EXPIRY_ENFORCER_ENABLED) {
  setInterval(async () => {
    if (mt5ExpiryEnforcerRunning) return;
    mt5ExpiryEnforcerRunning = true;
    try {
      await runMt5ExpiryEnforcerOnce();
    } catch (e) {
      console.error('MT5 expiry enforcer error:', e);
    } finally {
      mt5ExpiryEnforcerRunning = false;
    }
  }, MT5_EXPIRY_ENFORCER_INTERVAL_MS);
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '8mb';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    console.error('PAYLOAD TOO LARGE:', req.method, req.path, err.length || err.message);
    return res.status(413).json({
      ok: false,
      message: 'ข้อมูลจาก VPS ใหญ่เกินไป (ภาพหน้าจอ) — ลองเชื่อมต่อใหม่'
    });
  }
  return next(err);
});

app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(path.join(__dirname, 'public/downloads')));
app.use('/mt5-previews', express.static(path.join(__dirname, 'public/mt5-previews')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'trading-avelqua-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

app.use('/auth/', rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

passport.serializeUser((user, done) => done(null, String(user.id)));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await findById(id);
    done(null, user || false);
  } catch (error) {
    done(error);
  }
});

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          let user = await findByGoogleId(profile.id);
          if (!user) {
            const email = profile.emails?.[0]?.value || '';
            user = email ? await findByEmail(email) : null;
          }
          if (!user) {
            user = await createUser({
              email: profile.emails?.[0]?.value || '',
              name: profile.displayName || '',
              firstName: profile.name?.givenName || '',
              lastName: profile.name?.familyName || '',
              provider: 'google',
              googleId: profile.id,
              emailVerified: true,
              status: 'active'
            });
          }
          return done(null, user);
        } catch (error) {
          return done(error);
        }
      }
    )
  );
}

app.use(passport.initialize());
app.use(passport.session());
app.use(languageMiddleware);
app.use(injectUser);

// ทุกหน้า /app ใช้ user จาก DB ล่าสุด — sidebar / identity gate ไม่เพี้ยน (เช่น MT5 ไม่ส่ง user)
app.use('/app', appUserLocals);

app.get('/set-language/:lang', (req, res) => {
  const nextLang = normalizeLocale(req.params.lang);
  if (req.session) req.session.lang = nextLang;
  reloadLocaleCache();

  const rawTarget = String(req.query.redirect || req.get('referer') || '/');
  let safeTarget = rawTarget.startsWith('/') ? rawTarget : '/';
  try {
    const [pathname, queryString = ''] = safeTarget.split('?');
    const params = new URLSearchParams(queryString);
    params.delete('lang');
    safeTarget = `${pathname}${params.toString() ? `?${params.toString()}` : ''}`;
  } catch (_) {}

  if (String(req.query.ajax || '') === '1') {
    return res.json({ ok: true, lang: nextLang, redirect: safeTarget });
  }

  return res.redirect(safeTarget);
});

app.post('/api/i18n/switch', (req, res) => {
  const nextLang = normalizeLocale(req.body?.lang || req.params?.lang || 'th');
  if (req.session) req.session.lang = nextLang;
  return res.json({
    ok: true,
    lang: nextLang,
    locales: localeCache,
    labels: {
      th: 'ไทย',
      en: 'English',
      lo: 'ລາວ',
      vi: 'Tiếng Việt',
      my: 'မြန်မာ'
    }
  });
});

app.use((req, res, next) => {
  res.locals.site = {};
  res.locals.currentUser = req.user || req.session.user || null;
  res.locals.currentYear = new Date().getFullYear();
  res.locals.request = req;
  next();
});

function handleLogout(req, res) {
  const finish = () => {
    if (req.session) {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        return res.redirect('/');
      });
    }
    res.clearCookie('connect.sid');
    return res.redirect('/');
  };

  if (typeof req.logout === 'function') {
    return req.logout((err) => {
      if (err) {
        console.error('Logout error:', err);
      }
      return finish();
    });
  }

  return finish();
}

app.get('/logout', handleLogout);
app.get('/auth/logout', handleLogout);

app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin-mt5-presets'));
app.use('/admin', require('./routes/admin-vps-control'));
app.use('/admin', require('./routes/admin-vps-port-actions'));
// Production MT5/VPS routes first: atomic port lock + real MT5 login callback
app.use('/api/vps-agent', require('./routes/vps-agent-api-production'));
app.use('/app', require('./routes/app-mt5-connect-production'));

// Legacy routes kept only for endpoints not covered by production route
app.use('/api/vps-agent-legacy', require('./routes/vps-agent-api'));
app.use('/app', require('./routes/app-mt5-bot'));
app.use('/', require('./routes/web'));
app.use('/admin', require('./routes/admin'));
app.use('/app', require('./routes/app'));
app.use('/app/api', require('./routes/scoin-api'));
app.use('/', require('./routes/cart'));
app.use('/', require('./routes/payment'));
app.use('/api', require('./routes/api'));

app.use((req, res) => {
  return res.status(404).render('page', {
    title: 'Not Found',
    pageTitle: 'Page Not Found',
    content: 'The page you requested could not be found.'
  });
});

app.use((error, req, res, next) => {
  console.error('SERVER ERROR:', error);
  if (res.headersSent) {
    return next(error);
  }
  return res.status(500).render('page', {
    title: 'Server Error',
    pageTitle: 'Server Error',
    content: 'The server encountered an error while processing this request.'
  });
});

async function ensureOptionalTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS scoin_settings (
      id BIGSERIAL PRIMARY KEY,
      coin_name TEXT NOT NULL DEFAULT 'Scoin',
      coin_symbol TEXT NOT NULL DEFAULT 'SCOIN',
      current_price_thb NUMERIC(18,4) NOT NULL DEFAULT 0.10,
      transfer_fee_percent NUMERIC(8,4) NOT NULL DEFAULT 1.20,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scoin_wallets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      wallet_code CHAR(19) NOT NULL UNIQUE,
      wallet_type TEXT NOT NULL DEFAULT 'user',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scoin_market_orders (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_type TEXT NOT NULL,
      scoin_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
      price_thb NUMERIC(18,4) NOT NULL DEFAULT 0,
      gross_amount_thb NUMERIC(18,4) NOT NULL DEFAULT 0,
      fee_percent NUMERIC(8,4) NOT NULL DEFAULT 1.20,
      fee_amount_thb NUMERIC(18,4) NOT NULL DEFAULT 0,
      net_amount_thb NUMERIC(18,4) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scoin_price_history (
      id BIGSERIAL PRIMARY KEY,
      price_thb NUMERIC(18,4) NOT NULL DEFAULT 0.10,
      buy_volume NUMERIC(18,4) NOT NULL DEFAULT 0,
      sell_volume NUMERIC(18,4) NOT NULL DEFAULT 0,
      market_supply NUMERIC(18,4) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS transfer_confirmed_at TIMESTAMPTZ
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS transfer_confirmed_by BIGINT REFERENCES users(id) ON DELETE SET NULL
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS transfer_note TEXT NOT NULL DEFAULT ''
`);

  await query(`
    ALTER TABLE scoin_settings
    ADD COLUMN IF NOT EXISTS market_supply NUMERIC(18,4) NOT NULL DEFAULT 0
  `);

  await query(`
    ALTER TABLE scoin_settings
    ADD COLUMN IF NOT EXISTS auto_price_enabled BOOLEAN NOT NULL DEFAULT TRUE
  `);

  await query(`
    ALTER TABLE scoin_settings
    ADD COLUMN IF NOT EXISTS price_change_rate NUMERIC(18,6) NOT NULL DEFAULT 0.0000
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_scoin_wallets_user_id
    ON scoin_wallets(user_id)
  `);

  await query(`
    ALTER TABLE scoin_market_orders
    ADD COLUMN IF NOT EXISTS wallet_code CHAR(19)
  `);

  await query(`
    ALTER TABLE scoin_market_orders
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ
  `);

  await query(`
    ALTER TABLE scoin_market_orders
    ADD COLUMN IF NOT EXISTS approved_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS password_change_requests (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL DEFAULT '',
      token TEXT NOT NULL UNIQUE,
      new_password_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS forbidden_topics_th TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS conversation_instructions_th TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS admin_persona_th TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS app_persona_th TEXT NOT NULL DEFAULT ''`);

  await query(`ALTER TABLE packages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);

  await query(`
    CREATE TABLE IF NOT EXISTS payment_delete_logs (
      id BIGSERIAL PRIMARY KEY,
      payment_id BIGINT,
      deleted_by_user_id BIGINT,
      deleted_by_name TEXT NOT NULL DEFAULT '',
      deleted_by_email TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_identity_verifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      address_line TEXT NOT NULL DEFAULT '',
      subdistrict TEXT NOT NULL DEFAULT '',
      district TEXT NOT NULL DEFAULT '',
      province TEXT NOT NULL DEFAULT '',
      postal_code TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      verify_email TEXT NOT NULL DEFAULT '',
      otp_code TEXT NOT NULL DEFAULT '',
      otp_expires_at TIMESTAMPTZ,
      verified_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_user_identity_verifications_user_id
    ON user_identity_verifications(user_id);
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS identity_verified BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS identity_verified_at TIMESTAMPTZ
  `);
  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS referred_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS scoin_balance NUMERIC(18,4) NOT NULL DEFAULT 0
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scoin_settings (
      id BIGSERIAL PRIMARY KEY,
      coin_name TEXT NOT NULL DEFAULT 'Scoin',
      coin_symbol TEXT NOT NULL DEFAULT 'SCOIN',
      current_price_thb NUMERIC(18,4) NOT NULL DEFAULT 0.10,
      transfer_fee_percent NUMERIC(8,4) NOT NULL DEFAULT 1.20,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    INSERT INTO scoin_settings (id, coin_name, coin_symbol, current_price_thb, transfer_fee_percent, is_enabled, updated_at)
    VALUES (1, 'Scoin', 'SCOIN', 0.10, 1.20, TRUE, NOW())
    ON CONFLICT (id) DO NOTHING
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS package_scoin_rewards (
      id BIGSERIAL PRIMARY KEY,
      package_id BIGINT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
      reward_type TEXT NOT NULL DEFAULT 'fixed',
      reward_scoin NUMERIC(18,4) NOT NULL DEFAULT 0,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(package_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS referral_commissions (
      id BIGSERIAL PRIMARY KEY,
      level_no INTEGER NOT NULL UNIQUE,
      reward_percent NUMERIC(8,4) NOT NULL DEFAULT 0,
      reward_basis TEXT NOT NULL DEFAULT 'package_price',
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    INSERT INTO referral_commissions (level_no, reward_percent, reward_basis, is_enabled)
    VALUES
      (1, 10.0000, 'package_price', TRUE),
      (2, 5.0000, 'package_price', TRUE),
      (3, 3.0000, 'package_price', TRUE),
      (4, 2.0000, 'package_price', TRUE),
      (5, 1.0000, 'package_price', TRUE)
    ON CONFLICT (level_no) DO NOTHING
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scoin_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tx_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount NUMERIC(18,4) NOT NULL DEFAULT 0,
      fee_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
      balance_before NUMERIC(18,4) NOT NULL DEFAULT 0,
      balance_after NUMERIC(18,4) NOT NULL DEFAULT 0,
      ref_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      ref_payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
      ref_package_id BIGINT REFERENCES packages(id) ON DELETE SET NULL,
      level_no INTEGER NOT NULL DEFAULT 0,
      meta_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE scoin_transactions
    ADD COLUMN IF NOT EXISTS tx_ref TEXT
  `);

  await query(`
    ALTER TABLE scoin_transactions
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT
  `);

  await query(`
    ALTER TABLE scoin_transactions
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'
  `);

  await query(`
    ALTER TABLE scoin_transactions
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'confirmed'
  `);

  await query(`
    ALTER TABLE scoin_transactions
    ADD COLUMN IF NOT EXISTS transfer_group_id TEXT
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_scoin_transactions_tx_ref
    ON scoin_transactions(tx_ref)
    WHERE tx_ref IS NOT NULL
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_scoin_transactions_idempotency_key
    ON scoin_transactions(idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS scoin_locked_balance NUMERIC(18,4) NOT NULL DEFAULT 0
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS referral_click_logs (
      id BIGSERIAL PRIMARY KEY,
      referral_code TEXT NOT NULL,
      referrer_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      visitor_ip TEXT NOT NULL DEFAULT '',
      user_agent TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS scoin_transfer_requests (
      id BIGSERIAL PRIMARY KEY,
      from_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(18,4) NOT NULL DEFAULT 0,
      fee_percent NUMERIC(8,4) NOT NULL DEFAULT 1.20,
      fee_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
      receive_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);


await query(`
  CREATE TABLE IF NOT EXISTS user_bank_accounts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bank_name TEXT NOT NULL DEFAULT '',
    account_name TEXT NOT NULL DEFAULT '',
    account_number TEXT NOT NULL DEFAULT '',
    account_number_masked TEXT NOT NULL DEFAULT '',
    verify_email TEXT NOT NULL DEFAULT '',
    otp_code TEXT NOT NULL DEFAULT '',
    otp_expires_at TIMESTAMPTZ,
    verified_at TIMESTAMPTZ,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

await query(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_user_bank_accounts_user_id
  ON user_bank_accounts(user_id)
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS payment_method TEXT
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS payment_ref TEXT
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS gateway_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
`);

await query(`
  ALTER TABLE scoin_market_orders
  ADD COLUMN IF NOT EXISTS bank_account_id BIGINT REFERENCES user_bank_accounts(id) ON DELETE SET NULL
`);

await query(`
  CREATE TABLE IF NOT EXISTS system_wallets (
    id BIGSERIAL PRIMARY KEY,
    wallet_type TEXT NOT NULL UNIQUE,
    wallet_code TEXT NOT NULL UNIQUE,
    balance NUMERIC(18,4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

await query(`
  ALTER TABLE system_wallets
  ADD COLUMN IF NOT EXISTS thb_balance NUMERIC(18,2) NOT NULL DEFAULT 0
`);

await query(`
  CREATE TABLE IF NOT EXISTS fiat_ledger (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id BIGINT REFERENCES scoin_market_orders(id) ON DELETE SET NULL,
    tx_type TEXT NOT NULL,
    amount_thb NUMERIC(18,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`);

}

async function ensureMt5RuntimeSchema() {
  const { ensureMt5PreviewColumns } = require('./lib/mt5Preview');
  const { ensureMt5ConnectAttemptTables } = require('./lib/mt5ConnectAttempt');
  const vpsAgentRoutes = require('./routes/vps-agent-api-production');
  await ensureMt5PreviewColumns().catch(() => {});
  await ensureMt5ConnectAttemptTables().catch(() => {});
  if (typeof vpsAgentRoutes.ensureAgentTables === 'function') {
    await vpsAgentRoutes.ensureAgentTables().catch(() => {});
  }
}

ensureOptionalTables()
  .then(() => repairVpsAgentCommandSequences())
  .then(() => ensureMt5RuntimeSchema())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`TRADING AVELQUA V3 running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Startup migration error:', error);
    process.exit(1);
  });

// ===== MT5 PRESETS =====
const mt5PresetsRoutes = require('./routes/admin-mt5-presets');
app.use('/admin', mt5PresetsRoutes);

