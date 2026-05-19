'use strict';

const fs = require('fs');
const path = require('path');
const { presetSlugForBot } = require('./mt5BotPresets');

const META_DIR = path.join(process.cwd(), 'data', 'mt5-presets');

const SLUG_META_FILE = {
  'ak-sniper': 'ak-sniper-ea-meta.json',
  'pa-sniper': 'ak-sniper-ea-meta.json',
  '5pa-sniper': 'ak-sniper-ea-meta.json',
  'sniper-demo': 'sniper-demo-ea-meta.json'
};

function loadEaMeta(slug) {
  const file = SLUG_META_FILE[String(slug || '').toLowerCase()];
  if (!file) return null;
  const full = path.join(META_DIR, file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

function validateEaAccountAccess(botCode, mt5Login, opts = {}) {
  const slug = opts.presetSlug || '';
  const meta =
    loadEaMeta(slug) ||
    loadEaMeta(presetSlugForBot({ bot_code: botCode })) ||
    (String(slug || '').includes('demo') ? loadEaMeta('sniper-demo') : null) ||
    loadEaMeta('ak-sniper');
  if (!meta?.hardcoded_in_mq5) {
    return { ok: true, skipped: true };
  }

  const login = Number(String(mt5Login || '').replace(/\D/g, ''));
  if (!login) {
    return { ok: true, skipped: true, reason: 'NO_LOGIN' };
  }

  const list = meta.hardcoded_in_mq5.allowed_accounts || [];
  if (list.some((a) => Number(a) === 0)) {
    return { ok: true, anyAccount: true };
  }

  const allowed = list.some((a) => Number(a) === login);
  if (allowed) {
    return { ok: true, login };
  }

  return {
    ok: false,
    login,
    allowedAccounts: list,
    message:
      `เลขบัญชี ${login} ไม่อยู่ในรายการที่ EA ${meta.bot_code || 'นี้'} อนุญาต ` +
      `(รายการใน .ex5: ${list.join(', ')}) — ต้องใช้บัญชีที่ได้รับอนุญาต ` +
      `หรือใช้ SNIPER-DEMO ทดสอบ (รองรับทุกบัญชี) / ขอ .ex5 ใหม่จากผู้พัฒนา`
  };
}

function eaLicenseHintForDiagnostics(botCode, mt5Login, presetSlug) {
  const v = validateEaAccountAccess(botCode, mt5Login, { presetSlug });
  if (v.ok) return null;
  return v.message;
}

/** บอทแรกที่บัญชีนี้ใช้ได้ (มักเป็น sniper-demo) */
function findLicensedBotForLogin(mt5Login, bots) {
  for (const b of bots || []) {
    const slug = presetSlugForBot(b);
    const v = validateEaAccountAccess(b.bot_code, mt5Login, { presetSlug: slug });
    if (v.ok) return b;
  }
  return null;
}

module.exports = {
  loadEaMeta,
  validateEaAccountAccess,
  eaLicenseHintForDiagnostics,
  findLicensedBotForLogin
};
