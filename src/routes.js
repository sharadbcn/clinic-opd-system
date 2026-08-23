/** JSON API routes. All routes require auth; write access is role-guarded. */
const express = require('express');
const db = require('./db');
const settings = require('./settings');
const { requireAuth, requireRole, requireClinical, login, logout, me } = require('./auth');

const router = express.Router();

/** Wraps a sync handler so thrown httpErrors become clean JSON responses. */
const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Something went wrong on the server.' });
  }
};

// ---------------------------------------------------------------- auth
router.post('/auth/login', wrap(login));
router.post('/auth/logout', requireAuth, wrap(logout));
router.get('/auth/me', requireAuth, wrap(me));

// ---------------------------------------------------------------- settings
// Public: the login page needs the clinic name before anyone signs in, and the
// letterhead is printed on every bill handed to a patient. Admin-only to change.
router.get('/settings', wrap((req, res) => {
  res.json({ settings: settings.all() });
}));

router.put('/settings', requireAuth, requireRole('admin'), wrap((req, res) => {
  const { clinic, lists } = req.body || {};
  res.json({ settings: settings.update({ clinic, lists }) });
}));

// ---------------------------------------------------------------- staff (admin)
// Doctors and pharmacists are created here — none are hardcoded.
router.get('/users', requireAuth, requireRole('admin'), wrap((req, res) => {
  res.json({ users: db.listStaff({ hidden: req.query.hidden === '1' }).map(db.publicUser) });
}));

router.post('/users', requireAuth, requireRole('admin'), wrap((req, res) => {
  const { username, password, name, role, specialty } = req.body || {};
  const user = db.addStaff({ username, password, name, role, specialty });
  res.status(201).json({ user: db.publicUser(user) });
}));

// Deactivate/reactivate, or reset a password. Staff are never deleted —
// that would orphan their prescriptions and bills.
router.patch('/users/:id', requireAuth, requireRole('admin'), wrap((req, res) => {
  const { active, password, hidden, name, specialty } = req.body || {};
  const user = db.updateStaff(req.params.id, { active, password, hidden, name, specialty },
    { actingUserId: req.user.id });
  res.json({ user: db.publicUser(user) });
}));

// Removing a staff member hides them: their prescriptions and bills must keep
// working, so the record is never deleted. Restore with PATCH { hidden: false }.
router.delete('/users/:id', requireAuth, requireRole('admin'), wrap((req, res) => {
  const user = db.hideStaff(req.params.id, { actingUserId: req.user.id });
  res.json({ user: db.publicUser(user) });
}));

router.get('/stats', requireAuth, requireRole('admin'), wrap((req, res) => {
  res.json({ stats: db.clinicStats() });
}));

// ---------------------------------------------------------------- patients (doctor)
router.get('/patients', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const scope = req.query.scope === 'mine' ? 'mine' : 'all';

  let list = db.listPatients({ hidden: req.query.hidden === '1' }).map(db.patientSummary);
  if (scope === 'mine') {
    const myPatientIds = new Set(
      db.listPrescriptions({ doctorId: req.user.id }).map((rx) => rx.patientId)
    );
    list = list.filter((p) => myPatientIds.has(p.id) || p.createdBy === req.user.id);
  }
  if (search) {
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(search) ||
        p.code.toLowerCase().includes(search) ||
        (p.phone || '').toLowerCase().includes(search)
    );
  }
  list.sort((a, b) => (b.lastVisitAt || b.createdAt).localeCompare(a.lastVisitAt || a.createdAt));
  res.json({ patients: list });
}));

router.post('/patients', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const { name, age, gender, phone } = req.body || {};
  const patient = db.addPatient({ name, age, gender, phone, createdBy: req.user.id });
  res.status(201).json({ patient: db.patientSummary(patient) });
}));

// Removing a patient hides them from the registry; their prescriptions and
// bills reference them, so the record is never deleted.
router.delete('/patients/:id', requireAuth, requireRole('doctor'), wrap((req, res) => {
  res.json({ patient: db.patientSummary(db.setPatientHidden(req.params.id, true)) });
}));

router.patch('/patients/:id', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const { hidden } = req.body || {};
  if (hidden === undefined) throw db.httpError(400, 'Nothing to update.');
  res.json({ patient: db.patientSummary(db.setPatientHidden(req.params.id, !!hidden)) });
}));

router.get('/patients/:id', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const patient = db.getPatient(req.params.id);
  const history = db.prescriptionsForPatient(patient.id).map(db.prescriptionSummary);
  res.json({ patient: db.patientSummary(patient), history });
}));

// ---------------------------------------------------------------- medicines
// Doctors need the list (with stock) while prescribing; pharmacists manage it.
router.get('/medicines', requireAuth, requireClinical, wrap((req, res) => {
  const list = db.listMedicines({ hidden: req.query.hidden === '1' })
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ medicines: list });
}));

// Pharmacists add stocked medicines. Doctors may add one the pharmacy doesn't
// carry so they can prescribe it — forced to zero stock and zero price, and
// flagged for the pharmacy to price. Admins have no clinical access.
router.post('/medicines', requireAuth, requireClinical, wrap((req, res) => {
  const { name, category, unitPrice, stock } = req.body || {};
  const medicine = db.addMedicine({
    name, category, unitPrice, stock, byDoctor: req.user.role === 'doctor',
  });
  res.status(201).json({ medicine });
}));

router.patch('/medicines/:id', requireAuth, requireRole('pharmacist'), wrap((req, res) => {
  const { addStock, unitPrice, name, category, hidden } = req.body || {};
  const medicine = db.updateMedicine(req.params.id, { addStock, unitPrice, name, category, hidden });
  res.json({ medicine });
}));

// Removing a medicine hides it from the catalogue. A pending prescription
// containing it can still be dispensed, and past bills are untouched.
router.delete('/medicines/:id', requireAuth, requireRole('pharmacist'), wrap((req, res) => {
  res.json({ medicine: db.hideMedicine(req.params.id) });
}));

// ---------------------------------------------------------------- lab tests
// Ordered by doctors, printed on the prescription. Not billed, no results.
router.get('/lab-tests', requireAuth, wrap((req, res) => {
  res.json({ tests: db.listLabTests({ hidden: req.query.hidden === '1' }) });
}));

router.post('/lab-tests', requireAuth, requireRole('admin'), wrap((req, res) => {
  const { name, category } = req.body || {};
  res.status(201).json({ test: db.addLabTest({ name, category }) });
}));

router.patch('/lab-tests/:id', requireAuth, requireRole('admin'), wrap((req, res) => {
  const { name, category, hidden } = req.body || {};
  res.json({ test: db.updateLabTest(req.params.id, { name, category, hidden }) });
}));

router.delete('/lab-tests/:id', requireAuth, requireRole('admin'), wrap((req, res) => {
  res.json({ test: db.hideLabTest(req.params.id) });
}));

// ---------------------------------------------------------------- prescriptions
router.get('/prescriptions', requireAuth, requireClinical, wrap((req, res) => {
  const status = req.query.status;
  const list = db.listPrescriptions({
    doctorId: req.user.role === 'doctor' ? req.user.id : undefined,
    status: status === 'pending' || status === 'issued' ? status : undefined,
    hidden: req.query.hidden === '1',
  });
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ prescriptions: list.map(db.prescriptionSummary) });
}));

router.post('/prescriptions', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const { patientId, diagnosis, notes, consultationFee, items, tests } = req.body || {};
  const rx = db.createPrescription({
    patientId, doctorId: req.user.id, diagnosis, notes, consultationFee, items, tests,
  });
  res.status(201).json({ prescription: db.prescriptionDetail(rx) });
}));

// A doctor may revise their own prescription while it is still pending.
router.put('/prescriptions/:id', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const { diagnosis, notes, consultationFee, items, tests } = req.body || {};
  const rx = db.updatePrescription({
    prescriptionId: req.params.id, doctorId: req.user.id,
    diagnosis, notes, consultationFee, items, tests,
  });
  res.json({ prescription: db.prescriptionDetail(rx) });
}));

// Removing a prescription hides it everywhere, including the pharmacy queue,
// so removing a pending one withdraws it. Its bill, if any, is untouched.
router.delete('/prescriptions/:id', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const rx = db.setPrescriptionHidden({
    prescriptionId: req.params.id, doctorId: req.user.id, hidden: true,
  });
  res.json({ prescription: db.prescriptionSummary(rx) });
}));

router.patch('/prescriptions/:id', requireAuth, requireRole('doctor'), wrap((req, res) => {
  const { hidden } = req.body || {};
  if (hidden === undefined) throw db.httpError(400, 'Nothing to update.');
  const rx = db.setPrescriptionHidden({
    prescriptionId: req.params.id, doctorId: req.user.id, hidden: !!hidden,
  });
  res.json({ prescription: db.prescriptionSummary(rx) });
}));

router.get('/prescriptions/:id', requireAuth, requireClinical, wrap((req, res) => {
  const rx = db.getPrescription(req.params.id);
  res.json({ prescription: db.prescriptionDetail(rx) });
}));

// Dispensing: the pharmacy for any prescription, a doctor for their own.
// Either way this decrements stock and creates the bill.
router.post('/prescriptions/:id/issue', requireAuth, requireClinical, wrap((req, res) => {
  const { items } = req.body || {};
  const { prescription, bill } = db.issuePrescription({
    prescriptionId: req.params.id,
    issuedBy: req.user.id,
    issuedItems: items,
  });
  res.json({ prescription: db.prescriptionDetail(prescription), bill: db.billDetail(bill) });
}));

// ---------------------------------------------------------------- bills
router.get('/bills', requireAuth, requireClinical, wrap((req, res) => {
  const list = db.listBills({ doctorId: req.user.role === 'doctor' ? req.user.id : undefined });
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ bills: list.map(db.billSummary) });
}));

router.get('/bills/:id', requireAuth, requireClinical, wrap((req, res) => {
  const bill = db.getBill(req.params.id);
  if (req.user.role === 'doctor' && bill.doctorId !== req.user.id) {
    throw db.httpError(403, 'This bill belongs to another doctor.');
  }
  res.json({ bill: db.billDetail(bill) });
}));

module.exports = router;
