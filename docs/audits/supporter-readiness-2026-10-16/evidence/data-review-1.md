# Independent UI, data, billing and marketplace acceptance review

Result: no new confirmed P1/P2 and no unresolved candidate in the reviewed UI/data/billing/marketplace scope. This is not whole-product release acceptance. The provider destination verification fixes and graph-failure changes were being developed independently, and remain for their assigned reviewers and the final frozen suite.

## Source scope and stability

Review base: f241aa268344b407adf64735f1d8bd3c3aa12968.
Review began at dd290388b858ded8a5bda961c23a7c229f295f3f; during the last evidence capture HEAD advanced to ce0bbe6cf439273d01224c43764dbd54deeeadda. That commit changed seven graph/runtime-related files, outside this review's 22-file captured UI/data/billing scope. The 22 captured file hashes remained identical from first capture through final capture. service.js already contained the known concurrent provider verification-helper patch at first capture; do not attribute those helper bytes to dd290. The canonical revision writer, createWorkflow, updateWorkflow, setWorkflowState and saveDictionary bodies were checked separately and match committed HEAD; those bodies are unchanged by the graph commit.

Hash inventories: sat-independent-data-hashes-before-dd290.json and sat-independent-data-hashes-after-dd290.json. Section evidence: sat-independent-data-sections-dd290.json.

I read the master 50 findings and round-34's two billing findings. R32 is a recovery/runtime concern outside this review domain. I reviewed the applicable full base-to-dd290 UI/data changes, with adjacent callers and server authorization/transaction paths rather than considering only new test assertions. The original reports are untouched.

## Review boundaries exercised

- Async resource selection and details: workspace pagination, personal/guild scope inheritance, job selection and mutation CAS, monitor activity, marketplace list/detail request generations, stale shared-link response/error, same-workflow editor remount after restore, fragment/file state and draft-recovery provenance.
- Post-commit reads: workflow create's canonical DTO read participates in its transaction; UI separates commit identity/revision from later list/detail reads for workflow edits/restore/state/copy/delete, native monitor/destination saves/deletes/state, delivery actions, dictionary mutations, package create/install/editing-import/update/withdraw/status/feedback, starter dictionaries, moderation and report resolution.
- Marketplace immutable provenance: exact workflow source edition, old unknown edition fail-closed for redistribution while preserving content/runtime/edit/restore, private raw-file rights path kept distinct, copies of copies and pause-created editions, original-author own-package editing versus first-fork immutable license/attribution, dictionary-source publication from both dictionary and workflow packages, same-ID local edit and restore.
- Multiple dictionaries: canonical binding ID/revision identifies each asset even with identical content; per-alias server receipts and versioned source checksums preserve independent outer license/source; alias-renaming updates keep old editions; unsupported ambiguous editable-bundle rename fails closed instead of inferring by body/name; provenance is not accepted from raw portable fields.
- Portable compatibility: new metadata is kept outside the established portable bundle. The actual baseline f241 strict JSON/ZIP parser accepted a newly published two-source bundle. An imported portable file did not acquire trusted server lineage from human attribution text.
- Publication inspection: inherited/source notices are included before final bundle validation and safety inspection, and metadata is rechecked in the commit transaction; source corruption/access changes cannot silently drop restrictions. Runtime safety resolves pinned dictionary receipts and package versions without relying on an empty caller dictionaryRefs snapshot.
- Billing: cancellation confirmation carries immutable subscription plus checkout identities, canonical status invalidates old confirmation, owner/merchant/environment and late replacement fences remain; older donation history is display-only, stable created-at/ID pagination, independent of reconciliation or grant writes, with generation fencing and preserved already-loaded rows on read failure.
- Migration contract: four migrations add nine nullable columns to four existing tables, including two optional JSON columns, with no new table or destructive rewrite; new JSON columns do not guess/backfill dependencies. Legacy dictionary precondition and workflow unknown-edition behavior preserve existing bytes. These are source/local fixture checks, not production migration execution.

## Automated evidence

Command used pinned project Node 24 with AUTOMATION_TEST_DB_PORT=33621 and 14 files:

- automation-saturation-ui.test.js
- automation-post-commit-ui.test.js
- automation-package-lineage-ui.test.js
- automation-dictionary-publication-ui.test.js
- automation-recovery-origin-ui.test.js
- automation-donation-ui.test.js
- automation-subscription-ui.test.js
- automation-saturation-data-sql.test.js
- automation-service-commit-response-sql.test.js
- automation-marketplace-provenance-sql.test.js
- automation-dictionary-publication-sql.test.js
- automation-package-lineage-sql.test.js
- automation-square-billing-sql.test.js
- automation-square-donations-sql.test.js

Result: 248 tests passed; 0 failures, 0 cancelled, 0 skipped, 0 todo; duration 30017.917 ms; process exit 0. Log: sat-independent-data-acceptance-dd290.log. These are actual React/DOM and disposable MariaDB fixtures, with synthetic channel/payment/provider boundaries.

Six additional independent probes passed in sat-independent-data-witness-dd290.cjs, recorded in sat-independent-data-witness-dd290.json:

1. Identical dictionary contents retain two independently selected source packages.
2. A normal original workflow wrapper retains its MIT license and both independent dictionary outer licenses.
3. Actual f241 strict JSON and ZIP readers accept the new published package with no new portable fields.
4. A genuine raw bundle import treats attribution as human content and creates no trusted package receipt.
5. Official import records immediate wrapper plus exact transitive per-alias sources.
6. Pause-created immutable workflow edition and ordinary copy retain the exact source package/version.

The witness created only cbte_automation_test_508f4e67382712669a74, then dropped it through the standard fixture close path. The shared MariaDB service was not restarted. The 14-file test fixtures likewise use their own random disposable schemas and cleanup handlers.

No source files, Git refs, original reports, production data/configuration/services, external account state or payments were written by this reviewer. Test scripts/reports were saved only under the local Temp directory. No actual OAuth, Discord, X delivery, Square payment, production migration or production deployment is demonstrated by this review.
