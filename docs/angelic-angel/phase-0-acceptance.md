# Phase 0 acceptance: local compatibility gate G0 passed

Date: 2026-10-13 JST. Scope: pinned Rust CLI → strict TypeScript / Node.js CLI.
G0: **PASS for the specification's offline/controlled-network migration gate**.
The full new auto-expansion system is not complete or production-accepted.

All eight original Rust modules have mapped Node implementations; no original
CLI command, config schema, protocol branch, ECE encoding, legacy registration
path or recovery feature was intentionally omitted. The original fourteen files
remain byte-unchanged at `169a098e2025cc6e41a50fc8d521c483e21d9b6d` and pass
the SHA-256 manifest verifier. Node execution uses no Rust binary or addon.

## Executed evidence

| Check | Result |
|---|---|
| Node runtime / strict TypeScript | 24.15.0 / TypeScript 5.9.3; build and typecheck pass |
| Reproducible dependency install | `npm ci --ignore-scripts` pass; committed nested package lock |
| CLI/package lint | ESLint 10.12.0, all CLI source/tests/scripts pass |
| Existing service lint/typecheck | root `npm run lint` and `npm run typecheck` pass |
| Full Phase 0 tests | 198 Node test results, including parent tests; 189 leaf cases and 9 groups; 0 failure, 0 skipped, 0 TODO |
| True Rust comparisons | 13 differential groups: TOML, serde protocol, timers, ECE both directions, 72 golden fixtures, Webhook, old X request, CLI, real loopback WS, failures, duplicate cache, UAID recovery, malformed-key panic containment |
| Mock lifecycle | init → register → old X mock → persisted restart state → decrypt → Webhook → ACK → unregister passes |
| Recovery/errors | failed X / read-only save preserve old state; second invalidation stops; idle/backoff/Webhook SIGINT cleans up and exits 0 |
| Dependency audit | all nested npm dependencies: 0 reported vulnerabilities |
| Baseline preservation | all 14 source/reference file hashes pass |

The machine-readable results are `phase-0-tests.xml` and
`phase-0-dependency-audit.json`. The full source/function and MIG-001–014 mapping
is `phase-0-mapping.md`. Tests fail if the actual Rust oracle is absent.

All MIG-001–013 have implementation and passing required local evidence;
MIG-014's Node build/lint/type/unit/protocol/crypto gates pass. Human-facing
spinner/spacing, platform error text, config ordering and JSON object key ordering
are documented normalized display differences. Named safety differences include
secret redaction, explicit legacy authorization, non-2xx ACK102, finite HTTP,
atomic private configuration backups and controlled errors replacing Rust ECE
panic/oversized scratch allocation. These do not justify a claim of identical
unsafe behavior.

Windows PowerShell and compiled JS CLI were exercised. Node/Linux/macOS native
execution, real Firefox/X notification E2E, real Mozilla service behavior,
production DB/deployment and real Discord/Webhook delivery are **not verified**
by these results. The specification explicitly distinguishes credential-bound
live E2E from G0's controlled-network gate. No X/Mozilla live requests, production
changes or user credentials were used in these tests.

The retained upstream Rust files do not pass current rustfmt's style check.
They remain unchanged as the comparison reference. Formatting of owned oracle
files passes. `cargo test --all-targets --locked` passes for both comparison
binaries (there are 0 native Rust unit tests; actual functional comparisons are
the 13 Node-driven oracle groups). `cargo clippy --all-targets -- -D warnings`
fails on retained upstream diagnostics (`result_large_err`, `large_enum_variant`,
`collapsible_if`, `ptr_arg`: 35 baseline / 30 inherited oracle diagnostics).
Original source remains immutable. These Rust ancillary warnings are not
represented as successful checks or as Node failures.

## Review and next gate

Independent review identified and repaired duplicate/grouped CLI options, strict
serde JSON token/depth/number handling, UTF-8/BOM behavior, Webhook URL Basic auth,
signal interruption, WebSocket backpressure and frame/fragment bounds. Those
fixes are protected by comparisons and failure tests.

Proceed to Phase 1 design, then isolated Phase 2 PoC using the Node base. G1
requires actual existing Firefox subscription transfer and actual X notification
decryption plus current Mozilla operating acceptability. Local mock success does
not establish POC-01–05/08/09. Production integration/rollout stays gated.
