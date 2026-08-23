-- Adds the admin role, soft-deactivation of staff, a "needs pricing" flag for
-- medicines a doctor added, and a small key/value table for app-level state.
--
-- SQLite cannot alter a CHECK constraint, so `users` is rebuilt. The migration
-- runner disables foreign keys around each migration and runs
-- PRAGMA foreign_key_check before committing, which is the documented
-- procedure for this (see src/database.js).

CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  salt          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'doctor', 'pharmacist')),
  specialty     TEXT,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT ''
);

INSERT INTO users_new (id, username, salt, password_hash, name, role, specialty, active, created_at)
  SELECT id, username, salt, password_hash, name, role, specialty, 1, ''
  FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

-- Medicines a doctor added arrive with no price; the pharmacy sets one.
ALTER TABLE medicines ADD COLUMN needs_pricing INTEGER NOT NULL DEFAULT 0 CHECK (needs_pricing IN (0, 1));

-- App-level state. Currently only `demo_seeded`; clinic settings will live here.
CREATE TABLE app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A database that already holds the demo doctors was seeded with demo data.
INSERT INTO app_meta (key, value)
  SELECT 'demo_seeded', '1'
  WHERE EXISTS (SELECT 1 FROM users WHERE username IN ('dr.sharma', 'dr.patel'));
