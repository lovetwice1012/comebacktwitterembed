"""One-shot operator approval for exactly one primary-intent gate exception."""
import hashlib
import json
from pathlib import Path
import re
import time

try:
    from .restore_mysql import atomic_json
    from .standby_retention import private_json, regular_path
except ImportError:
    from restore_mysql import atomic_json
    from standby_retention import private_json, regular_path

ACTORS = {"933314562487386122", "796972193287503913"}
FIELDS = {"approvalId", "actorId", "expectedEpoch", "candidateId", "backupId", "backupSha256", "sourceTimestamp", "expectedPrimaryIntentRevision", "expectedPrimaryIntentState", "expectedOciPolicyRevision", "reason", "acceptBackupRollback", "acceptMissingSavedata", "acceptPrimaryIntentOverride"}
TTL = 600
VALIDATION_FIELDS = ("id", "container", "directory", "mysqlImage", "manifest", "checks")


def validation_digest(candidate):
    return hashlib.sha256(canonical({key: candidate.get(key) for key in VALIDATION_FIELDS}).encode()).hexdigest()


class ApprovalError(Exception):
    def __init__(self, code, message, status=409):
        self.code, self.status = code, status
        super().__init__(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def intent_binding(value):
    value = value or {}
    return {"desiredState": value.get("desiredState") or "unknown", "revision": value.get("revision")}


def source_matches(record, candidate):
    source = ((candidate or {}).get("manifest") or {}).get("source") or {}
    return (candidate or {}).get("id") == record.get("candidateId") and all(source.get(key) == record.get(field) for key, field in [("backupId", "backupId"), ("sourceSha256", "backupSha256"), ("sourceTimestamp", "sourceTimestamp")])


class ManualApprovals:
    def __init__(self, controller):
        self.controller = controller
        self.root = controller.root / "manual-approvals"

    def public(self, record):
        return {key: value for key, value in record.items() if key != "inputHash"}

    def path(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{48}", identifier):
            raise ApprovalError("INVALID_APPROVAL_ID", "Approval ID must be the fixed management action ID", 400)
        return self.root / (identifier + ".json")

    def load(self):
        pointer = self.root / "current.json"
        if not pointer.exists():
            return None
        selected = private_json(pointer)
        return private_json(self.path(selected.get("approvalId")))

    def save(self, record, state=None, reason=None, publish=True):
        self.root.mkdir(mode=0o700, exist_ok=True)
        regular_path(self.root, directory=True, private=True)
        record = dict(record)
        if state is not None and record.get("state") != state:
            record.update(state=state, updatedAt=time.time())
            record["history"] = list(record.get("history") or []) + [{"state": state, "at": record["updatedAt"], "reason": reason}]
        atomic_json(self.path(record["approvalId"]), record)
        if publish:
            atomic_json(self.root / "current.json", {"approvalId": record["approvalId"]})
            self.controller.update(manualEmergencyApproval=self.public(record))
        return record

    def validate_request(self, role, data):
        if role != "oci":
            raise ApprovalError("OCI_PRODUCER_REQUIRED", "Only the authenticated OCI management producer may record this approval", 403)
        if not isinstance(data, dict) or set(data) != FIELDS or len(canonical(data).encode()) > 4096:
            raise ApprovalError("INVALID_APPROVAL", "Exact bounded emergency approval fields are required", 400)
        self.path(data["approvalId"])
        if data["actorId"] not in ACTORS or type(data["expectedEpoch"]) is not int or data["expectedEpoch"] < 1 or type(data["expectedOciPolicyRevision"]) is not int or data["expectedOciPolicyRevision"] < 1:
            raise ApprovalError("INVALID_APPROVAL", "Allowed administrator, current epoch and OCI policy revision are required", 400)
        if data["expectedPrimaryIntentRevision"] is not None and (type(data["expectedPrimaryIntentRevision"]) is not int or data["expectedPrimaryIntentRevision"] < 1):
            raise ApprovalError("INVALID_APPROVAL", "Primary policy revision must match the last recorded observation", 400)
        if data["expectedPrimaryIntentState"] not in {"running", "stopped", "maintenance", "unknown"} or not isinstance(data["reason"], str) or not 5 <= len(data["reason"].strip()) <= 1000 or "\x00" in data["reason"]:
            raise ApprovalError("INVALID_APPROVAL", "An explicit bounded operator reason and recorded primary intent are required", 400)
        if any(data[key] is not True for key in ("acceptBackupRollback", "acceptMissingSavedata", "acceptPrimaryIntentOverride")):
            raise ApprovalError("CONFIRMATION_REQUIRED", "Backup rollback, missing savedata and the one-time primary-intent exception must each be confirmed", 400)
        if not isinstance(data["candidateId"], str) or not re.fullmatch(r"[0-9a-f]{24}", data["candidateId"]) or not isinstance(data["backupSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", data["backupSha256"]):
            raise ApprovalError("INVALID_APPROVAL", "A fixed validated candidate and backup SHA-256 are required", 400)

    def approve(self, role, data):
        self.validate_request(role, data)
        digest = hashlib.sha256(canonical(data).encode()).hexdigest()
        authority = self.controller.authority()
        self.controller.refresh_operator_intent("oci")
        with self.controller.lock:
            path = self.path(data["approvalId"])
            if path.exists():
                existing = private_json(path)
                if existing.get("inputHash") != digest:
                    raise ApprovalError("APPROVAL_ID_CONFLICT", "This approval ID already belongs to different confirmation data")
                selected = self.load()
                if selected and selected["approvalId"] != existing["approvalId"]:
                    if existing["state"] in {"approved", "reserved"}:
                        existing = self.save(existing, "invalidated", "Another approval became current before this retry", publish=False)
                else:
                    self.save(existing)  # Repair a lost current-pointer/response write without extending expiry.
                    if self.matches_promotion(authority, self.controller.state.get("candidate")):
                        self.consume(authority, self.controller.state.get("candidate"))
                    else:
                        self.current(authority)
                    existing = private_json(path)
                return {"ok": True, "approval": self.public(existing), "reused": True}
            active = self.current(authority)
            if active:
                raise ApprovalError("APPROVAL_ALREADY_PENDING", "An unexpired one-shot approval already exists; it is not extended or replaced")
            state = self.controller.snapshot()
            candidate = state.get("candidate") or {}
            if authority.get("activeNode") != "primary" or authority.get("epoch") != data["expectedEpoch"]:
                raise ApprovalError("APPROVAL_EPOCH_CHANGED", "Fleet ownership or epoch changed; review the current candidate")
            directory = Path(self.controller.config["candidateRoot"]) / data["candidateId"]
            if candidate.get("directory") != str(directory) or candidate.get("phase") != "VALIDATED" or not source_matches(data, candidate):
                raise ApprovalError("APPROVAL_CANDIDATE_CHANGED", "The confirmed candidate or backup no longer matches the validated standby")
            receipt = private_json(directory / "receipt.json")
            if receipt.get("phase") != "VALIDATED" or any(receipt.get(key) != candidate.get(key) for key in VALIDATION_FIELDS) or any((receipt.get("checks") or {}).get(key) is not True for key in ("ciphertextVerified", "importCompleted")):
                raise ApprovalError("APPROVAL_VALIDATION_MISSING", "A matching private checksum/import validation receipt is required")
            primary = intent_binding(state.get("primaryIntent"))
            oci = intent_binding(state.get("ociIntent"))
            if primary != {"desiredState": data["expectedPrimaryIntentState"], "revision": data["expectedPrimaryIntentRevision"]} or oci["revision"] != data["expectedOciPolicyRevision"] or (state.get("ociIntent") or {}).get("observationState") != "fresh":
                raise ApprovalError("APPROVAL_INTENT_CHANGED", "Operator intent changed or OCI intent is unavailable; review it again")
            now = time.time()
            record = dict(data, inputHash=digest, state="approved", createdAt=now, updatedAt=now, expiresAt=now + TTL,
                          primaryIntent=primary, ociIntent=oci, overriddenGate="PRIMARY_OPERATOR_RUNNING", primaryIntentPreserved=True,
                          validationDigest=validation_digest(receipt), doesNotArm=True, requiresOtherGates=True, history=[{"state": "approved", "at": now, "actorId": data["actorId"]}])
            self.save(record)
            return {"ok": True, "approval": self.public(record), "reused": False}

    def current(self, authority, reserve=False):
        with self.controller.lock:
            record = self.load()
            if not record or record.get("state") not in {"approved", "reserved"}:
                return None
            state = self.controller.snapshot()
            now = time.time()
            if now >= record["expiresAt"] or now < record["createdAt"] - 5:
                self.save(record, "expired", "Approval deadline or clock validity expired")
                return None
            if authority.get("activeNode") != "primary" or authority.get("epoch") != record["expectedEpoch"] or not source_matches(record, state.get("candidate")) or validation_digest(state.get("candidate") or {}) != record["validationDigest"]:
                self.save(record, "invalidated", "Epoch or selected candidate/backup changed")
                return None
            if intent_binding(state.get("primaryIntent")) != record["primaryIntent"] or intent_binding(state.get("ociIntent")) != record["ociIntent"]:
                self.save(record, "invalidated", "An operator policy revision changed before this promotion was accepted")
                return None
            if reserve:
                receipt = private_json(Path(self.controller.config["candidateRoot"]) / record["candidateId"] / "receipt.json")
                if receipt.get("phase") != "VALIDATED" or validation_digest(receipt) != record["validationDigest"]:
                    self.save(record, "invalidated", "Private candidate validation evidence changed")
                    return None
                record["promotionKey"] = f"manual-oci-{record['expectedEpoch']}-{record['candidateId']}-{record['approvalId']}"
                record = self.save(record, "reserved", "One exact promotion attempt reserved; all other gates remain required")
            else:
                self.controller.update(manualEmergencyApproval=self.public(record))
            return record

    def matches_promotion(self, authority, candidate):
        record = self.load()
        return bool(record and record.get("state") in {"reserved", "consumed"} and authority.get("activeNode") == "oci" and authority.get("epoch") == record["expectedEpoch"] + 1 and self.controller.state.get("promotionKey") == record.get("promotionKey") and source_matches(record, candidate))

    def consume(self, authority, candidate):
        with self.controller.lock:
            if self.matches_promotion(authority, candidate):
                # Ownership already changed under this exact reserved key. The
                # controller's seed-maintenance -> running CAS is not a new approval.
                self.save(self.load(), "consumed", "The reserved promotion is confirmed; this approval cannot authorize another attempt")
            else:
                record = self.load()
                if record and record.get("state") in {"approved", "reserved"} and authority.get("activeNode") == "oci":
                    self.save(record, "invalidated", "Ownership changed outside this exact reserved approval; it cannot be reused")
