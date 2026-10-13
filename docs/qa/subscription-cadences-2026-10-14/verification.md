# Subscription payment intervals and monthly price ordering

Base: `ce9607f3a1cc219b384c1fafd9c9de4fdef9d823`.

The customer sees one card per notification plan, sorted by the selected
interval's monthly equivalent. Monthly is initially selected when available;
otherwise the shortest configured interval is selected. Changing an interval
keeps keyboard focus and selects its exact Square variation. The full recurring
charge is visible alongside the comparison price and in confirmation/consent.
Annual prices divide by 12; two-year prices divide by 24. Day/week comparisons
use an explicitly labelled 30-day estimate. Sorting uses exact rational
comparisons before display rounding; different currencies are grouped separately.

Administrators can create or bind multiple intervals to the same plan and
independently enable or disable enrollment. Each interval keeps its own update
version and editing draft. Notification limits remain shared by the plan.
Already agreed contracts display their original checkout price and cadence.
Coupons still discount only the first invoice of the selected interval.

The migration preserves every existing binding and durable creation request.
Bindings and catalog creation uniqueness are extended to include cadence.
Old clients without a variation ID work for one available interval and receive
a validation error when the choice is ambiguous. Unknown creation results retry
the same persisted request and idempotency key.

## Verification

- Related serial Node acceptance suite: **361 passed, 0 failed, 0 skipped**,
  including disposable MariaDB billing, commerce, migration, entitlements,
  cadence and quota tests, plus customer/admin DOM tests and boundary checks.
- Root and dashboard TypeScript checks passed.
- ESLint on changed runtime and dashboard modules passed.
- Dashboard production build passed in an isolated worktree.
- Independent feature review found no actionable code findings.
- Local browser preview uses the real components with labelled synthetic
  prices and an in-memory API. Annual selection moved the example plan to its
  correct monthly-price position; disabling monthly preserved annual enrollment.
  `customer-preview.jpg` and `admin-preview.jpg` record these fixture results.

Square responses in the acceptance tests are mocks. No real card authorization,
subscription, donation, cancellation or catalog price creation was performed.
The primary dirty checkout was not modified by this feature.

## Deployment boundary

Publish frontend, backend and the reviewed
`20261014_add_square_payment_intervals` migration together. Next resolves
backend modules from its working directory, so an old runtime with only a new
frontend build is insufficient. Apply only this migration explicitly, preserving
a private backup of affected rows, then activate the matching dashboard runtime.
The Bot reads subscription grants and does not expose Square management routes;
it can remain running during the dashboard release change.

After additional intervals have been registered, retain the new backend during
a presentation rollback. The old backend assumes one binding per plan.
