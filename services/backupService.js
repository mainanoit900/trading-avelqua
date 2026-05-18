const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const APP_ROOT = process.env.APP_ROOT || '/root/trading-avelqua';
const BACKUP_ROOT = process.env.BACKUP_ROOT || '/root/Backup/trading-avelqua';
const KEEP_LATEST = Number(process.env.BACKUP_KEEP_LATEST || 3);
const CRON_MARKER = 'TRADING_AVELQUA_AUTO_BACKUP';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || APP_ROOT,
      env: { ...process.env, ...(options.env || {}) },
      shell: false
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      const err = new Error(`${command} failed (${code}): ${stderr || stdout}`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function dbEnv() {
  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || '5432',
    name: process.env.DB_NAME || 'trading_avelqua',
    user: process.env.DB_USER || 'trading_user',
    pass: process.env.DB_PASS || ''
  };
}

function backupDirName(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `backup-${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function backupPath(name) {
  const clean = safeName(name);
  if (!clean || !clean.startsWith('backup-')) throw new Error('Invalid backup name');
  return path.join(BACKUP_ROOT, clean);
}

async function createBackup() {
  ensureDir(BACKUP_ROOT);
  const name = backupDirName();
  const dir = path.join(BACKUP_ROOT, name);
  ensureDir(dir);

  const appFile = path.join(dir, 'app-files.tar.gz');
  const dbFile = path.join(dir, 'database.sql.gz');
  const manifestFile = path.join(dir, 'manifest.json');

  await run('tar', [
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=logs',
    '--exclude=tmp',
    '--exclude=*.tar.gz',
    '-czf', appFile,
    '-C', path.dirname(APP_ROOT), path.basename(APP_ROOT)
  ], { cwd: APP_ROOT });

  const db = dbEnv();
  await new Promise((resolve, reject) => {
    const dump = spawn('pg_dump', ['-h', db.host, '-p', db.port, '-U', db.user, '-d', db.name, '--clean', '--if-exists', '--no-owner', '--no-privileges'], {
      cwd: APP_ROOT,
      env: { ...process.env, PGPASSWORD: db.pass },
      shell: false
    });
    const gzip = spawn('gzip', ['-c'], { shell: false });
    const out = fs.createWriteStream(dbFile);
    let stderr = '';
    dump.stderr.on('data', d => { stderr += d.toString(); });
    gzip.stderr.on('data', d => { stderr += d.toString(); });
    dump.stdout.pipe(gzip.stdin);
    gzip.stdout.pipe(out);
    dump.on('error', reject);
    gzip.on('error', reject);
    out.on('error', reject);
    let dumpCode = null;
    let gzipCode = null;
    function done() {
      if (dumpCode === null || gzipCode === null) return;
      if (dumpCode === 0 && gzipCode === 0) return resolve();
      reject(new Error(`pg_dump/gzip failed: ${stderr}`));
    }
    dump.on('close', c => { dumpCode = c; done(); });
    gzip.on('close', c => { gzipCode = c; done(); });
  });

  const manifest = {
    name,
    created_at: new Date().toISOString(),
    timezone_note: 'Asia/Bangkok display in admin page',
    app_root: APP_ROOT,
    db_name: dbEnv().name,
    files: ['app-files.tar.gz', 'database.sql.gz']
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  await rotateBackups();
  return manifest;
}

function listBackups() {
  ensureDir(BACKUP_ROOT);
  return fs.readdirSync(BACKUP_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('backup-'))
    .map(d => {
      const dir = path.join(BACKUP_ROOT, d.name);
      const manifestPath = path.join(dir, 'manifest.json');
      let manifest = {};
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
      const stat = fs.statSync(dir);
      const app = path.join(dir, 'app-files.tar.gz');
      const db = path.join(dir, 'database.sql.gz');
      return {
        name: d.name,
        created_at: manifest.created_at || stat.mtime.toISOString(),
        app_size: fs.existsSync(app) ? fs.statSync(app).size : 0,
        db_size: fs.existsSync(db) ? fs.statSync(db).size : 0,
        has_app: fs.existsSync(app),
        has_db: fs.existsSync(db),
        path: dir
      };
    })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function rotateBackups() {
  const items = listBackups();
  for (const item of items.slice(KEEP_LATEST)) {
    fs.rmSync(path.join(BACKUP_ROOT, item.name), { recursive: true, force: true });
  }
}

async function restoreBackup(name, mode = 'all') {
  const dir = backupPath(name);
  if (!fs.existsSync(dir)) throw new Error('ไม่พบไฟล์ Backup ที่เลือก');
  const before = await createBackup();
  if (mode === 'all' || mode === 'files') {
    const appFile = path.join(dir, 'app-files.tar.gz');
    if (!fs.existsSync(appFile)) throw new Error('ไม่พบ app-files.tar.gz');
    await run('tar', ['-xzf', appFile, '-C', path.dirname(APP_ROOT)], { cwd: APP_ROOT });
  }
  if (mode === 'all' || mode === 'db') {
    const dbFile = path.join(dir, 'database.sql.gz');
    if (!fs.existsSync(dbFile)) throw new Error('ไม่พบ database.sql.gz');
    const db = dbEnv();
    await new Promise((resolve, reject) => {
      const gzip = spawn('gzip', ['-dc', dbFile], { shell: false });
      const psql = spawn('psql', ['-h', db.host, '-p', db.port, '-U', db.user, '-d', db.name, '-v', 'ON_ERROR_STOP=1'], {
        cwd: APP_ROOT,
        env: { ...process.env, PGPASSWORD: db.pass },
        shell: false
      });
      let stderr = '';
      gzip.stderr.on('data', d => { stderr += d.toString(); });
      psql.stderr.on('data', d => { stderr += d.toString(); });
      gzip.stdout.pipe(psql.stdin);
      gzip.on('error', reject);
      psql.on('error', reject);
      psql.on('close', code => code === 0 ? resolve() : reject(new Error(`psql restore failed: ${stderr}`)));
    });
  }
  return { restored: name, safety_backup: before.name, mode };
}

async function installSundayCron(hour = 3, minute = 0) {
  const h = Math.max(0, Math.min(23, Number(hour) || 3));
  const m = Math.max(0, Math.min(59, Number(minute) || 0));
  const line = `${m} ${h} * * 0 cd ${APP_ROOT} && /usr/bin/env node scripts/backup-now.js >> /root/Backup/trading-avelqua-cron.log 2>&1 # ${CRON_MARKER}`;
  let current = '';
  try { current = (await run('crontab', ['-l'], { cwd: APP_ROOT })).stdout; } catch (_) {}
  const cleaned = current.split('\n').filter(l => !l.includes(CRON_MARKER) && l.trim()).join('\n');
  const next = `${cleaned}${cleaned ? '\n' : ''}${line}\n`;
  await new Promise((resolve, reject) => {
    const child = spawn('crontab', ['-'], { shell: false });
    child.stdin.end(next);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'crontab failed')));
  });
  return line;
}

async function removeCron() {
  let current = '';
  try { current = (await run('crontab', ['-l'], { cwd: APP_ROOT })).stdout; } catch (_) {}
  const cleaned = current.split('\n').filter(l => !l.includes(CRON_MARKER)).join('\n').trim() + '\n';
  await new Promise((resolve, reject) => {
    const child = spawn('crontab', ['-'], { shell: false });
    child.stdin.end(cleaned);
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || 'crontab failed')));
  });
}

async function cronStatus() {
  let current = '';
  try { current = (await run('crontab', ['-l'], { cwd: APP_ROOT })).stdout; } catch (_) {}
  const line = current.split('\n').find(l => l.includes(CRON_MARKER)) || '';
  return { enabled: Boolean(line), line };
}

module.exports = { BACKUP_ROOT, KEEP_LATEST, createBackup, listBackups, restoreBackup, installSundayCron, removeCron, cronStatus };
