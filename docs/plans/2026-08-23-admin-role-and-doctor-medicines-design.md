# Admin role & doctor-added medicines — Design (approved 2026-08-23)

## Goal

Two changes to the OPD system:

1. **No hardcoded clinical staff.** Only an admin account is hardcoded. The
   admin creates doctors and pharmacists, deactivates them, resets their
   passwords, and sees clinic-wide counts.
2. **Doctors can add medicines the pharmacy doesn't carry**, at zero stock and
   zero price, and prescribe them immediately. The pharmacy prices and stocks
   them afterwards.

## Decisions taken

| Question | Decision |
| -------- | -------- |
| New-database contents | Admin **plus** demo clinic by default; `OPD_SEED=clean` seeds admin only |
| Prescribing an out-of-stock medicine | Allowed — pharmacy issues 0 on that line and restocks |
| Who prices a doctor-added medicine | The pharmacist, on first restock. Doctor never sets a price |
| Admin powers | Add staff · deactivate/reactivate · reset password · view stats |

Demo data remains the default because the demo must stay clickable, but it is
now an explicit *demo* seed rather than the only way to get staff. Admin can
deactivate the demo accounts at any time.

## Admin

**Credentials** — `admin` / `admin123`, overridable with `OPD_ADMIN_USER` and
`OPD_ADMIN_PASS`. Stored as a real `users` row because `sessions.user_id` is a
foreign key into `users`. Re-created on every startup when missing, so the
clinic cannot lock itself out of user management.

**Role model** — `admin` is an *operations* role, not a clinical one. It has no
access to patients, prescriptions or bills; the existing `requireRole` guards
already deny it, and no admin-facing clinical route is added.

**Deactivation, not deletion** — deleting a doctor would orphan their
prescriptions and bills. `users.active` is a soft switch. `getSessionUser`
re-checks it, so deactivating a user drops their live session on the next
request rather than waiting for them to sign out.

**Self-protection** — admin cannot deactivate itself or change its own role,
and `POST /users` accepts only `doctor` and `pharmacist`, so no second admin
can be created through the API.

### Routes (all `requireRole('admin')`)

| Method & path      | What                                          |
| ------------------ | --------------------------------------------- |
| `GET /users`       | Staff list — never password hashes            |
| `POST /users`      | Create a doctor or pharmacist                 |
| `PATCH /users/:id` | `{active}` to toggle, `{password}` to reset   |
| `GET /stats`       | Counts: staff, patients, prescriptions, bills |

## Doctor-added medicines

`POST /medicines` opens to doctors. When the caller is a doctor the server
**forces** `stock = 0`, `unitPrice = 0` and `needsPricing = 1` regardless of
the request body — a doctor cannot set a price even with a crafted request.
Pharmacist behaviour is unchanged.

The prescription composer stops disabling out-of-stock medicines; they are
selectable and labelled `— out of stock`, with a warning when one is on the
prescription. A "New medicine" modal (name + category only) creates one and
selects it in the row being edited.

The pharmacy inventory flags `needsPricing` rows; setting a price through the
existing `PATCH /medicines/:id` clears the flag. The issue modal needs no
change — it already caps at `min(prescribed, stock)`, so a zero-stock line
renders as "only 0 in stock" and partial issue covers the rest.

## Schema — migration 002

SQLite cannot alter a `CHECK` constraint, so `users` is rebuilt with the
documented procedure: `PRAGMA foreign_keys=OFF` **outside** the transaction,
rebuild inside it, `PRAGMA foreign_key_check` before commit, `ON` afterwards.
Verified to preserve rows, foreign-key references from `sessions`,
`prescriptions` and `bills`, and the `AUTOINCREMENT` sequence.

- `users` — role `CHECK` gains `admin`; new `active`, `created_at`
- `medicines` — new `needs_pricing`
- `app_meta` — key/value table; holds `demo_seeded`, and is where clinic
  settings will live later

The migration runner gains the FK-off wrapper so any future table rebuild works
the same way.

## Deliberately out of scope

If *every* line of a prescription is out of stock, the existing
`totalUnits === 0` guard blocks issuing and the prescription stays pending
until restock. The error message becomes actionable, but consult-fee-only bills
and prescription cancellation belong to the billing gap, not this change.

## Testing

Added to `test/api.test.mjs`: admin sign-in; admin denied clinical routes;
admin creates a doctor who then prescribes; `POST /users` rejects `admin`;
deactivation kills a live token and blocks re-login; reactivation restores it;
password reset; admin cannot deactivate itself; stats; a doctor-added medicine
is forced to zero price/stock even when the body says otherwise; prescribing it
out of stock; the pharmacist pricing, restocking and issuing it.

New `test/migration.test.mjs`: builds a database at migration 001, fills it,
then opens it through the app and asserts 002 applied with every row intact.
