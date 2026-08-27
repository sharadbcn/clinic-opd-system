/**
 * Clinic settings and the suggestion lists the admin maintains.
 * Stored as rows in `app_meta`, so there is no schema to migrate when a new
 * setting is added — give it a default here and it appears.
 */
const db = require('./db');

const CLINIC_FIELDS = ['name', 'address', 'phone', 'email', 'regNo', 'logoDataUrl'];
const LIST_NAMES = ['specialties', 'categories', 'frequencies'];

const DEFAULTS = {
  clinic: {
    name: 'Sunrise Clinic',
    address: '',
    phone: '',
    email: '',
    regNo: '',
    logoDataUrl: '',
  },
  lists: {
    specialties: [
      'General Physician', 'Internal Medicine', 'Paediatrics', 'Orthopaedics',
      'Dermatology', 'ENT', 'Gynaecology', 'Cardiology', 'Psychiatry', 'Pharmacy',
    ],
    categories: [
      'Analgesic', 'Antibiotic', 'Antihistamine', 'Antacid', 'Antidiabetic',
      'Antihypertensive', 'Rehydration', 'Cough & Cold', 'Supplement', 'General',
    ],
    frequencies: [
      '1-0-0 (morning)', '0-1-0 (afternoon)', '0-0-1 (night)',
      '1-0-1 (morning & night)', '1-1-1 (thrice daily)',
      'Once daily', 'SOS (as needed)', 'As directed',
    ],
  },
};

const MAX_TEXT = 120;
const MAX_ADDRESS = 240;
const MAX_LOGO_DATA_URL = 60000;
const MAX_LIST = 60;

/** Everything the app needs to render its letterhead and dropdowns. */
function all() {
  const clinic = {};
  for (const f of CLINIC_FIELDS) {
    const stored = db.getMeta('clinic.' + f);
    clinic[f] = stored === null ? DEFAULTS.clinic[f] : stored;
  }
  const lists = {};
  for (const name of LIST_NAMES) {
    const stored = db.getMeta('list.' + name);
    let parsed = null;
    if (stored !== null) {
      try { parsed = JSON.parse(stored); } catch { parsed = null; }
    }
    lists[name] = Array.isArray(parsed) && parsed.length ? parsed : DEFAULTS.lists[name];
  }
  return { clinic, lists };
}

function cleanText(value, { field, max }) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    throw db.httpError(400, `${field} must be ${max} characters or fewer.`);
  }
  return text;
}

/**
 * Partial update: only the keys present are written, so editing the phone
 * number cannot blank the clinic name.
 */
function update({ clinic, lists }) {
  if (clinic !== undefined) {
    if (clinic === null || typeof clinic !== 'object') {
      throw db.httpError(400, 'Clinic settings must be an object.');
    }
    for (const field of CLINIC_FIELDS) {
      if (!(field in clinic)) continue;
      if (field === 'logoDataUrl') {
        const logo = String(clinic[field] || '').trim();
        if (logo && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(logo)) {
          throw db.httpError(400, 'Clinic logo must be a PNG, JPEG or WebP image.');
        }
        if (logo.length > MAX_LOGO_DATA_URL) {
          throw db.httpError(400, 'Clinic logo is too large. Choose a smaller image.');
        }
        db.setMeta('clinic.' + field, logo);
        continue;
      }
      const max = field === 'address' ? MAX_ADDRESS : MAX_TEXT;
      const text = cleanText(clinic[field], { field: field === 'regNo' ? 'Registration number' : `Clinic ${field}`, max });
      if (field === 'name' && !text) {
        throw db.httpError(400, 'Clinic name is required.');
      }
      db.setMeta('clinic.' + field, text);
    }
  }

  if (lists !== undefined) {
    if (lists === null || typeof lists !== 'object') {
      throw db.httpError(400, 'Lists must be an object.');
    }
    for (const name of LIST_NAMES) {
      if (!(name in lists)) continue;
      const raw = lists[name];
      if (!Array.isArray(raw)) throw db.httpError(400, `${name} must be a list.`);
      const cleaned = [...new Set(
        raw.map((v) => cleanText(v, { field: name, max: MAX_TEXT })).filter(Boolean)
      )];
      if (!cleaned.length) throw db.httpError(400, `${name} cannot be empty — keep at least one option.`);
      if (cleaned.length > MAX_LIST) throw db.httpError(400, `${name} is limited to ${MAX_LIST} options.`);
      db.setMeta('list.' + name, JSON.stringify(cleaned));
    }
  }

  return all();
}

module.exports = { all, update, DEFAULTS, CLINIC_FIELDS, LIST_NAMES };
