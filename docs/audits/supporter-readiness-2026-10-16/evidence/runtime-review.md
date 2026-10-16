# Independent runtime follow-up: history materialization fix

Verdict: CLEAN for the assigned core runtime domain. The prior confirmed S7-1 / N6 cumulative-history defect is freshly verified fixed. No confirmed P1/P2 or unresolved implementation candidate remains in this scoped pass. This is ordinary functional review, not a security scan or release/deployment acceptance.

## Source scope and drift

Review began at d21301e81307012226d253e7a9119f32e7bbd5d5 with the explicitly frozen dirty backend/history/UI changes present. The final reviewed commit is 1d32f101922cc7eef9d971e36b8ab1ecbbdabbf2. The 28-file manifest covers core graph, join, queue, transport, reservation recovery, native source/store, X receiver/store, recovery fence, history/API, the new flow-trace helper and three new backend test files. core-before.json and core-after.json bind actual working bytes rather than falsely treating the entire checkout as initially committed.

During review the intended history implementation was committed as cbffa59. One additional implementation line changed in flow-trace.js: decoded cursor JSON must be a non-null, non-array object. The read SQL test file also changed for new fixture coverage and malformed JSON cursor cases. Both final changes were reread. Five null/array/scalar pure-input probes now return INVALID_CURSOR / 400, and the final complete SQL read test file passes. All other captured core source bytes remained unchanged. Documentation writes outside this scope are excluded.

The copied original witness script still has its old static ce0bbe6 head label inside its raw JSON. That literal identifies the original defect witness, not the executed source. Actual execution is bound by the before/after source manifests and this report; no old nonclean result is counted as a fix pass. The raw witness JSON is intentionally retained unchanged.

## Original >16MiB witness, freshly passed

The same accepted 52-node / 81-edge topology uses one original event, two fanout/aggregate stages producing 16 and 256 occurrences, fifteen dictionary nodes, one explicit merge and one notification. Dictionary terms remain at the legal 255-character limit and use the actual dictionary evaluator with eight matches. No limit, DDL, timeout, input or business-rule adjustment was made to get this case through.

The new implementation reaches run state queued and creates its projected job. Stored trace_json is 169 bytes, containing the bounded diagnostic index. Full immutable diagnostics remain available: 4,113 entries, including all 3,840 dictionary records, totaling 25,765,177 bytes when combined. The independent probe reads all 104 pages, checks one stable source revision, and deep-compares every original field and every match against the canonical per-step immutable decision data. It confirms unchanged unit checksums and unchanged saved index, plus 404 for a different owner. Largest complete response is 267,007 bytes including provenance/cursor metadata; the 256KiB entry budget and 50-entry bound preserve complete individual entries.

Evidence: fixed-witness.cjs and history-growth-fixed-witness.json. The initial independent harness had an incorrect FORBIDDEN expectation for private-owner denial; actual NOT_FOUND / 404 was correct. That harness-only failed expectation is preserved in fixed-witness-first-harness-expectation-error.json and is not a product failure or acceptance result.

Two exact probe schemas were checked after completion through a read-only INFORMATION_SCHEMA query; both are absent. See independent-schema-cleanup.json. No shared database restart/config change, source/Git write, upstream request or real notification occurred.

## Runtime / history review

- Bounded trace projection preserves ordinary small arrays and every original field. Beyond 4MiB it records an index and digest while retaining complete immutable step, batch/member, merge and job evidence. Permanent/expired state flags include records beyond the retained projection boundary.
- Complete history uses metadata manifests, hashes and keyset/position pages. It rechecks source revisions and actor/resource scope after reads; stale or changed sources return 409. It does not open a transaction, mutate state, acquire a send lease or add DDL.
- Owner-private runs remain private even for platform administrators. Guild reads require that request's guild view authority. Source/membership data are derived from persisted graph rows, not a client-supplied owner. Failures expose safe 503 text; SQL errors and signed data are not emitted as exception details.
- Current SQL tests cover complete terms/positions/custom fields, legacy raw arrays and an intact large legacy entry, page boundaries and failures, invalid cursors, changed bodies/versions/authorization, projection rollback and restart, exact per-member step/batch failure receipts, and one shared 1.7MiB decision fetched once for 1,000 distinct originating runs.
- Prior graph failure/closure, same-run healthy siblings, immutable payloads, permanent/transient distinctions, lease/version takeover, transaction rollback, restored-origin and encrypted-inbox cutoff, rate-generation recovery and fresh per-part permission behavior were rechecked with focused regression tests. Unchanged X plan/slot/manual-move semantics remain as reviewed previously; the root final suite covers the full release snapshot.

## Executed verification

Node 24.21.0 via scripts/run-project-node.cjs; SQL 127.0.0.1:33621 with disposable fixtures.

1. Five-file command: automation-flow-history-read-sql, automation-flow-trace, automation-flow-permanent-failure-sql, automation-recovery-cutoff-sql and automation-saturation-boundary-sql, --test --test-concurrency=1 --test-reporter=junit.
   Result: 46 cases, 45 passed, one new batch-page fixture failed FLOW_BATCH_INVALID, no errors/skips. The test file was still changing during that diagnostic run, so this is explicitly not a frozen acceptance pass. The other four files contributed 36 successful cases. XML: focused-history-runtime.xml, SHA256 769dfe265d905838adb2bea6a7444caf9e4971d87ffcb5185c3e599b6ae727c5.
2. Current exact failing fixture isolated: 1 passed, zero failure/error/skip, exit 0. batch-page-isolated.xml SHA256 ce51eda7bf7b869deafba91b4fc42130ffa436273c68974200077b6864a10b14.
3. Current complete automation-flow-history-read-sql.test.js: 10 passed, zero failure/error/skip, exit 0. history-read-final.xml SHA256 b18e6bc9a2eb94576b5e8645d609d313cdf5c87504d28764e3c1fa2b93deff03.

Thus all 46 distinct selected behavioral cases pass on the relevant final source, across the documented commands. The source-spanning diagnostic failure is retained rather than silently removed. The final full-release immutable acceptance belongs to root; this report does not replace it.

No browser integration, real OAuth, real X-to-Discord delivery, production database migration or deployment was performed or certified in this review.
