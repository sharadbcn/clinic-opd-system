-- Initial schema. Human-readable codes (P-101, RX-1001, INV-5001) are
-- generated from the row id so they stay sequential and gap-free.

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  salt          TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('doctor', 'pharmacist')),
  specialty     TEXT
);

CREATE TABLE sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL
);

CREATE TABLE patients (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    GENERATED ALWAYS AS ('P-' || (100 + id)) VIRTUAL,
  name       TEXT    NOT NULL,
  age        INTEGER NOT NULL,
  gender     TEXT    NOT NULL CHECK (gender IN ('Male', 'Female', 'Other')),
  phone      TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT    NOT NULL
);

CREATE TABLE medicines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  category   TEXT    NOT NULL,
  unit_price REAL    NOT NULL CHECK (unit_price >= 0),
  stock      INTEGER NOT NULL CHECK (stock >= 0)
);
CREATE UNIQUE INDEX medicines_name_unique ON medicines (name COLLATE NOCASE);

CREATE TABLE prescriptions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rx_number        TEXT    GENERATED ALWAYS AS ('RX-' || (1000 + id)) VIRTUAL,
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  doctor_id        INTEGER NOT NULL REFERENCES users(id),
  diagnosis        TEXT    NOT NULL,
  notes            TEXT,
  consultation_fee REAL    NOT NULL CHECK (consultation_fee >= 0),
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'issued')),
  pharmacist_id    INTEGER REFERENCES users(id),
  bill_id          INTEGER REFERENCES bills(id),
  created_at       TEXT    NOT NULL,
  issued_at        TEXT
);
CREATE INDEX prescriptions_patient ON prescriptions (patient_id);
CREATE INDEX prescriptions_doctor  ON prescriptions (doctor_id);
CREATE INDEX prescriptions_status  ON prescriptions (status);

CREATE TABLE prescription_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  medicine_id     INTEGER NOT NULL REFERENCES medicines(id),
  medicine_name   TEXT    NOT NULL,   -- snapshot so history survives renames
  dosage          TEXT    NOT NULL,
  frequency       TEXT    NOT NULL,
  duration_days   INTEGER NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  issued_quantity INTEGER             -- filled by the pharmacy at issue time
);
CREATE INDEX prescription_items_rx ON prescription_items (prescription_id);

CREATE TABLE bills (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_number      TEXT    GENERATED ALWAYS AS ('INV-' || (5000 + id)) VIRTUAL,
  prescription_id  INTEGER NOT NULL UNIQUE REFERENCES prescriptions(id),
  patient_id       INTEGER NOT NULL REFERENCES patients(id),
  doctor_id        INTEGER NOT NULL REFERENCES users(id),
  pharmacist_id    INTEGER NOT NULL REFERENCES users(id),
  medicines_total  REAL    NOT NULL,
  consultation_fee REAL    NOT NULL,
  grand_total      REAL    NOT NULL,
  created_at       TEXT    NOT NULL
);
CREATE INDEX bills_doctor ON bills (doctor_id);

CREATE TABLE bill_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id     INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id),
  name        TEXT    NOT NULL,       -- snapshot at issue time
  quantity    INTEGER NOT NULL,
  unit_price  REAL    NOT NULL,       -- price at issue time
  amount      REAL    NOT NULL
);
CREATE INDEX bill_items_bill ON bill_items (bill_id);
