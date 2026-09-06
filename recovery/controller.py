#!/usr/bin/env python3
"""Durable OCI backup preparation and guarded, one-way emergency promotion.

The separate authority is the only source of ownership. HTTP failures are
diagnostic observations, never permission to replace an unenrolled primary.
"""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import hmac
import http.server
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

INTENT_ACTORS = frozenset({"933314562487386122", "796972193287503913"})


class IntentError(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.status = code, status
        super().__init__(message)

try:
    from .restore_mysql import atomic_json, read_json, verify_artifact, prepare, run
    from .standby_retention import ensure_capacity, quarantine_interrupted_candidate, private_json
    from .cipher_retention import prune_validated_cache
except ImportError:
    from restore_mysql import atomic_json, read_json, verify_artifact, prepare, run
    from standby_retention import ensure_capacity, quarantine_interrupted_candidate, private_json
    from cipher_retention import prune_validated_cache


def iso_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def age_seconds(timestamp):
    parsed = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Backup timestamp has no timezone")
    return time.time() - parsed.timestamp()


def candidate_source(candidate):
    manifest = (candidate or {}).get("manifest") or {}
    return manifest.get("source") or {}


def same_backup_source(left, right):
    """Bind freshness to the archive actually imported into this candidate."""
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    return all(isinstance(left.get(key), str) and bool(left[key]) and left[key] == right.get(key)
               for key in ("backupId", "sourceSha256", "sourceTimestamp"))


def download_progress(manifest, state, received, **proof):
    source, export = manifest.get("source") or {}, manifest["export"]
    return {"exportId": manifest["exportId"], "backupId": source.get("backupId"), "sourceSha256": source.get("sourceSha256"),
            "exportSha256": export["sha256"], "expectedBytes": int(export["bytes"]), "receivedBytes": received,
            "state": state, "checksumVerified": state == "verified", **proof}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def endpoint(base, path):
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Recovery endpoints must use authenticated loopback HTTP tunnels")
    return base.rstrip("/") + path


def request_json(base, token, path, body=None, timeout=90, method=None):
    verb = method or ("GET" if body is None else "POST")
    if verb not in {"GET", "POST", "PUT"} or (verb == "GET" and body is not None) or (verb == "PUT" and not isinstance(body, dict)):
        raise ValueError("Unsupported recovery JSON method/body combination")
    request = urllib.request.Request(endpoint(base, path), data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method=verb)
    with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=timeout) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError("Recovery metadata response exceeded its limit")
        return json.loads(data)


def intent_is_known(intent):
    return (isinstance(intent, dict) and intent.get("observationState") in {"fresh", "stale"}
            and intent.get("desiredState") in {"running", "stopped", "maintenance"}
            and type(intent.get("revision")) is int and intent["revision"] > 0
            and isinstance(intent.get("fetchedAt"), str) and bool(intent["fetchedAt"]))


def intent_wants_running(intent, fresh=False):
    if not intent_is_known(intent) or intent.get("desiredState") != "running" or intent.get("policyDetailsConfirmed") is False or (fresh and intent.get("observationState") != "fresh"):
        return False
    until = intent.get("maintenanceUntil")
    try:
        return not until or age_seconds(until) >= 0
    except (ValueError, TypeError):
        return False


def is_seeded_oci_intent(intent, config):
    seed = config.get("ociStandbyPolicyRevision")
    return (type(seed) is int and seed > 0 and intent_is_known(intent)
            and intent.get("observationState") == "fresh"
            and intent.get("desiredState") == "maintenance" and intent.get("revision") == seed)


def promotion_gates(authority, backup, candidate, config, primary_intent=None, oci_intent=None):
    now = time.time()
    source = candidate_source(candidate)
    bound = same_backup_source(backup, source)
    try:
        age = age_seconds(source["sourceTimestamp"]) if bound else float("inf")
    except (ValueError, TypeError, KeyError):
        age = float("inf")
    lease = authority.get("lease") or {}
    gate = lambda code, message, ready: {"code": code, "message": message, "ready": bool(ready)}
    return [
        gate("BACKUP_SOURCE_MATCH", "復元した候補とバックアップの世代・SHA256・時刻が一致", bound),
        gate("BACKUP_FRESH", "許容時間内の検証済みバックアップ", bound and -300 <= age <= config.get("maxBackupAgeSeconds", 129600)),
        gate("DATABASE_VALIDATED", "独立MySQLへの復元と必須テーブル検証", candidate and candidate.get("phase") in ("VALIDATED", "ACTIVE")),
        gate("SAVEDATA_CONSTRAINT", "savedataを移行しない制約の合意", config.get("allowMissingSavedata") is True),
        gate("PRIMARY_ENROLLED", "本体の起動許可・停止監視の導入証明", authority.get("primaryEnrolled")),
        gate("AUTOMATION_ARMED", "自動切り替えの有効化", authority.get("armed")),
        gate("PRIMARY_OPERATOR_RUNNING", "本体で最後に確認した管理者の運転指示が稼働中", intent_wants_running(primary_intent)),
        gate("OCI_OPERATOR_PERMITS_PROMOTION", "OCIの運転指示が稼働中、または未変更の初期待機設定", intent_wants_running(oci_intent, fresh=True) or is_seeded_oci_intent(oci_intent, config)),
        gate("OLD_LEASE_EXPIRED", "本体の起動許可が失効している", not lease.get("valid") and now >= float(lease.get("expiresAt") or 0)),
        gate("LEASE_DRAIN_COMPLETE", "旧プロセス停止後の待機期間が経過", now >= max(float(authority.get("quarantineUntil") or 0), float(authority.get("drainUntil") or 0), float(lease.get("expiresAt") or 0) + 60)),
        gate("RUNTIME_PREPARED", "固定したOCI実行環境と設定を配置済み", config.get("runtimeReady") is True and Path(config.get("workloadConfig", "/nonexistent")).is_file()),
        gate("ROUTING_PREPARED", "公開経路の切り替え設定を配置済み", config.get("routingReady") is True),
    ]


class Controller:
    def __init__(self, config):
        self.config = config
        self.root = Path(config["stateDir"]).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.cache = self.root / "ciphertexts"
        self.cache.mkdir(mode=0o700, exist_ok=True)
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.state_path = self.root / "state.json"
        self.state = read_json(self.state_path, {"phase": "UNCONFIGURED", "gates": [], "candidate": None, "backup": None})
        self._policies = {}
        self._intent_observer = None
        if self.state.get("phase") in ("RESTORING_ISOLATED", "VALIDATING", "INITIALIZING"):
            candidate = self.state.get("candidate") or {}
            try:
                quarantined = quarantine_interrupted_candidate(config, candidate, self.authority)
                self.update(phase="PREPARATION_INTERRUPTED", candidate=quarantined, backup=None,
                            lastError={"code": "RESTORE_INTERRUPTED", "message": "中断した復元候補の所有権と停止を確認し、再利用せず隔離しました。"})
            except Exception as error:
                # Keep the original identity for later investigation; an
                # unknown container is never silently forgotten or deleted.
                self.update(phase="PREPARATION_INTERRUPTED", candidate=candidate or None, backup=None,
                            lastError={"code": "RESTORE_QUARANTINE_UNCONFIRMED", "message": str(error)})
        self.normalize_validated_download()

    def update(self, **changes):
        with self.lock:
            updated = dict(self.state, **changes, updatedAt=iso_now())
            atomic_json(self.state_path, updated)
            self.state = updated

    def snapshot(self):
        with self.lock:
            return json.loads(json.dumps(self.state))

    def normalize_validated_download(self):
        """Repair legacy display state from a matching historical restore proof."""
        state = self.snapshot()
        candidate, prior = state.get("candidate") or {}, state.get("download") or {}
        if state.get("phase") != "STANDBY_READY" or candidate.get("phase") != "VALIDATED":
            return False
        source = candidate_source(candidate)
        if not same_backup_source(state.get("backup"), source) or (state.get("pendingBackup") and not same_backup_source(state["pendingBackup"], source)):
            return False
        try:
            identifier = candidate["id"]
            if not re.fullmatch(r"[0-9a-f]{24}", identifier):
                return False
            directory = Path(self.config["candidateRoot"]) / identifier
            if candidate.get("directory") != str(directory):
                return False
            receipt = private_json(directory / "receipt.json")
            if receipt.get("phase") != "VALIDATED" or any(receipt.get(key) != candidate.get(key) for key in ("id", "directory", "container", "mysqlImage", "manifest", "checks")):
                return False
            checks, manifest = receipt.get("checks") or {}, receipt["manifest"]
            export = manifest["export"]
            verified_at = receipt.get("validatedAt")
            if checks.get("ciphertextVerified") is not True or checks.get("importCompleted") is not True or not same_backup_source(manifest.get("source"), source):
                return False
            if type(export.get("bytes")) is not int or export["bytes"] <= 0 or not re.fullmatch(r"[0-9a-f]{64}", export.get("sha256", "")) or not re.fullmatch(r"[0-9a-f]{64}", manifest.get("exportId", "")) or export.get("ociRecipient") != self.config["ociRecipient"]:
                return False
            if isinstance(verified_at, bool) or not isinstance(verified_at, (int, float)) or not math.isfinite(verified_at) or verified_at <= 0:
                return False
            if (prior.get("exportId") and prior["exportId"] != manifest["exportId"]) or (prior.get("backupId") and prior["backupId"] != source["backupId"]):
                return False
            if prior.get("state") == "verified" and prior.get("checksumVerified") is True and prior.get("receivedBytes") == export["bytes"] and prior.get("expectedBytes") == export["bytes"] and prior.get("exportId") == manifest["exportId"]:
                return False
            stamp = dt.datetime.fromtimestamp(verified_at, dt.timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return False
        self.update(download=download_progress(manifest, "verified", export["bytes"], verificationSource="validated_restore_receipt", verifiedAt=stamp, normalizedAt=iso_now(), transferredNow=False))
        return True

    def authority(self):
        return request_json(self.config["authorityUrl"], self.config["authorityControllerToken"], "/v1/status", timeout=10)

    def exporter(self, path, body=None):
        return request_json(self.config["exporterUrl"], self.config["exporterToken"], path, body)

    def admin_policy(self, node, body=None):
        if node not in {"primary", "oci"}:
            raise ValueError("Unknown operator-intent node")
        base = self.config.get(node + "AdminUrl", "http://127.0.0.1:30988" if node == "oci" else "http://127.0.0.1:34224")
        token = self.config.get(node + "AdminToken", "")
        if not isinstance(token, str) or len(token) < 32:
            raise ValueError("Operator-intent credential is not configured")
        return request_json(base, token, "/v1/policies", body, timeout=5, method="PUT" if body is not None else "GET")

    def refresh_operator_intent(self, node):
        key = node + "Intent"
        policy, error = None, None
        try:
            policy = self.admin_policy(node)
            if not isinstance(policy, dict) or policy.get("desiredState") not in {"running", "stopped", "maintenance"} or type(policy.get("revision")) is not int or policy["revision"] < 1:
                raise ValueError("Invalid operator policy")
            until = policy.get("maintenanceUntil") or ""
            if until:
                age_seconds(until)  # Reject invalid/naive timestamps.
        except Exception as failure:
            error = failure
        # Network I/O never holds this lock: a synchronous stop push can be
        # acknowledged while a GET or multi-hour database import is blocked.
        with self.lock:
            previous = self.state.get(key) or {}
            previously_observed = intent_is_known(dict(previous, observationState="stale"))
            checked = iso_now()
            if error is None and previously_observed and policy["revision"] < previous["revision"]:
                intent = dict(previous, checkedAt=checked, pollState="outdated", observationState="stale" if previous.get("lastPushedRevision") else "unknown",
                              reason="新しい運転指示を受信済みのため、遅れて届いた古いポリシー応答を無視しました。")
            elif error is None and previously_observed and policy["revision"] == previous["revision"] and (policy["desiredState"] != previous["desiredState"] or (previous.get("policyDetailsConfirmed") is not False and until != previous.get("maintenanceUntil", ""))):
                intent = dict(previous, checkedAt=checked, pollState="conflict", observationState="unknown",
                              reason="同じrevisionに異なる運転指示があるため自動起動を保留しました。")
            elif error is None:
                self._policies[node] = dict(policy)
                intent = dict(previous, desiredState=policy["desiredState"], revision=policy["revision"], maintenanceUntil=until,
                              fetchedAt=checked, checkedAt=checked, observationState="fresh", pollState="current", source="poll",
                              policyDetailsConfirmed=True, reason="管理デーモンの最新の運転指示を確認しました。")
            else:
                known = intent_is_known(previous) and not isinstance(error, (ValueError, TypeError, KeyError))
                intent = dict(previous, checkedAt=checked, observationState="stale" if known else "unknown", pollState="unavailable",
                              reason="管理デーモンに接続できないため最後に確認した運転指示を保持しています。" if known else "管理者の運転指示が未取得、設定不足、または不正な応答のため自動起動を許可できません。")
            if intent.get("pollState") != "current":
                self._policies.pop(node, None)
            self.update(**{key: intent})
            return intent

    def record_operator_intent(self, role, value):
        if not isinstance(value, dict) or set(value) != {"node", "desiredState", "revision", "actorId"}:
            raise IntentError("INVALID_INTENT", "Exactly node, desiredState, revision and actorId are required")
        if not all(isinstance(value[key], str) for key in ("node", "desiredState", "actorId")) or value["node"] not in {"primary", "oci"} or value["desiredState"] not in {"running", "stopped", "maintenance"} or type(value["revision"]) is not int or not 1 <= value["revision"] <= 2**53 - 1 or value["actorId"] not in INTENT_ACTORS:
            raise IntentError("INVALID_INTENT", "Unsupported node, desired state, revision or actor")
        if role != value["node"]:
            raise IntentError("INTENT_ROLE_MISMATCH", "This token cannot assert another node's operator intent", 403)
        key = role + "Intent"
        with self.lock:
            previous = self.state.get(key) or {}
            known = intent_is_known(dict(previous, observationState="stale"))
            if known and value["revision"] < previous["revision"]:
                raise IntentError("STALE_INTENT_REVISION", "A newer operator intent is already durable", 409)
            if known and value["revision"] == previous["revision"]:
                if value["desiredState"] != previous["desiredState"]:
                    raise IntentError("INTENT_REVISION_CONFLICT", "This revision already identifies another desired state", 409)
                # The exact intent is already durable; retries do not clear
                # full policy details that may have been polled meanwhile.
                return {"ok": True, "node": role, "desiredState": value["desiredState"], "revision": value["revision"]}
            checked = iso_now()
            intent = dict(previous, desiredState=value["desiredState"], revision=value["revision"], maintenanceUntil=previous.get("maintenanceUntil", ""),
                          fetchedAt=checked, checkedAt=checked, observationState="fresh", source="push", pushActorId=value["actorId"],
                          lastPushedAt=checked, lastPushedRevision=value["revision"], policyDetailsConfirmed=False,
                          reason="管理デーモンから受け取った運転指示を永続化しました。稼働指示の保守期限は別途確認します。")
            self._policies.pop(role, None)
            self.update(**{key: intent})  # Atomic write + fsync precedes ACK.
            return {"ok": True, "node": role, "desiredState": value["desiredState"], "revision": value["revision"]}

    def observe_intents_once(self):
        live = self.authority()
        if live.get("activeNode") == "primary":
            self.refresh_operator_intent("primary")
            self.refresh_operator_intent("oci")
        elif live.get("activeNode") == "oci":
            self.refresh_operator_intent("oci")
        else:
            raise ValueError("Unknown fleet owner while observing operator intent")
        self.update(intentObserver={"state": "observing", "checkedAt": iso_now(), "intervalSeconds": 15})

    def start_intent_observer(self):
        with self.lock:
            if self._intent_observer and self._intent_observer.is_alive():
                return self._intent_observer
            def observe():
                while not self.stop.is_set():
                    try:
                        self.observe_intents_once()
                    except Exception:
                        try:
                            self.update(intentObserver={"state": "unavailable", "checkedAt": iso_now(), "intervalSeconds": 15})
                        except Exception:
                            pass  # No successful ACK can be issued by a failed state store.
                    self.stop.wait(15)
            self._intent_observer = threading.Thread(target=observe, name="cbte-operator-intent", daemon=True)
            self._intent_observer.start()
            return self._intent_observer

    def activate_oci_operator_intent(self):
        """Only the exact controller-owned standby revision may be changed."""
        intent = self.refresh_operator_intent("oci")
        plan = self.state.get("ociActivationPolicy") or {}
        if plan.get("state") != "pending":
            return intent
        if intent_wants_running(intent, fresh=True):
            self.update(ociActivationPolicy=dict(plan, state="applied", observedRevision=intent["revision"], checkedAt=iso_now()))
            return intent
        if intent.get("observationState") != "fresh":
            return intent
        if plan.get("seedRevision") != self.config.get("ociStandbyPolicyRevision") or not is_seeded_oci_intent(intent, self.config):
            self.update(ociActivationPolicy=dict(plan, state="blocked", reason="管理者が初期待機設定を変更したため自動で上書きしません。", checkedAt=iso_now()))
            return intent
        policy = dict(self._policies.get("oci") or {})
        if policy.get("revision") != intent["revision"]:
            return intent  # A newer pushed intent arrived during the policy GET.
        policy.update(desiredState="running", expectedRevision=intent["revision"])
        try:
            self.admin_policy("oci", policy)
        except Exception:
            # A lost PUT response can mean success. Re-read before deciding,
            # and only ever retry the same unchanged seed revision.
            self.update(ociActivationPolicy=dict(plan, reason="OCI運転指示の保存結果を再確認しています。", checkedAt=iso_now()))
        intent = self.refresh_operator_intent("oci")
        if intent_wants_running(intent, fresh=True):
            self.update(ociActivationPolicy=dict(plan, state="applied", observedRevision=intent["revision"], checkedAt=iso_now()))
        elif intent.get("observationState") == "fresh" and not is_seeded_oci_intent(intent, self.config):
            self.update(ociActivationPolicy=dict(plan, state="blocked", reason="運転指示が変更されたため自動起動を中止しました。", checkedAt=iso_now()))
        return intent

    def reconcile_oci_workload(self, authority, active):
        intent = self.activate_oci_operator_intent()
        status = run(["systemctl", "show", "cbte-recovery-workload.service", "--property=ActiveState", "--value"], timeout=10).strip()
        if not intent_wants_running(intent, fresh=True):
            self.update(phase="OCI_OPERATOR_PAUSED" if intent.get("observationState") == "fresh" else "OCI_OPERATOR_INTENT_UNCONFIRMED",
                        candidate=active, workloadUnitState=status,
                        operatorIntentReason="管理者の停止・保守指示を尊重し、自動起動を停止しています。" if intent.get("observationState") == "fresh" else "OCI管理デーモンの運転指示を確認できないため、稼働中のBotを維持し、新規起動は行いません。")
            return
        if status not in {"active", "activating"}:
            run(["systemctl", "start", "cbte-recovery-workload.service"], timeout=30)
            status = run(["systemctl", "show", "cbte-recovery-workload.service", "--property=ActiveState", "--value"], timeout=10).strip()
        self.update(phase="VERIFYING" if status == "active" else "ACTIVATING", candidate=active, workloadUnitState=status, operatorIntentReason=None)
        if status == "active":
            self.verify_active(authority, active)

    def download(self, export_id, manifest):
        if not re.fullmatch(r"[0-9a-f]{64}", export_id):
            raise ValueError("Invalid export ID")
        metadata = manifest["export"]
        if manifest.get("exportId") != export_id or metadata.get("ociRecipient") != self.config["ociRecipient"]:
            raise ValueError("Export identity or recipient does not match this OCI installation")
        expected_hash, expected_bytes = metadata["sha256"], int(metadata["bytes"])
        if expected_bytes <= 0 or expected_bytes > int(self.config.get("maxCiphertextBytes", 16 * 1024**3)):
            raise ValueError("Export exceeds the OCI ciphertext size limit")
        destination = self.cache / (export_id + ".sql.zst.age")
        if destination.exists():
            self.update(download=download_progress(manifest, "verifying_cache", 0))
            try:
                verify_artifact(destination, expected_hash, expected_bytes)
            except Exception:
                self.update(download=download_progress(manifest, "failed", 0))
                raise
            self.update(download=download_progress(manifest, "verified", expected_bytes, verificationSource="cache_checksum_verified", verifiedAt=iso_now(), transferredNow=False))
            return destination
        temporary = destination.with_name(destination.name + "." + secrets.token_hex(5) + ".partial")
        request = urllib.request.Request(endpoint(self.config["exporterUrl"], "/v1/exports/" + export_id + "/data"),
                                         headers={"Authorization": "Bearer " + self.config["exporterToken"]})
        digest, received, last_update = hashlib.sha256(), 0, 0.0
        deadline = time.monotonic() + int(self.config.get("downloadTimeoutSeconds", 1800))
        self.update(phase="DOWNLOADING", download=download_progress(manifest, "downloading", 0))
        try:
            fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "wb") as output, urllib.request.build_opener(NoRedirect()).open(request, timeout=90) as response:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    received += len(chunk)
                    if received > expected_bytes or time.monotonic() >= deadline or self.stop.is_set():
                        raise TimeoutError("Encrypted backup download exceeded its size/time budget")
                    digest.update(chunk)
                    output.write(chunk)
                    if time.monotonic() - last_update >= 15:
                        self.update(phase="DOWNLOADING", download=download_progress(manifest, "downloading", received))
                        last_update = time.monotonic()
                output.flush()
                os.fsync(output.fileno())
            if received != expected_bytes or digest.hexdigest() != expected_hash:
                raise ValueError("Downloaded encrypted backup failed checksum verification")
            os.replace(temporary, destination)
            verify_artifact(destination, expected_hash, expected_bytes)
            self.update(download=download_progress(manifest, "verified", expected_bytes, verificationSource="download_checksum_verified", verifiedAt=iso_now(), transferredNow=True))
            return destination
        except Exception:
            self.update(download=download_progress(manifest, "failed", received))
            raise
        finally:
            if temporary.exists():
                temporary.unlink()

    def prepare_latest(self):
        newest = self.exporter("/v1/backups/latest")["backup"]
        self.update(pendingBackup=newest)
        if not -300 <= age_seconds(newest["sourceTimestamp"]) <= self.config.get("maxBackupAgeSeconds", 129600):
            self.update(phase="BACKUP_STALE", lastError={"code": "BACKUP_STALE", "message": "最新の検証済みバックアップが許容時間外です。"})
            return
        current = self.state.get("candidate") or {}
        if same_backup_source(candidate_source(current), newest) and current.get("phase") == "VALIDATED":
            self.update(backup=candidate_source(current), pendingBackup=None)
            self.normalize_validated_download()
            self.prune_candidates(current["id"])
            return
        self.update(phase="PINNING_BACKUP", lastError=None)
        job = self.exporter("/v1/exports", {"backupId": newest["backupId"]})
        export_id = job["exportId"]
        deadline = time.monotonic() + int(self.config.get("exportTimeoutSeconds", 2100))
        while job["state"] != "ready":
            if job["state"] in ("failed", "interrupted"):
                raise RuntimeError("NAS export failed: " + json.dumps(job.get("error"), ensure_ascii=False))
            if time.monotonic() >= deadline or self.stop.wait(5):
                raise TimeoutError("NAS export did not complete within its deadline")
            self.update(phase="EXPORTING", export={"exportId": export_id, "state": job["state"]})
            job = self.exporter("/v1/exports/" + export_id)
        manifest = job["manifest"]
        if not same_backup_source(manifest.get("source"), newest):
            raise ValueError("The exported archive differs from the pinned backup")
        artifact = self.download(export_id, manifest)
        capacity = ensure_capacity(self.config, artifact, manifest, self.state.get("candidate"), self.authority, self.update)
        self.update(restoreCapacity=capacity)
        self.update(phase="RESTORING_ISOLATED", candidate=None)
        candidate = prepare(self.config, manifest, artifact, lambda value: self.update(**value))
        if not same_backup_source(candidate_source(candidate), newest):
            raise ValueError("The restored candidate differs from the pinned backup")
        atomic_json(self.root / "prepared-candidate.json", candidate)
        self.update(phase="STANDBY_READY", candidate=candidate, backup=candidate_source(candidate), pendingBackup=None, lastError=None)
        self.prune_candidates(candidate["id"])

    def prune_candidates(self, protected_id):
        """Keep receipt history; database retirement has its own ownership journal."""
        try:
            result = prune_validated_cache(self.config, protected_id)
        except Exception as error:
            # A validated standby remains usable even when cache ownership or
            # verification is uncertain. Never turn cleanup failure into a lost
            # candidate, or continue with destructive fallback cleanup.
            result = {"state": "blocked", "code": type(error).__name__,
                      "message": str(error), "receiptsPreserved": True,
                      "checkedAt": time.time()}
        self.update(ciphertextRetention=result)

    def activate(self, authority):
        candidate = self.state["candidate"]
        primary_intent = self.refresh_operator_intent("primary")
        oci_intent = self.refresh_operator_intent("oci")
        if not intent_wants_running(primary_intent) or not (intent_wants_running(oci_intent, fresh=True) or is_seeded_oci_intent(oci_intent, self.config)):
            self.update(phase="OPERATOR_PROMOTION_BLOCKED", operatorIntentReason="管理者の運転指示が昇格直前に変更されたか、確認できなくなったため昇格を中止しました。")
            return
        key = f"oci-{authority['epoch']}-{candidate['id']}"
        policy_plan = {"state": "pending", "seedRevision": oci_intent["revision"], "reservedAt": iso_now()} if is_seeded_oci_intent(oci_intent, self.config) else None
        self.update(phase="PROMOTION_RESERVED", promotionKey=key, ociActivationPolicy=policy_plan)
        # The exact key is persisted before the request. A lost response is
        # reconciled against authority state instead of selecting another owner.
        result = request_json(self.config["authorityUrl"], self.config["authorityControllerToken"], "/v1/promote",
                              {"target": "oci", "expectedEpoch": authority["epoch"], "idempotencyKey": key}, timeout=15)
        epoch = result["epoch"]
        candidate = dict(candidate, epoch=epoch)
        atomic_json(self.root / "active-candidate.json", candidate)
        self.update(phase="ACTIVATING", epoch=epoch, activeNode="oci", candidate=candidate)
        self.reconcile_oci_workload(self.authority(), candidate)

    def verify_active(self, authority, candidate):
        """Routing needs a fresh proof of this Bot, not merely a live web server."""
        workload = read_json(self.config.get("workloadConfig", "/nonexistent")) or {}
        runtime = Path(workload.get("runtimeRoot", "/var/lib/cbte-recovery/workload")) / candidate["id"]
        proof = read_json(runtime / "activation.json") or {}
        lease = read_json(workload.get("leaseFile", "/nonexistent")) or {}
        now = time.time()
        live = authority.get("lease") or {}
        valid = (proof.get("phase") == "ACTIVE" and proof.get("candidateId") == candidate["id"]
                 and proof.get("bootstrapComplete") is True
                 and proof.get("epoch") == authority["epoch"] and not proof.get("observabilityDegraded")
                 and 0 <= now - float(proof.get("gatewayProofVerifiedAt") or 0) <= 45
                 and isinstance(proof.get("bootId"), str) and bool(proof.get("bootId"))
                 and type(proof.get("botPid")) is int and proof["botPid"] > 1
                 and lease.get("node") == "oci" and lease.get("epoch") == authority["epoch"]
                 and lease.get("state") in ("active", "renewal_unconfirmed")
                 and float(lease.get("validUntilUnixMs") or 0) > now * 1000
                 and live.get("valid") and live.get("instanceId") == lease.get("instanceId"))
        if valid:
            # The receipt PID must still be a descendant of the current guardian
            # child. A reused PID or an old root-owned receipt cannot authorize DNS.
            parent = proof["botPid"]
            seen = set()
            belongs = False
            for _ in range(12):
                if parent == lease.get("childPid"):
                    belongs = True
                    break
                if parent <= 1 or parent in seen:
                    break
                seen.add(parent)
                try:
                    status = Path(f"/proc/{parent}/status").read_text()
                    parent = int(next(line.split()[1] for line in status.splitlines() if line.startswith("PPid:")))
                except (OSError, StopIteration, ValueError):
                    break
            valid = belongs
        if not valid:
            self.update(phase="VERIFYING", activationProof=proof or None,
                        lastError={"code": "GATEWAY_READINESS_UNCONFIRMED", "message": "現在のOCI Botの接続完了・DB応答・起動許可を確認しています。"})
            return
        routing_path = self.config.get("routingConfig")
        if not routing_path:
            self.update(phase="ROUTING_UNCONFIGURED", activationProof=proof)
            return
        try:
            try:
                from .routing import ensure_routes, load_config
            except ImportError:
                from routing import ensure_routes, load_config
            result = ensure_routes(load_config(routing_path), authority["epoch"])
            self.update(phase="ACTIVE" if result.get("ok") else "VERIFYING_PUBLIC_ROUTE",
                        routing=result, activationProof=proof, lastError=None)
        except Exception as error:
            self.update(phase="VERIFYING_PUBLIC_ROUTE", activationProof=proof,
                        lastError={"code": getattr(error, "code", "ROUTING_UNCONFIRMED"), "message": str(error)})

    def tick(self):
        authority = self.authority()
        self.update(primaryEnrolled=authority["primaryEnrolled"], activeNode=authority["activeNode"], epoch=authority["epoch"])
        if authority["activeNode"] == "oci":
            # Never import a daily-old primary dump over an OCI database that
            # has become authoritative. Preserve current writes across restarts.
            active = read_json(self.root / "active-candidate.json")
            if not active:
                prepared = read_json(self.root / "prepared-candidate.json")
                if not prepared or self.state.get("promotionKey") != f"oci-{authority['epoch'] - 1}-{prepared['id']}":
                    self.update(phase="ACTIVE_STATE_UNKNOWN", lastError={"code": "ACTIVE_POINTER_MISSING", "message": "OCI所有権に対応するDBを確認できないため再復元せず停止しています。"})
                    return
                active = dict(prepared, epoch=authority["epoch"])
                atomic_json(self.root / "active-candidate.json", active)
            active["epoch"] = authority["epoch"]
            atomic_json(self.root / "active-candidate.json", active)
            self.reconcile_oci_workload(authority, active)
            return
        self.refresh_operator_intent("primary")
        self.refresh_operator_intent("oci")
        if self.config.get("autoPrepare", True) and time.time() >= self.state.get("nextPrepareAt", 0):
            try:
                self.prepare_latest()
                self.update(nextPrepareAt=time.time() + self.config.get("prepareIntervalSeconds", 3600))
            except Exception as error:
                self.update(lastError={"code": "BACKUP_REFRESH_FAILED", "message": str(error)},
                            nextPrepareAt=time.time() + self.config.get("failureBackoffSeconds", 300))
                if not self.state.get("candidate") or self.state["candidate"].get("phase") != "VALIDATED":
                    raise
            # Import/export may take much longer than the lease drain. Observe
            # any stop/maintenance intent entered while preparation was busy.
            self.refresh_operator_intent("primary")
            self.refresh_operator_intent("oci")
        gates = promotion_gates(authority, self.state.get("backup"), self.state.get("candidate"), self.config, self.state.get("primaryIntent"), self.state.get("ociIntent"))
        if all(gate["ready"] for gate in gates):
            self.update(gates=gates)
            self.activate(authority)
        else:
            candidate = self.state.get("candidate")
            phase = "STANDBY_READY" if candidate and candidate.get("phase") == "VALIDATED" else self.state["phase"]
            self.update(phase=phase, gates=gates)

    def loop(self):
        while not self.stop.is_set():
            try:
                self.tick()
            except Exception as error:
                self.update(phase="RECOVERY_ACTION_FAILED" if self.state.get("activeNode") == "oci" else "PREPARATION_FAILED",
                            lastError={"code": type(error).__name__, "message": str(error)},
                            nextPrepareAt=time.time() + self.config.get("failureBackoffSeconds", 300))
            self.stop.wait(self.config.get("intervalSeconds", 15))


def make_server(controller, config):
    host, port = config.get("listen", "127.0.0.1:34212").rsplit(":", 1)
    if host not in ("127.0.0.1", "localhost"):
        raise ValueError("Controller must listen on loopback")

    class Handler(http.server.BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(3)

        def reply(self, status, value):
            body = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(body)

        def do_GET(self):
            route = urllib.parse.urlsplit(self.path)
            if route.path == "/v1/workload-logs":
                if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + config["statusToken"]).encode()):
                    self.reply(401, {"ok": False, "error": {"code": "UNAUTHORIZED", "message": "Status credential required"}})
                    return
                try:
                    try:
                        from .workload_logs import read_workload_logs, WorkloadLogError
                    except ImportError:
                        from workload_logs import read_workload_logs, WorkloadLogError
                    self.reply(200, read_workload_logs(config, route.query))
                except WorkloadLogError as error:
                    self.reply(error.status, {"ok": False, "available": False, "error": {"code": error.code, "message": str(error)}})
                except (BrokenPipeError, ConnectionResetError):
                    return
                except Exception:
                    self.reply(503, {"ok": False, "available": False, "error": {"code": "WORKLOAD_LOGS_UNAVAILABLE", "message": "Root-verified workload log evidence could not be read"}})
                return
            if self.path == "/health":
                status, value = 200, {"ok": True, "scope": "recovery_controller_http_only"}
            elif self.path != "/v1/status":
                status, value = 404, {"error": "not_found"}
            elif not hmac.compare_digest(self.headers.get("Authorization", "").encode(), ("Bearer " + config["statusToken"]).encode()):
                status, value = 401, {"error": "unauthorized"}
            else:
                status, value = 200, controller.snapshot()
            self.reply(status, value)

        def do_POST(self):
            try:
                if self.path != "/v1/intent":
                    raise IntentError("NOT_FOUND", "Unknown intent endpoint", 404)
                tokens = {node: config.get(node + "IntentToken") for node in ("primary", "oci")}
                if any(not isinstance(token, str) or not 32 <= len(token) <= 4096 for token in tokens.values()) or len(set(tokens.values())) != 2 or config.get("statusToken") in tokens.values():
                    raise IntentError("INTENT_BRIDGE_UNCONFIGURED", "Distinct node intent credentials are required", 503)
                authorization = self.headers.get("Authorization", "").encode()
                matches = [node for node, token in tokens.items() if hmac.compare_digest(authorization, ("Bearer " + token).encode())]
                if len(matches) != 1:
                    raise IntentError("UNAUTHORIZED", "A node intent credential is required", 401)
                if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
                    raise IntentError("INVALID_REQUEST", "A bounded JSON intent is required")
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= 4096:
                    raise IntentError("INTENT_BODY_LIMIT", "Intent body must contain 1..4096 bytes", 413)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise IntentError("INCOMPLETE_INTENT", "Intent body is incomplete")
                def pairs(items):
                    result = {}
                    for key, value in items:
                        if key in result:
                            raise IntentError("INVALID_INTENT", "Duplicate JSON keys are not permitted")
                        result[key] = value
                    return result
                value = json.loads(raw, object_pairs_hook=pairs)
                result = controller.record_operator_intent(matches[0], value)
                self.reply(200, result)
            except IntentError as error:
                self.reply(error.status, {"ok": False, "error": {"code": error.code, "message": str(error)}})
            except (ValueError, UnicodeError, TypeError):
                self.reply(400, {"ok": False, "error": {"code": "INVALID_INTENT", "message": "Invalid intent JSON or request metadata"}})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                self.reply(503, {"ok": False, "error": {"code": "INTENT_PERSIST_FAILED", "message": "Operator intent could not be durably acknowledged"}})

        def log_message(self, *_args):
            pass

    server = http.server.ThreadingHTTPServer((host, int(port)), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config_path = Path(args.config)
    if os.name != "nt" and (config_path.stat().st_uid != 0 or config_path.stat().st_mode & 0o077):
        raise ValueError("Controller config must be root-owned mode 0600")
    config = read_json(config_path)
    if len(config.get("statusToken", "")) < 32:
        raise ValueError("A status token is required")
    state_root = Path(config["stateDir"]).resolve()
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_file = open(state_root / "controller.lock", "a")
    if os.name != "nt":
        import fcntl
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    controller = Controller(config)
    server = make_server(controller, config)
    controller.start_intent_observer()
    threading.Thread(target=controller.loop, daemon=True).start()
    for number in (signal.SIGINT, signal.SIGTERM):
        signal.signal(number, lambda *_args: (controller.stop.set(), threading.Thread(target=server.shutdown, daemon=True).start()))
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        controller.stop.set()
        server.server_close()
        lock_file.close()


if __name__ == "__main__":
    main()
