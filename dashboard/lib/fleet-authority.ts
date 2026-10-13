import "server-only";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type DashboardFleetAuthority = {
  managed: boolean;
  available: boolean;
  node?: "primary" | "oci";
  epoch?: number;
  instanceId?: string;
};
const MAX_LEASE_BYTES = 16384;

/** Read guardian-owned evidence on every call; never cache an activation epoch. */
export function readDashboardFleetAuthority(env = process.env, now = Date.now()): DashboardFleetAuthority {
  const filename = env.CBTE_FLEET_LEASE_FILE;
  const sharedCurrent = env.DASHBOARD_FLEET_LEASE_MODE === "shared-current";
  if (!filename) return { managed: sharedCurrent, available: !sharedCurrent };
  let fd: number | undefined;
  try {
    fd = openSync(filename, "r");
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_LEASE_BYTES) throw new Error("invalid evidence");
    const bytes = Buffer.alloc(MAX_LEASE_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const count = readSync(fd, bytes, total, bytes.length - total, total);
      if (!count) break;
      total += count;
    }
    if (total > MAX_LEASE_BYTES) throw new Error("invalid evidence");
    const lease = JSON.parse(bytes.subarray(0, total).toString("utf8"));
    if (!lease || typeof lease !== "object" || Array.isArray(lease)
      || !["active", "renewal_unconfirmed"].includes(lease.state)
      || !["primary", "oci"].includes(lease.node) || lease.node !== env.CBTE_FLEET_NODE
      || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
      || !sharedCurrent && String(lease.epoch) !== env.CBTE_FLEET_EPOCH
      || typeof lease.instanceId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(lease.instanceId)
      || typeof lease.validUntilUnixMs !== "number" || !Number.isFinite(lease.validUntilUnixMs) || lease.validUntilUnixMs <= now) throw new Error("invalid evidence");
    return { managed: true, available: true, node: lease.node, epoch: lease.epoch, instanceId: lease.instanceId };
  } catch { return { managed: true, available: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export class DashboardFleetAuthorityError extends Error {
  readonly status = 503;
  readonly code = "DASHBOARD_AUTHORITY_UNAVAILABLE";
  constructor(locale = "ja") {
    super(locale === "ja" ? "現在、変更を保存できません。Botの再起動・復旧が完了してから、入力を保ったまま再試行してください。" : "Changes cannot be saved right now. Keep your input and retry after the Bot restart or recovery completes.");
  }
}

export function assertDashboardFleetWriteAuthority(locale = "ja") {
  const authority = readDashboardFleetAuthority();
  if (!authority.available) throw new DashboardFleetAuthorityError(locale);
  return authority;
}

/** Pin an operation to its admitted guardian instance, including shared-current mode. */
export function createDashboardFleetWriteFence(locale = "ja") {
  const admitted = assertDashboardFleetWriteAuthority(locale);
  return () => {
    const current = assertDashboardFleetWriteAuthority(locale);
    if (current.managed !== admitted.managed || current.node !== admitted.node || current.epoch !== admitted.epoch || current.instanceId !== admitted.instanceId) throw new DashboardFleetAuthorityError(locale);
  };
}

/** Only session/cookie operations and the fixed independent rescue contract are exempt. */
export function dashboardRequestNeedsWriteAuthority(method: string, pathname: string) {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false;
  if (method.toUpperCase() === "POST" && (pathname.startsWith("/api/auth/")
    || pathname === "/api/me/dashboard-ui"
    || pathname === "/api/admin/agent-recovery")) return false;
  return true;
}
