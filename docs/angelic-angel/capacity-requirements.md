# New X auto expansion capacity requirements

Updated: 2026-10-14 JST. The quota model, APIs, permanent supporter ledger and
existing-screen integration are implemented and tested locally. Registration is
**off by default**. Genuine Firefox/X transfer and receipt remain unverified at
G1; no production data, deployment or payment activation was changed.

The latest user instructions in [quota-allocation-spec.md](quota-allocation-spec.md)
supersede the earlier capacity description. Existing reservations must never move
automatically. Local evidence is mapped in
[quota-acceptance-matrix.md](quota-acceptance-matrix.md).

## Pools and individual allowance

- One slot is one monitored X account **per owner**. Ten owners monitoring the
  same account consume ten reservations. A Firefox subscription, UAID or receiver
  connection is a separate identity; shared internal retrieval does not reduce
  the owners' quota consumption.
- The shared free pool defaults to 50 across all users, including paid users.
  Each reservation also consumes one existing personal notification slot.
- The independent supporter pool defaults to 100 across supporters. Its use
  consumes one owned supporter allocation and one personal notification slot.
  Permanent supporter holdings increase the personal allowance; the global pool
  itself does not grant an individual additional allowance.
- Paid special capacity is independently configured per eligible Basic-or-higher
  plan and applied per owner. It does not increase the personal allowance. The
  account reservation consumes one personal slot, including when free/supporter
  pools are full.
- New registration always selects **free → supporter → special** among eligible,
  available pools. If the personal allowance is exhausted, no pool may admit the
  account. Paused and suspended registrations keep their reservation and count
  as used until explicit release or a successful manual move.

The shared personal allowance is the existing server-managed plan basic allowance
plus `getSupporterHolding(...).totalSupporterSlots`. Ordinary auto/price targets,
X targets and existing cadence boost slots use the same persistent
`automation_notification_slots` system. The UI distinguishes registration count
from boost consumption. A custom legacy supporter basic allowance is preserved:
the tested 20 basic slots plus 2 owned additional slots remain 22 after X opt-in.
Choosing free-plan X quality must not silently lower that established allowance.

Supporter holdings preserve recorded legacy purchase counts. An old 500–2,500-yen
product purchase granted one slot; past amounts are never divided by 500 to
recreate that count. Trusted manual counts and recorded Square additional counts
are retained/snapshotted. Confirmed historical purchases may be added only by an
actual administrator with an auditable reference, reason and idempotency key.
An already included purchase must not grant again.

New verified completed JPY payments grant `floor(amount / 500)` permanent slots;
500 yen is the minimum that grants a new slot. Separate sub-500 payments are not
combined into a grant. Cancellation or expiry of a monthly plan does not remove
the purchase. Scope and payment identity prevent duplicate grants on replay.
The existing Square financial amount/unit/refund/expiry calculations remain
available, but their promotional unit count does not create a second personal
allowance for a new payment. The tested 1,000-yen purchase grants 2 personal slots
even when that separate financial calculation reports 10 units.

## Quality and interval settings

X priority, minute/day limits and confirmation interval come from the current
verified paid contract or the configured free plan. Pool kind never selects
quality. Legacy supporter basic registration capacity remains compatible, while
the pool does not confer the legacy donor priority on X. Existing ordinary
notification quality is retained.

The optional plan interval is stored in
`automation_notification_plans.confirmation_interval_minutes` and edited in the
existing plan screen. It accepts 5–10,080 minutes or an unset value; no separate
fixed X interval is introduced. Existing `users.auto_watch_interval_minutes`
values and their management screen remain intact. A trusted server/test option
(`useLegacyUserInterval`, exposed by `ANGELIC_X_USE_LEGACY_USER_INTERVAL`) can use
those existing values. A request body cannot enable that option or choose a plan,
supporter status, limit or priority.

## Atomic allocation and manual movement

`automation_x_monitors` records owner/account identity, settings, revision,
subscription state, qualification state and nullable pool kind. It stores no
Firefox private keys, cookies or Push endpoints. The encrypted subscription
registry and receiver remain separate, later G1 work.

X changes serialize through the existing global policy singleton, then the
owner row. Pool allocation, personal reservation and audit commit in one DB
transaction. Native registration continues to use its existing owner lock.
Optimistic revisions reject stale settings/moves; duplicate registration and
release do not allocate/free twice. Used counts include all non-deleted assigned
rows, including suspended rows.

Free vacancies, release, reads, delivery qualification checks, plan changes and
capacity edits **never change another reservation's pool kind**. A qualification
change can suspend use while preserving the assigned pool, personal reservation,
account, notification bindings, enabled choice and subscription state.

Only the owner or an actual administrator may explicitly move a registration.
The destination must have capacity and the owner must meet its supporter/plan
and existing personal-slot eligibility. A manual move may select a later eligible
pool even when free capacity is available; the priority order applies to new
registration. One transaction changes the reservation and audit, retaining its
ID, personal slot, notification bindings, subscription state and current-plan
quality. A failed move retains the complete source reservation.

Global limits cannot be reduced below occupied free/supporter capacity. Plan
eligibility/special-cap changes reevaluate use and retain suspended reservations.
They do not delete records or move them into another pool. Read-only integrity
diagnostics expose orphaned mappings and invalid allocation/count state; they
must not repair or delete data as a side effect of inspection.

## Existing UI and API integration

The administrator edits pool limits and existing-plan special capacity under
`/admin/notification-plans`; the same screen shows used/available counts, owner
holdings, reservations, safe payment/grant history and audit pages. The existing
user plan screen shows the current plan, total/used allowance, additional supporter
slots, free capacity and specific unavailable reasons. Manual moves require a
reviewable explicit choice.

Owner metadata routes use `/api/automation/x-monitor-quota` and
`/api/automation/x-monitors`, with PATCH/DELETE on `/{id}` and explicit POST on
`/{id}/move`. Admin capacity, plan and history routes remain under
`/api/automation/push-capacity`. Existing session, server-side admin/ownership,
CSRF/canonical-origin protection, operation limits and CAS are reused. There is
no public automatic-rebalance endpoint. Capacity changes do not turn on X
registration or paid payment acceptance.

Do not invent higher-plan IDs or special-slot numbers. The user reports an actual
production Basic plan, but its production row was not read or overwritten in
this work. Eligibility and special limits bind to existing administrator-managed
plan IDs; unconfigured special capacity is zero.

## Validation and release boundary

Local real-MariaDB tests cover free49+2 and supporter99+2 concurrency, shared
native/X personal limits, manual-move conflicts/rollback, retained suspension,
payment replay, legacy migration, unsafe-count failure, ownership, audit failure,
read-only diagnostics and fresh-process persistence. DOM tests exercise the
existing administrator/user screens. Exact final totals are recorded in the
acceptance matrix; [support-grant-migration.md](support-grant-migration.md)
documents safe migration/rollback and unresolved historical records.

This proves the local quota model and UI. It does not prove actual Firefox
export, same-UAID takeover, real X decryption, Discord delivery or Mozilla
operating acceptability. Registration remains default off until G1 and the
required operational approval are met. No production migration, deployment,
real payment activation or donation reopening was performed.
