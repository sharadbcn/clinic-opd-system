/**
 * Persistence + domain operations for the OPD system, on SQLite.
 * Call init() once at startup; every other function talks to that
 * connection. All domain logic (prescribe, issue, bill) lives here —
 * the route layer only calls these functions.
 *
 * IDs are exposed to the API as strings, matching what the frontend expects.
 */
const crypto = require('crypto');
const database = require('./database');

let conn = null;
const stmtCache = new Map();

/**
 * The one hardcoded account. Everyone else — doctors and pharmacists — is
 * created by the admin through the UI. Override for a real deployment.
 */
const ADMIN = {
  username: (process.env.OPD_ADMIN_USER || 'admin').toLowerCase(),
  password: process.env.OPD_ADMIN_PASS || 'admin123',
  name: 'Clinic Administrator',
};

const STAFF_ROLES = ['doctor', 'pharmacist'];

/** Open the database (creating the file + schema on first run) and ensure the admin exists. */
function init(file) {
  conn = database.open(file);
  stmtCache.clear();
  ensureAdmin();
  return conn;
}

/**
 * Guarantees the admin account exists, on a brand-new database and on one
 * migrated from an older version — so the clinic can never lock itself out of
 * user management. Existing admins are left alone (password changes stick).
 */
function ensureAdmin() {
  const existing = findUserByUsername(ADMIN.username);
  if (existing) return existing;
  return addUser({ username: ADMIN.username, password: ADMIN.password, name: ADMIN.name, role: 'admin' });
}

/** Prepared-statement cache: same SQL → same compiled statement. */
function q(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = conn.prepare(sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

/** Runs fn inside a transaction; nested calls become savepoints. */
let txDepth = 0;
function transaction(fn) {
  const name = `sp${txDepth}`;
  conn.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    conn.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${name}`);
    return result;
  } catch (err) {
    txDepth -= 1;
    conn.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw err;
  }
}

// ---------------------------------------------------------------- helpers
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

const sid = (n) => (n == null ? null : String(n));
const now = () => new Date().toISOString();

// ---------------------------------------------------------------- row mappers
function toUser(r) {
  return r && {
    id: sid(r.id), username: r.username, salt: r.salt, passwordHash: r.password_hash,
    name: r.name, role: r.role, specialty: r.specialty,
    active: r.active === 1, hidden: r.hidden === 1, createdAt: r.created_at || null,
  };
}
function toPatient(r) {
  return r && {
    id: sid(r.id), code: r.code, name: r.name, age: r.age, gender: r.gender,
    phone: r.phone, createdBy: sid(r.created_by), createdAt: r.created_at,
    hidden: r.hidden === 1,
  };
}
function toMedicine(r) {
  return r && {
    id: sid(r.id), name: r.name, category: r.category,
    unitPrice: r.unit_price, stock: r.stock,
    needsPricing: r.needs_pricing === 1, hidden: r.hidden === 1,
  };
}
function toItem(r) {
  return {
    id: sid(r.id), medicineId: sid(r.medicine_id), medicineName: r.medicine_name,
    dosage: r.dosage, frequency: r.frequency, durationDays: r.duration_days,
    quantity: r.quantity, issuedQuantity: r.issued_quantity,
  };
}
function toPrescription(r, items, tests = []) {
  return r && {
    id: sid(r.id), rxNumber: r.rx_number, patientId: sid(r.patient_id), doctorId: sid(r.doctor_id),
    diagnosis: r.diagnosis, notes: r.notes, consultationFee: r.consultation_fee, items, tests,
    status: r.status, pharmacistId: sid(r.pharmacist_id), billId: sid(r.bill_id),
    hidden: r.hidden === 1, createdAt: r.created_at, issuedAt: r.issued_at,
  };
}
function toBillItem(r) {
  return { medicineId: sid(r.medicine_id), name: r.name, quantity: r.quantity, unitPrice: r.unit_price, amount: r.amount };
}
function toBill(r, items) {
  return r && {
    id: sid(r.id), billNumber: r.bill_number, prescriptionId: sid(r.prescription_id),
    rxNumber: r.rx_number, patientId: sid(r.patient_id), doctorId: sid(r.doctor_id),
    pharmacistId: sid(r.pharmacist_id), items, medicinesTotal: r.medicines_total,
    consultationFee: r.consultation_fee, grandTotal: r.grand_total, createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------- users & sessions
function addUser({ username, password, name, role, specialty }) {
  const salt = crypto.randomBytes(8).toString('hex');
  const { lastInsertRowid } = q(`
    INSERT INTO users (username, salt, password_hash, name, role, specialty, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(username.toLowerCase(), salt, hashPassword(password, salt), name, role, specialty || null, now());
  return getUser(lastInsertRowid);
}

/**
 * Admin-facing staff creation, with the validation the seed path doesn't need.
 * Only doctors and pharmacists can be created — never another admin.
 */
function addStaff({ username, password, name, role, specialty }) {
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const pass = String(password || '');
  if (!/^[a-z0-9._-]{3,}$/.test(cleanUsername)) {
    throw httpError(400, 'Username must be at least 3 characters: letters, numbers, dot, dash or underscore.');
  }
  if (!cleanName) throw httpError(400, 'Full name is required.');
  if (pass.length < 6) throw httpError(400, 'Password must be at least 6 characters.');
  if (!STAFF_ROLES.includes(role)) {
    throw httpError(400, `Role must be ${STAFF_ROLES.join(' or ')}.`);
  }
  if (findUserByUsername(cleanUsername)) {
    throw httpError(409, `The username "${cleanUsername}" is already taken.`);
  }
  return addUser({ username: cleanUsername, password: pass, name: cleanName, role, specialty });
}

/** Correct details, activate/deactivate, restore a removed account, or reset a password. */
function updateStaff(id, { active, password, hidden, name, specialty }, { actingUserId } = {}) {
  const user = getUser(id);
  if (!user) throw httpError(404, 'User not found.');
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) throw httpError(400, 'Full name is required.');
    q('UPDATE users SET name = ? WHERE id = ?').run(cleanName, Number(user.id));
  }
  if (specialty !== undefined) {
    // Blank clears it. A doctor with no specialty simply prints nothing under
    // their name on the prescription.
    q('UPDATE users SET specialty = ? WHERE id = ?')
      .run(String(specialty).trim() || null, Number(user.id));
  }
  if (hidden !== undefined) {
    if (user.role === 'admin') throw httpError(400, 'The admin account cannot be removed.');
    q('UPDATE users SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, Number(user.id));
    if (hidden) q('DELETE FROM sessions WHERE user_id = ?').run(Number(user.id));
  }
  if (active !== undefined) {
    if (String(user.id) === String(actingUserId)) {
      throw httpError(400, 'You cannot deactivate your own account.');
    }
    if (user.role === 'admin') throw httpError(400, 'The admin account cannot be deactivated.');
    q('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(user.id));
    // Drop their live sessions immediately when switching off.
    if (!active) q('DELETE FROM sessions WHERE user_id = ?').run(Number(user.id));
  }
  if (password !== undefined) {
    const pass = String(password);
    if (pass.length < 6) throw httpError(400, 'Password must be at least 6 characters.');
    const salt = crypto.randomBytes(8).toString('hex');
    q('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?')
      .run(salt, hashPassword(pass, salt), Number(user.id));
    // Force a fresh sign-in with the new password.
    q('DELETE FROM sessions WHERE user_id = ?').run(Number(user.id));
  }
  return getUser(user.id);
}

/** Doctors and pharmacists, newest first. The admin is not listed as staff. */
function listStaff({ hidden = false } = {}) {
  return q("SELECT * FROM users WHERE role != 'admin' AND hidden = ? ORDER BY id DESC")
    .all(hidden ? 1 : 0).map(toUser);
}

/**
 * "Removing" a staff member hides them: their prescriptions and bills must
 * keep working, so the row is never deleted. Hiding also deactivates them and
 * ends their sessions, so removed really means removed.
 */
function hideStaff(id, { actingUserId } = {}) {
  const user = getUser(id);
  if (!user) throw httpError(404, 'User not found.');
  if (String(user.id) === String(actingUserId)) throw httpError(400, 'You cannot remove your own account.');
  if (user.role === 'admin') throw httpError(400, 'The admin account cannot be removed.');
  q('UPDATE users SET hidden = 1, active = 0 WHERE id = ?').run(Number(user.id));
  q('DELETE FROM sessions WHERE user_id = ?').run(Number(user.id));
  return getUser(user.id);
}

/** Counts only — the admin has no access to patient or clinical detail. */
function clinicStats() {
  const one = (sql, ...p) => q(sql).get(...p).n;
  return {
    doctors: one("SELECT COUNT(*) n FROM users WHERE role = 'doctor' AND active = 1"),
    pharmacists: one("SELECT COUNT(*) n FROM users WHERE role = 'pharmacist' AND active = 1"),
    inactiveStaff: one("SELECT COUNT(*) n FROM users WHERE role != 'admin' AND active = 0"),
    patients: one('SELECT COUNT(*) n FROM patients WHERE hidden = 0'),
    prescriptions: one('SELECT COUNT(*) n FROM prescriptions WHERE hidden = 0'),
    pending: one("SELECT COUNT(*) n FROM prescriptions WHERE status = 'pending' AND hidden = 0"),
    bills: one('SELECT COUNT(*) n FROM bills'),
    medicines: one('SELECT COUNT(*) n FROM medicines'),
    outOfStock: one('SELECT COUNT(*) n FROM medicines WHERE stock <= 0'),
    needsPricing: one('SELECT COUNT(*) n FROM medicines WHERE needs_pricing = 1'),
    revenue: round2(q('SELECT COALESCE(SUM(grand_total), 0) n FROM bills').get().n),
  };
}

function getUser(id) {
  return toUser(q('SELECT * FROM users WHERE id = ?').get(Number(id)));
}

function findUserByUsername(username) {
  const uname = String(username || '').trim().toLowerCase();
  return toUser(q('SELECT * FROM users WHERE username = ?').get(uname));
}

function verifyPassword(user, password) {
  return hashPassword(String(password || ''), user.salt) === user.passwordHash;
}

/** Everything safe to send to a client — never the salt or password hash. */
function publicUser(user) {
  if (!user) return null;
  const { id, username, name, role, specialty, active, hidden, createdAt } = user;
  return { id, username, name, role, specialty, active, hidden, createdAt };
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  q('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, Number(userId), now());
  return token;
}

/** Resolves a token to its user. Deactivated staff resolve to null, so
 *  switching an account off drops its live sessions on the next request. */
function getSessionUser(token) {
  return toUser(
    q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND u.active = 1 AND u.hidden = 0`).get(String(token))
  );
}

function destroySession(token) {
  q('DELETE FROM sessions WHERE token = ?').run(String(token));
}

// ---------------------------------------------------------------- patients
function addPatient({ name, age, gender, phone, createdBy }) {
  const cleanName = String(name || '').trim();
  const numAge = Number(age);
  if (!cleanName) throw httpError(400, 'Patient name is required.');
  if (!Number.isFinite(numAge) || numAge < 0 || numAge > 120) {
    throw httpError(400, 'Age must be a number between 0 and 120.');
  }
  if (!['Male', 'Female', 'Other'].includes(gender)) {
    throw httpError(400, 'Gender must be Male, Female or Other.');
  }
  const { lastInsertRowid } = q(
    'INSERT INTO patients (name, age, gender, phone, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(cleanName, numAge, gender, String(phone || '').trim() || null, createdBy ? Number(createdBy) : null, now());
  return getPatient(lastInsertRowid);
}

function getPatient(id) {
  const p = toPatient(q('SELECT * FROM patients WHERE id = ?').get(Number(id)));
  if (!p) throw httpError(404, 'Patient not found.');
  return p;
}

function listPatients({ hidden = false } = {}) {
  return q('SELECT * FROM patients WHERE hidden = ?').all(hidden ? 1 : 0).map(toPatient);
}

/**
 * "Removing" a patient hides them from the registry. Their prescriptions and
 * bills reference them, so the row stays and those records still resolve.
 */
function setPatientHidden(id, hidden) {
  const patient = getPatient(id);
  q('UPDATE patients SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, Number(patient.id));
  return getPatient(patient.id);
}

// ---------------------------------------------------------------- medicines
/** Includes hidden medicines: the unique index covers them, so a name clash
 *  must be reported rather than hitting a raw constraint error. */
function findMedicineByName(name, excludeId = null) {
  return toMedicine(
    q('SELECT * FROM medicines WHERE name = ? COLLATE NOCASE AND id IS NOT ?').get(name, excludeId)
  );
}

/** True when a form field was actually filled in, rather than left blank. */
function stated(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Adds a medicine to the inventory.
 * `byDoctor` is the doctor-initiated path: a doctor can put a medicine the
 * pharmacy doesn't carry into the catalogue so they can prescribe it. Price and
 * opening stock are optional there — anything left blank starts at zero, and a
 * medicine with no price is flagged for the pharmacy to price. A pharmacist
 * must state both, as before.
 */
function addMedicine({ name, category, unitPrice, stock, byDoctor = false }) {
  const cleanName = String(name || '').trim();
  const hasPrice = stated(unitPrice);
  const hasStock = stated(stock);
  const price = hasPrice || !byDoctor ? Number(unitPrice) : 0;
  const qty = hasStock || !byDoctor ? Number(stock) : 0;
  if (!cleanName) throw httpError(400, 'Medicine name is required.');
  if (!Number.isFinite(price) || price < 0) throw httpError(400, 'Unit price must be 0 or more.');
  if (!Number.isInteger(qty) || qty < 0) throw httpError(400, 'Stock must be a whole number, 0 or more.');
  const duplicate = findMedicineByName(cleanName);
  if (duplicate) throw httpError(409, `"${duplicate.name}" already exists in the inventory.`);
  const { lastInsertRowid } = q(
    'INSERT INTO medicines (name, category, unit_price, stock, needs_pricing) VALUES (?, ?, ?, ?, ?)'
  ).run(cleanName, String(category || '').trim() || 'General', round2(price), qty,
    byDoctor && !hasPrice ? 1 : 0);
  return getMedicine(lastInsertRowid);
}

function getMedicine(id) {
  const m = toMedicine(q('SELECT * FROM medicines WHERE id = ?').get(Number(id)));
  if (!m) throw httpError(404, 'Medicine not found.');
  return m;
}

function listMedicines({ hidden = false } = {}) {
  return q('SELECT * FROM medicines WHERE hidden = ?').all(hidden ? 1 : 0).map(toMedicine);
}

/**
 * "Removing" a medicine hides it from the catalogue. Prescriptions and bills
 * reference it, and a pending prescription containing it must still be
 * dispensable, so the row stays.
 */
function hideMedicine(id) {
  const med = getMedicine(id);
  q('UPDATE medicines SET hidden = 1 WHERE id = ?').run(Number(med.id));
  return getMedicine(med.id);
}

function updateMedicine(id, { addStock, unitPrice, name, category, hidden }) {
  const med = getMedicine(id);
  const next = { ...med };
  if (hidden !== undefined) next.hidden = !!hidden;
  if (addStock !== undefined) {
    const extra = Number(addStock);
    if (!Number.isInteger(extra) || extra <= 0) {
      throw httpError(400, 'Restock quantity must be a whole number greater than 0.');
    }
    next.stock += extra;
  }
  if (unitPrice !== undefined) {
    const price = Number(unitPrice);
    if (!Number.isFinite(price) || price < 0) throw httpError(400, 'Unit price must be 0 or more.');
    next.unitPrice = round2(price);
    next.needsPricing = false; // the pharmacy has now priced it
  }
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) throw httpError(400, 'Medicine name cannot be empty.');
    const duplicate = findMedicineByName(cleanName, Number(med.id));
    if (duplicate) throw httpError(409, `"${duplicate.name}" already exists in the inventory.`);
    next.name = cleanName;
  }
  if (category !== undefined) {
    next.category = String(category).trim() || 'General';
  }
  q(`UPDATE medicines SET name = ?, category = ?, unit_price = ?, stock = ?, needs_pricing = ?, hidden = ?
     WHERE id = ?`)
    .run(next.name, next.category, next.unitPrice, next.stock,
      next.needsPricing ? 1 : 0, next.hidden ? 1 : 0, Number(med.id));
  return getMedicine(med.id);
}

// ---------------------------------------------------------------- lab tests
/**
 * The catalogue of tests a doctor can order. Tests are not billed and no
 * results are recorded — the catalogue exists so tests are named consistently
 * and print correctly on the prescription.
 */
const MAX_TESTS_PER_RX = 20;

function toLabTest(r) {
  return r && { id: sid(r.id), name: r.name, category: r.category, hidden: r.hidden === 1 };
}

function listLabTests({ hidden = false } = {}) {
  return q('SELECT * FROM lab_tests WHERE hidden = ? ORDER BY category, name')
    .all(hidden ? 1 : 0).map(toLabTest);
}

function getLabTest(id) {
  const t = toLabTest(q('SELECT * FROM lab_tests WHERE id = ?').get(Number(id)));
  if (!t) throw httpError(404, 'Lab test not found.');
  return t;
}

function addLabTest({ name, category }) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw httpError(400, 'Test name is required.');
  if (cleanName.length > 120) throw httpError(400, 'Test name must be 120 characters or fewer.');
  const duplicate = q('SELECT * FROM lab_tests WHERE name = ? COLLATE NOCASE').get(cleanName);
  if (duplicate) throw httpError(409, `"${duplicate.name}" is already in the test catalogue.`);
  const { lastInsertRowid } = q('INSERT INTO lab_tests (name, category) VALUES (?, ?)')
    .run(cleanName, String(category || '').trim() || 'General');
  return getLabTest(lastInsertRowid);
}

function updateLabTest(id, { name, category, hidden }) {
  const test = getLabTest(id);
  const next = { ...test };
  if (name !== undefined) {
    const cleanName = String(name).trim();
    if (!cleanName) throw httpError(400, 'Test name cannot be empty.');
    const duplicate = q('SELECT * FROM lab_tests WHERE name = ? COLLATE NOCASE AND id IS NOT ?')
      .get(cleanName, Number(test.id));
    if (duplicate) throw httpError(409, `"${duplicate.name}" is already in the test catalogue.`);
    next.name = cleanName;
  }
  if (category !== undefined) next.category = String(category).trim() || 'General';
  if (hidden !== undefined) next.hidden = !!hidden;
  q('UPDATE lab_tests SET name = ?, category = ?, hidden = ? WHERE id = ?')
    .run(next.name, next.category, next.hidden ? 1 : 0, Number(test.id));
  return getLabTest(test.id);
}

/** Removing a test hides it — prescriptions snapshot the name, so history is safe. */
function hideLabTest(id) {
  return updateLabTest(id, { hidden: true });
}

/** Validates the tests ordered on a prescription. Free text is allowed. */
function cleanTests(tests) {
  if (tests === undefined || tests === null) return [];
  if (!Array.isArray(tests)) throw httpError(400, 'Tests must be a list.');
  const cleaned = [...new Set(
    tests.map((t) => String(typeof t === 'object' && t ? t.name : t).replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  )];
  for (const name of cleaned) {
    if (name.length > 120) throw httpError(400, 'A test name must be 120 characters or fewer.');
  }
  if (cleaned.length > MAX_TESTS_PER_RX) {
    throw httpError(400, `A prescription can order at most ${MAX_TESTS_PER_RX} tests.`);
  }
  return cleaned;
}

function testsFor(prescriptionId) {
  return q('SELECT name FROM prescription_tests WHERE prescription_id = ? ORDER BY id')
    .all(Number(prescriptionId)).map((r) => r.name);
}

// ---------------------------------------------------------------- prescriptions
/**
 * Validates the editable body of a prescription. Shared by create and update
 * so an edit is held to exactly the same rules as a new prescription, and so
 * nothing is written until every line has passed.
 */
function validatePrescriptionBody({ diagnosis, notes, consultationFee, items, tests }) {
  const cleanDiagnosis = String(diagnosis || '').trim();
  if (!cleanDiagnosis) throw httpError(400, 'Diagnosis is required.');
  const fee = Number(consultationFee);
  if (!Number.isFinite(fee) || fee < 0) throw httpError(400, 'Consultation fee must be 0 or more.');
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Add at least one medicine to the prescription.');
  }

  const rxItems = items.map((raw) => {
    const med = getMedicine(raw.medicineId);
    const quantity = Number(raw.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw httpError(400, `Quantity for ${med.name} must be a whole number greater than 0.`);
    }
    return {
      medicineId: Number(med.id),
      medicineName: med.name, // snapshot so history survives renames
      dosage: String(raw.dosage || '').trim() || '1 unit',
      frequency: String(raw.frequency || '').trim() || 'As directed',
      durationDays: Math.max(1, Number(raw.durationDays) || 1),
      quantity,
    };
  });

  return {
    diagnosis: cleanDiagnosis,
    notes: String(notes || '').trim() || null,
    fee: round2(fee),
    items: rxItems,
    tests: cleanTests(tests),
  };
}

/** Writes the items and tests of a prescription, replacing whatever is there. */
function writePrescriptionLines(rxId, { items, tests }) {
  q('DELETE FROM prescription_items WHERE prescription_id = ?').run(Number(rxId));
  q('DELETE FROM prescription_tests WHERE prescription_id = ?').run(Number(rxId));

  const insertItem = q(`
    INSERT INTO prescription_items
      (prescription_id, medicine_id, medicine_name, dosage, frequency, duration_days, quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const it of items) {
    insertItem.run(Number(rxId), it.medicineId, it.medicineName, it.dosage, it.frequency, it.durationDays, it.quantity);
  }
  const insertTest = q('INSERT INTO prescription_tests (prescription_id, name) VALUES (?, ?)');
  for (const name of tests) insertTest.run(Number(rxId), name);
}

function createPrescription({ patientId, doctorId, diagnosis, notes, consultationFee, items, tests }) {
  return transaction(() => {
    const patient = getPatient(patientId);
    const doctor = getUser(doctorId);
    if (!doctor || doctor.role !== 'doctor') throw httpError(400, 'Invalid doctor.');
    const body = validatePrescriptionBody({ diagnosis, notes, consultationFee, items, tests });

    const { lastInsertRowid: rxId } = q(`
      INSERT INTO prescriptions (patient_id, doctor_id, diagnosis, notes, consultation_fee, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(Number(patient.id), Number(doctor.id), body.diagnosis, body.notes, body.fee, now());

    writePrescriptionLines(rxId, body);
    return getPrescription(rxId);
  });
}

/**
 * "Removing" a prescription hides it from every list, including the pharmacy
 * queue — so removing a pending one withdraws it. Any bill it already produced
 * is a financial record and is left untouched. Only the prescriber may do it.
 */
function setPrescriptionHidden({ prescriptionId, doctorId, hidden }) {
  const rx = getPrescription(prescriptionId);
  if (String(rx.doctorId) !== String(doctorId)) {
    throw httpError(403, 'This prescription belongs to another doctor.');
  }
  q('UPDATE prescriptions SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, Number(rx.id));
  return getPrescription(rx.id);
}

/**
 * Edits a prescription that is still waiting at the pharmacy.
 * Only the prescribing doctor may edit, and only before it is issued: once
 * dispensed a bill exists and stock has moved, so an edit would contradict a
 * bill already handed to the patient. The patient and Rx number never change.
 */
function updatePrescription({ prescriptionId, doctorId, diagnosis, notes, consultationFee, items, tests }) {
  return transaction(() => {
    const rx = getPrescription(prescriptionId);
    if (String(rx.doctorId) !== String(doctorId)) {
      throw httpError(403, 'This prescription belongs to another doctor.');
    }
    if (rx.status !== 'pending') {
      throw httpError(409, `${rx.rxNumber} has already been issued and can no longer be edited.`);
    }
    const body = validatePrescriptionBody({ diagnosis, notes, consultationFee, items, tests });

    q('UPDATE prescriptions SET diagnosis = ?, notes = ?, consultation_fee = ? WHERE id = ?')
      .run(body.diagnosis, body.notes, body.fee, Number(rx.id));
    writePrescriptionLines(rx.id, body);
    return getPrescription(rx.id);
  });
}

function itemsFor(prescriptionId) {
  return q('SELECT * FROM prescription_items WHERE prescription_id = ? ORDER BY id').all(Number(prescriptionId)).map(toItem);
}

function getPrescription(id) {
  const row = q('SELECT * FROM prescriptions WHERE id = ?').get(Number(id));
  if (!row) throw httpError(404, 'Prescription not found.');
  return toPrescription(row, itemsFor(row.id), testsFor(row.id));
}

/** All prescriptions, optionally filtered; items loaded in one extra query. */
function listPrescriptions({ doctorId, patientId, status, hidden = false } = {}) {
  const where = ['hidden = ?'];
  const params = [hidden ? 1 : 0];
  if (doctorId != null) { where.push('doctor_id = ?'); params.push(Number(doctorId)); }
  if (patientId != null) { where.push('patient_id = ?'); params.push(Number(patientId)); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = 'SELECT * FROM prescriptions WHERE ' + where.join(' AND ');
  const rows = q(sql).all(...params);
  if (rows.length === 0) return [];

  const byRx = new Map(rows.map((r) => [r.id, []]));
  const testsByRx = new Map(rows.map((r) => [r.id, []]));
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  for (const r of conn.prepare(
    `SELECT * FROM prescription_items WHERE prescription_id IN (${placeholders}) ORDER BY id`
  ).all(...ids)) {
    byRx.get(r.prescription_id).push(toItem(r));
  }
  for (const r of conn.prepare(
    `SELECT * FROM prescription_tests WHERE prescription_id IN (${placeholders}) ORDER BY id`
  ).all(...ids)) {
    testsByRx.get(r.prescription_id).push(r.name);
  }
  return rows.map((r) => toPrescription(r, byRx.get(r.id), testsByRx.get(r.id)));
}

function prescriptionsForPatient(patientId) {
  return listPrescriptions({ patientId }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Dispenses medicines against a pending prescription and bills for them.
 * The pharmacy does this for any prescription; a doctor may do it for their
 * own, for a clinic that dispenses at the consulting room. Either way the bill
 * records who handed the medicines over.
 *
 * issuedItems: [{ itemId, quantity }] — quantity may be lower than requested
 * (e.g. limited stock) but never higher, and never more than current stock.
 * Decrements stock, creates the bill, and marks the prescription issued —
 * all in one transaction, so a failure part-way leaves nothing changed.
 */
function issuePrescription({ prescriptionId, issuedBy, issuedItems }) {
  return transaction(() => {
    const rx = getPrescription(prescriptionId);
    if (rx.status !== 'pending') {
      throw httpError(409, `${rx.rxNumber} has already been issued.`);
    }
    const issuer = getUser(issuedBy);
    if (!issuer || !['pharmacist', 'doctor'].includes(issuer.role)) {
      throw httpError(403, 'Only pharmacists and doctors can dispense medicines.');
    }
    if (issuer.role === 'doctor' && String(rx.doctorId) !== String(issuer.id)) {
      throw httpError(403, 'This prescription belongs to another doctor.');
    }

    const requested = new Map((issuedItems || []).map((it) => [String(it.itemId), Number(it.quantity)]));

    // Validate everything before touching stock.
    const plan = rx.items.map((item) => {
      const qty = requested.has(item.id) ? requested.get(item.id) : item.quantity;
      if (!Number.isInteger(qty) || qty < 0) {
        throw httpError(400, `Issue quantity for ${item.medicineName} must be 0 or a positive whole number.`);
      }
      if (qty > item.quantity) {
        throw httpError(400, `Cannot issue more than the prescribed ${item.quantity} of ${item.medicineName}.`);
      }
      const med = getMedicine(item.medicineId);
      if (qty > med.stock) {
        throw httpError(400, `Not enough stock for ${med.name} — requested ${qty}, only ${med.stock} available.`);
      }
      return { item, med, qty };
    });

    const totalUnits = plan.reduce((sum, p) => sum + p.qty, 0);
    if (totalUnits === 0) {
      const empty = plan.filter((p) => p.med.stock <= 0).map((p) => p.med.name);
      throw httpError(400, empty.length
        ? `Nothing to issue — restock ${empty.join(', ')} first. ${rx.rxNumber} stays in the queue until then.`
        : 'Issue at least one unit of one medicine, or the bill would be empty.');
    }

    // Apply: decrement stock, record issued quantities, build bill lines.
    const billLines = [];
    for (const { item, med, qty } of plan) {
      q('UPDATE prescription_items SET issued_quantity = ? WHERE id = ?').run(qty, Number(item.id));
      if (qty > 0) {
        q('UPDATE medicines SET stock = stock - ? WHERE id = ?').run(qty, Number(med.id));
        billLines.push({
          medicineId: Number(med.id), name: med.name, quantity: qty,
          unitPrice: med.unitPrice, amount: round2(qty * med.unitPrice),
        });
      }
    }

    const medicinesTotal = round2(billLines.reduce((sum, line) => sum + line.amount, 0));
    const grandTotal = round2(medicinesTotal + rx.consultationFee);
    const issuedAt = now();

    const { lastInsertRowid: billId } = q(`
      INSERT INTO bills
        (prescription_id, patient_id, doctor_id, pharmacist_id, medicines_total, consultation_fee, grand_total, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(Number(rx.id), Number(rx.patientId), Number(rx.doctorId), Number(issuer.id),
      medicinesTotal, rx.consultationFee, grandTotal, issuedAt);

    const insertLine = q(
      'INSERT INTO bill_items (bill_id, medicine_id, name, quantity, unit_price, amount) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const line of billLines) {
      insertLine.run(billId, line.medicineId, line.name, line.quantity, line.unitPrice, line.amount);
    }

    q(`UPDATE prescriptions SET status = 'issued', pharmacist_id = ?, bill_id = ?, issued_at = ? WHERE id = ?`)
      .run(Number(issuer.id), billId, issuedAt, Number(rx.id));

    return { prescription: getPrescription(rx.id), bill: getBill(billId) };
  });
}

// ---------------------------------------------------------------- bills
const BILL_SELECT = `
  SELECT b.*, p.rx_number FROM bills b JOIN prescriptions p ON p.id = b.prescription_id
`;

function billLinesFor(billId) {
  return q('SELECT * FROM bill_items WHERE bill_id = ? ORDER BY id').all(Number(billId)).map(toBillItem);
}

function getBill(id) {
  const row = q(`${BILL_SELECT} WHERE b.id = ?`).get(Number(id));
  if (!row) throw httpError(404, 'Bill not found.');
  return toBill(row, billLinesFor(row.id));
}

function listBills({ doctorId } = {}) {
  const rows = doctorId != null
    ? q(`${BILL_SELECT} WHERE b.doctor_id = ?`).all(Number(doctorId))
    : q(BILL_SELECT).all();
  return rows.map((r) => toBill(r, billLinesFor(r.id)));
}

// ---------------------------------------------------------------- enrichment (API views)
function patientSummary(patient) {
  const r = q(
    'SELECT COUNT(*) AS visit_count, MAX(created_at) AS last_visit FROM prescriptions WHERE patient_id = ? AND hidden = 0'
  ).get(Number(patient.id));
  return { ...patient, visitCount: r.visit_count, lastVisitAt: r.last_visit || null };
}

function prescriptionSummary(rx) {
  const patient = toPatient(q('SELECT * FROM patients WHERE id = ?').get(Number(rx.patientId)));
  const doctor = getUser(rx.doctorId);
  const bill = rx.billId ? toBill(q(`${BILL_SELECT} WHERE b.id = ?`).get(Number(rx.billId)), []) : null;
  return {
    id: rx.id,
    rxNumber: rx.rxNumber,
    patientId: rx.patientId,
    patientName: patient ? patient.name : 'Unknown',
    patientCode: patient ? patient.code : '',
    doctorId: rx.doctorId,
    doctorName: doctor ? doctor.name : 'Unknown',
    diagnosis: rx.diagnosis,
    status: rx.status,
    itemCount: rx.items.length,
    testCount: rx.tests.length,
    hidden: rx.hidden,
    createdAt: rx.createdAt,
    issuedAt: rx.issuedAt,
    billTotal: bill ? bill.grandTotal : null,
    billNumber: bill ? bill.billNumber : null,
  };
}

function prescriptionDetail(rx) {
  const patient = toPatient(q('SELECT * FROM patients WHERE id = ?').get(Number(rx.patientId)));
  const doctor = getUser(rx.doctorId);
  const pharmacist = rx.pharmacistId ? getUser(rx.pharmacistId) : null;
  const bill = rx.billId ? getBill(rx.billId) : null;
  return {
    ...rx,
    patient,
    doctor: publicUser(doctor),
    pharmacist: publicUser(pharmacist),
    items: rx.items.map((item) => {
      const med = toMedicine(q('SELECT * FROM medicines WHERE id = ?').get(Number(item.medicineId)));
      return {
        ...item,
        currentStock: med ? med.stock : 0,
        currentPrice: med ? med.unitPrice : 0,
      };
    }),
    bill: bill ? billDetail(bill) : null,
  };
}

function billSummary(bill) {
  const patient = toPatient(q('SELECT * FROM patients WHERE id = ?').get(Number(bill.patientId)));
  const doctor = getUser(bill.doctorId);
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    rxNumber: bill.rxNumber,
    prescriptionId: bill.prescriptionId,
    patientName: patient ? patient.name : 'Unknown',
    doctorName: doctor ? doctor.name : 'Unknown',
    grandTotal: bill.grandTotal,
    createdAt: bill.createdAt,
  };
}

function billDetail(bill) {
  const patient = toPatient(q('SELECT * FROM patients WHERE id = ?').get(Number(bill.patientId)));
  const doctor = getUser(bill.doctorId);
  const pharmacist = getUser(bill.pharmacistId);
  return {
    ...bill,
    patient,
    doctorName: doctor ? doctor.name : 'Unknown',
    doctorSpecialty: doctor ? doctor.specialty : null,
    pharmacistName: pharmacist ? pharmacist.name : 'Unknown',
  };
}

// ---------------------------------------------------------------- seed
function daysAgo(days, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 15, 0, 0);
  return d.toISOString();
}

/** Nothing but the admin — i.e. no clinical staff has been created yet. */
function isEmpty() {
  return q("SELECT COUNT(*) AS n FROM users WHERE role != 'admin'").get().n === 0;
}

function getMeta(key) {
  const r = q('SELECT value FROM app_meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  q('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** True when this database was loaded with the demo clinic. */
function isDemo() {
  return getMeta('demo_seeded') === '1';
}

/** Backdate a seeded visit so the demo history looks lived-in. */
function backdateVisit(rx, createdAt, issuedAt) {
  q('UPDATE prescriptions SET created_at = ?, issued_at = ? WHERE id = ?').run(createdAt, issuedAt, Number(rx.id));
  if (issuedAt) q('UPDATE bills SET created_at = ? WHERE prescription_id = ?').run(issuedAt, Number(rx.id));
}

/**
 * Loads the demo clinic on a brand-new database. Returns true if it seeded.
 * `OPD_SEED=clean` skips it, leaving only the admin — the real deployment
 * posture, where the admin creates every doctor and pharmacist.
 */
function seedIfEmpty() {
  if (process.env.OPD_SEED === 'clean') return false;
  if (!isEmpty()) return false;
  transaction(() => {
    seed();
    setMeta('demo_seeded', '1');
  });
  return true;
}

function seed() {
  // --- staff
  const drSharma = addUser({
    username: 'dr.sharma', password: 'doctor123',
    name: 'Dr. Meera Sharma', role: 'doctor', specialty: 'General Physician',
  });
  const drPatel = addUser({
    username: 'dr.patel', password: 'doctor123',
    name: 'Dr. Arjun Patel', role: 'doctor', specialty: 'Internal Medicine',
  });
  const pharmacist = addUser({
    username: 'pharma', password: 'pharma123',
    name: 'Ravi Kulkarni', role: 'pharmacist', specialty: 'Pharmacy',
  });

  // --- inventory
  const med = {};
  med.paracetamol = addMedicine({ name: 'Paracetamol 500mg Tablet', category: 'Analgesic', unitPrice: 2.5, stock: 240 });
  med.paraSyrup = addMedicine({ name: 'Paracetamol Syrup 125mg/5ml', category: 'Analgesic', unitPrice: 42, stock: 30 });
  med.amoxicillin = addMedicine({ name: 'Amoxicillin 500mg Capsule', category: 'Antibiotic', unitPrice: 9, stock: 150 });
  med.azithromycin = addMedicine({ name: 'Azithromycin 500mg Tablet', category: 'Antibiotic', unitPrice: 22, stock: 14 });
  med.cetirizine = addMedicine({ name: 'Cetirizine 10mg Tablet', category: 'Antihistamine', unitPrice: 3, stock: 180 });
  med.omeprazole = addMedicine({ name: 'Omeprazole 20mg Capsule', category: 'Antacid', unitPrice: 5.5, stock: 120 });
  med.pantoprazole = addMedicine({ name: 'Pantoprazole 40mg Tablet', category: 'Antacid', unitPrice: 8, stock: 90 });
  med.metformin = addMedicine({ name: 'Metformin 500mg Tablet', category: 'Antidiabetic', unitPrice: 4, stock: 200 });
  med.amlodipine = addMedicine({ name: 'Amlodipine 5mg Tablet', category: 'Antihypertensive', unitPrice: 6, stock: 160 });
  med.ibuprofen = addMedicine({ name: 'Ibuprofen 400mg Tablet', category: 'Analgesic', unitPrice: 4.5, stock: 7 });
  med.ors = addMedicine({ name: 'ORS Sachet 21g', category: 'Rehydration', unitPrice: 18, stock: 60 });
  med.coughSyrup = addMedicine({ name: 'Dextromethorphan Cough Syrup 100ml', category: 'Cough & Cold', unitPrice: 95, stock: 25 });
  med.vitaminD = addMedicine({ name: 'Vitamin D3 60K Capsule', category: 'Supplement', unitPrice: 35, stock: 80 });

  // --- patients
  const ramesh = addPatient({ name: 'Ramesh Gupta', age: 52, gender: 'Male', phone: '98200 11223', createdBy: drSharma.id });
  const sunita = addPatient({ name: 'Sunita Devi', age: 45, gender: 'Female', phone: '99870 44556', createdBy: drPatel.id });
  const aarav = addPatient({ name: 'Aarav Mehta', age: 9, gender: 'Male', phone: '98111 77889', createdBy: drPatel.id });
  const fatima = addPatient({ name: 'Fatima Khan', age: 31, gender: 'Female', phone: '97654 32109', createdBy: drPatel.id });
  const joseph = addPatient({ name: 'Joseph Varghese', age: 67, gender: 'Male', phone: '94477 88990', createdBy: drSharma.id });
  const setCreated = q('UPDATE patients SET created_at = ? WHERE id = ?');
  setCreated.run(daysAgo(30), Number(ramesh.id));
  setCreated.run(daysAgo(21), Number(sunita.id));
  setCreated.run(daysAgo(12), Number(aarav.id));
  setCreated.run(daysAgo(1), Number(fatima.id));
  setCreated.run(daysAgo(0, 9), Number(joseph.id));

  const issueAll = (rx) => issuePrescription({
    prescriptionId: rx.id, issuedBy: pharmacist.id,
    issuedItems: rx.items.map((it) => ({ itemId: it.id, quantity: it.quantity })),
  });

  // --- history: issued visits (prescription -> issue -> bill), backdated
  const visit1 = createPrescription({
    patientId: ramesh.id, doctorId: drSharma.id,
    diagnosis: 'Type 2 diabetes with mild hypertension — routine review',
    notes: 'Continue diet control. Review after 30 days with fasting sugar report.',
    consultationFee: 500,
    items: [
      { medicineId: med.metformin.id, dosage: '1 tablet', frequency: '1-0-1 (morning & night)', durationDays: 30, quantity: 60 },
      { medicineId: med.amlodipine.id, dosage: '1 tablet', frequency: '1-0-0 (morning)', durationDays: 30, quantity: 30 },
    ],
  });
  issueAll(visit1);
  backdateVisit(visit1, daysAgo(10), daysAgo(10, 12));

  const visit2 = createPrescription({
    patientId: sunita.id, doctorId: drPatel.id,
    diagnosis: 'Gastritis with acid reflux',
    notes: 'Avoid spicy food and late dinners. Plenty of water.',
    consultationFee: 400,
    items: [
      { medicineId: med.pantoprazole.id, dosage: '1 tablet', frequency: '1-0-0 (before breakfast)', durationDays: 14, quantity: 14 },
    ],
  });
  issueAll(visit2);
  backdateVisit(visit2, daysAgo(6), daysAgo(6, 13));

  const visit3 = createPrescription({
    patientId: aarav.id, doctorId: drPatel.id,
    diagnosis: 'Acute tonsillitis with fever',
    notes: 'Warm salt-water gargles. Return immediately if fever crosses 102°F.',
    consultationFee: 400,
    items: [
      { medicineId: med.amoxicillin.id, dosage: '1 capsule', frequency: '1-0-1 (morning & night)', durationDays: 5, quantity: 10 },
      { medicineId: med.paraSyrup.id, dosage: '5 ml', frequency: 'SOS (if fever > 100°F)', durationDays: 5, quantity: 1 },
    ],
  });
  issueAll(visit3);
  backdateVisit(visit3, daysAgo(3), daysAgo(3, 11));

  // --- today: pending prescriptions waiting at the pharmacy
  const pending1 = createPrescription({
    patientId: ramesh.id, doctorId: drSharma.id,
    diagnosis: 'Viral fever with body ache',
    notes: 'Rest for 2 days. Hydrate well.',
    consultationFee: 500,
    items: [
      { medicineId: med.paracetamol.id, dosage: '1 tablet', frequency: '1-1-1 (thrice daily)', durationDays: 3, quantity: 9 },
      { medicineId: med.cetirizine.id, dosage: '1 tablet', frequency: '0-0-1 (night)', durationDays: 3, quantity: 3 },
    ],
  });
  backdateVisit(pending1, daysAgo(0, 9), null);

  const pending2 = createPrescription({
    patientId: fatima.id, doctorId: drPatel.id,
    diagnosis: 'Upper respiratory tract infection',
    notes: 'Steam inhalation twice daily.',
    consultationFee: 400,
    items: [
      { medicineId: med.azithromycin.id, dosage: '1 tablet', frequency: '1-0-0 (morning)', durationDays: 3, quantity: 3 },
      { medicineId: med.coughSyrup.id, dosage: '10 ml', frequency: '1-0-1 (morning & night)', durationDays: 5, quantity: 1 },
      { medicineId: med.ors.id, dosage: '1 sachet in 1L water', frequency: 'Once daily', durationDays: 3, quantity: 3 },
    ],
  });
  backdateVisit(pending2, daysAgo(0, 10), null);
}

module.exports = {
  // connection
  init,
  connection: () => conn,
  ADMIN, STAFF_ROLES,
  // helpers
  httpError,
  // users & sessions
  addUser, getUser, findUserByUsername, verifyPassword, publicUser,
  createSession, getSessionUser, destroySession,
  // staff management (admin)
  addStaff, updateStaff, listStaff, hideStaff, clinicStats,
  // app state
  isDemo, getMeta, setMeta,
  // patients
  addPatient, getPatient, listPatients, setPatientHidden, patientSummary, prescriptionsForPatient,
  // medicines
  addMedicine, getMedicine, listMedicines, updateMedicine, hideMedicine,
  // lab tests
  listLabTests, getLabTest, addLabTest, updateLabTest, hideLabTest,
  // prescriptions & bills
  createPrescription, updatePrescription, setPrescriptionHidden,
  getPrescription, listPrescriptions, issuePrescription,
  getBill, listBills,
  prescriptionSummary, prescriptionDetail, billSummary, billDetail,
  // seed
  seedIfEmpty,
};
