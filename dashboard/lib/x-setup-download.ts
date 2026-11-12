import "server-only";

import { createHash } from "node:crypto";
import { requireBotModule } from "@/lib/bot-require";

// This is the already-built, immutable preview.6 release. Updating source files
// alone must never silently replace a release offered to dashboard users.
type SetupRelease = Readonly<{ version: string; filename: string; sha256: string; bytes: number; href: string }>;
export const X_SETUP_DOWNLOAD = requireBotModule<{ X_SETUP_RELEASE: SetupRelease }>("src/automation/x-setup-release.js").X_SETUP_RELEASE;

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
