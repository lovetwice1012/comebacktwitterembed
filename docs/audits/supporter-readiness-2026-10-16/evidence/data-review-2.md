# UI / data / billing acceptance review v7 (independent second whole-scope pass)

Frozen clean candidate: 99078a98e9e3f7658e41f547296d7d7f6cce8ec5
Baseline: f241aa268344b407adf64735f1d8bd3c3aa12968
Repository: C:/Users/yussy/.codex/worktrees/x-realtime-choice-20261014/comebacktwitterembed

RESULT: Whole assigned UI/data/billing/marketplace scope CLEAN.
Confirmed P1/P2: 0. Unresolved P1/P2 candidates: 0.
This result is for this exact immutable candidate and scope. Earlier v4 with a residual finding remains non-clean and is not counted as acceptance.

## Review scope

Re-read original master findings and relevant detailed sections, including:
- initial report R3/R4 status and safe errors;
- reaudit-02 N2 draft/destination ownership, N8 delivery selection races, N9 >100 resource pagination;
- reaudit-03 T3 clone scope, T4/T5 dictionary safety/provenance, T9 discarded text after restore, T10 removed-unused bindings (including dictionaries expanded in round31), T11 assignment CAS;
- round04 S4-3 delayed Marketplace detail selection, S4-4 fork/source license and provenance, S4-5 personal-channel edits, S4-6 X receiver release (data/API surface);
- S7-2 dirty dictionary import guard, S7-3 X consumers in application roster, S9-1 async rule/fragment file import ownership;
- S18-1 target/destination resume integrity, S20-1 reviewed target roster and authoritative token, S20-2 X duplicate registration with explicit changed input, S21-1 workflow deletion/consumer state, S22-1 revision composer discard confirmation;
- S24-1 editor and every real registration owner destination rights, S24-2 all mutation-commit/followup-read boundaries expanded in round31, S26-1 X stale-edit rebasing;
- round34 S34-1 cancellation identity and S34-2 complete donation history beyond the first100 quotes.

Read complete current changed files in src/automation and dashboard/components/automation, all additional provenance migrations, Dashboard service construction, and current lineage/safety/official install/update code. Rechecked the full baseline-to-candidate scope; did not restrict this pass to the last patch or the prior v4 finding.

## Former S4-4 residual independently verified fixed

The v4 witness (official dictionary -> ordinary workflow -> workflow-source republication) now preserves the outer dictionary license and attribution as per-dictionary source facts and portable notices, while preserving an independently authored outer workflow license. It does not invent license compatibility or collapse multiple origins into one fork_of.

Current code:
- package-dependencies.js validates/sorts bounded immutable package ID/version/checksum references, verifies stored editions and human snapshots, and stores per-immutable-revision receipts.
- marketplace-core.js workflowAssets/publicationDependencies loads canonical dictionary IDs and pinned revisions, checks source content, and revalidates access/dependencies inside the write transaction.
- exportWorkflowPublication/exportDictionaryPackage return server-side structured facts; the old raw bundle schema remains unchanged.
- marketplace-installs.js carries the verified dependency map only from the stored official edition; raw file import does not turn editable source-looking text into trusted runtime dependencies.
- service.saveDictionary retains the exact receipt through local edits/restores; immutable historical revisions remain unchanged.
- package-safety.js checks the exact flattened applicable package editions; revoking unrelated packages does not create a universal workflow cascade.

Independent real-SQL operation groups (separate from repository regression tests):
1. Official CC-BY-SA outer / CC0 inner dictionary -> actual lookup-node ordinary workflow -> MIT-authored workflow package. Exact original source metadata remains visible; export is read-only; a foreign actor cannot export the private workflow. The exact old f241 bundle parser loaded with git show accepts the actual encoded bundle.
2. Official wrapper install -> local dictionary edit -> restore -> ordinary workflow copy. Both original A and wrapper B remain in the immutable receipt. Revoking A's applicable edition stops revisions1/2/3 while an independent dictionary remains usable.
3. A mismatched dictionary body with a claimed canonical workflow source is rejected with REVISION_CONFLICT before creating a package.

All three groups passed against random owned schema cbte_automation_test_68a1ffc7c15eabeb6d5d; the schema was dropped in finally.

Evidence:
C:/Users/yussy/AppData/Local/Temp/sat-accept-data-v7-probe.cjs
C:/Users/yussy/AppData/Local/Temp/sat-accept-data-v7-probe-output.json

## Remaining whole-scope conclusions

- Actor/scope access is rechecked from canonical rows. Custom workflow destinations and X default destinations require active resources, real endpoint identity and current View/Send rights for actual owners; DM needs no Discord reads. Deleted/moved webhook, permission failure, remote503/429 and in-transaction identity change reject without partial mutations. Factory callbacks include both verifyChannel and verifyWebhook.
- Workflow private/guild clone scope is preserved. Exact source editions persist through ordinary copies, copies of copies, restored editions, state-only snapshots and conflict recovery. Legacy unknown editions fail closed for export/copy/publication while source content/editing/runtime data are retained.
- Same-ID original/fork editing imports preserve existing author license control and immutable upstream fork constraints; source retarget attempts reject. Multiple dictionary source origins and alias rename use canonical bindings; ambiguous edited bundle matching fails closed rather than guessing.
- Old portable bundle top-level fields remain unchanged. Structured dependency metadata stays in trusted server DTOs/records, and notices pass the existing bundle/publication mechanical checks.
- Resource pagination, delayed details/files, inactive/closing generations, restored text reset, package source identity/preview success-and-error guards and consent invalidation are covered. No stale selection write was reproduced.
- Committed creates, saves, installs/updates, pause/resume, restores, deletions, feedback/report/moderation changes and history mutations adopt returned identity/revision/token before followup reads. Retry-read paths do not replay committed POSTs. createWorkflow canonical response reads occur inside the write transaction and roll back with nested imports on read failure.
- Workflow activation roster includes all native/X consumers and has server token/CAS fencing; stale assignment guards cannot overwrite later changes. Deletion pauses/unassigns consumers without deleting monitor settings/data.
- Cancellation requires the displayed immutable subscription+checkout IDs on both client/server; refresh invalidates confirmation. Donation history uses a separate stable owner/environment/merchant display cursor, retains visible pages on failure, and does not change payment/grant state through history pagination.
- No new confirmed or unresolved P1/P2 in the assigned scope.

## Focused automated evidence

15 focused SQL/actual React test files:
automation-marketplace-provenance-sql
automation-dictionary-publication-sql
automation-dictionary-publication-ui
automation-package-lineage-sql
automation-package-lineage-ui
automation-service-commit-response-sql
automation-post-commit-ui
automation-recovery-origin-ui
automation-square-billing-sql
automation-square-donations-sql
automation-subscription-ui
automation-donation-ui
automation-saturation-ui
automation-saturation-data-sql
automation-workflow-destination-principals-sql

Node through scripts/run-project-node.cjs, explicit disposable MariaDB listener127.0.0.1:33621.
263 tests passed, 0 failed, 0 cancelled, 0 skipped, process exit0; duration117973.5152ms.
C:/Users/yussy/AppData/Local/Temp/sat-accept-data-v7-focused.xml

Hash coverage: 206 files (src/automation, dashboard/components/automation, migrations, Dashboard service factory, db_schema and local harness factory). Before/after SHA256 changed0; HEAD remained99078; git status remained empty.
C:/Users/yussy/AppData/Local/Temp/sat-accept-data-v7-hashes-before.json
C:/Users/yussy/AppData/Local/Temp/sat-accept-data-v7-hashes-after.json

This reviewer made no repository source edits, commits, production DB/config changes, remote calls, actual payments or messages. No real OAuth/Discord/X delivery, production deployment or browser layout proof is claimed. Root's full suite and release/runtime reviews are separate gates.
