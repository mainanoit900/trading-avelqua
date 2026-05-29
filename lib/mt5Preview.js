'use strict';

const fs = require('fs');
const path = require('path');
const { query } = require('../config/database');
const { runSchemaOnce } = require('./schemaOnce');

const PREVIEW_DIR = path.join(__dirname, '..', 'public', 'mt5-previews');

async function ensureMt5PreviewColumnsCore() {
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_window_title TEXT`).catch(() => {});
  await query(`ALTER TABLE vps_system.mt5_accounts ADD COLUMN IF NOT EXISTS mt5_preview_path TEXT`).catch(() => {});
}

function ensureMt5PreviewColumns() {
  return runSchemaOnce('mt5-preview-columns', ensureMt5PreviewColumnsCore);
}

function saveMt5Preview(accountId, base64Jpeg) {
  const id = Number(accountId || 0);
  const raw = String(base64Jpeg || '').trim();
  if (!id || !raw) return '';

  try {
    const buf = Buffer.from(raw.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    if (!buf.length || buf.length > 2_500_000) return '';
    fs.mkdirSync(PREVIEW_DIR, { recursive: true });
    const filePath = path.join(PREVIEW_DIR, `${id}.jpg`);
    fs.writeFileSync(filePath, buf);
    return `/mt5-previews/${id}.jpg`;
  } catch (e) {
    console.error('[mt5Preview] save error:', e.message);
    return '';
  }
}

function previewPublicPath(accountId) {
  const id = Number(accountId || 0);
  if (!id) return '';
  const filePath = path.join(PREVIEW_DIR, `${id}.jpg`);
  if (!fs.existsSync(filePath)) return '';
  return `/mt5-previews/${id}.jpg`;
}

function windowTitleFromMessage(message) {
  const m = String(message || '').match(/หน้าต่าง MT5:\s*(.+)/i);
  return m ? m[1].trim().slice(0, 200) : '';
}

async function patchAccountMt5Preview(accountId, { status, message, windowTitle, previewB64, inProgress } = {}) {
  const id = Number(accountId || 0);
  if (!id) return '';

  await ensureMt5PreviewColumns();
  const previewPath = saveMt5Preview(id, previewB64) || previewPublicPath(id);
  const title = String(windowTitle || '').trim();
  let displayMsg = String(message || '').trim();
  if (title) {
    displayMsg = displayMsg
      ? `${displayMsg} — หน้าต่าง MT5: ${title.slice(0, 160)}`
      : `หน้าต่าง MT5: ${title.slice(0, 160)}`;
  }

  const st = String(status || '').trim().toLowerCase();
  const previewParams = st
    ? [id, st, displayMsg || null, title || null, previewPath || null]
    : [id, displayMsg || null, title || null, previewPath || null];
  const touchAt = inProgress ? '' : ', updated_at=NOW()';
  const previewSqlWithCols = st
    ? `UPDATE vps_system.mt5_accounts SET status=$2, last_error=NULL, last_login_message=$3,
         mt5_window_title=COALESCE(NULLIF($4, ''), mt5_window_title),
         mt5_preview_path=COALESCE(NULLIF($5, ''), mt5_preview_path)${touchAt} WHERE id=$1`
    : `UPDATE vps_system.mt5_accounts SET last_login_message=$2,
         mt5_window_title=COALESCE(NULLIF($3, ''), mt5_window_title),
         mt5_preview_path=COALESCE(NULLIF($4, ''), mt5_preview_path)${touchAt} WHERE id=$1`;
  const previewSqlBasic = st
    ? `UPDATE vps_system.mt5_accounts SET status=$2, last_error=NULL, last_login_message=$3, updated_at=NOW() WHERE id=$1`
    : `UPDATE vps_system.mt5_accounts SET last_login_message=$2, updated_at=NOW() WHERE id=$1`;
  const basicParams = st ? [id, st, displayMsg || null] : [id, displayMsg || null];

  const withCols = await query(previewSqlWithCols, previewParams).catch((e) => e);
  if (withCols instanceof Error || (withCols && withCols.code === '42703')) {
    await query(previewSqlBasic, basicParams).catch(() => {});
  }

  return previewPath;
}

module.exports = {
  saveMt5Preview,
  previewPublicPath,
  windowTitleFromMessage,
  ensureMt5PreviewColumns,
  patchAccountMt5Preview,
  PREVIEW_DIR
};
