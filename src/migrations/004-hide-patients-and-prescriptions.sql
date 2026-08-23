-- Patients and prescriptions can be removed from the lists they appear in.
-- As with staff and medicines, "remove" hides the row: a patient is referenced
-- by their prescriptions and bills, and a prescription by the bill it produced,
-- so deleting either would corrupt a financial record already given to someone.
ALTER TABLE patients      ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
ALTER TABLE prescriptions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));

CREATE INDEX patients_hidden      ON patients (hidden);
CREATE INDEX prescriptions_hidden ON prescriptions (hidden);
