/* Doctor portal: patients & history, prescription composer, prescriptions & bills. */

const user = guard('doctor');
if (user) initTopbar(user);

/** Fill the suggestion lists the admin maintains. Any other value can be typed. */
loadSettings().then(() => {
  document.getElementById('category-list').innerHTML =
    settings.lists.categories.map((c) => `<option value="${esc(c)}"></option>`).join('');
  // Rows built before the settings arrived have an empty dropdown.
  document.querySelectorAll('.it-freq-sel').forEach((sel) => {
    if (sel.options.length <= 1) sel.innerHTML = frequencyOptions(settings.lists.frequencies[0]);
  });
  document.querySelectorAll('#items-tbody tr').forEach(autoQuantity);
});

const state = {
  medicines: [],
  patients: [],
  composerPatients: [],
  tests: [],
  editingRxId: null,
  scope: 'mine',
  search: '',
  showRemovedPatients: false,
  showRemovedRx: false,
  rxStatus: '',
  activeTab: 'patients',
};

// ---------------------------------------------------------------- tabs
const tabs = document.querySelectorAll('.tab');
tabs.forEach((t) =>
  t.addEventListener('click', () => switchTab(t.dataset.tab))
);
function switchTab(name) {
  state.activeTab = name;
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('[data-section]').forEach((s) => (s.hidden = s.id !== 'tab-' + name));
  if (name === 'patients') loadPatients();
  if (name === 'compose') prepareComposer();
  if (name === 'prescriptions') loadPrescriptions();
}

// ---------------------------------------------------------------- patients
const patientsTbody = document.getElementById('patients-tbody');
const patientsEmpty = document.getElementById('patients-empty');
const listView = document.getElementById('patients-list-view');
const detailView = document.getElementById('patient-detail-view');

document.getElementById('patient-search').addEventListener('input', (e) => {
  state.search = e.target.value;
  clearTimeout(state._searchTimer);
  state._searchTimer = setTimeout(loadPatients, 250);
});
document.querySelectorAll('#patient-scope button').forEach((b) =>
  b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    document.querySelectorAll('#patient-scope button').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b))
    );
    loadPatients();
  })
);
document.getElementById('patient-back').addEventListener('click', showPatientList);

function showPatientList() {
  detailView.hidden = true;
  listView.hidden = false;
}

async function loadPatients() {
  const params = new URLSearchParams();
  if (state.search.trim()) params.set('search', state.search.trim());
  params.set('scope', state.scope);
  if (state.showRemovedPatients) params.set('hidden', '1');
  const { patients } = await api('/patients?' + params.toString());
  state.patients = patients;
  patientsTbody.innerHTML = patients.map((p) => `
    <tr class="rowlink" data-id="${p.id}">
      <td class="mono">${esc(p.code)}</td>
      <td><b>${esc(p.name)}</b></td>
      <td>${p.age} / ${esc(p.gender[0])}</td>
      <td class="mono">${esc(p.phone || '—')}</td>
      <td class="num">${p.visitCount}</td>
      <td>${p.lastVisitAt ? fmtDate(p.lastVisitAt) : '<span class="muted">New</span>'}</td>
      <td class="row-actions">
        <button class="btn-quiet ${p.hidden ? '' : 'danger'}" data-act="${p.hidden ? 'restore' : 'remove'}" type="button">
          ${p.hidden ? 'Restore' : 'Remove'}
        </button>
      </td>
    </tr>`).join('');
  patientsEmpty.hidden = patients.length > 0;
  patientsTbody.querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act) togglePatientHidden(patients.find((p) => String(p.id) === tr.dataset.id), act === 'remove');
      else openPatientDetail(tr.dataset.id);
    })
  );
}

async function togglePatientHidden(patient, remove) {
  if (remove && !confirm(
    `Remove ${patient.name} from the registry?\n\nTheir prescriptions and bills are kept — the record is hidden, not deleted — and you can bring them back from "Show removed".`
  )) return;
  try {
    if (remove) await api('/patients/' + patient.id, { method: 'DELETE' });
    else await api('/patients/' + patient.id, { method: 'PATCH', body: { hidden: false } });
    toast(`${patient.name} ${remove ? 'removed' : 'restored'}`);
    loadPatients();
  } catch (err) {
    toast(err.message, 'err');
  }
}

document.getElementById('patients-removed-toggle').addEventListener('click', (e) => {
  state.showRemovedPatients = !state.showRemovedPatients;
  e.target.textContent = state.showRemovedPatients ? 'Show current' : 'Show removed';
  e.target.setAttribute('aria-pressed', String(state.showRemovedPatients));
  loadPatients();
});

async function openPatientDetail(id) {
  const { patient, history } = await api('/patients/' + id);
  const card = document.getElementById('patient-detail-card');
  card.innerHTML = `
    <div class="patient-head">
      <div>
        <h2>${esc(patient.name)} <span class="mono muted" style="font-size:14px">${esc(patient.code)}</span></h2>
        <div class="patient-facts">
          <span><b>${patient.age}</b> yrs · ${esc(patient.gender)}</span>
          <span>Phone <b class="mono">${esc(patient.phone || '—')}</b></span>
          <span>Registered <b>${fmtDate(patient.createdAt)}</b></span>
          <span><b>${patient.visitCount}</b> visit${patient.visitCount === 1 ? '' : 's'}</span>
        </div>
      </div>
      <button class="btn" id="detail-prescribe" type="button">New prescription</button>
    </div>
    <div class="visit-list" id="visit-list">
      ${history.length === 0 ? '<div class="empty"><strong>No visits yet</strong>Write the first prescription to start this patient\'s history.</div>' : ''}
    </div>`;
  const list = card.querySelector('#visit-list');
  history.forEach((h) => {
    const el = document.createElement('div');
    el.className = 'visit-card';
    el.innerHTML = `
      <div class="visit-main">
        <div class="line1">
          <span class="diag">${esc(h.diagnosis)}</span>
        </div>
        <div class="muted small">
          <span class="mono">${esc(h.rxNumber)}</span> · ${fmtDate(h.createdAt)} · ${esc(h.doctorName)} · ${h.itemCount} medicine${h.itemCount === 1 ? '' : 's'}
        </div>
      </div>
      <div class="visit-side">
        ${h.billTotal != null ? `<span class="mono">${fmtMoney(h.billTotal)}</span>` : ''}
        ${statusPill(h.status)}
      </div>`;
    el.addEventListener('click', () => openRxModal(h.id));
    list.appendChild(el);
  });
  card.querySelector('#detail-prescribe').addEventListener('click', () => {
    switchTab('compose');
    // prepareComposer is async; set the selection after it fills options.
    setTimeout(() => { document.getElementById('rx-patient').value = patient.id; }, 150);
  });
  listView.hidden = true;
  detailView.hidden = false;
}

// -------- add patient modal
document.getElementById('add-patient-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-head"><h3>Add patient</h3><button class="modal-close" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <form id="patient-form" class="form-grid" autocomplete="off">
        <div class="field span-2"><label for="p-name">Full name</label><input id="p-name" required /></div>
        <div class="field"><label for="p-age">Age</label><input id="p-age" type="number" min="0" max="120" required /></div>
        <div class="field"><label for="p-gender">Gender</label>
          <select id="p-gender"><option>Male</option><option>Female</option><option>Other</option></select>
        </div>
        <div class="field span-2"><label for="p-phone">Phone (optional)</label><input id="p-phone" /></div>
      </form>
      <div id="patient-form-error" class="form-error" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn-ghost" id="patient-save-prescribe" type="button">Save &amp; prescribe</button>
      <button class="btn" id="patient-save" type="button">Save patient</button>
    </div>`);
  const submit = async (thenPrescribe) => {
    const errBox = document.getElementById('patient-form-error');
    errBox.classList.remove('show');
    try {
      const { patient } = await api('/patients', {
        method: 'POST',
        body: {
          name: document.getElementById('p-name').value,
          age: document.getElementById('p-age').value,
          gender: document.getElementById('p-gender').value,
          phone: document.getElementById('p-phone').value,
        },
      });
      closeModal();
      toast(`${patient.name} added (${patient.code})`);
      if (thenPrescribe) {
        switchTab('compose');
        setTimeout(() => { document.getElementById('rx-patient').value = patient.id; }, 150);
      } else {
        loadPatients();
      }
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  };
  document.getElementById('patient-save').addEventListener('click', () => submit(false));
  document.getElementById('patient-save-prescribe').addEventListener('click', () => submit(true));
  document.getElementById('patient-form').addEventListener('submit', (e) => { e.preventDefault(); submit(false); });
});

// ------------------------------------------------------- quantity calculation
/* Quantity is doses per day x days x units per dose. These are pure functions
   so they can be unit-tested — see test/quantity.test.mjs. */

/** Doses per day from a frequency, or null when it cannot be known. */
function dosesPerDay(frequency) {
  const f = String(frequency || '').trim().toLowerCase();
  if (!f) return null;
  // As-needed regimens have no fixed count.
  if (/\b(sos|prn|as needed|as directed|if required|stat)\b/.test(f)) return null;

  // "1-0-1", "1-1-1", "1-1-1-1" — the slots are doses at each time of day.
  const slots = f.match(/^\s*\d+(?:\s*-\s*\d+)+/);
  if (slots) {
    return slots[0].split('-').reduce((sum, n) => sum + Number(n.trim()), 0) || null;
  }

  const everyHours = f.match(/every\s+(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (everyHours) {
    const hours = Number(everyHours[1]);
    return hours > 0 ? 24 / hours : null;
  }

  if (/\balternate\s+days?\b|\bevery\s+other\s+day\b|\beod\b/.test(f)) return 0.5;
  if (/\bweekly\b|\bonce\s+a\s+week\b/.test(f)) return 1 / 7;
  if (/\bonce\b/.test(f)) return 1;
  if (/\btwice\b/.test(f)) return 2;
  if (/\bthrice\b|\bthree\s+times\b/.test(f)) return 3;
  if (/\bfour\s+times\b/.test(f)) return 4;
  return null;
}

/**
 * The dose amount, or null when the dose is not countable.
 * A syrup dosed at 5 ml is dispensed as bottles, not millilitres, so there is
 * no way to turn a volume into a quantity — better to leave it to the doctor.
 */
function doseUnits(dosage) {
  const d = String(dosage || '').trim().toLowerCase();
  if (!d) return 1; // an unstated dose is one unit
  if (/\b(ml|millilitre|milliliter|l|litre|liter|mg|mcg|g|gram|grams|iu|unit\s*\/)\b/.test(d)) return null;
  const n = d.match(/^\s*(\d+(?:\.\d+)?)/);
  if (!n) return 1;
  const count = Number(n[1]);
  return count > 0 ? count : null;
}

/**
 * Whole units to prescribe: dose amount x doses per day x days.
 * Returns null when it cannot be known — an as-needed regimen has no fixed
 * count, and a dose in ml or mg is dispensed as bottles or packs — so the
 * field is left for the doctor to fill in.
 */
function computeQuantity({ frequency, durationDays, dosage }) {
  const perDay = dosesPerDay(frequency);
  const units = doseUnits(dosage);
  const days = Number(durationDays);
  if (perDay === null || units === null) return null;
  if (!Number.isFinite(days) || days <= 0) return null;
  const total = Math.ceil(perDay * days * units);
  return total > 0 ? total : null;
}

// ---------------------------------------------------------------- composer
const itemsTbody = document.getElementById('items-tbody');

/* Both switchTab('compose') and editPrescription() prepare the composer, so
   concurrent calls share one in-flight load — otherwise the slower one
   rebuilds the patient list after the caller has already made a selection. */
let composerPrep = null;
function prepareComposer() {
  if (!composerPrep) {
    composerPrep = loadComposer().finally(() => { composerPrep = null; });
  }
  return composerPrep;
}

async function loadComposer() {
  const [{ medicines }, { patients }] = await Promise.all([
    api('/medicines'),
    api('/patients?scope=all'),
  ]);
  state.medicines = medicines;
  // Every patient in the clinic — the registry tab's state.patients is scoped
  // and search-filtered, so it cannot be used to resolve the chosen patient.
  state.composerPatients = patients;
  const select = document.getElementById('rx-patient');
  const current = select.value;
  select.innerHTML = '<option value="" disabled selected>Select patient…</option>' +
    patients
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)} (${p.age}${esc(p.gender[0])})</option>`)
      .join('');
  if (current) select.value = current;
  if (itemsTbody.children.length === 0) addItemRow();
  updateComposeTotal();
}

/**
 * Out-of-stock medicines stay selectable: a doctor prescribes what the patient
 * needs, and the pharmacy issues what it has (partial issue) or restocks.
 */
function medicineOptions(selectedId) {
  return '<option value="" disabled ' + (selectedId ? '' : 'selected') + '>Select medicine…</option>' +
    state.medicines.map((m) => {
      // A medicine a doctor just added has never been stocked, so "out of
      // stock" would be misleading — it reads as a problem rather than a
      // pending order. Show its name alone.
      const label = m.needsPricing
        ? esc(m.name)
        : `${esc(m.name)} — ${fmtMoney(m.unitPrice)}${m.stock <= 0 ? ' — out of stock' : ` — ${m.stock} left`}`;
      return `<option value="${m.id}" ${String(selectedId) === String(m.id) ? 'selected' : ''}>
        ${label}
      </option>`;
    }).join('');
}

const CUSTOM_FREQUENCY = '__custom__';

/**
 * A real dropdown rather than an <input list>: a datalist filters its
 * suggestions by whatever is already typed, so a pre-filled row would only
 * ever offer the one option that matched. "Custom…" keeps the escape hatch
 * for a frequency the admin hasn't listed.
 */
function frequencyOptions(selected) {
  const list = settings.lists.frequencies;
  const known = list.includes(selected);
  return list.map((f) => `<option value="${esc(f)}" ${f === selected ? 'selected' : ''}>${esc(f)}</option>`).join('') +
    `<option value="${CUSTOM_FREQUENCY}" ${selected && !known ? 'selected' : ''}>Custom…</option>`;
}

/** The frequency a row is actually prescribing, from whichever control is live. */
function rowFrequency(tr) {
  const sel = tr.querySelector('.it-freq-sel');
  return sel.value === CUSTOM_FREQUENCY ? tr.querySelector('.it-freq').value : sel.value;
}

function addItemRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><select class="it-med" required>${medicineOptions()}</select></td>
    <td><input class="it-dosage" placeholder="1 tablet" /></td>
    <td class="freq-cell">
      <select class="it-freq-sel">${frequencyOptions(settings.lists.frequencies[0])}</select>
      <input class="it-freq" placeholder="e.g. Every 6 hours" hidden />
    </td>
    <td><input class="it-days" type="number" min="1" value="5" /></td>
    <td class="qty-cell">
      <input class="it-qty" type="number" min="1" value="10" />
      <span class="qty-auto" hidden>auto</span>
    </td>
    <td><button class="btn-quiet" type="button" title="Remove" aria-label="Remove medicine">✕</button></td>`;
  tr.querySelector('button').addEventListener('click', () => {
    tr.remove();
    if (itemsTbody.children.length === 0) addItemRow();
    updateComposeTotal();
  });

  const qty = tr.querySelector('.it-qty');
  const freqSel = tr.querySelector('.it-freq-sel');
  const freqText = tr.querySelector('.it-freq');

  tr.querySelector('.it-med').addEventListener('change', updateComposeTotal);
  // Typing your own quantity switches this row off auto for good.
  qty.addEventListener('input', () => {
    tr.dataset.qtyTouched = '1';
    tr.querySelector('.qty-auto').hidden = true;
    updateComposeTotal();
  });

  freqSel.addEventListener('change', () => {
    const custom = freqSel.value === CUSTOM_FREQUENCY;
    freqText.hidden = !custom;
    if (custom) freqText.focus();
    autoQuantity(tr);
  });
  // Dosage, days and a typed frequency all feed the quantity.
  [tr.querySelector('.it-dosage'), tr.querySelector('.it-days'), freqText].forEach((el) =>
    el.addEventListener('input', () => autoQuantity(tr))
  );

  itemsTbody.appendChild(tr);
  autoQuantity(tr);
}

/**
 * Fills the quantity from dosage x frequency x days. Stops as soon as the
 * doctor types their own number, and leaves the field alone whenever the
 * quantity cannot be known (as-needed regimens, or doses measured in ml).
 */
function autoQuantity(tr) {
  if (tr.dataset.qtyTouched === '1') return;
  const computed = computeQuantity({
    dosage: tr.querySelector('.it-dosage').value,
    frequency: rowFrequency(tr),
    durationDays: tr.querySelector('.it-days').value,
  });
  const badge = tr.querySelector('.qty-auto');
  if (computed === null) {
    badge.hidden = true;
  } else {
    tr.querySelector('.it-qty').value = computed;
    badge.hidden = false;
  }
  updateComposeTotal();
}
document.getElementById('add-item-btn').addEventListener('click', addItemRow);
document.getElementById('rx-fee').addEventListener('input', updateComposeTotal);

// ---------------------------------------------------------------- lab tests
/* Tests are ordered here and printed on the prescription. They are not billed
   and no results are recorded — the catalogue keeps the naming consistent. */

function renderChosenTests() {
  const host = document.getElementById('tests-chosen');
  host.innerHTML = state.tests.map((name, i) => `
    <span class="chip">
      ${esc(name)}
      <button type="button" data-i="${i}" aria-label="Remove ${esc(name)}">✕</button>
    </span>`).join('');
  document.getElementById('tests-empty').hidden = state.tests.length > 0;
  host.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.tests.splice(Number(b.dataset.i), 1);
      renderChosenTests();
    })
  );
}

document.getElementById('add-tests-btn').addEventListener('click', async () => {
  const { tests } = await api('/lab-tests');
  const byCategory = tests.reduce((acc, t) => {
    (acc[t.category] = acc[t.category] || []).push(t);
    return acc;
  }, {});

  const groups = Object.keys(byCategory).sort().map((cat) => `
    <div class="test-group" data-category="${esc(cat)}">
      <div class="test-group-name">${esc(cat)}</div>
      ${byCategory[cat].map((t) => `
        <label class="test-option">
          <input type="checkbox" value="${esc(t.name)}" ${state.tests.includes(t.name) ? 'checked' : ''} />
          <span>${esc(t.name)}</span>
        </label>`).join('')}
    </div>`).join('');

  openModal(`
    <div class="modal-head">
      <h3>Add lab tests</h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <input id="test-search" type="search" placeholder="Search tests…" />
      </div>
      <div class="test-picker" id="test-picker">${groups}</div>
      <div id="test-none" class="muted small" hidden style="padding:8px 0">No test matches that search.</div>
      <div class="field" style="margin-top:12px">
        <label for="test-custom">Not listed? Add your own</label>
        <div style="display:flex;gap:8px">
          <input id="test-custom" placeholder="e.g. Serum Ferritin" style="flex:1" />
          <button class="btn-ghost" id="test-custom-add" type="button">Add</button>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="tests-apply" type="button">Add selected</button>
    </div>
  `, { wide: true });

  const picker = document.getElementById('test-picker');
  const custom = [];

  document.getElementById('test-search').addEventListener('input', (e) => {
    const term = e.target.value.trim().toLowerCase();
    let visible = 0;
    picker.querySelectorAll('.test-group').forEach((g) => {
      let shown = 0;
      g.querySelectorAll('.test-option').forEach((o) => {
        const match = !term || o.textContent.toLowerCase().includes(term);
        o.hidden = !match;
        if (match) shown += 1;
      });
      g.hidden = shown === 0;
      visible += shown;
    });
    document.getElementById('test-none').hidden = visible > 0;
  });

  const addCustom = () => {
    const input = document.getElementById('test-custom');
    const name = input.value.trim();
    if (!name) return;
    if (![...picker.querySelectorAll('input:checked')].some((c) => c.value === name) && !custom.includes(name)) {
      custom.push(name);
    }
    input.value = '';
    toast(`"${name}" will be added`);
  };
  document.getElementById('test-custom-add').addEventListener('click', addCustom);
  document.getElementById('test-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCustom(); }
  });

  document.getElementById('tests-apply').addEventListener('click', () => {
    const checked = [...picker.querySelectorAll('input:checked')].map((c) => c.value);
    state.tests = [...new Set([...checked, ...custom])];
    closeModal();
    renderChosenTests();
  });
});

// ---------------------------------------------------------------- new medicine
/**
 * A medicine the pharmacy doesn't carry. The doctor supplies name and category
 * only — it enters the catalogue at zero stock for the pharmacy to price and
 * order, and can be prescribed straight away.
 */
document.getElementById('new-med-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-head">
      <h3>Add a medicine the pharmacy doesn't carry</h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <form class="modal-body form-grid" id="new-med-form" autocomplete="off">
      <p class="muted span-2">
        It joins the catalogue straight away and you can put it on this prescription now.
        Price and opening stock are optional — leave them blank and the pharmacy will
        set them when it orders.
      </p>
      <div class="field span-2">
        <label for="nm-name">Medicine name</label>
        <input id="nm-name" required placeholder="e.g. Rifampicin 450mg Capsule" />
      </div>
      <div class="field span-2">
        <label for="nm-category">Category</label>
        <input id="nm-category" list="category-list" placeholder="Antibiotic" />
      </div>
      <div class="field">
        <label for="nm-price">Unit price (₹) — optional</label>
        <input id="nm-price" type="number" min="0" step="0.5" placeholder="leave blank if unknown" />
      </div>
      <div class="field">
        <label for="nm-stock">Opening stock — optional</label>
        <input id="nm-stock" type="number" min="0" step="1" placeholder="leave blank if none" />
      </div>
      <div id="new-med-error" class="form-error span-2" role="alert"></div>
    </form>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="new-med-save" type="button">Add &amp; use</button>
    </div>
  `);

  const submit = async () => {
    const errBox = document.getElementById('new-med-error');
    errBox.classList.remove('show');
    const btn = document.getElementById('new-med-save');
    btn.disabled = true;
    try {
      const { medicine } = await api('/medicines', {
        method: 'POST',
        body: {
          name: document.getElementById('nm-name').value,
          category: document.getElementById('nm-category').value,
          // Blank means "not stated", so the server leaves it at zero rather
          // than treating it as a deliberate price of nothing.
          unitPrice: document.getElementById('nm-price').value,
          stock: document.getElementById('nm-stock').value,
        },
      });
      const { medicines } = await api('/medicines');
      state.medicines = medicines;
      closeModal();
      selectMedicineInComposer(medicine.id);
      toast(medicine.needsPricing
        ? `${medicine.name} added — the pharmacy will price and stock it`
        : `${medicine.name} added at ${fmtMoney(medicine.unitPrice)}`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      btn.disabled = false;
    }
  };
  document.getElementById('new-med-save').addEventListener('click', submit);
  document.getElementById('new-med-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
});

/** Re-renders every medicine dropdown, then selects the new one in the first free row. */
function selectMedicineInComposer(medicineId) {
  const rows = [...itemsTbody.querySelectorAll('tr')];
  rows.forEach((tr) => {
    const sel = tr.querySelector('.it-med');
    sel.innerHTML = medicineOptions(sel.value);
  });
  let target = rows.find((tr) => !tr.querySelector('.it-med').value);
  if (!target) {
    addItemRow();
    target = itemsTbody.lastElementChild;
  }
  target.querySelector('.it-med').value = String(medicineId);
  updateComposeTotal();
}

function composerItems() {
  return [...itemsTbody.querySelectorAll('tr')].map((tr) => ({
    medicineId: tr.querySelector('.it-med').value,
    dosage: tr.querySelector('.it-dosage').value,
    frequency: rowFrequency(tr),
    durationDays: Number(tr.querySelector('.it-days').value),
    quantity: Number(tr.querySelector('.it-qty').value),
  }));
}

function updateComposeTotal() {
  const fee = Number(document.getElementById('rx-fee').value) || 0;
  let meds = 0;
  const short = [];
  for (const it of composerItems()) {
    const m = state.medicines.find((x) => String(x.id) === String(it.medicineId));
    if (!m || !(it.quantity > 0)) continue;
    meds += m.unitPrice * it.quantity;
    // Newly added medicines are excluded: they are awaiting their first order,
    // not short, and flagging them would read as a problem with the choice.
    if (m.needsPricing) continue;
    if (m.stock <= 0) short.push(m.name);
    else if (m.stock < it.quantity) short.push(`${m.name} (only ${m.stock} left)`);
  }
  document.getElementById('compose-total').textContent = fmtMoney(meds + fee);

  document.getElementById('compose-warn').textContent = short.length
    ? `The pharmacy is short on ${short.join(', ')} — it will issue what it has and restock the rest.`
    : '';
}

/** The composer body, shared by create, edit and the draft print. */
function composerBody() {
  return {
    diagnosis: document.getElementById('rx-diagnosis').value,
    notes: document.getElementById('rx-notes').value,
    consultationFee: Number(document.getElementById('rx-fee').value),
    items: composerItems().filter((it) => it.medicineId),
    tests: state.tests,
  };
}

/** Saves the composer — creating a prescription or updating the one being edited. */
async function savePrescription() {
  const editing = state.editingRxId;
  const { prescription } = editing
    ? await api('/prescriptions/' + editing, { method: 'PUT', body: composerBody() })
    : await api('/prescriptions', {
        method: 'POST',
        body: { patientId: document.getElementById('rx-patient').value, ...composerBody() },
      });
  return { prescription, wasEditing: !!editing };
}

/** Rejects an incomplete composer with the same message the server would give. */
function composerProblem() {
  const patientId = document.getElementById('rx-patient').value;
  const body = composerBody();
  if (!state.composerPatients.some((p) => String(p.id) === String(patientId))) return 'Choose a patient first.';
  if (!body.diagnosis.trim()) return 'Enter a diagnosis first.';
  if (body.items.length === 0) return 'Add at least one medicine first.';
  return null;
}

document.getElementById('compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('compose-error');
  errBox.classList.remove('show');
  const btn = document.getElementById('compose-submit');
  btn.disabled = true;
  try {
    const { prescription, wasEditing } = await savePrescription();
    toast(wasEditing
      ? `${prescription.rxNumber} updated`
      : `${prescription.rxNumber} sent to the pharmacy`);
    resetComposer();
    switchTab('prescriptions');
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- editing
/**
 * Puts the composer into edit mode for a saved prescription. The patient is
 * fixed: re-pointing a prescription at someone else is not an edit, it is a
 * different prescription.
 */
function enterEditMode(prescription) {
  state.editingRxId = prescription.id;
  document.getElementById('compose-title').textContent = 'Edit prescription';
  document.getElementById('edit-rx-number').textContent = prescription.rxNumber;
  document.getElementById('edit-banner').hidden = false;
  document.getElementById('compose-submit').textContent = 'Save changes';
  const patientSel = document.getElementById('rx-patient');
  patientSel.value = prescription.patientId;
  patientSel.disabled = true;
}

/** Loads a pending prescription back into the composer. */
async function editPrescription(id) {
  const { prescription } = await api('/prescriptions/' + id);
  if (prescription.status !== 'pending') {
    toast('This prescription has already been issued and can no longer be edited.', 'err');
    return;
  }
  closeModal();
  switchTab('compose');
  await prepareComposer();

  enterEditMode(prescription);

  document.getElementById('rx-diagnosis').value = prescription.diagnosis;
  document.getElementById('rx-notes').value = prescription.notes || '';
  document.getElementById('rx-fee').value = prescription.consultationFee;

  itemsTbody.innerHTML = '';
  prescription.items.forEach((it) => {
    addItemRow();
    const tr = itemsTbody.lastElementChild;
    tr.querySelector('.it-med').value = it.medicineId;
    tr.querySelector('.it-dosage').value = it.dosage;
    const sel = tr.querySelector('.it-freq-sel');
    sel.innerHTML = frequencyOptions(it.frequency);
    if (sel.value === CUSTOM_FREQUENCY) {
      const text = tr.querySelector('.it-freq');
      text.hidden = false;
      text.value = it.frequency;
    }
    tr.querySelector('.it-days').value = it.durationDays;
    tr.querySelector('.it-qty').value = it.quantity;
    // These quantities were chosen deliberately — don't recalculate over them.
    tr.dataset.qtyTouched = '1';
    tr.querySelector('.qty-auto').hidden = true;
  });

  state.tests = [...prescription.tests];
  renderChosenTests();
  updateComposeTotal();
}

document.getElementById('edit-cancel').addEventListener('click', () => {
  resetComposer();
  switchTab('prescriptions');
});

// ---------------------------------------------------------------- print a draft
/**
 * Saves the prescription, then prints it. Saving first is what gives the sheet
 * a real Rx number — the numbers are sequential and gap-free, so one cannot be
 * handed out before the record exists. A new prescription therefore reaches the
 * pharmacy queue at this point, and the composer switches to editing it, so
 * printing twice revises one prescription rather than creating two.
 */
document.getElementById('compose-print').addEventListener('click', async () => {
  const errBox = document.getElementById('compose-error');
  errBox.classList.remove('show');
  const btn = document.getElementById('compose-print');

  const problem = composerProblem();
  if (problem) {
    errBox.textContent = problem;
    errBox.classList.add('show');
    return;
  }

  btn.disabled = true;
  try {
    const { prescription, wasEditing } = await savePrescription();
    if (!wasEditing) {
      enterEditMode(prescription);
      toast(`${prescription.rxNumber} saved and sent to the pharmacy`);
    } else {
      toast(`${prescription.rxNumber} updated`);
    }
    const label = `${prescription.rxNumber} ${prescription.patient ? prescription.patient.name : ''}`;
    openModal(`
      <div class="modal-head">
        <h3>Prescription <span class="mono">${esc(prescription.rxNumber)}</span></h3>
        <button class="modal-close" data-close aria-label="Close">×</button>
      </div>
      <div class="modal-body">${renderRxPad(prescription, { showBill: false })}</div>
      <div class="modal-foot">
        <button class="btn-ghost" data-close type="button">Close</button>
        ${printButton(label)}
      </div>
    `, { wide: true });
    // Straight to the print dialog. The sheet has to be in the document to be
    // printed, so it is rendered first and dismissed once printing is done.
    // Two frames guarantee it has been laid out and painted before printing.
    requestAnimationFrame(() => requestAnimationFrame(() => printModal(label, { closeAfter: true })));
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
  }
});

function resetComposer() {
  state.editingRxId = null;
  document.getElementById('compose-title').textContent = 'New prescription';
  document.getElementById('edit-banner').hidden = true;
  document.getElementById('compose-submit').textContent = 'Send to pharmacy';
  const patientSel = document.getElementById('rx-patient');
  patientSel.disabled = false;
  patientSel.value = '';
  document.getElementById('compose-error').classList.remove('show');
  document.getElementById('rx-diagnosis').value = '';
  document.getElementById('rx-notes').value = '';
  document.getElementById('rx-fee').value = '0';
  itemsTbody.innerHTML = '';
  state.tests = [];
  renderChosenTests();
  addItemRow();
  updateComposeTotal();
}

// ---------------------------------------------------------------- prescriptions & bills
const rxTbody = document.getElementById('rx-tbody');
const rxEmpty = document.getElementById('rx-empty');

document.querySelectorAll('#rx-filter button').forEach((b) =>
  b.addEventListener('click', () => {
    state.rxStatus = b.dataset.status;
    document.querySelectorAll('#rx-filter button').forEach((x) =>
      x.setAttribute('aria-pressed', String(x === b))
    );
    loadPrescriptions();
  })
);

async function loadPrescriptions() {
  const params = new URLSearchParams();
  if (state.rxStatus) params.set('status', state.rxStatus);
  if (state.showRemovedRx) params.set('hidden', '1');
  const query = params.toString();
  const { prescriptions } = await api('/prescriptions' + (query ? '?' + query : ''));
  rxTbody.innerHTML = prescriptions.map((rx) => `
    <tr class="rowlink" data-id="${rx.id}">
      <td class="mono">${esc(rx.rxNumber)}</td>
      <td>${fmtDate(rx.createdAt)}</td>
      <td><b>${esc(rx.patientName)}</b> <span class="mono muted small">${esc(rx.patientCode)}</span></td>
      <td>${esc(rx.diagnosis)}</td>
      <td class="num">${rx.itemCount}</td>
      <td>${statusPill(rx.status)}</td>
      <td class="num">${rx.billTotal != null ? fmtMoney(rx.billTotal) : '—'}</td>
      <td class="row-actions">${rx.hidden ? `
        <button class="btn-quiet" data-act="restore" type="button">Restore</button>` : `
        ${rx.status === 'pending' ? `
          <button class="btn-quiet" data-act="issue" type="button">Issue &amp; bill</button>
          <button class="btn-quiet" data-act="edit" type="button">Edit</button>` : ''}
        <button class="btn-quiet danger" data-act="remove" type="button">Remove</button>`}
      </td>
    </tr>`).join('');
  rxEmpty.hidden = prescriptions.length > 0;
  rxTbody.querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      const rx = prescriptions.find((p) => String(p.id) === tr.dataset.id);
      if (act === 'edit') editPrescription(tr.dataset.id);
      else if (act === 'issue') openIssueModal(tr.dataset.id, { onIssued: loadPrescriptions });
      else if (act === 'remove' || act === 'restore') toggleRxHidden(rx, act === 'remove');
      else openRxModal(tr.dataset.id);
    })
  );
}

async function toggleRxHidden(rx, remove) {
  if (remove && !confirm(
    rx.status === 'pending'
      ? `Remove ${rx.rxNumber}?\n\nIt is still pending, so this also withdraws it from the pharmacy queue. You can bring it back from "Show removed".`
      : `Remove ${rx.rxNumber} from the history?\n\nThe bill it produced is kept as a financial record. You can bring the prescription back from "Show removed".`
  )) return;
  try {
    if (remove) await api('/prescriptions/' + rx.id, { method: 'DELETE' });
    else await api('/prescriptions/' + rx.id, { method: 'PATCH', body: { hidden: false } });
    toast(`${rx.rxNumber} ${remove ? 'removed' : 'restored'}`);
    loadPrescriptions();
  } catch (err) {
    toast(err.message, 'err');
  }
}

document.getElementById('rx-removed-toggle').addEventListener('click', (e) => {
  state.showRemovedRx = !state.showRemovedRx;
  e.target.textContent = state.showRemovedRx ? 'Show current' : 'Show removed';
  e.target.setAttribute('aria-pressed', String(state.showRemovedRx));
  loadPrescriptions();
});

async function openRxModal(id) {
  const { prescription } = await api('/prescriptions/' + id);
  openModal(`
    <div class="modal-head">
      <h3>Prescription <span class="mono">${esc(prescription.rxNumber)}</span></h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <div class="modal-body">${renderRxPad(prescription)}</div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Close</button>
      ${prescription.status === 'pending' && String(prescription.doctorId) === String(user.id) ? `
        <button class="btn-ghost" id="rx-edit" type="button">Edit</button>
        <button class="btn-ghost" id="rx-issue" type="button">Issue &amp; bill</button>` : ''}
      ${printButton(prescription.rxNumber)}
    </div>
  `, { wide: true });
  const edit = document.getElementById('rx-edit');
  if (edit) edit.addEventListener('click', () => editPrescription(prescription.id));
  const issue = document.getElementById('rx-issue');
  if (issue) issue.addEventListener('click', () =>
    openIssueModal(prescription.id, { onIssued: loadPrescriptions }));
}

// ---------------------------------------------------------------- light auto-refresh
setInterval(() => {
  if (modalOpen()) return;
  if (state.activeTab === 'prescriptions') loadPrescriptions();
}, 20000);

// ---------------------------------------------------------------- init
switchTab('patients');
