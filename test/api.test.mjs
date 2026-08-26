/**
 * End-to-end API tests. Boots the real server on a throwaway database,
 * drives login → register → prescribe → issue → bill over HTTP, then
 * restarts the server and checks everything survived.
 *
 * Run with: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let work;   // temp dir holding opd.db and backups/
let server; // child process

// ---------------------------------------------------------------- harness
async function startServer() {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      OPD_DB_PATH: path.join(work, 'opd.db'),
      OPD_BACKUP_DIR: path.join(work, 'backups'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', (d) => (output += d));
  proc.stderr.on('data', (d) => (output += d));

  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    try {
      const res = await fetch(`${BASE}/api/auth/me`);
      if (res.status === 401) return proc;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server did not start:\n${output}`);
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill('SIGTERM');
  await exited;
}

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function login(username, password) {
  const r = await api('/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
}

async function medicineByName(token, name) {
  const { data } = await api('/medicines', { token });
  const med = data.medicines.find((m) => m.name === name);
  assert.ok(med, `medicine "${name}" should be seeded`);
  return med;
}

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'opd-test-'));
  server = await startServer();
});

after(async () => {
  await stopServer(server);
  await rm(work, { recursive: true, force: true });
});

// Shared across the sequential tests below.
const ctx = {};

// ---------------------------------------------------------------- auth & guards
test('seeded accounts can sign in; wrong password is rejected', async () => {
  ctx.doctor = await login('dr.sharma', 'doctor123');
  ctx.pharma = await login('pharma', 'pharma123');

  const bad = await api('/auth/login', { method: 'POST', body: { username: 'dr.sharma', password: 'nope' } });
  assert.equal(bad.status, 401);

  const me = await api('/auth/me', { token: ctx.doctor });
  assert.equal(me.data.user.role, 'doctor');
  assert.equal(me.data.user.username, 'dr.sharma');
});

test('role guards: doctor cannot restock or price, pharmacist cannot see the registry', async () => {
  // Doctors may add a medicine (see the doctor-added-medicine tests below) but
  // never touch stock or price — that is the pharmacy's.
  const restock = await api('/medicines/1', { method: 'PATCH', token: ctx.doctor, body: { addStock: 10 } });
  assert.equal(restock.status, 403);
  const reprice = await api('/medicines/1', { method: 'PATCH', token: ctx.doctor, body: { unitPrice: 1 } });
  assert.equal(reprice.status, 403);

  const registry = await api('/patients', { token: ctx.pharma });
  assert.equal(registry.status, 403);

  // Doctors may dispense their own prescriptions (see the dispensing tests),
  // but an already-issued one is closed to everyone.
  const reissue = await api('/prescriptions/1/issue', { method: 'POST', token: ctx.doctor, body: {} });
  assert.equal(reissue.status, 409);
});

// ---------------------------------------------------------------- prescribe
test('doctor registers a patient and sends a prescription to the pharmacy', async () => {
  const reg = await api('/patients', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Test Patient', age: 40, gender: 'Female', phone: '90000 00000' },
  });
  assert.equal(reg.status, 201, JSON.stringify(reg.data));
  ctx.patient = reg.data.patient;
  assert.match(ctx.patient.code, /^P-\d+$/);

  const para = await medicineByName(ctx.doctor, 'Paracetamol 500mg Tablet');
  const cet = await medicineByName(ctx.doctor, 'Cetirizine 10mg Tablet');
  ctx.stockBefore = { para: para.stock, cet: cet.stock };
  ctx.prices = { para: para.unitPrice, cet: cet.unitPrice };

  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: {
      patientId: ctx.patient.id,
      diagnosis: 'Test diagnosis',
      consultationFee: 300,
      items: [
        { medicineId: para.id, quantity: 10, dosage: '1 tablet', frequency: '1-1-1', durationDays: 3 },
        { medicineId: cet.id, quantity: 5, dosage: '1 tablet', frequency: '0-0-1', durationDays: 5 },
      ],
    },
  });
  assert.equal(rx.status, 201, JSON.stringify(rx.data));
  ctx.rx = rx.data.prescription;
  assert.equal(ctx.rx.status, 'pending');
  assert.equal(ctx.rx.items.length, 2);
  assert.match(ctx.rx.rxNumber, /^RX-\d+$/);

  // It shows up in the pharmacy queue.
  const queue = await api('/prescriptions?status=pending', { token: ctx.pharma });
  assert.ok(queue.data.prescriptions.some((p) => p.id === ctx.rx.id));
});

// ---------------------------------------------------------------- issue & bill
test('pharmacist issues a partial quantity: stock drops and bill math is right', async () => {
  const [paraItem, cetItem] = ctx.rx.items;
  const res = await api(`/prescriptions/${ctx.rx.id}/issue`, {
    method: 'POST', token: ctx.pharma,
    body: { items: [{ itemId: paraItem.id, quantity: 10 }, { itemId: cetItem.id, quantity: 2 }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const { prescription, bill } = res.data;
  ctx.bill = bill;

  assert.equal(prescription.status, 'issued');
  assert.equal(prescription.items[1].issuedQuantity, 2);

  const medsTotal = 10 * ctx.prices.para + 2 * ctx.prices.cet;
  assert.equal(bill.medicinesTotal, medsTotal);
  assert.equal(bill.consultationFee, 300);
  assert.equal(bill.grandTotal, medsTotal + 300);
  assert.match(bill.billNumber, /^INV-\d+$/);

  const para = await medicineByName(ctx.pharma, 'Paracetamol 500mg Tablet');
  const cet = await medicineByName(ctx.pharma, 'Cetirizine 10mg Tablet');
  assert.equal(para.stock, ctx.stockBefore.para - 10);
  assert.equal(cet.stock, ctx.stockBefore.cet - 2);

  // Bill is visible to the prescribing doctor.
  const mine = await api('/bills', { token: ctx.doctor });
  assert.ok(mine.data.bills.some((b) => b.id === bill.id));
});

test('issuing more than prescribed is rejected; re-issuing is rejected', async () => {
  // Fresh prescription so we can test the over-issue guard.
  const para = await medicineByName(ctx.doctor, 'Paracetamol 500mg Tablet');
  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Guard test', consultationFee: 0,
      items: [{ medicineId: para.id, quantity: 3 }] },
  });
  const over = await api(`/prescriptions/${rx.data.prescription.id}/issue`, {
    method: 'POST', token: ctx.pharma,
    body: { items: [{ itemId: rx.data.prescription.items[0].id, quantity: 4 }] },
  });
  assert.equal(over.status, 400);
  assert.match(over.data.error, /more than the prescribed/);

  const again = await api(`/prescriptions/${ctx.rx.id}/issue`, { method: 'POST', token: ctx.pharma, body: {} });
  assert.equal(again.status, 409);

  // Failed issue must not have touched stock.
  const paraAfter = await medicineByName(ctx.doctor, 'Paracetamol 500mg Tablet');
  assert.equal(paraAfter.stock, para.stock);
});

// ---------------------------------------------------------------- persistence
test('data and sessions survive a server restart; seed does not run again', async () => {
  const medsBefore = (await api('/medicines', { token: ctx.doctor })).data.medicines;
  const patientsBefore = (await api('/patients?scope=all', { token: ctx.doctor })).data.patients;

  await stopServer(server);
  server = await startServer();

  // Old bearer token still works — sessions are persisted.
  const me = await api('/auth/me', { token: ctx.doctor });
  assert.equal(me.status, 200, 'session should survive restart');

  const patient = await api(`/patients/${ctx.patient.id}`, { token: ctx.doctor });
  assert.equal(patient.status, 200);
  assert.equal(patient.data.patient.name, 'Test Patient');
  assert.equal(patient.data.history.length, 2);

  const rx = await api(`/prescriptions/${ctx.rx.id}`, { token: ctx.doctor });
  assert.equal(rx.data.prescription.status, 'issued');
  assert.equal(rx.data.prescription.bill.billNumber, ctx.bill.billNumber);

  const bill = await api(`/bills/${ctx.bill.id}`, { token: ctx.pharma });
  assert.equal(bill.status, 200);
  assert.equal(bill.data.bill.grandTotal, ctx.bill.grandTotal);

  const medsAfter = (await api('/medicines', { token: ctx.doctor })).data.medicines;
  assert.deepEqual(
    medsAfter.map((m) => [m.name, m.stock]),
    medsBefore.map((m) => [m.name, m.stock]),
    'inventory and stock levels should be unchanged by a restart'
  );
  const patientsAfter = (await api('/patients?scope=all', { token: ctx.doctor })).data.patients;
  assert.equal(patientsAfter.length, patientsBefore.length, 'seed must not re-run on an existing database');
});

test('a dated backup is written on startup and not duplicated on the same day', async () => {
  const files = (await readdir(path.join(work, 'backups'))).filter((f) => /^opd-\d{4}-\d{2}-\d{2}\.db$/.test(f));
  assert.equal(files.length, 1, `expected one daily backup, got: ${files.join(', ')}`);
});

// ---------------------------------------------------------------- admin
test('the hardcoded admin can sign in and is denied every clinical route', async () => {
  ctx.admin = await login('admin', 'admin123');
  const me = await api('/auth/me', { token: ctx.admin });
  assert.equal(me.data.user.role, 'admin');

  for (const p of ['/patients', '/prescriptions', '/bills']) {
    const r = await api(p, { token: ctx.admin });
    assert.equal(r.status, 403, `admin must not reach ${p}`);
  }
});

test('admin creates a doctor who can then sign in and prescribe', async () => {
  const created = await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'dr.new', password: 'newdoc123', name: 'Dr. Nita Rao', role: 'doctor', specialty: 'Paediatrics' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.role, 'doctor');
  assert.equal(created.data.user.active, true);
  assert.ok(!('passwordHash' in created.data.user), 'never expose the password hash');
  assert.ok(!('salt' in created.data.user), 'never expose the salt');
  ctx.newDoctorId = created.data.user.id;

  ctx.newDoctor = await login('dr.new', 'newdoc123');
  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.newDoctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Created-by-admin doctor works', consultationFee: 250,
      items: [{ medicineId: '1', quantity: 2 }] },
  });
  assert.equal(rx.status, 201, JSON.stringify(rx.data));
});

test('admin cannot create another admin, duplicate usernames, or weak input', async () => {
  const asAdmin = await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'admin2', password: 'secret123', name: 'Sneaky', role: 'admin' },
  });
  assert.equal(asAdmin.status, 400);
  assert.match(asAdmin.data.error, /doctor|pharmacist/i);

  const dupe = await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'dr.new', password: 'another123', name: 'Clash', role: 'doctor' },
  });
  assert.equal(dupe.status, 409);
});

test('only the admin can manage users', async () => {
  for (const token of [ctx.doctor, ctx.pharma]) {
    assert.equal((await api('/users', { token })).status, 403);
    assert.equal((await api('/stats', { token })).status, 403);
  }
});

test('deactivating a doctor kills their live session and blocks re-login', async () => {
  const off = await api(`/users/${ctx.newDoctorId}`, { method: 'PATCH', token: ctx.admin, body: { active: false } });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.user.active, false);

  // The token they were already holding must stop working immediately.
  const stale = await api('/auth/me', { token: ctx.newDoctor });
  assert.equal(stale.status, 401, 'a deactivated user must lose their live session');

  const relogin = await api('/auth/login', { method: 'POST', body: { username: 'dr.new', password: 'newdoc123' } });
  assert.equal(relogin.status, 401);
  assert.match(relogin.data.error, /deactivat/i);
});

test('reactivating restores access, and a password reset works', async () => {
  await api(`/users/${ctx.newDoctorId}`, { method: 'PATCH', token: ctx.admin, body: { active: true } });
  ctx.newDoctor = await login('dr.new', 'newdoc123');

  const reset = await api(`/users/${ctx.newDoctorId}`, { method: 'PATCH', token: ctx.admin, body: { password: 'changed456' } });
  assert.equal(reset.status, 200);

  const oldPw = await api('/auth/login', { method: 'POST', body: { username: 'dr.new', password: 'newdoc123' } });
  assert.equal(oldPw.status, 401, 'the old password must stop working');
  await login('dr.new', 'changed456');
});

test('admin can correct a staff member\'s name and specialty after creating them', async () => {
  // A doctor added without a specialty — the prescription has nothing to print
  // under their name until it is filled in.
  const created = (await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'dr.nospec', password: 'nospec12345', name: 'Dr Missing Spec', role: 'doctor' },
  })).data.user;
  assert.ok(!created.specialty, 'created without a specialty');

  const fixed = await api(`/users/${created.id}`, {
    method: 'PATCH', token: ctx.admin,
    body: { name: 'Dr. Shailendra Singh', specialty: 'Orthopaedics' },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
  assert.equal(fixed.data.user.name, 'Dr. Shailendra Singh');
  assert.equal(fixed.data.user.specialty, 'Orthopaedics');

  // It must reach the prescription, which is the point of setting it.
  const token = await login('dr.nospec', 'nospec12345');
  const rx = (await api('/prescriptions', {
    method: 'POST', token,
    body: { patientId: ctx.patient.id, diagnosis: 'Specialty check', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 1 }] },
  })).data.prescription;
  assert.equal(rx.doctor.name, 'Dr. Shailendra Singh');
  assert.equal(rx.doctor.specialty, 'Orthopaedics');

  // Clearing it is allowed; a blank name is not.
  const cleared = await api(`/users/${created.id}`, { method: 'PATCH', token: ctx.admin, body: { specialty: '' } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.user.specialty, null);
  const blank = await api(`/users/${created.id}`, { method: 'PATCH', token: ctx.admin, body: { name: '   ' } });
  assert.equal(blank.status, 400);

  await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token });
  await api(`/users/${created.id}`, { method: 'DELETE', token: ctx.admin });
});

test('admin cannot deactivate itself', async () => {
  const meId = (await api('/auth/me', { token: ctx.admin })).data.user.id;
  const r = await api(`/users/${meId}`, { method: 'PATCH', token: ctx.admin, body: { active: false } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /your own/i);
  assert.equal((await api('/auth/me', { token: ctx.admin })).status, 200, 'admin still signed in');
});

test('admin sees clinic counts but no patient details', async () => {
  const { status, data } = await api('/stats', { token: ctx.admin });
  assert.equal(status, 200);
  for (const k of ['doctors', 'pharmacists', 'patients', 'prescriptions', 'bills']) {
    assert.equal(typeof data.stats[k], 'number', `stats.${k} should be a number`);
  }
  assert.ok(data.stats.patients > 0);
  assert.ok(!JSON.stringify(data).includes('Test Patient'), 'stats must not leak patient names');
});

// ---------------------------------------------------------------- doctor-added medicines
test('a doctor adds a medicine without a price: it is flagged for the pharmacy', async () => {
  const res = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Rifampicin 450mg Capsule', category: 'Antibiotic' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  ctx.newMed = res.data.medicine;
  assert.equal(ctx.newMed.stock, 0);
  assert.equal(ctx.newMed.unitPrice, 0);
  assert.equal(ctx.newMed.needsPricing, true, 'with no price it awaits the pharmacy');
});

test('a doctor may supply a price and opening stock, and both are optional', async () => {
  const both = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Doctor Priced Tablet', category: 'General', unitPrice: 12.5, stock: 20 },
  });
  assert.equal(both.status, 201, JSON.stringify(both.data));
  assert.equal(both.data.medicine.unitPrice, 12.5);
  assert.equal(both.data.medicine.stock, 20);
  assert.equal(both.data.medicine.needsPricing, false, 'a stated price needs no pharmacy follow-up');

  // Price only — stock stays at zero.
  const priceOnly = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Doctor Price Only Tablet', category: 'General', unitPrice: 8 },
  });
  assert.equal(priceOnly.status, 201, JSON.stringify(priceOnly.data));
  assert.equal(priceOnly.data.medicine.unitPrice, 8);
  assert.equal(priceOnly.data.medicine.stock, 0);
  assert.equal(priceOnly.data.medicine.needsPricing, false);

  // Stock only — still awaits a price.
  const stockOnly = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Doctor Stock Only Tablet', category: 'General', stock: 15 },
  });
  assert.equal(stockOnly.status, 201, JSON.stringify(stockOnly.data));
  assert.equal(stockOnly.data.medicine.stock, 15);
  assert.equal(stockOnly.data.medicine.unitPrice, 0);
  assert.equal(stockOnly.data.medicine.needsPricing, true);

  // Empty strings from an untouched form mean "not stated", not "zero".
  const blanks = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Doctor Blank Fields Tablet', category: 'General', unitPrice: '', stock: '' },
  });
  assert.equal(blanks.status, 201, JSON.stringify(blanks.data));
  assert.equal(blanks.data.medicine.unitPrice, 0);
  assert.equal(blanks.data.medicine.stock, 0);
  assert.equal(blanks.data.medicine.needsPricing, true);
});

test('a doctor still cannot supply a negative price or fractional stock', async () => {
  const negative = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Bad Price Tablet', category: 'General', unitPrice: -5 },
  });
  assert.equal(negative.status, 400);

  const fractional = await api('/medicines', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Bad Stock Tablet', category: 'General', stock: 2.5 },
  });
  assert.equal(fractional.status, 400);
});

test('a doctor can prescribe a medicine that is out of stock', async () => {
  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: {
      patientId: ctx.patient.id, diagnosis: 'Suspected TB — start ATT', consultationFee: 400,
      items: [
        { medicineId: ctx.newMed.id, quantity: 30, dosage: '1 capsule', frequency: '1-0-0 (morning)', durationDays: 30 },
        { medicineId: '1', quantity: 4 },
      ],
    },
  });
  assert.equal(rx.status, 201, JSON.stringify(rx.data));
  ctx.oosRx = rx.data.prescription;
  assert.equal(rx.data.prescription.items[0].currentStock, 0);
});

test('the pharmacist prices and restocks it, then issues at the new price', async () => {
  const flagged = await api('/medicines', { token: ctx.pharma });
  assert.ok(flagged.data.medicines.find((m) => m.id === ctx.newMed.id).needsPricing,
    'the medicine should be flagged for pricing until a pharmacist prices it');

  const priced = await api(`/medicines/${ctx.newMed.id}`, {
    method: 'PATCH', token: ctx.pharma, body: { unitPrice: 18, addStock: 30 },
  });
  assert.equal(priced.status, 200, JSON.stringify(priced.data));
  assert.equal(priced.data.medicine.unitPrice, 18);
  assert.equal(priced.data.medicine.stock, 30);
  assert.equal(priced.data.medicine.needsPricing, false, 'pricing it must clear the flag');

  const items = ctx.oosRx.items.map((it) => ({ itemId: it.id, quantity: it.quantity }));
  const issued = await api(`/prescriptions/${ctx.oosRx.id}/issue`, { method: 'POST', token: ctx.pharma, body: { items } });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  const line = issued.data.bill.items.find((l) => l.name.startsWith('Rifampicin'));
  assert.equal(line.unitPrice, 18, 'billed at the price set by the pharmacist');
  assert.equal(line.amount, 540);
});

test('a pharmacist adding a medicine still sets price and stock normally', async () => {
  const res = await api('/medicines', {
    method: 'POST', token: ctx.pharma,
    body: { name: 'Ranitidine 150mg Tablet', category: 'Antacid', unitPrice: 3.5, stock: 60 },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.medicine.stock, 60);
  assert.equal(res.data.medicine.unitPrice, 3.5);
  assert.equal(res.data.medicine.needsPricing, false);
});

test('a pharmacist can edit a medicine name, category and price', async () => {
  const added = await api('/medicines', {
    method: 'POST', token: ctx.pharma,
    body: { name: 'Correction Test Tablet', category: 'General', unitPrice: 4, stock: 20 },
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));

  const edited = await api(`/medicines/${added.data.medicine.id}`, {
    method: 'PATCH', token: ctx.pharma,
    body: { name: 'Corrected Test Tablet', category: 'Analgesic', unitPrice: 6.25 },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.medicine.name, 'Corrected Test Tablet');
  assert.equal(edited.data.medicine.category, 'Analgesic');
  assert.equal(edited.data.medicine.unitPrice, 6.25);
  assert.equal(edited.data.medicine.stock, 20, 'editing details must not change stock');

  const listed = (await api('/medicines', { token: ctx.pharma })).data.medicines;
  assert.ok(listed.some((medicine) => medicine.id === added.data.medicine.id &&
    medicine.name === 'Corrected Test Tablet'));
});

// ---------------------------------------------------------------- clinic settings
test('settings are readable without signing in — the login page needs the clinic name', async () => {
  const { status, data } = await api('/settings');
  assert.equal(status, 200);
  assert.equal(typeof data.settings.clinic.name, 'string');
  assert.ok(data.settings.clinic.name.length > 0);
  for (const k of ['address', 'phone', 'email', 'regNo']) {
    assert.equal(typeof data.settings.clinic[k], 'string', `clinic.${k} should always be present`);
  }
  for (const k of ['specialties', 'categories', 'frequencies']) {
    assert.ok(Array.isArray(data.settings.lists[k]), `lists.${k} should be an array`);
    assert.ok(data.settings.lists[k].length > 0, `lists.${k} should have defaults`);
  }
});

test('only the admin can change settings', async () => {
  for (const token of [ctx.doctor, ctx.pharma, undefined]) {
    const r = await api('/settings', { method: 'PUT', token, body: { clinic: { name: 'Hacked Clinic' } } });
    assert.ok(r.status === 403 || r.status === 401, `expected refusal, got ${r.status}`);
  }
  assert.notEqual((await api('/settings')).data.settings.clinic.name, 'Hacked Clinic');
});

test('admin renames the clinic and sets the letterhead', async () => {
  const res = await api('/settings', {
    method: 'PUT', token: ctx.admin,
    body: {
      clinic: {
        name: 'Meadowbrook Family Clinic',
        address: '14 Linden Road, Bandra West, Mumbai 400050',
        phone: '022 2640 1122',
        email: 'care@meadowbrook.example',
        regNo: 'MH/CLIN/2019/4471',
      },
    },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.settings.clinic.name, 'Meadowbrook Family Clinic');

  const fresh = await api('/settings');
  assert.equal(fresh.data.settings.clinic.address, '14 Linden Road, Bandra West, Mumbai 400050');
  assert.equal(fresh.data.settings.clinic.regNo, 'MH/CLIN/2019/4471');
});

test('a blank clinic name is rejected; other fields may be blank', async () => {
  const blank = await api('/settings', { method: 'PUT', token: ctx.admin, body: { clinic: { name: '   ' } } });
  assert.equal(blank.status, 400);
  assert.match(blank.data.error, /name/i);

  const tooLong = await api('/settings', { method: 'PUT', token: ctx.admin, body: { clinic: { name: 'x'.repeat(200) } } });
  assert.equal(tooLong.status, 400);

  // Clearing an optional field is fine and must not disturb the name.
  const ok = await api('/settings', { method: 'PUT', token: ctx.admin, body: { clinic: { email: '' } } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.settings.clinic.name, 'Meadowbrook Family Clinic', 'a partial update must not reset other fields');
});

test('admin edits the suggestion lists; doctors and pharmacists can read them', async () => {
  const res = await api('/settings', {
    method: 'PUT', token: ctx.admin,
    body: { lists: { frequencies: ['1-0-1 (morning & night)', 'Every 6 hours', 'Alternate days'] } },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.settings.lists.frequencies, ['1-0-1 (morning & night)', 'Every 6 hours', 'Alternate days']);
  // Editing one list must leave the others alone.
  assert.ok(res.data.settings.lists.specialties.length > 0);

  const asDoctor = await api('/settings', { token: ctx.doctor });
  assert.deepEqual(asDoctor.data.settings.lists.frequencies, ['1-0-1 (morning & night)', 'Every 6 hours', 'Alternate days']);
});

test('a frequency outside the list is still accepted on a prescription', async () => {
  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: {
      patientId: ctx.patient.id, diagnosis: 'Custom frequency test', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 2, dosage: '1 tablet', frequency: 'Twice weekly on Mon & Thu', durationDays: 14 }],
    },
  });
  assert.equal(rx.status, 201, JSON.stringify(rx.data));
  assert.equal(rx.data.prescription.items[0].frequency, 'Twice weekly on Mon & Thu');
});

test('the tap-to-fill demo endpoint is gone', async () => {
  const r = await api('/auth/demo-mode');
  assert.equal(r.status, 404);
});

test('the renamed clinic and edited lists survive a restart', async () => {
  await stopServer(server);
  server = await startServer();

  const { data } = await api('/settings');
  assert.equal(data.settings.clinic.name, 'Meadowbrook Family Clinic');
  assert.equal(data.settings.clinic.phone, '022 2640 1122');
  assert.deepEqual(data.settings.lists.frequencies, ['1-0-1 (morning & night)', 'Every 6 hours', 'Alternate days']);
});

// ---------------------------------------------------------------- doctor dispensing
test('a doctor can issue their own prescription and it bills exactly like the pharmacy', async () => {
  const para = await medicineByName(ctx.doctor, 'Paracetamol 500mg Tablet');
  const before = para.stock;

  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Dispensed at the consulting room', consultationFee: 250,
      items: [{ medicineId: para.id, quantity: 6 }] },
  })).data.prescription;

  const issued = await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: ctx.doctor,
    body: { items: [{ itemId: rx.items[0].id, quantity: 6 }] },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));

  const { prescription, bill } = issued.data;
  assert.equal(prescription.status, 'issued');
  assert.equal(bill.medicinesTotal, 6 * para.unitPrice);
  assert.equal(bill.grandTotal, 6 * para.unitPrice + 250);
  assert.match(bill.billNumber, /^INV-\d+$/);
  assert.equal(bill.pharmacistName, 'Dr. Meera Sharma', 'the bill names whoever dispensed it');

  const after = await medicineByName(ctx.doctor, 'Paracetamol 500mg Tablet');
  assert.equal(after.stock, before - 6, 'stock moves the same way whoever issues');

  // The pharmacy sees the bill, and the prescription has left its queue.
  assert.ok((await api('/bills', { token: ctx.pharma })).data.bills.some((b) => b.id === bill.id));
  assert.ok(!(await api('/prescriptions?status=pending', { token: ctx.pharma }))
    .data.prescriptions.some((p) => p.id === rx.id));
  ctx.selfIssuedRxId = rx.id;
});

test('a doctor cannot issue another doctor\'s prescription', async () => {
  const other = await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'dr.second', password: 'second12345', name: 'Dr. Second', role: 'doctor' },
  });
  const otherToken = await login('dr.second', 'second12345');

  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Not theirs to dispense', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 1 }] },
  })).data.prescription;

  const refused = await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: otherToken,
    body: { items: [{ itemId: rx.items[0].id, quantity: 1 }] },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /another doctor/i);
  assert.equal((await api(`/prescriptions/${rx.id}`, { token: ctx.doctor })).data.prescription.status, 'pending');

  // A pharmacist may still dispense anyone's.
  const byPharma = await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: ctx.pharma,
    body: { items: [{ itemId: rx.items[0].id, quantity: 1 }] },
  });
  assert.equal(byPharma.status, 200, JSON.stringify(byPharma.data));
  await api(`/users/${other.data.user.id}`, { method: 'DELETE', token: ctx.admin });
});

test('the admin still cannot issue anything', async () => {
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Admin guard', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 1 }] },
  })).data.prescription;
  assert.equal((await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: ctx.admin, body: { items: [] },
  })).status, 403);
  await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token: ctx.doctor });
});

// ---------------------------------------------------------------- editing a prescription
test('a doctor edits their own pending prescription', async () => {
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: {
      patientId: ctx.patient.id, diagnosis: 'Initial diagnosis', notes: 'first note', consultationFee: 300,
      items: [{ medicineId: '1', quantity: 5, dosage: '1 tablet', frequency: '1-0-0', durationDays: 5 }],
      tests: ['ESR'],
    },
  })).data.prescription;
  ctx.editRx = rx;

  const edited = await api(`/prescriptions/${rx.id}`, {
    method: 'PUT', token: ctx.doctor,
    body: {
      diagnosis: 'Revised diagnosis', notes: 'revised note', consultationFee: 450,
      items: [
        { medicineId: '1', quantity: 12, dosage: '2 tablets', frequency: '1-0-1', durationDays: 6 },
        { medicineId: '5', quantity: 3, dosage: '1 tablet', frequency: '0-0-1', durationDays: 3 },
      ],
      tests: ['Complete Blood Count (CBC)', 'HbA1c'],
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const p = edited.data.prescription;
  assert.equal(p.diagnosis, 'Revised diagnosis');
  assert.equal(p.notes, 'revised note');
  assert.equal(p.consultationFee, 450);
  assert.equal(p.items.length, 2);
  assert.equal(p.items[0].quantity, 12);
  assert.equal(p.items[0].dosage, '2 tablets');
  assert.deepEqual(p.tests, ['Complete Blood Count (CBC)', 'HbA1c']);
  assert.equal(p.status, 'pending', 'editing must not change the status');
  assert.equal(p.rxNumber, rx.rxNumber, 'the Rx number is stable across edits');
});

test('the edit is persisted, not just echoed back', async () => {
  const fetched = await api(`/prescriptions/${ctx.editRx.id}`, { token: ctx.doctor });
  assert.equal(fetched.data.prescription.diagnosis, 'Revised diagnosis');
  assert.equal(fetched.data.prescription.items.length, 2);
  assert.deepEqual(fetched.data.prescription.tests, ['Complete Blood Count (CBC)', 'HbA1c']);
  // The replaced items must be gone, not orphaned alongside the new ones.
  const summary = (await api('/prescriptions', { token: ctx.doctor }))
    .data.prescriptions.find((x) => x.id === ctx.editRx.id);
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.testCount, 2);
});

test('another doctor cannot edit it, and a pharmacist cannot either', async () => {
  const other = await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'dr.other', password: 'other12345', name: 'Dr. Other', role: 'doctor' },
  });
  const otherToken = await login('dr.other', 'other12345');

  const byOther = await api(`/prescriptions/${ctx.editRx.id}`, {
    method: 'PUT', token: otherToken,
    body: { diagnosis: 'Hijacked', consultationFee: 0, items: [{ medicineId: '1', quantity: 1 }] },
  });
  assert.equal(byOther.status, 403);
  assert.match(byOther.data.error, /another doctor/i);

  const byPharma = await api(`/prescriptions/${ctx.editRx.id}`, {
    method: 'PUT', token: ctx.pharma,
    body: { diagnosis: 'Nope', consultationFee: 0, items: [{ medicineId: '1', quantity: 1 }] },
  });
  assert.equal(byPharma.status, 403);

  assert.equal((await api(`/prescriptions/${ctx.editRx.id}`, { token: ctx.doctor })).data.prescription.diagnosis,
    'Revised diagnosis', 'the prescription is unchanged after the refused edits');
  await api(`/users/${other.data.user.id}`, { method: 'DELETE', token: ctx.admin });
});

test('an issued prescription can no longer be edited', async () => {
  const rx = (await api(`/prescriptions/${ctx.editRx.id}`, { token: ctx.doctor })).data.prescription;
  const issued = await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: ctx.pharma,
    body: { items: rx.items.map((i) => ({ itemId: i.id, quantity: i.quantity })) },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));

  const late = await api(`/prescriptions/${rx.id}`, {
    method: 'PUT', token: ctx.doctor,
    body: { diagnosis: 'Too late', consultationFee: 0, items: [{ medicineId: '1', quantity: 1 }] },
  });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /already been issued/i);

  // The bill must still match what was actually dispensed.
  const after = (await api(`/prescriptions/${rx.id}`, { token: ctx.doctor })).data.prescription;
  assert.equal(after.diagnosis, 'Revised diagnosis');
  assert.equal(after.bill.medicinesTotal, after.bill.items.reduce((s, l) => s + l.amount, 0));
});

test('an edit is validated the same way as a new prescription', async () => {
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Validation base', consultationFee: 100,
      items: [{ medicineId: '1', quantity: 2 }] },
  })).data.prescription;

  const noDiagnosis = await api(`/prescriptions/${rx.id}`, { method: 'PUT', token: ctx.doctor,
    body: { diagnosis: '  ', consultationFee: 100, items: [{ medicineId: '1', quantity: 2 }] } });
  assert.equal(noDiagnosis.status, 400);

  const noItems = await api(`/prescriptions/${rx.id}`, { method: 'PUT', token: ctx.doctor,
    body: { diagnosis: 'ok', consultationFee: 100, items: [] } });
  assert.equal(noItems.status, 400);

  const badQty = await api(`/prescriptions/${rx.id}`, { method: 'PUT', token: ctx.doctor,
    body: { diagnosis: 'ok', consultationFee: 100, items: [{ medicineId: '1', quantity: 0 }] } });
  assert.equal(badQty.status, 400);

  // A rejected edit must leave the original completely intact.
  const still = (await api(`/prescriptions/${rx.id}`, { token: ctx.doctor })).data.prescription;
  assert.equal(still.diagnosis, 'Validation base');
  assert.equal(still.items.length, 1);
  assert.equal(still.items[0].quantity, 2);
});

// ---------------------------------------------------------------- removing patients & prescriptions
test('removing a prescription takes it out of every list but keeps its bill', async () => {
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'To be removed', consultationFee: 100,
      items: [{ medicineId: '1', quantity: 2 }] },
  })).data.prescription;

  // Issue it, so a bill exists and removal cannot mean deletion.
  const bill = (await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: ctx.pharma,
    body: { items: [{ itemId: rx.items[0].id, quantity: 2 }] },
  })).data.bill;

  const removed = await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token: ctx.doctor });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  assert.ok(!(await api('/prescriptions', { token: ctx.doctor })).data.prescriptions.some((p) => p.id === rx.id),
    'a removed prescription leaves the doctor\'s list');
  assert.ok(!(await api(`/patients/${ctx.patient.id}`, { token: ctx.doctor })).data.history.some((h) => h.id === rx.id),
    'and the patient\'s visit history');

  // The bill it produced is a financial record and must survive.
  const keptBill = await api(`/bills/${bill.id}`, { token: ctx.pharma });
  assert.equal(keptBill.status, 200);
  assert.equal(keptBill.data.bill.grandTotal, bill.grandTotal);
  ctx.removedRxId = rx.id;
});

test('a removed prescription can be listed and restored', async () => {
  const hidden = await api('/prescriptions?hidden=1', { token: ctx.doctor });
  const row = hidden.data.prescriptions.find((p) => p.id === ctx.removedRxId);
  assert.ok(row);
  // The list payload must say so, or the UI cannot offer Restore instead of Edit.
  assert.equal(row.hidden, true, 'a list row must carry its hidden flag');
  assert.ok((await api('/prescriptions', { token: ctx.doctor })).data.prescriptions.every((p) => p.hidden === false),
    'rows in the normal list are marked not hidden');

  const restored = await api(`/prescriptions/${ctx.removedRxId}`, {
    method: 'PATCH', token: ctx.doctor, body: { hidden: false },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.ok((await api('/prescriptions', { token: ctx.doctor })).data.prescriptions.some((p) => p.id === ctx.removedRxId));
});

test('removing a pending prescription also clears it from the pharmacy queue', async () => {
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Withdrawn before dispensing', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 1 }] },
  })).data.prescription;
  assert.ok((await api('/prescriptions?status=pending', { token: ctx.pharma }))
    .data.prescriptions.some((p) => p.id === rx.id), 'it starts in the queue');

  await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token: ctx.doctor });
  assert.ok(!(await api('/prescriptions?status=pending', { token: ctx.pharma }))
    .data.prescriptions.some((p) => p.id === rx.id), 'and is gone from it once removed');
});

test('only the prescribing doctor can remove a prescription', async () => {
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Ownership check', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 1 }] },
  })).data.prescription;
  assert.equal((await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token: ctx.pharma })).status, 403);
  assert.equal((await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token: ctx.admin })).status, 403);
  await api(`/prescriptions/${rx.id}`, { method: 'DELETE', token: ctx.doctor });
});

test('removing a patient hides them from the registry but keeps their records', async () => {
  const p = (await api('/patients', {
    method: 'POST', token: ctx.doctor,
    body: { name: 'Removable Patient', age: 30, gender: 'Other' },
  })).data.patient;
  const rx = (await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: p.id, diagnosis: 'Their only visit', consultationFee: 200,
      items: [{ medicineId: '1', quantity: 1 }] },
  })).data.prescription;

  const removed = await api(`/patients/${p.id}`, { method: 'DELETE', token: ctx.doctor });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  assert.ok(!(await api('/patients?scope=all', { token: ctx.doctor })).data.patients.some((x) => x.id === p.id),
    'a removed patient leaves the registry');
  // The record still resolves, so their prescription still names them.
  const stillNamed = (await api(`/prescriptions/${rx.id}`, { token: ctx.doctor })).data.prescription;
  assert.equal(stillNamed.patient.name, 'Removable Patient');

  const hidden = await api('/patients?hidden=1', { token: ctx.doctor });
  assert.ok(hidden.data.patients.some((x) => x.id === p.id), 'removed patients are listed on request');

  const restored = await api(`/patients/${p.id}`, { method: 'PATCH', token: ctx.doctor, body: { hidden: false } });
  assert.equal(restored.status, 200);
  assert.ok((await api('/patients?scope=all', { token: ctx.doctor })).data.patients.some((x) => x.id === p.id));
});

test('only a doctor can remove a patient', async () => {
  for (const token of [ctx.pharma, ctx.admin]) {
    assert.equal((await api(`/patients/${ctx.patient.id}`, { method: 'DELETE', token })).status, 403);
  }
});

// ---------------------------------------------------------------- removing staff
test('removing a doctor hides them and blocks sign-in, but keeps their records', async () => {
  const created = await api('/users', {
    method: 'POST', token: ctx.admin,
    body: { username: 'dr.temp', password: 'temp12345', name: 'Dr. Temp Locum', role: 'doctor' },
  });
  const id = created.data.user.id;
  const tempToken = await login('dr.temp', 'temp12345');

  // Give them a prescription, so removal cannot mean deletion.
  const rx = await api('/prescriptions', {
    method: 'POST', token: tempToken,
    body: { patientId: ctx.patient.id, diagnosis: 'Locum visit', consultationFee: 200,
      items: [{ medicineId: '1', quantity: 2 }] },
  });
  assert.equal(rx.status, 201);

  const removed = await api(`/users/${id}`, { method: 'DELETE', token: ctx.admin });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  assert.ok(!(await api('/users', { token: ctx.admin })).data.users.some((u) => u.id === id),
    'a removed doctor is out of the staff list');
  assert.equal((await api('/auth/me', { token: tempToken })).status, 401, 'their session ends');
  assert.equal((await api('/auth/login', { method: 'POST', body: { username: 'dr.temp', password: 'temp12345' } })).status, 401);

  // The clinical record is untouched and still names them.
  const kept = await api(`/prescriptions/${rx.data.prescription.id}`, { token: ctx.pharma });
  assert.equal(kept.status, 200);
  assert.equal(kept.data.prescription.doctor.name, 'Dr. Temp Locum');
  ctx.removedDoctorId = id;
});

test('removed staff can be listed and restored', async () => {
  const hidden = await api('/users?hidden=1', { token: ctx.admin });
  assert.ok(hidden.data.users.some((u) => u.id === ctx.removedDoctorId), 'removed staff are listed on request');

  const restored = await api(`/users/${ctx.removedDoctorId}`, {
    method: 'PATCH', token: ctx.admin, body: { hidden: false, active: true },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.ok((await api('/users', { token: ctx.admin })).data.users.some((u) => u.id === ctx.removedDoctorId));
  await login('dr.temp', 'temp12345');
});

test('the admin cannot remove itself', async () => {
  const meId = (await api('/auth/me', { token: ctx.admin })).data.user.id;
  const r = await api(`/users/${meId}`, { method: 'DELETE', token: ctx.admin });
  assert.equal(r.status, 400);
  assert.equal((await api('/auth/me', { token: ctx.admin })).status, 200);
});

// ---------------------------------------------------------------- removing medicines
test('removing a medicine hides it but a pending prescription can still be issued', async () => {
  const med = (await api('/medicines', { method: 'POST', token: ctx.pharma,
    body: { name: 'Discontinued Tablet', category: 'General', unitPrice: 5, stock: 50 } })).data.medicine;

  const rx = (await api('/prescriptions', { method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'Before discontinuation', consultationFee: 0,
      items: [{ medicineId: med.id, quantity: 4 }] } })).data.prescription;

  const removed = await api(`/medicines/${med.id}`, { method: 'DELETE', token: ctx.pharma });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));

  const visible = (await api('/medicines', { token: ctx.doctor })).data.medicines;
  assert.ok(!visible.some((m) => m.id === med.id), 'a removed medicine leaves the catalogue');

  // The already-written prescription must still dispense correctly.
  const issued = await api(`/prescriptions/${rx.id}/issue`, {
    method: 'POST', token: ctx.pharma, body: { items: [{ itemId: rx.items[0].id, quantity: 4 }] },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.equal(issued.data.bill.items[0].name, 'Discontinued Tablet');
  assert.equal(issued.data.bill.grandTotal, 20);

  const restored = await api(`/medicines/${med.id}`, { method: 'PATCH', token: ctx.pharma, body: { hidden: false } });
  assert.equal(restored.status, 200);
  assert.ok((await api('/medicines', { token: ctx.doctor })).data.medicines.some((m) => m.id === med.id));
});

test('only a pharmacist can remove a medicine', async () => {
  for (const token of [ctx.doctor, ctx.admin]) {
    assert.equal((await api('/medicines/1', { method: 'DELETE', token })).status, 403);
  }
});

// ---------------------------------------------------------------- lab tests
test('the lab test catalogue is seeded and grouped by category', async () => {
  const { status, data } = await api('/lab-tests', { token: ctx.doctor });
  assert.equal(status, 200);
  assert.ok(data.tests.length >= 20, `expected a seeded catalogue, got ${data.tests.length}`);
  const names = data.tests.map((t) => t.name);
  for (const expected of ['Complete Blood Count (CBC)', 'Lipid Profile', 'Thyroid Profile (TSH, T3, T4)']) {
    assert.ok(names.includes(expected), `catalogue should include ${expected}`);
  }
  assert.ok(new Set(data.tests.map((t) => t.category)).size >= 4, 'tests span several categories');
});

test('a doctor orders lab tests on a prescription, including one not in the catalogue', async () => {
  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: {
      patientId: ctx.patient.id, diagnosis: 'Fatigue — workup', consultationFee: 400,
      items: [{ medicineId: '1', quantity: 6 }],
      tests: ['Complete Blood Count (CBC)', 'Thyroid Profile (TSH, T3, T4)', 'Serum Ferritin (custom)'],
    },
  });
  assert.equal(rx.status, 201, JSON.stringify(rx.data));
  assert.deepEqual(rx.data.prescription.tests,
    ['Complete Blood Count (CBC)', 'Thyroid Profile (TSH, T3, T4)', 'Serum Ferritin (custom)']);
  ctx.testRxId = rx.data.prescription.id;
});

test('ordered tests survive and reach the pharmacy view', async () => {
  const detail = await api(`/prescriptions/${ctx.testRxId}`, { token: ctx.pharma });
  assert.equal(detail.data.prescription.tests.length, 3);
  const summary = (await api('/prescriptions', { token: ctx.doctor }))
    .data.prescriptions.find((p) => p.id === ctx.testRxId);
  assert.equal(summary.testCount, 3);
});

test('a prescription with no tests is still valid', async () => {
  const rx = await api('/prescriptions', {
    method: 'POST', token: ctx.doctor,
    body: { patientId: ctx.patient.id, diagnosis: 'No tests needed', consultationFee: 0,
      items: [{ medicineId: '1', quantity: 1 }] },
  });
  assert.equal(rx.status, 201);
  assert.deepEqual(rx.data.prescription.tests, []);
});

test('only the admin can change the lab test catalogue', async () => {
  for (const token of [ctx.doctor, ctx.pharma]) {
    assert.equal((await api('/lab-tests', { method: 'POST', token, body: { name: 'Nope', category: 'X' } })).status, 403);
    assert.equal((await api('/lab-tests/1', { method: 'DELETE', token })).status, 403);
  }
});

test('admin adds a test to the catalogue and removes another', async () => {
  const added = await api('/lab-tests', {
    method: 'POST', token: ctx.admin, body: { name: 'Vitamin B12', category: 'Biochemistry' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  assert.equal(added.data.test.name, 'Vitamin B12');

  const dupe = await api('/lab-tests', {
    method: 'POST', token: ctx.admin, body: { name: 'vitamin b12', category: 'Biochemistry' },
  });
  assert.equal(dupe.status, 409, 'duplicate test names are rejected');

  const removed = await api(`/lab-tests/${added.data.test.id}`, { method: 'DELETE', token: ctx.admin });
  assert.equal(removed.status, 200);
  assert.ok(!(await api('/lab-tests', { token: ctx.doctor })).data.tests.some((t) => t.name === 'Vitamin B12'));
});

// ---------------------------------------------------------------- scripts
function runScript(name) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [`scripts/${name}.js`], {
      cwd: ROOT,
      env: { ...process.env, OPD_DB_PATH: path.join(work, 'opd.db'), OPD_BACKUP_DIR: path.join(work, 'backups') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    proc.on('exit', (code) => resolve({ code, output }));
  });
}

test('npm run backup writes a timestamped copy while the server is running', async () => {
  const { code, output } = await runScript('backup');
  assert.equal(code, 0, output);
  const files = (await readdir(path.join(work, 'backups'))).filter((f) => /^opd-\d{4}-\d{2}-\d{2}-\d{6}\.db$/.test(f));
  assert.equal(files.length, 1, `expected one on-demand backup, got: ${files.join(', ')}`);
});

test('npm run reset wipes the database so the next start re-seeds', async () => {
  await stopServer(server);
  const { code, output } = await runScript('reset');
  assert.equal(code, 0, output);
  server = await startServer();

  const doctor = await login('dr.sharma', 'doctor123');
  const { data } = await api('/patients?scope=all', { token: doctor });
  assert.equal(data.patients.length, 5, 'only the five demo patients should exist after a reset');
  assert.ok(!data.patients.some((p) => p.name === 'Test Patient'));
  const old = await api('/auth/me', { token: ctx.doctor });
  assert.equal(old.status, 401, 'old sessions should be gone after a reset');
});
