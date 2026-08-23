/**
 * SQLite connection + schema migrations. Uses Node's built-in `node:sqlite`,
 * so there is nothing to install and the whole database is one file.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const DEFAULT_DB_PATH = path.join(ROOT, 'data', 'opd.db');
const DEFAULT_BACKUP_DIR = path.join(ROOT, 'backups');

function dbPath() {
  return process.env.OPD_DB_PATH || DEFAULT_DB_PATH;
}
function backupDir() {
  return process.env.OPD_BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

/** Opens (creating if needed) the database file and brings the schema up to date. */
function open(file = dbPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 5000');
  migrate(conn);
  return conn;
}

/**
 * Applies every src/migrations/NNN-*.sql file not yet recorded in
 * schema_migrations, in filename order, each inside its own transaction.
 *
 * Foreign keys are disabled around each migration and verified with
 * PRAGMA foreign_key_check before committing. That is SQLite's documented
 * procedure for rebuilding a table other tables reference — which is the only
 * way to change a CHECK constraint. PRAGMA foreign_keys is a no-op inside a
 * transaction, so it has to be toggled out here.
 */
function migrate(conn) {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    conn.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+-.*\.sql$/.test(f)).sort();
  const record = conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    conn.exec('PRAGMA foreign_keys = OFF');
    conn.exec('BEGIN');
    try {
      conn.exec(sql);
      const violations = conn.prepare('PRAGMA foreign_key_check').all();
      if (violations.length) {
        throw new Error(`left ${violations.length} dangling foreign key(s)`);
      }
      record.run(file, new Date().toISOString());
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err.message}`);
    } finally {
      conn.exec('PRAGMA foreign_keys = ON');
    }
  }
}

module.exports = { open, dbPath, backupDir };
