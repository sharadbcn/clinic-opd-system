/* Shared utilities for all pages: API client, session, formatting, toast,
   modal, and the Rx-pad / invoice renderers used by both portals. */

// ---------------------------------------------------------------- session
function token() { return localStorage.getItem('opd_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('opd_user') || 'null'); }
  catch { return null; }
}
function saveSession(tok, user) {
  localStorage.setItem('opd_token', tok);
  localStorage.setItem('opd_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('opd_token');
  localStorage.removeItem('opd_user');
}

/** Redirect to login unless a user with the given role is signed in. */
function guard(role) {
  const user = getUser();
  if (!token() || !user || user.role !== role) {
    clearSession();
    window.location.href = '/';
    return null;
  }
  return user;
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch {}
  clearSession();
  window.location.href = '/';
}

// ---------------------------------------------------------------- API client
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token() ? { Authorization: 'Bearer ' + token() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    clearSession();
    window.location.href = '/';
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
  return data;
}

// ---------------------------------------------------------------- clinic settings
/* Fetched once per page load. The clinic name and letterhead are set by the
   admin, so nothing about the clinic is hardcoded in the markup. */
let settings = {
  clinic: { name: 'Clinic', address: '', phone: '', email: '', regNo: '' },
  lists: { specialties: [], categories: [], frequencies: [] },
};

async function loadSettings() {
  try {
    const data = await api('/settings');
    if (data && data.settings) settings = data.settings;
  } catch {}
  applyClinicBranding();
  return settings;
}

/** Puts the clinic name into the page title and every element marked for it. */
function applyClinicBranding() {
  const name = settings.clinic.name;
  document.querySelectorAll('[data-clinic-name]').forEach((el) => { el.textContent = name; });
  const suffix = document.body.dataset.pageTitle || '';
  document.title = suffix ? `${suffix} · ${name} OPD` : `${name} OPD`;
  renderPrintFooter();
}

/** Letterhead block — hidden on screen, printed at the top of bills. */
function clinicLetterhead() {
  return `
    <div class="letterhead print-only">
      <div class="letterhead-name">${esc(settings.clinic.name)}</div>
      <div class="letterhead-sub">Outpatient Department</div>
    </div>`;
}

/**
 * The clinic's details, printed along the foot of every page. It is fixed to
 * the bottom of the sheet in print, which is what fills the space the browser
 * would otherwise use for its own header and footer (the page URL and date).
 * Only the fields that have been filled in appear.
 */
function renderPrintFooter() {
  const c = settings.clinic;
  const details = [c.address, c.phone && `Phone ${c.phone}`, c.email,
    c.regNo && `Reg. No. ${c.regNo}`].filter(Boolean);
  let el = document.getElementById('print-footer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'print-footer';
    el.className = 'print-footer print-only';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <span class="print-footer-name">${esc(c.name)}</span>
    ${details.length ? `<span class="print-footer-details">${esc(details.join('  ·  '))}</span>` : ''}`;
}

// ---------------------------------------------------------------- printing
/**
 * Prints whatever is open in the modal — the Rx pad or the invoice — and
 * nothing else. The browser's dialog offers a printer or "Save as PDF",
 * which is how a bill gets downloaded.
 */
function printModal(documentName, { closeAfter = false } = {}) {
  const previousTitle = document.title;
  // The browser prints its page title in the header and offers it as the
  // default PDF filename, so make it the document's own name.
  if (documentName) document.title = `${documentName} · ${settings.clinic.name}`;
  document.body.classList.add('printing');

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    document.body.classList.remove('printing');
    document.title = previousTitle;
    window.removeEventListener('afterprint', cleanup);
    if (closeAfter) closeModal();
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
  // Safari does not always fire afterprint; make sure the page recovers.
  setTimeout(cleanup, 1000);
}

/** A print button for a modal footer. */
function printButton(documentName) {
  return `<button class="btn-ghost" type="button" data-print="${esc(documentName || '')}">Print / Save as PDF</button>`;
}

// ---------------------------------------------------------------- formatting
function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function fmtMoney(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ', ' +
    d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}
function statusPill(status) {
  return status === 'issued'
    ? '<span class="pill pill-issued">Issued</span>'
    : '<span class="pill pill-pending">Pending</span>';
}
function stockBadge(stock) {
  if (stock <= 0) return '<span class="badge badge-out">Out</span>';
  if (stock < 10) return '<span class="badge badge-low">Low</span>';
  return '<span class="badge badge-ok">In stock</span>';
}

// ---------------------------------------------------------------- toast
function toast(message, kind = 'ok') {
  const host = document.getElementById('toast');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'err' ? ' err' : '');
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ---------------------------------------------------------------- modal
function modalOpen() {
  const overlay = document.getElementById('modal');
  return !!(overlay && overlay.classList.contains('open'));
}
function openModal(html, { wide = false } = {}) {
  const overlay = document.getElementById('modal');
  if (!overlay) return;
  const card = overlay.querySelector('.modal-card');
  card.classList.toggle('wide', wide);
  card.innerHTML = html;
  overlay.classList.add('open');
  card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  card.querySelectorAll('[data-print]').forEach((b) =>
    b.addEventListener('click', () => printModal(b.dataset.print))
  );
  const first = card.querySelector('input, select, textarea, button:not(.modal-close)');
  if (first) first.focus();
}
function closeModal() {
  const overlay = document.getElementById('modal');
  if (overlay) overlay.classList.remove('open');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOpen()) closeModal();
});
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'modal') closeModal();
});

// ---------------------------------------------------------------- topbar
function initTopbar(user) {
  document.body.dataset.role = user.role;
  const name = document.getElementById('tb-name');
  const role = document.getElementById('tb-role');
  if (name) name.textContent = user.name;
  if (role) {
    const ROLE_LABEL = { admin: 'Administrator', doctor: 'Doctor', pharmacist: 'Pharmacist' };
    role.textContent = user.specialty || ROLE_LABEL[user.role] || user.role;
  }
  const out = document.getElementById('tb-logout');
  if (out) out.addEventListener('click', logout);
}

/**
 * The dispensing sheet: adjust what is actually handed over, then bill it.
 * Used by the pharmacy for any prescription and by a doctor for their own, so
 * both dispense through exactly the same rules and the same arithmetic.
 */
async function openIssueModal(id, { onIssued } = {}) {
  const { prescription: rx } = await api('/prescriptions/' + id);
  const p = rx.patient || {};
  const rows = rx.items.map((it) => {
    const maxIssue = Math.min(it.quantity, it.currentStock);
    const short = it.currentStock < it.quantity;
    return `
      <tr data-item="${it.id}" data-price="${it.currentPrice}">
        <td>
          <div class="med-name" style="font-weight:600">${esc(it.medicineName)}</div>
          <div class="muted small">${esc(it.dosage)} · ${esc(it.frequency)} · ${it.durationDays}d</div>
        </td>
        <td class="num">${it.quantity}</td>
        <td class="num">
          ${it.currentStock}
          ${short ? `<div class="stock-note short">only ${it.currentStock} in stock</div>` : ''}
        </td>
        <td><input class="issue-qty" type="number" min="0" max="${maxIssue}" value="${maxIssue}" style="width:76px" /></td>
        <td class="num">${fmtMoney(it.currentPrice)}</td>
        <td class="num line-total">${fmtMoney(maxIssue * it.currentPrice)}</td>
      </tr>`;
  }).join('');

  openModal(`
    <div class="modal-head">
      <h3>Issue <span class="mono">${esc(rx.rxNumber)}</span></h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="rx-diagnosis" style="margin-bottom:4px">
        <b>${esc(p.name || '')}</b> <span class="mono muted">${esc(p.code || '')}</span>
        · ${p.age != null ? p.age : '—'}/${esc((p.gender || '—')[0])}
        · by ${esc(rx.doctor ? rx.doctor.name : '')}
      </div>
      <div class="muted small" style="margin-bottom:12px"><b>Diagnosis:</b> ${esc(rx.diagnosis)}${rx.notes ? ` · <b>Advice:</b> ${esc(rx.notes)}` : ''}</div>
      <div class="composer-items">
        <table id="issue-table">
          <thead>
            <tr>
              <th style="min-width:200px">Medicine</th>
              <th style="text-align:right">Prescribed</th>
              <th style="text-align:right">Stock</th>
              <th style="width:90px">Issue</th>
              <th style="text-align:right">Rate</th>
              <th style="text-align:right">Amount</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="composer-total" style="margin-top:12px">
        <span>
          Medicines <span class="mono" id="issue-meds-total"></span>
          &nbsp;+&nbsp; Consultation <span class="mono">${fmtMoney(rx.consultationFee)}</span>
        </span>
        <span class="amount" id="issue-grand-total"></span>
      </div>
      <div id="issue-error" class="form-error" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="issue-submit" type="button">Issue &amp; generate bill</button>
    </div>
  `, { wide: true });

  const table = document.getElementById('issue-table');
  const recalc = () => {
    let meds = 0;
    table.querySelectorAll('tbody tr').forEach((tr) => {
      const price = Number(tr.dataset.price);
      const qty = Math.max(0, Number(tr.querySelector('.issue-qty').value) || 0);
      const line = qty * price;
      tr.querySelector('.line-total').textContent = fmtMoney(line);
      meds += line;
    });
    document.getElementById('issue-meds-total').textContent = fmtMoney(meds);
    document.getElementById('issue-grand-total').textContent = fmtMoney(meds + rx.consultationFee);
  };
  table.querySelectorAll('.issue-qty').forEach((inp) => inp.addEventListener('input', recalc));
  recalc();

  document.getElementById('issue-submit').addEventListener('click', async () => {
    const errBox = document.getElementById('issue-error');
    errBox.classList.remove('show');
    const items = [...table.querySelectorAll('tbody tr')].map((tr) => ({
      itemId: tr.dataset.item,
      quantity: Number(tr.querySelector('.issue-qty').value) || 0,
    }));
    const btn = document.getElementById('issue-submit');
    btn.disabled = true;
    try {
      const { bill } = await api('/prescriptions/' + id + '/issue', { method: 'POST', body: { items } });
      closeModal();
      toast(`${bill.billNumber} · ${fmtMoney(bill.grandTotal)} billed to ${bill.patient ? bill.patient.name : 'patient'}`);
      if (onIssued) onIssued(bill);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- shared renderers
/** Renders a full prescription detail as an Rx-pad sheet (plus bill when issued). */
function renderRxPad(rx, { showBill = true } = {}) {
  const p = rx.patient || {};
  // Dosage, frequency and duration each get their own column so a printed
  // prescription can be read at a glance rather than parsed from one line.
  const itemsRows = rx.items.map((it, i) => `
    <tr>
      <td class="mono muted">${i + 1}.</td>
      <td><div class="med-name">${esc(it.medicineName)}</div></td>
      <td>${esc(it.dosage)}</td>
      <td>${esc(it.frequency)}</td>
      <td class="num">${it.durationDays} day${it.durationDays > 1 ? 's' : ''}</td>
      <td class="num rx-qty">${it.quantity}</td>
      ${rx.status === 'issued' ? `<td class="num rx-qty">${it.issuedQuantity != null ? it.issuedQuantity : '—'}</td>` : ''}
    </tr>`).join('');

  return `
    <div class="rx-pad">
      <div class="rx-water" aria-hidden="true">R<sub>x</sub></div>
      <div class="rx-clinic-row">
        <div class="rx-clinic">${esc(settings.clinic.name)}<span>Outpatient Department</span></div>
        <div class="rx-doctor">
          <div class="name">${esc(rx.doctor ? rx.doctor.name : '')}</div>
          ${rx.doctor && rx.doctor.specialty
            ? `<div class="muted small">${esc(rx.doctor.specialty)}</div>` : ''}
        </div>
      </div>

      <div class="rx-meta">
        <div class="field-ro"><label>Patient</label><div>${esc(p.name || '')} <span class="mono muted">${esc(p.code || '')}</span></div></div>
        <div class="field-ro"><label>Age / Sex</label><div>${p.age != null ? p.age : '—'} / ${esc((p.gender || '—')[0])}</div></div>
        <div class="field-ro"><label>Rx No.</label><div class="mono">${esc(rx.rxNumber)}</div></div>
        <div class="field-ro"><label>Date</label><div>${fmtDate(rx.createdAt)}</div></div>
      </div>
      <div class="rx-lines">
        <div class="rx-line">
          <div class="rx-line-label">Diagnosis</div>
          <div class="rx-line-text">${esc(rx.diagnosis)}</div>
        </div>
        ${rx.notes ? `
          <div class="rx-line">
            <div class="rx-line-label">Advice</div>
            <div class="rx-line-text">${esc(rx.notes)}</div>
          </div>` : ''}
      </div>
      <table class="rx-items">
        <thead>
          <tr>
            <th style="width:26px"></th>
            <th>Medicine</th>
            <th style="width:96px">Dosage</th>
            <th style="width:150px">Frequency</th>
            <th style="width:72px;text-align:right">Duration</th>
            <th class="rx-qty" style="width:56px;text-align:right">Qty</th>
            ${rx.status === 'issued' ? '<th class="rx-qty" style="width:62px;text-align:right">Issued</th>' : ''}
          </tr>
        </thead>
        <tbody>${itemsRows}</tbody>
      </table>
      ${rx.tests && rx.tests.length ? `
        <table class="rx-items">
          <thead><tr><th style="width:26px"></th><th>Test advised</th></tr></thead>
          <tbody>
            ${rx.tests.map((t, i) => `
              <tr>
                <td class="mono muted">${i + 1}.</td>
                <td><div class="med-name">${esc(t)}</div></td>
              </tr>`).join('')}
          </tbody>
        </table>` : ''}
      ${rx.consultationFee > 0 ? `
        <div class="rx-foot">
          <div>Consultation fee: <span class="mono">${fmtMoney(rx.consultationFee)}</span></div>
        </div>` : ''}
    </div>
    ${showBill && rx.bill ? renderInvoice(rx.bill) : ''}
    ${showBill && rx.status === 'pending' ? '<p class="muted small screen-only" style="margin-top:10px">Waiting at the pharmacy — the bill appears here once medicines are issued.</p>' : ''}
  `;
}

/** Renders a bill as an invoice block. */
function renderInvoice(bill) {
  const lines = bill.items.map((line) => `
    <tr>
      <td>${esc(line.name)}</td>
      <td class="num">${line.quantity}</td>
      <td class="num">${fmtMoney(line.unitPrice)}</td>
      <td class="num">${fmtMoney(line.amount)}</td>
    </tr>`).join('');
  const p = bill.patient || {};
  return `
    <div class="invoice">
      ${clinicLetterhead()}
      <div class="invoice-patient print-only">
        <span>Billed to <b>${esc(p.name || '')}</b> <span class="mono">${esc(p.code || '')}</span></span>
        <span class="invoice-doctor">
          <span class="mono">${esc(bill.rxNumber || '')}</span>
          <b>${esc(bill.doctorName || '')}</b>
          ${bill.doctorSpecialty ? `<span class="muted">${esc(bill.doctorSpecialty)}</span>` : ''}
        </span>
      </div>
      <div class="invoice-head">
        <span>Bill <span class="mono">${esc(bill.billNumber)}</span></span>
        <span class="muted">${fmtDateTime(bill.createdAt)} · by ${esc(bill.pharmacistName || 'Pharmacy')}</span>
      </div>
      <table>
        <thead><tr><th>Medicine</th><th style="text-align:right">Qty</th><th style="text-align:right">Rate</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>
          ${lines}
          <tr class="sub-row"><td colspan="3">Medicines total</td><td class="num">${fmtMoney(bill.medicinesTotal)}</td></tr>
          ${bill.consultationFee > 0 ? `
            <tr class="sub-row"><td colspan="3">Consultation fee</td><td class="num">${fmtMoney(bill.consultationFee)}</td></tr>` : ''}
          <tr class="total-row"><td colspan="3">Grand total</td><td class="num">${fmtMoney(bill.grandTotal)}</td></tr>
        </tbody>
      </table>
    </div>`;
}
