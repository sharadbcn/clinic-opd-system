# Sunrise Clinic OPD

A local outpatient-department system for a small clinic. Doctors register
patients, review visit history, and send prescriptions to the pharmacy. The
pharmacist works a pending queue, issues medicines against live stock, manages
inventory, and generates bills that flow straight back to the doctor.

Everything runs in one Node.js process with a **local SQLite database** (a
single file, using Node's built-in `node:sqlite`) — no setup, no external
services, and your data is still there after a restart.

## Quick start

Requires Node.js 22.13+ (for the built-in SQLite module).

```bash
npm install
npm start
```

Open **http://localhost:3000**

The first start creates `data/opd.db` and loads the demo clinic below. Every
later start reuses it.

| Role           | Username    | Password    |
| -------------- | ----------- | ----------- |
| **Admin**      | `admin`     | `admin123`  |
| Doctor (demo)  | `dr.sharma` | `doctor123` |
| Doctor (demo)  | `dr.patel`  | `doctor123` |
| Pharmacist (demo) | `pharma` | `pharma123` |

**Only the admin is hardcoded.** Every doctor and pharmacist is created by the
admin in the Administration portal — the three demo accounts above exist only
because a new database is seeded with a demo clinic. Start with
`OPD_SEED=clean npm start` for an empty clinic with nothing but the admin.

Override the admin credentials with `OPD_ADMIN_USER` and `OPD_ADMIN_PASS`.

## What's inside

**Administration portal**
- Create doctor and pharmacist accounts — no clinical account is hardcoded
- Deactivate and reactivate staff (never delete: that would orphan their
  prescriptions and bills); deactivating signs them out immediately
- Edit a staff member's name and specialty. A doctor's specialty prints under
  their name on every prescription, so it can be corrected after the account was
  created; staff without one are flagged **Not set**
- Reset a password when someone is locked out
- **Clinic details** — name, address, phone, email and registration number.
  The name replaces "Sunrise Clinic" throughout the app; the rest is printed on
  every bill and prescription
- **Dropdown suggestions** — doctor specialties, medicine categories and
  prescription frequencies. These are suggestions only: staff can always type a
  value that isn't listed, so a missing option never blocks anyone
- **Lab test catalogue** — ~28 common tests grouped by category, which doctors
  pick from when ordering. Add, remove and restore them here
- **Remove staff** — hides them and signs them out. Nothing is deleted, so
  their prescriptions and bills stay intact; "Show removed" restores them
- Clinic counts. Administration has **no** access to patient records,
  prescriptions or bills

**Doctor portal**
- Patient registry with search, "my patients / all clinic" scope, and add-patient
- Full visit history per patient; every past prescription opens as an Rx-pad
  view with its bill, showing dosage, frequency and duration in their own
  columns
- Prescription composer: live stock and price per medicine, estimated total,
  one click to send to the pharmacy
- **Quantity is calculated for you** — dose amount x doses per day x days, so
  `1 tablet` at `1-0-1` for `5 days` fills in 10. Type your own number and it
  stops auto-filling that row. It stays out of the way when the quantity cannot
  be known: `SOS (as needed)` has no fixed count, and a dose in `5 ml` or
  `500 mg` is dispensed as bottles or packs rather than counted units
- **Lab tests** — order tests from the catalogue (searchable, grouped by
  category) or type one that isn't listed. They print on the prescription under
  "Tests advised". Tests are not billed and no results are recorded
- **Not in the list?** — add a medicine the pharmacy doesn't carry and prescribe
  it straight away. Unit price and opening stock are optional: state them if you
  know them, or leave them blank and the medicine is flagged for the pharmacy to
  price and order
- Out-of-stock medicines can still be prescribed: the pharmacy issues what it
  has and restocks the rest
- Prescriptions & bills list with pending/issued filters — bills appear against
  each prescription as soon as the pharmacy issues it
- **Remove a patient or a prescription** — takes them out of the registry,
  the visit history and the prescription list. Removing a *pending*
  prescription also withdraws it from the pharmacy queue. Nothing is deleted:
  bills survive and "Show removed" restores either
- **Issue & bill** — dispense your own prescription at the consulting room and
  generate the bill, using the same sheet, the same stock rules and the same
  arithmetic as the pharmacy counter. The bill records whoever handed the
  medicines over
- **Edit a pending prescription** — revise the diagnosis, fee, medicines or
  tests while it is still waiting at the pharmacy. Only the prescriber can
  edit, and only before it is issued: once dispensed a bill exists and stock
  has moved, so an edit would contradict a bill already given to the patient
- **Save & print** in the composer saves the prescription and opens it ready to
  print. Saving first is what gives the sheet a real Rx number — the numbers are
  sequential and gap-free, so one cannot be handed out before the record exists.
  The prescription reaches the pharmacy queue at that point, and the composer
  switches to editing it, so printing twice revises one prescription rather than
  creating two
- **Print / Save as PDF** on any prescription or bill

**Pharmacy portal**
- Pending queue (auto-refreshes) — review each prescription, adjust issue
  quantities (capped at the prescribed amount **and** current stock, partial
  issue allowed), and generate the bill in one step
- Inventory: add medicines, restock, update prices; low-stock, out-of-stock and
  "needs pricing" rows are flagged
- **Remove a medicine** — hides it from prescribing and the inventory. Past
  bills are untouched and a pending prescription containing it can still be
  issued; "Show removed" restores it
- Bills: every generated bill, with a jump back to its prescription
- **Print / Save as PDF** on any bill or prescription

**Nothing is ever deleted**

"Remove" sets a hidden flag. Staff, medicines, lab tests, patients and
prescriptions are all referenced by
other records, so deleting a row would corrupt history that has already been
handed to a patient. Every list has a "Show removed" toggle to restore.

**Guard rails baked in**
- A doctor may dispense only their own prescription; a pharmacist may dispense
  anyone's; the admin may dispense nothing
- Role-based access on every API route (doctors can't restock or set prices,
  pharmacists can't see the registry, doctors only see their own bills, and the
  admin reaches no clinical data at all)
- Only doctors and pharmacists can be created through the API; the admin cannot
  deactivate itself
- Stock can never go negative; issuing more than prescribed is rejected
- Clear validation errors surfaced in the UI

## Printing

Open a prescription or a bill and click **Print / Save as PDF**. The browser's
print dialog offers a printer or "Save as PDF" — that PDF is the download. The
sheet prints on its own, with no app chrome, and the browser names the file
after the document (`INV-5004 · Sunrise Clinic`).

The clinic's name, address, phone, email and registration number print along the
**foot of every page**. Each field appears only when you have filled it in, so a
clinic with just a name prints just the name. Set them in
Administration → Clinic.

The page is printed with a zero page margin and its own margins in CSS, which is
what stops the browser adding its own header and footer — the page URL, date and
page number. If your browser still prints those, untick "Headers and footers" in
the print dialog.

## Seeded demo data

The admin, plus 2 doctors, 1 pharmacist, 13 medicines (one low-stock, to show
the flags), 5 patients with realistic visit history, and 2 prescriptions
already waiting in the pharmacy queue. Loaded only when the database is brand
new; `OPD_SEED=clean` skips it and leaves just the admin.

## Data, backups & reset

| Command          | What it does                                                            |
| ---------------- | ----------------------------------------------------------------------- |
| `npm start`      | Opens `data/opd.db`; takes one backup per day into `backups/`           |
| `npm run backup` | Extra on-demand backup (`backups/opd-YYYY-MM-DD-HHMMSS.db`), safe while the server is running |
| `npm run reset`  | Deletes the database (stop the server first); next start re-seeds the demo |
| `npm test`       | End-to-end API tests, including a restart-survives check                 |

- **Where the data lives** — `data/opd.db` by default. Override with
  `OPD_DB_PATH=/path/to/clinic.db` and backups with `OPD_BACKUP_DIR=…`.
- **Daily backups** — `backups/opd-YYYY-MM-DD.db`, newest 14 kept. On-demand
  backups are never pruned.
- **Restore** — stop the server, copy the backup over `data/opd.db`
  (delete `opd.db-wal` / `opd.db-shm` if present), start again.
- **Schema changes** — SQL files in `src/migrations/` run once each, in order,
  on startup; applied versions are recorded in `schema_migrations`.

## Project structure

```
server.js            entry point (Express, static hosting, startup banner)
src/database.js      opens data/opd.db, runs migrations
src/migrations/      numbered schema files
src/db.js            all domain logic (prescribe, issue, bill, staff) + seed data
src/settings.js      clinic letterhead + admin-managed suggestion lists
src/backup.js        daily / on-demand backups
src/auth.js          bearer-token sessions, role guards
src/routes.js        JSON API
scripts/             npm run backup · npm run reset
test/                npm test
public/              login, admin, doctor and pharmacy portals (vanilla JS)
docs/plans/          approved design document
```

## API at a glance

All routes sit under `/api` and expect `Authorization: Bearer <token>`.

| Method & path                    | Who        | What                                   |
| -------------------------------- | ---------- | -------------------------------------- |
| `POST /auth/login`               | anyone     | sign in → token                        |
| `GET  /settings`                 | anyone     | clinic letterhead + suggestion lists   |
| `PUT  /settings`                 | admin      | change them                            |
| `GET  /users`                    | admin      | staff list                             |
| `POST /users`                    | admin      | create a doctor or pharmacist          |
| `PATCH /users/:id`               | admin      | deactivate/reactivate · reset password |
| `GET  /stats`                    | admin      | clinic counts                          |
| `GET  /patients?search=&scope=`  | doctor     | registry with visit counts             |
| `POST /patients`                 | doctor     | register patient                       |
| `GET  /patients/:id`             | doctor     | patient + full history                 |
| `GET  /medicines`                | both       | inventory with stock & price           |
| `POST /medicines`                | both       | pharmacist: priced & stocked · doctor: zero-stock, unpriced |
| `PATCH /medicines/:id`           | pharmacist | restock / reprice                      |
| `GET  /prescriptions?status=`    | both       | doctor: own · pharmacist: all          |
| `POST /prescriptions`            | doctor     | create → lands in pending queue        |
| `PUT  /prescriptions/:id`        | doctor     | revise own prescription while pending  |
| `DELETE /prescriptions/:id`      | doctor     | hide own prescription (bill is kept)   |
| `DELETE /patients/:id`           | doctor     | hide a patient (records are kept)      |
| `POST /prescriptions/:id/issue`  | both       | pharmacist: any · doctor: own only     |
| `GET  /bills` / `GET /bills/:id` | both       | doctor: own · pharmacist: all          |
| `DELETE /users/:id`              | admin      | hide a staff member (never deleted)    |
| `DELETE /medicines/:id`          | pharmacist | hide a medicine (never deleted)        |
| `GET  /lab-tests`                | signed in  | test catalogue                         |
| `POST`/`PATCH`/`DELETE /lab-tests` | admin    | maintain the catalogue                 |

## Adapting it

- **Another database** — all persistence and domain logic is in `src/db.js`
  (schema in `src/migrations/`); reimplement that module against Postgres or
  MySQL and the routes and frontend are unchanged.
- **Admin credentials** — `OPD_ADMIN_USER` / `OPD_ADMIN_PASS`, or `ADMIN` in `src/db.js`.
- **Currency** — `fmtMoney()` in `public/js/common.js`.
- **Clinic name & letterhead** — set in Administration → Clinic, no code change.
- **Fonts** — loaded from Google Fonts with system fallbacks, so the app is
  fully usable offline.
