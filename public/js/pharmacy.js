/* Pharmacy portal: pending queue → issue & bill, inventory, bills. */

const user = guard('pharmacist');
if (user) initTopbar(user);

/** Category suggestions the admin maintains; any other value can be typed. */
loadSettings().then(() => {
  document.getElementById('category-list').innerHTML =
    settings.lists.categories.map((c) => `<option value="${esc(c)}"></option>`).join('');
});

const state = {
  medicines: [],
  medSearch: '',
  showRemoved: false,
  activeTab: 'queue',
};

// ---------------------------------------------------------------- tabs
const tabs = document.querySelectorAll('.tab');
tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  state.activeTab = name;
  tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('[data-section]').forEach((s) => (s.hidden = s.id !== 'tab-' + name));
  if (name === 'queue') loadQueue();
  if (name === 'inventory') loadInventory();
  if (name === 'bills') loadBills();
}

// ---------------------------------------------------------------- pending queue
const queueTbody = document.getElementById('queue-tbody');
const queueEmpty = document.getElementById('queue-empty');
document.getElementById('queue-refresh').addEventListener('click', loadQueue);

async function loadQueue() {
  const { prescriptions } = await api('/prescriptions?status=pending');
  queueTbody.innerHTML = prescriptions.map((rx) => `
    <tr class="rowlink" data-id="${rx.id}">
      <td class="mono">${esc(rx.rxNumber)}</td>
      <td>${fmtDateTime(rx.createdAt)}</td>
      <td><b>${esc(rx.patientName)}</b> <span class="mono muted small">${esc(rx.patientCode)}</span></td>
      <td>${esc(rx.doctorName)}</td>
      <td>${esc(rx.diagnosis)}</td>
      <td class="num">${rx.itemCount}</td>
      <td style="text-align:right"><button class="btn btn-sm" type="button">Review &amp; issue</button></td>
    </tr>`).join('');
  queueEmpty.hidden = prescriptions.length > 0;
  queueTbody.querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', () => openIssueModal(tr.dataset.id, { onIssued: loadQueue }))
  );
}


// ---------------------------------------------------------------- inventory
const medTbody = document.getElementById('med-tbody');
const medEmpty = document.getElementById('med-empty');
document.getElementById('med-search').addEventListener('input', (e) => {
  state.medSearch = e.target.value.toLowerCase();
  renderInventory();
});

document.getElementById('med-removed-toggle').addEventListener('click', (e) => {
  state.showRemoved = !state.showRemoved;
  e.target.textContent = state.showRemoved ? 'Show current stock' : 'Show removed';
  e.target.setAttribute('aria-pressed', String(state.showRemoved));
  loadInventory();
});

async function loadInventory() {
  const { medicines } = await api('/medicines' + (state.showRemoved ? '?hidden=1' : ''));
  state.medicines = medicines;
  renderInventory();
}

function renderInventory() {
  const q = state.medSearch.trim();
  const list = state.medicines.filter(
    (m) => !q || m.name.toLowerCase().includes(q) || m.category.toLowerCase().includes(q)
  );
  medTbody.innerHTML = list.map((m) => `
    <tr class="${m.stock <= 0 ? 'out-row' : m.stock < 10 ? 'low-row' : ''}">
      <td>
        <b>${esc(m.name)}</b>
        ${m.needsPricing ? '<div class="muted small">added by a doctor · set a price and order stock</div>' : ''}
      </td>
      <td class="muted">${esc(m.category)}</td>
      <td class="num">${m.needsPricing ? '<span class="muted">—</span>' : fmtMoney(m.unitPrice)}</td>
      <td class="num">${m.stock}</td>
      <td>
        ${stockBadge(m.stock)}
        ${m.needsPricing ? '<span class="badge badge-pricing">Needs pricing</span>' : ''}
      </td>
      <td style="text-align:right;white-space:nowrap">${m.hidden ? `
        <button class="btn-quiet btn-sm" data-act="restore" data-id="${m.id}" type="button">Restore</button>` : `
        <button class="btn-ghost btn-sm" data-act="restock" data-id="${m.id}" type="button">Restock</button>
        <button class="btn-quiet btn-sm" data-act="edit" data-id="${m.id}" type="button">Edit</button>
        <button class="btn-quiet btn-sm" data-act="price" data-id="${m.id}" type="button">Price</button>
        <button class="btn-quiet btn-sm danger" data-act="remove" data-id="${m.id}" type="button">Remove</button>`}
      </td>
    </tr>`).join('');
  medEmpty.hidden = list.length > 0;
  medTbody.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      const med = state.medicines.find((m) => String(m.id) === String(b.dataset.id));
      if (b.dataset.act === 'restock') openRestockModal(med);
      else if (b.dataset.act === 'edit') openMedicineEditModal(med);
      else if (b.dataset.act === 'remove') removeMedicine(med);
      else if (b.dataset.act === 'restore') restoreMedicine(med);
      else openPriceModal(med);
    })
  );
}

function openMedicineEditModal(med) {
  openModal(`
    <div class="modal-head"><h3>Edit medicine</h3><button class="modal-close" data-close aria-label="Close">×</button></div>
    <form class="modal-body form-grid" id="edit-med-form" autocomplete="off">
      <div class="field span-2"><label for="edit-med-name">Name (with strength)</label><input id="edit-med-name" required value="${esc(med.name)}" /></div>
      <div class="field span-2"><label for="edit-med-category">Category</label><input id="edit-med-category" list="category-list" value="${esc(med.category)}" /></div>
      <div class="field span-2"><label for="edit-med-price">Unit price (₹)</label><input id="edit-med-price" type="number" min="0" step="0.01" required value="${med.unitPrice}" /></div>
      <p class="muted small span-2">New prescriptions and bills use these details. Existing bills are unchanged.</p>
      <div id="edit-med-error" class="form-error span-2" role="alert"></div>
    </form>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="edit-med-save" type="button">Save changes</button>
    </div>`);

  const submit = async () => {
    const errBox = document.getElementById('edit-med-error');
    const button = document.getElementById('edit-med-save');
    errBox.classList.remove('show');
    button.disabled = true;
    try {
      const { medicine } = await api('/medicines/' + med.id, {
        method: 'PATCH',
        body: {
          name: document.getElementById('edit-med-name').value,
          category: document.getElementById('edit-med-category').value,
          unitPrice: document.getElementById('edit-med-price').value,
        },
      });
      closeModal();
      toast(`${medicine.name} updated`);
      loadInventory();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
      button.disabled = false;
    }
  };
  document.getElementById('edit-med-save').addEventListener('click', submit);
  document.getElementById('edit-med-form').addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });
}

async function removeMedicine(med) {
  if (!confirm(
    `Remove ${med.name} from the inventory?\n\nIt disappears from prescribing and this list. Past bills are untouched, a pending prescription containing it can still be issued, and you can restore it from "Show removed".`
  )) return;
  try {
    await api('/medicines/' + med.id, { method: 'DELETE' });
    toast(`${med.name} removed`);
    loadInventory();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function restoreMedicine(med) {
  try {
    await api('/medicines/' + med.id, { method: 'PATCH', body: { hidden: false } });
    toast(`${med.name} restored`);
    loadInventory();
  } catch (err) {
    toast(err.message, 'err');
  }
}

document.getElementById('add-med-btn').addEventListener('click', () => {
  openModal(`
    <div class="modal-head"><h3>Add medicine</h3><button class="modal-close" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <form id="med-form" class="form-grid" autocomplete="off">
        <div class="field span-2"><label for="m-name">Name (with strength)</label><input id="m-name" required placeholder="e.g. Paracetamol 650mg Tablet" /></div>
        <div class="field span-2"><label for="m-cat">Category</label><input id="m-cat" list="category-list" placeholder="e.g. Analgesic" /></div>
        <div class="field"><label for="m-price">Unit price (₹)</label><input id="m-price" type="number" min="0" step="0.5" required /></div>
        <div class="field"><label for="m-stock">Opening stock</label><input id="m-stock" type="number" min="0" step="1" required /></div>
      </form>
      <div id="med-form-error" class="form-error" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="med-save" type="button">Add to inventory</button>
    </div>`);
  const submit = async () => {
    const errBox = document.getElementById('med-form-error');
    errBox.classList.remove('show');
    try {
      const { medicine } = await api('/medicines', {
        method: 'POST',
        body: {
          name: document.getElementById('m-name').value,
          category: document.getElementById('m-cat').value,
          unitPrice: document.getElementById('m-price').value,
          stock: Number(document.getElementById('m-stock').value),
        },
      });
      closeModal();
      toast(`${medicine.name} added to inventory`);
      loadInventory();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  };
  document.getElementById('med-save').addEventListener('click', submit);
  document.getElementById('med-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
});

function openRestockModal(med) {
  openModal(`
    <div class="modal-head"><h3>Restock ${esc(med.name)}</h3><button class="modal-close" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <p class="muted small">Current stock: <b class="mono">${med.stock}</b></p>
      <div class="field"><label for="restock-qty">Add quantity</label><input id="restock-qty" type="number" min="1" value="50" /></div>
      <div id="restock-error" class="form-error" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="restock-save" type="button">Add stock</button>
    </div>`);
  document.getElementById('restock-save').addEventListener('click', async () => {
    const errBox = document.getElementById('restock-error');
    errBox.classList.remove('show');
    try {
      const { medicine } = await api('/medicines/' + med.id, {
        method: 'PATCH',
        body: { addStock: Number(document.getElementById('restock-qty').value) },
      });
      closeModal();
      toast(`${medicine.name} → ${medicine.stock} in stock`);
      loadInventory();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  });
}

function openPriceModal(med) {
  openModal(`
    <div class="modal-head"><h3>Update price · ${esc(med.name)}</h3><button class="modal-close" data-close aria-label="Close">×</button></div>
    <div class="modal-body">
      <div class="field"><label for="price-val">Unit price (₹)</label><input id="price-val" type="number" min="0" step="0.5" value="${med.unitPrice}" /></div>
      <p class="muted small" style="margin-top:8px">New bills use the updated price. Existing bills are unchanged.</p>
      <div id="price-error" class="form-error" role="alert"></div>
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Cancel</button>
      <button class="btn" id="price-save" type="button">Save price</button>
    </div>`);
  document.getElementById('price-save').addEventListener('click', async () => {
    const errBox = document.getElementById('price-error');
    errBox.classList.remove('show');
    try {
      const { medicine } = await api('/medicines/' + med.id, {
        method: 'PATCH',
        body: { unitPrice: Number(document.getElementById('price-val').value) },
      });
      closeModal();
      toast(`${medicine.name} price updated to ${fmtMoney(medicine.unitPrice)}`);
      loadInventory();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.add('show');
    }
  });
}

// ---------------------------------------------------------------- bills
const billsTbody = document.getElementById('bills-tbody');
const billsEmpty = document.getElementById('bills-empty');

async function loadBills() {
  const { bills } = await api('/bills');
  billsTbody.innerHTML = bills.map((b) => `
    <tr class="rowlink" data-id="${b.id}">
      <td class="mono">${esc(b.billNumber)}</td>
      <td>${fmtDateTime(b.createdAt)}</td>
      <td class="mono">${esc(b.rxNumber)}</td>
      <td><b>${esc(b.patientName)}</b></td>
      <td>${esc(b.doctorName)}</td>
      <td class="num">${fmtMoney(b.grandTotal)}</td>
    </tr>`).join('');
  billsEmpty.hidden = bills.length > 0;
  billsTbody.querySelectorAll('tr').forEach((tr) =>
    tr.addEventListener('click', () => openBillModal(tr.dataset.id))
  );
}

async function openBillModal(id) {
  const { bill } = await api('/bills/' + id);
  const p = bill.patient || {};
  openModal(`
    <div class="modal-head">
      <h3>Bill <span class="mono">${esc(bill.billNumber)}</span></h3>
      <button class="modal-close" data-close aria-label="Close">×</button>
    </div>
    <div class="modal-body bill-print-body">
      <div class="rx-diagnosis screen-only" style="margin-bottom:10px">
        <b>${esc(p.name || '')}</b> <span class="mono muted">${esc(p.code || '')}</span>
        · Prescribed by ${esc(bill.doctorName)}
        · <button class="btn-quiet btn-sm" id="bill-view-rx" type="button" style="padding:2px 6px">View <span class="mono">${esc(bill.rxNumber)}</span></button>
      </div>
      ${renderInvoice(bill)}
    </div>
    <div class="modal-foot">
      <button class="btn-ghost" data-close type="button">Close</button>
      ${printButton(bill.billNumber)}
    </div>
  `, { wide: true });
  document.getElementById('bill-view-rx').addEventListener('click', async () => {
    const { prescription } = await api('/prescriptions/' + bill.prescriptionId);
    openModal(`
      <div class="modal-head">
        <h3>Prescription <span class="mono">${esc(prescription.rxNumber)}</span></h3>
        <button class="modal-close" data-close aria-label="Close">×</button>
      </div>
      <div class="modal-body">${renderRxPad(prescription)}</div>
      <div class="modal-foot">
        <button class="btn-ghost" data-close type="button">Close</button>
        ${printButton(prescription.rxNumber)}
      </div>
    `, { wide: true });
  });
}

// ---------------------------------------------------------------- auto-refresh queue
setInterval(() => {
  if (modalOpen()) return;
  if (state.activeTab === 'queue') loadQueue();
}, 15000);

// ---------------------------------------------------------------- init
switchTab('queue');
