# UI integration into main — 2026-10-13

Base: `02f26665277c5866c2ddb4309c1c9646f28c317b`.

The integration was assembled and tested in an isolated checkout of current main.
The shared working folder contains separate Bot, billing and operational work;
those changes are excluded from this integration.

## Included behavior

- Consistent server and personal navigation, clearer Japanese/English labels,
  settings search that opens the matching field, and explicit loading/error/empty states.
- Owner-scoped drafts, stable editable rows, mobile save controls, per-server
  save results and failed-only retry. Personal links open the saved list first.
- Notification registration preview, searchable notification lists, affected
  notification review, dictionary edit review and undo, and accessible rule editing.
- Admin result labels, frozen inspector input identity, durable actor-scoped
  recovery receipts and mobile investigation detail/focus restoration.
- Existing signed per-account UI selection and opt-in switch, with the captured
  legacy presentation retained. Exact snapshot bytes are preserved by Git attributes.

Required backend changes are limited to the format-only monitor preview and
owner-scoped list filtering, plus the actor-scoped admin receipt lookup and
action-status filter metadata. Registration eligibility and existing slot policy
remain those of the base revision.

## Validation of this isolated integration

- Complete Node suite with disposable MariaDB on loopback: **1,401 passed,
  0 failed, 1 platform-specific skip** (1,402 tests).
- Root TypeScript and ESLint checks passed.
- Dashboard TypeScript/ESLint checks and final production build passed.
- `admin-agent`: `go test ./... -count=1` passed.
- Legacy snapshot verification: 59 files, 328 imports, 0 missing dependencies,
  0 errors. All 59 staged Git blobs match their recorded output hashes.
- Browser fixture bundles compile; previous local visual QA remains recorded in
  the UI task evidence. These checks do not assert production deployment,
  production database writes, real OAuth login or actual Discord delivery.
- Independent import/scope audit covered 115 changed/new UI, dependency and test
  sources and found no missing local imports or unrelated billing/fleet additions.

The only edits after freezing runtime code for final verification remove trailing
blank lines in four files and add the snapshot Git attributes and this report.

Commands:

```powershell
$env:AUTOMATION_TEST_DB_PORT='33621'
$env:EXPANSION_TEST_DB_PORT='33621'
$env:NODE_ENV='test'
node --test --test-concurrency=1 scripts/test/**/*.test.js
npm run typecheck
npm run lint
npm run lint --prefix dashboard
npm run typecheck --prefix dashboard
npm run build --prefix dashboard
node dashboard/legacy/verify.cjs
# Run from admin-agent with the validation Go runtime:
go test ./... -count=1
```

The history permission unit explicitly selects the new presentation; its
Manage Server denial and zero stored-log reads remain asserted. The rollout
tests independently exercise signed preference cookies, sessions and both views.

## Latest main integration

While remote checks were running, PR #27 advanced main to
`2308de031b8eacb9da0b00582a4c46c676599c65`. That revision was merged into the
isolated UI branch without conflicts. The UI diff against this new base still
contains only the same 203 UI/integration files.

Root TypeScript passed again. An additional 50 tests passed with 0 failures or
skips, covering monitor normalization/preview/filtering, notification management
with disposable SQL, both UI selections, signed preferences and server summaries.
The provider normalizer contracts used by UI preview remain compatible.
