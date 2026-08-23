/**
 * Backups: copies of the SQLite file made with `VACUUM INTO`, which is safe
 * to run while the server is live. Restore = stop the server, copy a backup
 * over data/opd.db, start again.
 */
const fs = require('fs');
const path = require('path');

const KEEP_DAILY = 14;

function pad(n) {
  return String(n).padStart(2, '0');
}
/** Local calendar date, e.g. 2026-08-23 — backups are named by the clinic's day. */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d = new Date()) {
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeBackup(conn, dir, filename) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, filename);
  conn.prepare('VACUUM INTO ?').run(file);
  return file;
}

/** On-demand backup: backups/opd-YYYY-MM-DD-HHMMSS.db */
function backupNow(conn, dir) {
  return writeBackup(conn, dir, `opd-${localDate()}-${localTime()}.db`);
}

/**
 * Startup backup: backups/opd-YYYY-MM-DD.db, at most one per day.
 * Keeps the newest KEEP_DAILY daily files; on-demand backups are never pruned.
 * Returns the file written, or null if today's already exists.
 */
function dailyBackup(conn, dir) {
  const filename = `opd-${localDate()}.db`;
  if (fs.existsSync(path.join(dir, filename))) return null;
  const file = writeBackup(conn, dir, filename);

  const daily = fs.readdirSync(dir).filter((f) => /^opd-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const old of daily.slice(0, Math.max(0, daily.length - KEEP_DAILY))) {
    fs.unlinkSync(path.join(dir, old));
  }
  return file;
}

module.exports = { backupNow, dailyBackup };
