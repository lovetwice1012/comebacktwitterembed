# Independent whole-provider acceptance review

Reviewed candidate: `d21301e81307012226d253e7a9119f32e7bbd5d5`.
Full comparison: `f241aa268344b407adf64735f1d8bd3c3aa12968..d21301e81307012226d253e7a9119f32e7bbd5d5`.

## Result

**No confirmed P1/P2 finding and no residual candidate in the reviewed provider / command / notification-destination scope.** The previously confirmed S18/S24 native exact-key default-resource re-registration defect is fixed. This conclusion is scoped to provider, command and destination behavior; it does not approve the concurrently changing history backend/UI, the entire checkout, production delivery, or the final release bundle.

## Independent verification

- Eleven focused files: **164 tests, 164 passed, 0 failed, 0 skipped**, 65,678 ms. JUnit: `sat-provider-v7-independent-focused.xml`.
- Independent public-command probes: **24 conditions passed** across new-item/price × raw webhook/selected channel/DM × disabled/deleted/foreign/healthy default resources. This repeats the original adverse and healthy webhook witnesses and extends them to DM, selected-channel and foreign-owner cases. It uses the real command handlers, native stores and **actual `createService` fallback factory**, with no service argument injected into native registration. Only Discord REST responses and the operation-budget fixture policy are injected.
- Disabled/deleted/foreign resources reject registration with actionable safe replies, preserve the paused target, target count, slots, pending jobs, monitor metadata and audit state. All six healthy route controls reuse the same target, five slots and resource binding without changing the monitor revision. Both DM routes make **zero REST calls** in all four states.
- Actual fallback service construction resolves the mocked Discord transport through the normal default destination-verifier construction. This verifies the production native fallback wiring, beyond tests that supply `options.service` explicitly.
- Six disposable random SQL schemas from the independent probe were independently confirmed absent after cleanup. The focused tests clean up their own schemas.

Evidence: `sat-provider-v7-fallback-probe.cjs`, `sat-provider-v7-fallback-probe.json`, `sat-provider-v7-before.json`, `sat-provider-v7-after.json`.

## Whole-scope recheck

The previous whole-provider review found only the exact-key default-resource gap. All provider implementation files outside the six-file follow-up commit remain unchanged; the changed common validator, native handlers and safe error mapping were inspected in full and against adjacent store branches. Every native existing-target branch calls the common validator before its enabling upsert, including exact webhook keys, selected-channel key matches, legacy channel repair, DM and already enabled retries. It validates the bound default independently of workflow assignment, enforces scope and private ownership, permits existing shared-resource use without granting resource-edit rights, and reuses fresh endpoint/recipient owner validation and transactional resource/endpoint locks. It retains legitimate unmanaged native targets and explicit same-channel repair. Target/config endpoint equality is intentionally not imposed on this repair path.

Rechecked the full baseline diff and original provider-relevant findings: durable rolling observations and local backlog admission/rescue; interval/backoff/lease preservation; Steam discount metadata and threshold handling; BOOTH first-observation validation; strict native price input; interaction acknowledgement and safe error replies; stable native channel identity; native/Dashboard channel and raw URL locking/adoption; rollback, uncertain commit and cleanup; legacy dead-endpoint repair without origin-channel guessing; editor and actual owner permissions; managed/unmanaged missing or moved endpoint checks; private/shared bindings; custom workflow activation/attach/resume; X default/custom settings and resume; endpoint/resource identity CAS; and pause/removal/disabled-edit/DM controls.

The focused tests independently cover adverse REST 404/410/403/429/503, resource deletion/disable, moved recipient, URL/hash/resource identity swaps, denied owner/editor access, SQL failure rollback, partial registration rollback, webhook creator/adopter races, commit acknowledgement loss, unknown creation outcome, foreign-resource retention, explicit legacy repair, and healthy controls. The earlier 24 baseline-vs-candidate resume witnesses remain applicable to the unchanged monitor resume implementation; the resume paths were exercised again by the focused suite.

Bot runtime, Dashboard and local UI harness callback construction still supplies both `verifyChannel` and `verifyWebhook` through the shared destination service. Twenty-two frozen product-source files have identical before/after SHA-256 fingerprints. HEAD remained d213 during this review. The checkout is intentionally dirty in other owners' history/UI files and in `scripts/automation-ui-harness.js`; no whole-checkout-clean claim is made. The harness seed change was excluded from the frozen product proof. A separate fixture-only concern was sent to the parent: its new stop action uses `pausedDestination.revision`, while `saveDestination` returns only `{ id }`; the parent owns correcting that fixture revision.

## Boundary

Read-only source review plus disposable local MariaDB at port 33621 and mocked Discord. No real OAuth, Discord webhook/message, production DB/deployment, paid payment, Git mutation or repository source mutation was performed. This report does not substitute for final frozen aggregate checks, real-user X-to-Discord validation or production resident proof.
