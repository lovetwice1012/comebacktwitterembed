# Donor manual administration

Base: `c2b9e2d285a37f92eb4555fc0696ebb5d08b3b95`.

Global administrators can open `/admin/donors` from either admin presentation or
notification-plan management. The screen supports donor search and pagination,
manual supporter status and additional notification slots, historical manual
payment/purchase-unit counts, management aliases and notes. A reason and an
explicit before/after review are required before saving.

Legacy `users.is_donor` and `additional_auto_extract_slots` remain authoritative,
so existing Bot behavior stays compatible. Counts and units are recordkeeping;
they do not imply a charge or automatically convert into extra slots. Verified
Square history is read-only and scoped to the configured merchant/environment.
Lifetime payment counts and currency-specific amounts/refunds are separate from
the current automatic grant and its validity window.

Edits lock the owner and compare both raw legacy fields and the profile revision.
Concurrent admin or legacy Discord updates return a conflict without overwriting
unseen changes. The profile, legacy fields and immutable audit entry commit in
one transaction. The change-history panel lazily shows actor, reason, date and
before/after values. Existing registrations, boost reservations and usage
counters remain intact, including when capacity is reduced.

Unknown-user detail GET performs only SELECT; creation occurs only on confirmed
save. All endpoints enforce global admin authorization and reuse origin, fleet
authority, guarded DB, durable write admission and private no-store boundaries.
The additive migration creates two management tables and three query indexes.

## Verification

- Serial related acceptance: **391 passed, 0 failed, 0 skipped**, using a
  disposable MariaDB schema, fixture Square responses and DOM tests.
- Root and dashboard TypeScript checks passed.
- Changed backend/dashboard ESLint checks passed without relaxing rules.
- Final dashboard production build passed after adding the audit panel.
- Frozen legacy snapshot verification passed unchanged.
- Independent source review covered authorization, read-only GET, legacy CAS,
  scoped donation summaries, safe money precision, audit rollback and migration.
- Real-component browser fixture confirmed editing extra slots after reasoned
  review and displaying the saved change reason in lazy audit history.
- Final additional UI recovery check passed in the **17-test donor UI suite**:
  a committed save with a lost response retains the draft, requires reload,
  shows the committed state and prevents a second write/audit. The final feature
  has **392 unique passing acceptance cases** including this added case.

No real donor settings, payments, refunds or subscriptions were changed during
testing. The primary dirty checkout was left untouched. Production rollout
requires the reviewed migration and matching dashboard runtime; the Bot does
not need a restart because manual grants use the existing legacy fields.
