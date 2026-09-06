import { NextResponse } from "next/server";
import { open } from "node:fs/promises";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const MAX_LEASE_BYTES = 16384;
const headers = { "cache-control": "no-store, max-age=0" };

async function readLease(filename: string): Promise<Record<string, unknown>> {
  const file = await open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_LEASE_BYTES) throw new Error("invalid lease file");
    const bytes = Buffer.alloc(MAX_LEASE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_LEASE_BYTES) throw new Error("lease exceeds bound");
    const lease = JSON.parse(bytes.subarray(0, total).toString("utf8"));
    if (!lease || typeof lease !== "object" || Array.isArray(lease)) throw new Error("invalid lease");
    return lease;
  } finally { await file.close(); }
}

/** Public HTTP reachability only. Bot readiness is verified independently from fresh telemetry. */
export async function GET() {
  const filename = process.env.CBTE_FLEET_LEASE_FILE;
  if (!filename) return NextResponse.json({ ok: true, scope: "dashboard_http_only", time: new Date().toISOString() }, { headers });
  try {
    const lease = await readLease(filename);
    if (!(["active", "renewal_unconfirmed"] as unknown[]).includes(lease.state)
      || !(["primary", "oci"] as unknown[]).includes(lease.node)
      || lease.node !== process.env.CBTE_FLEET_NODE
      || !Number.isSafeInteger(lease.epoch) || Number(lease.epoch) < 1
      || String(lease.epoch) !== process.env.CBTE_FLEET_EPOCH
      || typeof lease.instanceId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(lease.instanceId)
      || typeof lease.validUntilUnixMs !== "number" || !Number.isFinite(lease.validUntilUnixMs) || lease.validUntilUnixMs <= Date.now()) throw new Error("invalid current lease");
    return NextResponse.json({ ok: true, scope: "dashboard_http_only", time: new Date().toISOString(), node: lease.node, epoch: lease.epoch, instanceId: lease.instanceId }, { headers });
  } catch {
    return NextResponse.json({ ok: false, scope: "dashboard_http_only", time: new Date().toISOString() }, { status: 503, headers });
  }
}
