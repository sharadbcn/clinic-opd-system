# OPD System — Design (approved 2026-08-21)

## Goal
A local-first outpatient department (OPD) app for a small clinic: doctors write
prescriptions and see billing; the pharmacy issues medicines, manages inventory,
and generates bills. In-memory database, zero external services.

## Stack
- **Node.js + Express** — one process serves the JSON API (`/api/...`) and the
  static frontend. No build step: `npm install` → `npm start`.
- **Vanilla HTML/CSS/JS frontend** — three pages (login, doctor, pharmacy).
- **In-memory store** — JavaScript `Map`s in `src/db.js`. All domain logic
  (prescribe, issue, bill) lives there, so swapping in MongoDB/Postgres later
  means reimplementing that one module.

Considered and set aside: React + Vite (adds a build step this project doesn't
need), Python Flask (equally fine, but Node keeps one language end-to-end).

## Roles & auth
- Bearer tokens in memory (`sessions` map); `localStorage` on the client.
- `requireAuth` + `requireRole('doctor'|'pharmacist')` guards on every route.
- Doctors: patient registry, prescribing, their own prescriptions/bills.
- Pharmacists: pending queue, issuing, inventory, all bills.

## Data model
- **users** — name, role, specialty, salted SHA-256 password hash
- **patients** — code (P-1xx), name, age, gender, phone
- **prescriptions** — rxNumber (RX-1xxx), patient, doctor, diagnosis, notes,
  consultationFee, items[{medicine, dosage, frequency, durationDays, quantity,
  issuedQuantity}], status `pending → issued`
- **medicines** — name, category, unitPrice, stock
- **bills** — billNumber (INV-5xxx), prescription link, line items priced at
  issue time, medicinesTotal + consultationFee = grandTotal

## Workflow
1. Doctor signs in → registry with visit history, search, add patient.
2. Doctor composes prescription (live stock + price shown) → "Send to
   pharmacy" → status `pending`.
3. Pharmacist reviews queue → adjusts issue quantities (capped at prescribed
   and at stock; partial issue allowed) → stock decrements → bill generated.
4. Bill is immediately visible to the prescribing doctor against the Rx.

## Inventory (selected add-on)
Pharmacist tab: add medicine, restock, edit price. Low-stock (<10) and
out-of-stock highlighting. Doctors see live availability while prescribing;
out-of-stock medicines can't be selected.

## Deliberately left out (user's choice)
Queue tokens, printing, dashboard stats — all straightforward to add later.

## Design language
Chart-paper neutrals; fountain-ink blue keys the doctor portal, dispensary
green keys the pharmacy (`body[data-role]` swaps the accent). Type: Archivo
(display) / Public Sans (body) / IBM Plex Mono (codes & money). Signature
element: prescription details render as an Rx-pad sheet — double rule, Rx
watermark, mono numbering. Google Fonts via CDN with system fallbacks, so the
app still works fully offline.

## Testing
- `opd-test.mjs` (dev-only, not shipped): 38 API assertions across auth, role
  guards, validation, stock caps, partial issue, billing math, visibility.
- jsdom smoke test (dev-only): loads all three pages against the live server
  and drives login → prescribe → issue → bill without JS errors.
