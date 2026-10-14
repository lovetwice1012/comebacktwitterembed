import "server-only";

import { createHash } from "node:crypto";
import { requireBotModule } from "@/lib/bot-require";

// This is the already-built, immutable preview.4 release. Updating source files
// alone must never silently replace a release offered to dashboard users.
export const X_SETUP_DOWNLOAD = Object.freeze({
  version: "0.1.0-preview.4",
  filename: "x-notification-setup-0.1.0-preview.4.zip",
  sha256: "c41a47ecb694cc8afe19ccfab3420d492a5a327b8264cb84b46da9ab1d7325db",
  bytes: 68653,
  href: "/api/automation/x-setup/download",
});

type PackageBuilder = {
  buildArchive: () => Promise<{ archive: Uint8Array; version: string }>;
};

async function readVerifiedArchive(): Promise<Uint8Array> {
  // The builder defaults to its own fixed client/angelic-setup directory and
  // exact allowlist. No request data or environment path reaches the builder.
  const builder = requireBotModule<PackageBuilder>("scripts/build-angelic-setup-package.cjs");
  const result = await builder.buildArchive();
  const archive = result.archive;
  if (result.version !== X_SETUP_DOWNLOAD.version || !(archive instanceof Uint8Array)
      || archive.byteLength !== X_SETUP_DOWNLOAD.bytes
      || createHash("sha256").update(archive).digest("hex") !== X_SETUP_DOWNLOAD.sha256) {
    throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
  }
  return archive;
}

// Share only simultaneous reads. A later download rechecks the source and pin;
// failures also clear the promise so repaired deployments can recover.
let pendingArchive: Promise<Uint8Array> | undefined;
export async function readXSetupDownload(): Promise<Uint8Array> {
  if (!pendingArchive) {
    pendingArchive = readVerifiedArchive().finally(() => { pendingArchive = undefined; });
  }
  return pendingArchive;
}
