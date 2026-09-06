#!/usr/bin/env python3
"""Send durable, user-facing recovery notices through a configured Discord webhook.

The webhook is an operational delivery channel, not a user-controlled input.
Only the four fixed stages below are accepted.  A stage/epoch/operation key is
persisted after an accepted response so a controller restart cannot duplicate a
notice.  A transport timeout remains pending and is retried with the same
Idempotency-Key; it is never reported as delivered without a 2xx response.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import stat
import time
import urllib.error
import urllib.parse
import urllib.request


STAGES = {
    "failover-start": {
        "title": "予備のクラウドサーバーへ移行を開始します",
        "description": "メインサーバーの障害を検知したため、予備のクラウドサーバーへの移行を開始します。",
        "color": 15158332,
        "fields": [
            ("起動の目安", "30分ほどで起動完了する見込みです。"),
            ("ご利用への影響", "起動中はBotが一時的に応答しない場合や、設定・集計が最新バックアップ時点へ戻る場合があります。"),
        ],
    },
    "standby-active": {
        "title": "予備のクラウドサーバー上で稼働中です",
        "description": "現在、Botとダッシュボードは予備のクラウドサーバーで稼働しています。",
        "color": 3447003,
        "fields": [
            ("今後の移行", "メインサーバーが復旧したら、自動でメインサーバーへの移行を開始します。"),
            ("ご利用への影響", "一部の機能に制限がかかる場合があります。"),
        ],
    },
    "failback-start": {
        "title": "メインサーバーへの移行を開始します",
        "description": "メインサーバーが復旧したため、今からメインサーバーへの移行を開始します。",
        "color": 15844367,
        "fields": [
            ("移行の目安", "30分ほどかかる場合があります。"),
            ("ご利用への影響", "サービスは停止しませんが、最大で30分間、設定などが移行前の状態へ戻る可能性があります。"),
        ],
    },
    "primary-active": {
        "title": "メインサーバーへの移行が完了しました",
        "description": "メインサーバーへの移行が完了し、通常どおり全ての機能を利用できます。",
        "color": 3066993,
        "fields": [
            ("サービス状況", "Botとダッシュボードはメインサーバーで稼働しています。"),
            ("ご利用への影響", "全ての機能を利用できます。"),
        ],
    },
}


class NotificationError(Exception):
    pass


def _private_json(path: Path) -> dict:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or (os.name == "posix" and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) & 0o077)):
        raise NotificationError("Notification configuration must be a private root-owned file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        raise NotificationError("Notification configuration is invalid") from None
    if not isinstance(value, dict):
        raise NotificationError("Notification configuration is invalid")
    return value


def _config(path: str | os.PathLike[str]) -> tuple[dict, Path]:
    value = _private_json(Path(path))
    url = value.get("webhookUrl")
    parsed = urllib.parse.urlsplit(url if isinstance(url, str) else "")
    if (parsed.scheme != "https" or parsed.hostname not in {"discord.com", "discordapp.com"}
            or not parsed.path.startswith("/api/webhooks/") or parsed.query or parsed.fragment):
        raise NotificationError("Notification webhook URL is invalid")
    state = Path(value.get("statePath", "/var/lib/cbte-recovery/user-notifications.json"))
    if not state.is_absolute() or state == Path(state.anchor) or ".." in state.parts:
        raise NotificationError("Notification state path is invalid")
    return value, state


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + ".next")
    with temporary.open("w", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, ensure_ascii=False, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def _load_state(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "notices": {}}
    value = _private_json(path)
    if value.get("version") != 1 or not isinstance(value.get("notices"), dict):
        raise NotificationError("Notification state is invalid")
    return value


def _payload(config: dict, stage: str) -> dict:
    template = STAGES[stage]
    return {
        "username": config.get("name") if isinstance(config.get("name"), str) and config["name"] else "ComebackTwitterEmbed お知らせ",
        "avatar_url": config.get("avatarUrl") if isinstance(config.get("avatarUrl"), str) and config["avatarUrl"].startswith("https://") else None,
        "allowed_mentions": {"parse": []},
        "embeds": [{
            "title": template["title"],
            "description": template["description"],
            "color": template["color"],
            "fields": [{"name": name, "value": value, "inline": False} for name, value in template["fields"]],
            "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        }],
    }


def send(config_path: str, stage: str, epoch: int, operation_id: str, *, dry_run: bool = False) -> dict:
    if stage not in STAGES:
        raise NotificationError("Unknown fixed notification stage")
    if type(epoch) is not int or epoch < 1 or epoch > 2**63 - 1:
        raise NotificationError("Notification epoch is invalid")
    if not isinstance(operation_id, str) or not 16 <= len(operation_id) <= 128:
        raise NotificationError("Notification operation ID is invalid")
    config, state_path = _config(config_path)
    key = f"{stage}:{epoch}:{operation_id}"
    idempotency = hashlib.sha256(key.encode("utf-8")).hexdigest()
    state = _load_state(state_path)
    prior = state["notices"].get(key)
    if isinstance(prior, dict) and prior.get("status") == "accepted":
        return {"stage": stage, "epoch": epoch, "operationId": operation_id, "status": "accepted", "duplicate": True, "messageId": prior.get("messageId")}
    if dry_run:
        return {"stage": stage, "epoch": epoch, "operationId": operation_id, "status": "dry_run", "payload": _payload(config, stage)}
    payload = _payload(config, stage)
    payload = {key: value for key, value in payload.items() if value is not None}
    url = config["webhookUrl"] + ("&" if "?" in config["webhookUrl"] else "?") + "wait=true"
    request = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json", "User-Agent": "CBTE-Recovery/1.0", "Idempotency-Key": idempotency}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            body = response.read(65537)
            if not 200 <= response.status < 300:
                raise NotificationError("Notification webhook rejected the notice")
            receipt = json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        raise NotificationError(f"Notification webhook returned HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise NotificationError("Notification delivery is pending; remote receipt is unknown") from None
    state["notices"][key] = {"status": "accepted", "stage": stage, "epoch": epoch, "operationId": operation_id, "messageId": receipt.get("id"), "acceptedAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    _atomic_json(state_path, state)
    return {"stage": stage, "epoch": epoch, "operationId": operation_id, "status": "accepted", "duplicate": False, "messageId": receipt.get("id")}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="/etc/cbte-recovery/notification-webhook.json")
    parser.add_argument("--stage", choices=sorted(STAGES), required=True)
    parser.add_argument("--epoch", type=int, required=True)
    parser.add_argument("--operation-id", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(send(args.config, args.stage, args.epoch, args.operation_id, dry_run=args.dry_run), ensure_ascii=False))
        return 0
    except NotificationError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
