/* Administration portal: create and manage clinical staff, view clinic counts. */

const user = guard('admin');
if (user) initTopbar(user);
loadSettings();

const state = {
  staff: [],
  search: '',
  showRemovedStaff: false,
  tests: [],
  testSearch: '',
  showRemovedTests: false,
  activeTab: 'staff',
};

// ---------------------------------------------------------------- tabs
const tabs = document.querySelectorAll('.tab');
tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  state.activeTab = name;
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('[data-section]').forEach((s) => (s.hidden = s.id !== 'tab-' + name));
  if (name === 'staff') loadStaff();
  if (name === 'clinic') loadClinicForms();
  if (name === 'overview') loadStats();
}

// ---------------------------------------------------------------- staff
const staffTbody = document.getElementById('staff-tbody');
const staffEmpty = document.getElementById('staff-empty');

document.getElementById('staff-search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderStaff();
});

async function loadStaff() {
  const { users } = await api('/users' + (state.showRemovedStaff ? '?hidden=1' : ''));
  state.staff = users;
  renderStaff();
}

document.getElementById('staff-removed-toggle').addEventListener('click', (e) => {
  state.showRemovedStaff = !state.showRemovedStaff;
  e.target.textContent = state.showRemovedStaff ? 'Show current staff' : 'Show removed';
  e.target.setAttribute('aria-pressed', String(state.showRemovedStaff));
  loadStaff();
});

function renderStaff() {
  const list = state.search
    ? state.staff.filter((u) =>
        u.name.toLowerCase().includes(state.search) || u.username.toLowerCase().includes(state.search))
    : state.staff;

  staffTbody.innerHTML = list.map((u) => `
    <tr class="${u.active ? '' : 'row-muted'}" data-id="${u.id}">
      <td><div class="med-name">${esc(u.name)}</div></td>
      <td class="mono">${esc(u.username)}</td>
      <td>${u.role === 'doctor' ? 'Doctor' : 'Pharmacist'}</td>
      <td class="${u.specialty ? 'muted' : ''}">${u.specialty
        ? esc(u.specialty)
        : '<span class="badge badge-pricing">Not set</span>'}</td>
      <td>${u.active
        ? '<span class="pill pill-issued">Active</span>'
        : '<span class="pill pill-off">Deactivated</span>'}</td>
      <td class="muted">${fmtDate(u.createdAt)}</td>
      <td class="row-actions">${u.hidden ? `
        <button class="btn-quiet" data-act="restore" type="button">Restore</button>` : `
        <button class="btn-quiet" data-act="details" type="button">Edit</button>
        <button class="btn-quiet" data-act="password" type="button">Reset password</button>
        <button class="btn-quiet" data-act="toggle" type="button">${u.active ? 'Deactivate' : 'Reactivate'}</button>
        <button class="btn-quiet danger" data-act="remove" type="button">Remove</button>`}
      </td>
    </tr>`).join('');

  staffEmpty.hidden = list.length > 0;
  staffTbody.querySelectorAll('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => {
      const u = state.staff.find((s) => String(s.id) === b.closest('tr').dataset.id);
      if (b.dataset.act === 'toggle') toggleStaff(u);
      else if (b.dataset.act === 'details') openDetailsModal(u);
      else if (b.dataset.act === 'remove') removeStaff(u);
      else if (b.dataset.act === 'restore') restoreStaff(u);
      else openPasswordModal(u);
    })
  );
}

async function toggleStaff(u) {
  const turningOff = u.active;
  if (turningOff && !confirm(
    `Deactivate ${u.name}?\n\nThey will be signed out immediately and cannot sign in again until reactivated. Their prescriptions and bills are kept.`
  )) return;
  try {
    await api('/users/' + u.id, { method: 'PATCH', body: { active: !u.active } });
    toast(`${u.name} ${turningOff ? 'deactivated' : 'reactivated'}`);
    loadStaff();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function removeStaff(u) {
  if (!confirm(
    `Remove ${u.name}?\n\nThey are hidden from the clinic and signed out immediately. Their prescriptions and bills are kept, and you can restore them from "Show removed".`
  )) return;
  try {
    await api('/users/' + u.id, { method: 'DELETE' });
    toast(`${u.name} removed`);
    loadStaff();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function restoreStaff(u) {
  try {
    await api('/users/' + u.id, { method: 'PATCH', body: { hidden: false, active: true } });
    toast(`${u.name} restored`);
    loadStaff();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ---------------------------------------------------------------- add staff
document.getElementById('add-staff-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-head">
      <h3>Add staff</h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <form class="modal-body form-grid" id="staff-form" autocomplete="off">
      <div class="field">
        <label for="s-name">Full name</label>
        <input id="s-name" required placeholder="Dr. Meera Sharma" />
      </div>
      <div class="field">
        <label for="s-role">Role</label>
        <select id="s-role">
          <option value="doctor">Doctor</option>
          <option value="pharmacist">Pharmacist</option>
        </select>
      </div>
      <div class="field">
        <label for="s-username">Username</label>
        <input id="s-username" required placeholder="dr.sharma" autocapitalize="none" spellcheck="false" />
      </div>
      <div class="field">
        <label for="s-password">Password</label>
        <input id="s-password" required type="text" placeholder="at least 6 characters" />
      </div>
      <div class="field span-2">
        <label for="s-specialty">Specialty</label>
        <input id="s-specialty" list="specialty-list" placeholder="General Physician" />
        <datalist id="specialty-list"></datalist>
      </div>
      <div id="staff-error" class="form-error span-2" role="alert"></div>
    </form>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="staff-save" type="button">Create account</button>
    </div>
  `);

  const roleSel = document.getElementById('s-role');
  const specialty = document.getElementById('s-specialty');
  document.getElementById('specialty-list').innerHTML =
    settings.lists.specialties.map((s) => `<option value="${esc(s)}"></option>`).join('');
  roleSel.addEventListener('change', () => {
    if (roleSel.value === 'pharmacist' && !specialty.value) specialty.value = 'Pharmacy';
  });

  const submit = async () => {
    const errBox = document.getElementById('staff-error');
    errBox.classList.remove('show');
    const btn = document.getElementById('staff-save');
    btn.disabled = true;
    try {
      const { user: created } = await api('/users', {
        method: 'POST',
        body: {
          name: document.getElementById('s-name').value,
          username: document.getElementById('s-username').value,
          password: document.getElementById('s-password').value,
          role: roleSel.value,
          specialty: specialty.value,
        },
      });
      closeModal();
      toast(`${created.name} can now sign in as ${created.username}`);
      loadStaff();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      btn.disabled = false;
    }
  };
  document.getElementById('staff-save').addEventListener('click', submit);
  document.getElementById('staff-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
});

// ---------------------------------------------------------------- edit details
/**
 * Corrects a staff member's name and specialty. A doctor's specialty prints
 * under their name on every prescription, so it has to be fixable after the
 * account was created rather than only at that moment.
 */
function openDetailsModal(u) {
  openModal(`
    <div class="modal-head">
      <h3>Edit ${esc(u.name)}</h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <form class="modal-body" id="details-form" autocomplete="off">
      <div class="field">
        <label for="d-name">Full name</label>
        <input id="d-name" required value="${esc(u.name)}" />
      </div>
      <div class="field">
        <label for="d-specialty">Specialty</label>
        <input id="d-specialty" list="specialty-list" value="${esc(u.specialty || '')}"
               placeholder="${u.role === 'doctor' ? 'General Physician' : 'Pharmacy'}" />
        <datalist id="specialty-list"></datalist>
        <p class="muted small" style="margin:4px 0 0">
          ${u.role === 'doctor'
            ? 'Printed under the doctor\'s name on every prescription. Leave blank for none.'
            : 'Shown on the pharmacist\'s profile.'}
        </p>
      </div>
      <div id="details-error" class="form-error" role="alert"></div>
    </form>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="details-save" type="button">Save</button>
    </div>
  `);
  document.getElementById('specialty-list').innerHTML =
    settings.lists.specialties.map((x) => `<option value="${esc(x)}"></option>`).join('');

  const submit = async () => {
    const errBox = document.getElementById('details-error');
    errBox.classList.remove('show');
    const btn = document.getElementById('details-save');
    btn.disabled = true;
    try {
      const { user: saved } = await api('/users/' + u.id, {
        method: 'PATCH',
        body: {
          name: document.getElementById('d-name').value,
          specialty: document.getElementById('d-specialty').value,
        },
      });
      closeModal();
      toast(`${saved.name} updated`);
      loadStaff();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      btn.disabled = false;
    }
  };
  document.getElementById('details-save').addEventListener('click', submit);
  document.getElementById('details-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// ---------------------------------------------------------------- reset password
function openPasswordModal(u) {
  openModal(`
    <div class="modal-head">
      <h3>Reset password</h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <form class="modal-body" id="pw-form" autocomplete="off">
      <p class="muted">Set a new password for <b>${esc(u.name)}</b> (<span class="mono">${esc(u.username)}</span>).
      They will be signed out and must use the new password.</p>
      <div class="field">
        <label for="pw-new">New password</label>
        <input id="pw-new" required type="text" placeholder="at least 6 characters" />
      </div>
      <div id="pw-error" class="form-error" role="alert"></div>
    </form>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="pw-save" type="button">Set password</button>
    </div>
  `);

  const submit = async () => {
    const errBox = document.getElementById('pw-error');
    errBox.classList.remove('show');
    const btn = document.getElementById('pw-save');
    btn.disabled = true;
    try {
      await api('/users/' + u.id, { method: 'PATCH', body: { password: document.getElementById('pw-new').value } });
      closeModal();
      toast(`Password updated for ${u.name}`);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      btn.disabled = false;
    }
  };
  document.getElementById('pw-save').addEventListener('click', submit);
  document.getElementById('pw-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
}

// ---------------------------------------------------------------- clinic settings
const CLINIC_FIELDS = [['c-name', 'name'], ['c-address', 'address'], ['c-phone', 'phone'],
  ['c-email', 'email'], ['c-regno', 'regNo']];
const LIST_FIELDS = [['l-specialties', 'specialties'], ['l-categories', 'categories'],
  ['l-frequencies', 'frequencies']];
let clinicLogoDataUrl = '';

function renderClinicLogoPreview() {
  const preview = document.getElementById('c-logo-preview');
  preview.innerHTML = clinicLogoDataUrl
    ? `<img src="${clinicLogoDataUrl}" alt="Clinic logo preview" />`
    : '<span>No logo</span>';
  document.getElementById('c-logo-remove').hidden = !clinicLogoDataUrl;
}

function resizeClinicLogo(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    return Promise.reject(new Error('Choose a PNG, JPEG or WebP image.'));
  }
  if (file.size > 3 * 1024 * 1024) {
    return Promise.reject(new Error('Logo file must be 3 MB or smaller.'));
  }
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let scale = Math.min(1, 360 / image.naturalWidth, 160 / image.naturalHeight);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      let result = '';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        result = canvas.toDataURL('image/webp', Math.max(0.45, 0.88 - attempt * 0.06));
        if (result.length <= 60000) break;
        scale *= 0.82;
      }
      if (result.length > 60000) reject(new Error('Logo could not be compressed enough. Choose a simpler image.'));
      else resolve(result);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The selected image could not be read.'));
    };
    image.src = objectUrl;
  });
}

async function loadClinicForms() {
  await loadSettings();
  loadTestCatalogue();
  CLINIC_FIELDS.forEach(([id, key]) => { document.getElementById(id).value = settings.clinic[key] || ''; });
  clinicLogoDataUrl = settings.clinic.logoDataUrl || '';
  renderClinicLogoPreview();
  LIST_FIELDS.forEach(([id, key]) => { document.getElementById(id).value = settings.lists[key].join('\n'); });
}

document.getElementById('c-logo').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const errBox = document.getElementById('clinic-error');
  errBox.classList.remove('show');
  try {
    clinicLogoDataUrl = await resizeClinicLogo(file);
    renderClinicLogoPreview();
  } catch (err) {
    event.target.value = '';
    errBox.textContent = err.message;
    errBox.classList.add('show');
  }
});

document.getElementById('c-logo-remove').addEventListener('click', () => {
  clinicLogoDataUrl = '';
  document.getElementById('c-logo').value = '';
  renderClinicLogoPreview();
});

/** Saves a settings form, showing the server's message on failure. */
async function saveSettings(body, { errorId, buttonId, message }) {
  const errBox = document.getElementById(errorId);
  const btn = document.getElementById(buttonId);
  errBox.classList.remove('show');
  btn.disabled = true;
  try {
    const { settings: saved } = await api('/settings', { method: 'PUT', body });
    settings = saved;
    applyClinicBranding(); // the topbar and page title update immediately
    toast(message);
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.add('show');
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('clinic-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const clinic = {};
  CLINIC_FIELDS.forEach(([id, key]) => { clinic[key] = document.getElementById(id).value; });
  clinic.logoDataUrl = clinicLogoDataUrl;
  saveSettings({ clinic }, { errorId: 'clinic-error', buttonId: 'clinic-save', message: 'Clinic details saved' });
});

document.getElementById('lists-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const lists = {};
  LIST_FIELDS.forEach(([id, key]) => {
    lists[key] = document.getElementById(id).value.split('\n').map((v) => v.trim()).filter(Boolean);
  });
  saveSettings({ lists }, { errorId: 'lists-error', buttonId: 'lists-save', message: 'Lists saved' });
});

// ---------------------------------------------------------------- lab test catalogue
const testsTbody = document.getElementById('tests-tbody');

document.getElementById('test-cat-search').addEventListener('input', (e) => {
  state.testSearch = e.target.value.trim().toLowerCase();
  renderTestCatalogue();
});
document.getElementById('tests-removed-toggle').addEventListener('click', (e) => {
  state.showRemovedTests = !state.showRemovedTests;
  e.target.textContent = state.showRemovedTests ? 'Show current tests' : 'Show removed';
  e.target.setAttribute('aria-pressed', String(state.showRemovedTests));
  loadTestCatalogue();
});

async function loadTestCatalogue() {
  const { tests } = await api('/lab-tests' + (state.showRemovedTests ? '?hidden=1' : ''));
  state.tests = tests;
  renderTestCatalogue();
}

function renderTestCatalogue() {
  const term = state.testSearch || '';
  const list = term
    ? state.tests.filter((t) => t.name.toLowerCase().includes(term) || t.category.toLowerCase().includes(term))
    : state.tests;

  testsTbody.innerHTML = list.map((t) => `
    <tr data-id="${t.id}" class="${t.hidden ? 'row-muted' : ''}">
      <td><div class="med-name">${esc(t.name)}</div></td>
      <td class="muted">${esc(t.category)}</td>
      <td class="row-actions">
        <button class="btn-quiet" data-act="${t.hidden ? 'restore' : 'remove'}" type="button">
          ${t.hidden ? 'Restore' : 'Remove'}
        </button>
      </td>
    </tr>`).join('');
  document.getElementById('tests-cat-empty').hidden = list.length > 0;

  testsTbody.querySelectorAll('button[data-act]').forEach((b) =>
    b.addEventListener('click', async () => {
      const t = state.tests.find((x) => String(x.id) === b.closest('tr').dataset.id);
      try {
        if (b.dataset.act === 'remove') await api('/lab-tests/' + t.id, { method: 'DELETE' });
        else await api('/lab-tests/' + t.id, { method: 'PATCH', body: { hidden: false } });
        toast(`${t.name} ${b.dataset.act === 'remove' ? 'removed' : 'restored'}`);
        loadTestCatalogue();
      } catch (err) {
        toast(err.message, 'err');
      }
    })
  );
}

document.getElementById('add-test-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-head">
      <h3>Add lab test</h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <form class="modal-body" id="test-form" autocomplete="off">
      <div class="field">
        <label for="t-name">Test name</label>
        <input id="t-name" required placeholder="e.g. Vitamin B12" />
      </div>
      <div class="field">
        <label for="t-category">Category</label>
        <input id="t-category" list="test-cat-list" placeholder="Biochemistry" />
        <datalist id="test-cat-list"></datalist>
      </div>
      <div id="test-error" class="form-error" role="alert"></div>
    </form>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="test-save" type="button">Add test</button>
    </div>
  `);
  document.getElementById('test-cat-list').innerHTML =
    [...new Set(state.tests.map((t) => t.category))].sort()
      .map((c) => `<option value="${esc(c)}"></option>`).join('');

  const submit = async () => {
    const errBox = document.getElementById('test-error');
    errBox.classList.remove('show');
    const btn = document.getElementById('test-save');
    btn.disabled = true;
    try {
      const { test } = await api('/lab-tests', {
        method: 'POST',
        body: {
          name: document.getElementById('t-name').value,
          category: document.getElementById('t-category').value,
        },
      });
      closeModal();
      toast(`${test.name} added to the catalogue`);
      loadTestCatalogue();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      btn.disabled = false;
    }
  };
  document.getElementById('test-save').addEventListener('click', submit);
  document.getElementById('test-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
});

// ---------------------------------------------------------------- clinic stats
const STAT_ROWS = [
  ['Active doctors', 'doctors'],
  ['Active pharmacists', 'pharmacists'],
  ['Deactivated staff', 'inactiveStaff'],
  ['Patients registered', 'patients'],
  ['Prescriptions written', 'prescriptions'],
  ['Waiting at the pharmacy', 'pending'],
  ['Bills generated', 'bills'],
  ['Medicines in catalogue', 'medicines'],
  ['Out of stock', 'outOfStock'],
  ['Awaiting a price', 'needsPricing'],
];

document.getElementById('stats-refresh').addEventListener('click', loadStats);

async function loadStats() {
  const { stats } = await api('/stats');
  document.getElementById('stats-tbody').innerHTML =
    STAT_ROWS.map(([label, key]) => `
      <tr>
        <td>${label}</td>
        <td class="num mono">${stats[key]}</td>
      </tr>`).join('') +
    `<tr class="total-row">
       <td>Total billed</td>
       <td class="num mono">${fmtMoney(stats.revenue)}</td>
     </tr>`;
}

// ---------------------------------------------------------------- init
switchTab('staff');
