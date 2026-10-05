#!/usr/bin/env bash
set -euo pipefail
node_bin="${ADMIN_AGENT_NODE:-/usr/local/bin/node}"
runtime="${ADMIN_AGENT_WORKER_DIR:-/opt/cbte-admin/worker-runtime}"
now_ms="$(date +%s%3N)"
start_ms=$(( (now_ms / 3600000 - 3) * 3600000 ))
end_ms=$(( (now_ms / 3600000 + 1) * 3600000 ))
exec "$node_bin" "$runtime/scripts/backfill_metric_observation_rollup.js" \
  --start="$start_ms" --end="$end_ms" --rebuild
