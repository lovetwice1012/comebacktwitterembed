"""Fixed, non-secret diagnostic schema attached to an existing lease renewal."""
import json
import math

MAX_OBSERVATION_BYTES = 2048
STATES = {"unknown", "startup_grace", "clear", "observing", "confirmed"}
REASONS = {"awaiting_sample", "invalid_sample", "child_identity_changed", "startup_grace", "baseline_required", "counter_reset", "write_progress", "stall_conjunction_not_present", "continuous_stall_candidate", "primary_io_stall", "sample_too_late", "sample_timeout", "sampler_start_failed", "sampler_failed"}
KEYS = {"enabled", "physicalDevice", "logicalDevice", "thresholdSeconds", "startupGraceSeconds", "state", "reason", "childPid", "childStartTicks", "observedAtUnixMs", "continuousSeconds", "evidence"}
COUNTERS = {"physicalWrites", "logicalWrites", "physicalInflight", "logicalInflight", "wbtInflight"}


def primary_io_observation(value):
    """Return a detached allowlisted value, or None without failing the lease."""
    if not isinstance(value, dict) or set(value) != KEYS:
        return None
    if value.get("enabled") is not True or value.get("physicalDevice") != "sda" or value.get("logicalDevice") != "dm-0":
        return None
    if not isinstance(value.get("state"), str) or value["state"] not in STATES or not isinstance(value.get("reason"), str) or value["reason"] not in REASONS:
        return None
    for key, low, high in [("thresholdSeconds", 180, 86400), ("startupGraceSeconds", 300, 86400), ("childPid", 1, 2**31 - 1), ("observedAtUnixMs", 1, 2**53 - 1)]:
        if type(value.get(key)) is not int or not low <= value[key] <= high:
            return None
    if value.get("childStartTicks") is not None and (type(value["childStartTicks"]) is not int or not 1 <= value["childStartTicks"] <= 2**64 - 1):
        return None
    duration = value.get("continuousSeconds")
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 <= duration <= 2 * 86400:
        return None
    evidence = value.get("evidence")
    if evidence is not None:
        if not isinstance(evidence, dict) or set(evidence) != COUNTERS | {"state"} or not isinstance(evidence.get("state"), str) or evidence["state"] not in {"R", "S", "D", "T", "t", "Z", "X", "I"}:
            return None
        if any(type(evidence[key]) is not int or not 0 <= evidence[key] <= 2**64 - 1 for key in COUNTERS):
            return None
    result = dict(value, evidence=dict(evidence) if evidence is not None else None)
    if len(json.dumps(result, separators=(",", ":"), allow_nan=False).encode()) > MAX_OBSERVATION_BYTES:
        return None
    return result
