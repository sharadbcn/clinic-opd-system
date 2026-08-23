-- "Remove" hides a record rather than deleting it: staff and medicines are
-- referenced by prescriptions and bills, and deleting either would corrupt
-- history. Nothing is ever removed from this database.
ALTER TABLE users     ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
ALTER TABLE medicines ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));

-- Lab tests a doctor can order. Not billed and no results are recorded — the
-- catalogue exists so the tests are picked consistently and print on the Rx.
CREATE TABLE lab_tests (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  category TEXT    NOT NULL,
  hidden   INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1))
);
CREATE UNIQUE INDEX lab_tests_name_unique ON lab_tests (name COLLATE NOCASE);

-- Tests ordered on one prescription. The name is a snapshot, so renaming or
-- removing a catalogue entry never rewrites a prescription already issued.
CREATE TABLE prescription_tests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  prescription_id INTEGER NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL
);
CREATE INDEX prescription_tests_rx ON prescription_tests (prescription_id);

INSERT INTO lab_tests (name, category) VALUES
  ('Complete Blood Count (CBC)',        'Haematology'),
  ('Haemoglobin (Hb)',                  'Haematology'),
  ('ESR',                               'Haematology'),
  ('Peripheral Smear',                  'Haematology'),
  ('Platelet Count',                    'Haematology'),
  ('Fasting Blood Sugar (FBS)',         'Biochemistry'),
  ('Post Prandial Blood Sugar (PPBS)',  'Biochemistry'),
  ('HbA1c',                             'Biochemistry'),
  ('Lipid Profile',                     'Biochemistry'),
  ('Liver Function Test (LFT)',         'Biochemistry'),
  ('Kidney Function Test (KFT)',        'Biochemistry'),
  ('Serum Uric Acid',                   'Biochemistry'),
  ('Serum Electrolytes',                'Biochemistry'),
  ('Serum Calcium',                     'Biochemistry'),
  ('Vitamin D (25-OH)',                 'Biochemistry'),
  ('Thyroid Profile (TSH, T3, T4)',     'Endocrinology'),
  ('TSH',                               'Endocrinology'),
  ('Urine Routine & Microscopy',        'Urine'),
  ('Urine Culture & Sensitivity',       'Urine'),
  ('Dengue NS1 Antigen',                'Serology'),
  ('Widal Test',                        'Serology'),
  ('Malaria Antigen',                   'Serology'),
  ('HIV I & II',                        'Serology'),
  ('HBsAg',                             'Serology'),
  ('X-Ray Chest PA',                    'Imaging'),
  ('USG Abdomen & Pelvis',              'Imaging'),
  ('ECG',                               'Imaging'),
  ('2D Echocardiography',               'Imaging');
