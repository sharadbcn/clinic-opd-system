/**
 * Migration tests. Builds a database at an older schema version, fills it with
 * data, then opens it through the app and checks the newer migrations applied
 * without losing anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

test('an existing 001-era database upgrades to 002 with every row intact', async (t) => {
  const work = await mkdtemp(path.join(tmpdir(), 'opd-migrate-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const file = path.join(work, 'opd.db');

  // --- build a database at migration 001 only, exactly as the old app left it
  {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    db.exec(await readFile(path.join(ROOT, 'src/migrations/001-initial.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run('001-initial.sql', '2026-01-01T00:00:00.000Z');

    db.prepare('INSERT INTO users (username, salt, password_hash, name, role, specialty) VALUES (?,?,?,?,?,?)')
      .run('dr.old', 'abc', 'def', 'Dr. Old Timer', 'doctor', 'General Physician');
    db.prepare('INSERT INTO users (username, salt, password_hash, name, role, specialty) VALUES (?,?,?,?,?,?)')
      .run('pharma.old', 'abc', 'def', 'Old Pharmacist', 'pharmacist', 'Pharmacy');
    db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)')
      .run('legacy-token', 1, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO patients (name, age, gender, phone, created_by, created_at) VALUES (?,?,?,?,?,?)')
      .run('Legacy Patient', 44, 'Female', '90000 00000', 1, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO medicines (name, category, unit_price, stock) VALUES (?,?,?,?)')
      .run('Legacy Tablet', 'Analgesic', 12.5, 40);
    db.prepare(`INSERT INTO prescriptions (patient_id, doctor_id, diagnosis, consultation_fee, status, created_at)
                VALUES (1, 1, 'Legacy diagnosis', 300, 'pending', '2026-01-01T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO prescription_items
                (prescription_id, medicine_id, medicine_name, dosage, frequency, duration_days, quantity)
                VALUES (1, 1, 'Legacy Tablet', '1 tablet', '1-0-1', 5, 10)`).run();
    db.close();
  }

  // --- open it through the app, which must run 002 and ensure an admin exists
  const db = require(path.join(ROOT, 'src/db.js'));
  const conn = db.init(file);
  t.after(() => conn.close());

  const applied = conn.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
  assert.ok(applied.includes('001-initial.sql'));
  assert.ok(applied.some((v) => v.startsWith('002-')), `002 should have applied, got: ${applied.join(', ')}`);

  // --- every pre-existing row survived
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM users').get().n, 3, 'two legacy users + the seeded admin');
  const doctor = conn.prepare("SELECT * FROM users WHERE username = 'dr.old'").get();
  assert.equal(doctor.name, 'Dr. Old Timer');
  assert.equal(doctor.specialty, 'General Physician');
  assert.equal(doctor.salt, 'abc');
  assert.equal(doctor.password_hash, 'def');
  assert.equal(doctor.active, 1, 'existing users default to active');

  assert.equal(conn.prepare("SELECT name FROM patients WHERE id = 1").get().name, 'Legacy Patient');
  assert.equal(conn.prepare("SELECT code FROM patients WHERE id = 1").get().code, 'P-101', 'generated column still works');
  assert.equal(conn.prepare('SELECT COUNT(*) n FROM prescription_items').get().n, 1);
  assert.equal(conn.prepare("SELECT rx_number FROM prescriptions WHERE id = 1").get().rx_number, 'RX-1001');

  // --- foreign keys still wired after the users rebuild
  assert.deepEqual(conn.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling foreign keys');
  const joined = conn.prepare('SELECT u.username FROM sessions s JOIN users u ON u.id = s.user_id').get();
  assert.equal(joined.username, 'dr.old', 'session -> user foreign key survived the rebuild');

  // --- the new columns exist and behave
  assert.equal(conn.prepare("SELECT needs_pricing FROM medicines WHERE id = 1").get().needs_pricing, 0);
  assert.throws(
    () => conn.prepare("INSERT INTO users (username, salt, password_hash, name, role) VALUES ('x','a','b','X','janitor')").run(),
    /constraint/i,
    'the role CHECK must still reject unknown roles'
  );

  // --- an admin exists and the role is now allowed
  const admin = conn.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  assert.ok(admin, 'migrating an old database must create the admin account');
});
