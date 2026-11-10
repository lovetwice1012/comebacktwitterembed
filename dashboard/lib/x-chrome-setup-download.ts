import "server-only";
import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "@/lib/env";

// A prebuilt, immutable Windows package. A Linux dashboard never builds or
// executes the Windows runtime and never accepts a request-supplied path.
export const X_CHROME_SETUP_DOWNLOAD = Object.freeze({
  version: "0.1.0-chrome-preview.1",
  filename: "chrome-setup-0.1.0-chrome-preview.1.zip",
  sha256: "acc5fd05a4759f3f5478da1bd10925bbf5b143b5b7feb0103631aa2848992b36",
  bytes: 35923573,
  href: "/api/automation/x-setup/download-chrome",
});

async function readVerified(): Promise<Uint8Array> {
  const filename = path.join(repoRoot(), "artifacts", "angelic-setup", X_CHROME_SETUP_DOWNLOAD.filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== X_CHROME_SETUP_DOWNLOAD.bytes) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== X_CHROME_SETUP_DOWNLOAD.bytes) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || createHash("sha256").update(bytes).digest("hex") !== X_CHROME_SETUP_DOWNLOAD.sha256)
      throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
    return bytes;
  } finally { await handle.close(); }
}
let pending: Promise<Uint8Array> | undefined;
export function readChromeSetupDownload(): Promise<Uint8Array> {
  if (!pending) pending = readVerified().finally(() => { pending = undefined; });
  return pending;
}
