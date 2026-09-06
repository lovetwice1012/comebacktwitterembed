# Explicit one-shot emergency approval

The independent OCI Go Web recovery tab can record a ten-minute approval for one exact validated candidate when the primary remains unreachable but its last recorded intent is stopped, maintenance or unknown. It preserves that original primary intent. This is an explicit administrator action; automation is not allowed to create it.

The approval overrides **only** `PRIMARY_OPERATOR_RUNNING`. `AUTOMATION_ARMED`, enrollment, backup identity/freshness, validation, accepted missing savedata, old lease expiration, drain/quarantine, runtime/routing preparation and current OCI operator intent remain required. The action does not arm recovery, request DNS changes or directly start a service. The normal controller may consume the approval only when every other gate is satisfied.

The action is `recovery.emergency.approve`, submitted through the existing authenticated/CSRF-protected `POST /v1/actions` API. An operator can also use that API directly without a browser. Obtain the exact fields from `GET /v1/recovery`, then submit:

```json
{
  "type": "recovery.emergency.approve",
  "idempotencyKey": "unique-operator-request-key",
  "input": {
    "expectedEpoch": 2,
    "candidateId": "EXACT_CURRENT_CANDIDATE_ID",
    "backupId": "EXACT_CURRENT_BACKUP_ID",
    "backupSha256": "EXACT_CURRENT_SOURCE_SHA256",
    "sourceTimestamp": "EXACT_CURRENT_SOURCE_TIMESTAMP",
    "expectedPrimaryIntentRevision": 3,
    "expectedPrimaryIntentState": "maintenance",
    "expectedOciPolicyRevision": 24,
    "reason": "Explicit operator explanation of why emergency activation is needed",
    "acceptBackupRollback": true,
    "acceptMissingSavedata": true,
    "acceptPrimaryIntentOverride": true
  }
}
```

The numbers above are examples, not defaults. The UI displays the candidate, backup timestamp/SHA, primary intent and OCI revision before requiring all three acknowledgements. The actual allowed Discord principal and durable action ID are supplied by Go, not accepted from user input. The producer uses its existing separate OCI intent token for the internal `POST /v1/emergency-approvals` endpoint. Neither authority role credentials nor primary intent credentials are sent by this action.

Root-private receipts under the controller's `manual-approvals` directory retain the approval ID, actor, reason, confirmations, original intent bindings, validation digest, expiry and lifecycle history. Only one current unexpired approval may exist. Repeating the same ID and data does not extend its expiry; different data under that ID is rejected. Changed epochs, candidate/backup identity or operator revisions invalidate unused approval. The private validation receipt is checked again when reserving the attempt.

A reserved approval produces one stable `manual-oci-...` promotion key. A lost response is reconciled with the same candidate/epoch/key instead of choosing another database. A confirmed promotion consumes the approval before the controller's own OCI seed-maintenance-to-running CAS; that expected CAS does not invalidate an already used authorization. Subsequent OCI stop/maintenance instructions still prevent workload start through the existing OCI intent gate. An already accepted fleet promotion is not reversed by the approval mechanism.

`approved` means the bounded permission was recorded, not that the Bot is running. Check the action receipt, `manualEmergencyApproval`, all remaining gates, activation proof and public-route verification. If a response is uncertain, inspect the saved approval ID before creating another request. No policy or controller state should be edited to fabricate confirmation.

This source feature must be reviewed and deployed as a coordinated controller/module/Go update before use. Adding it to the repository does not grant, arm or execute a live emergency activation.
