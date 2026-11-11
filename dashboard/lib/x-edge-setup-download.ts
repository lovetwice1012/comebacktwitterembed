import "server-only";
import { createHash } from "node:crypto";
import { open, lstat } from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "@/lib/env";

// The dashboard serves only this pinned, prebuilt archive; it never builds a
// Windows executable or accepts a filesystem path from a request.
export const X_EDGE_SETUP_DOWNLOAD = Object.freeze({
  version: "0.1.0-edge-preview.8",
  filename: "edge-setup-0.1.0-edge-preview.8.zip",
  sha256: "9c4e9d4440e90cc67f1ab723f42d961df9e7fe587903a25491a69d7569aac157",
  bytes: 35993436,
  href: "/api/automation/x-setup/download-edge",
});
async function readVerified(): Promise<Uint8Array> {
  const filename = path.join(repoRoot(), "artifacts", "angelic-setup", X_EDGE_SETUP_DOWNLOAD.filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== X_EDGE_SETUP_DOWNLOAD.bytes) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
  const handle = await open(filename, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== X_EDGE_SETUP_DOWNLOAD.bytes) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || createHash("sha256").update(bytes).digest("hex") !== X_EDGE_SETUP_DOWNLOAD.sha256) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
    return bytes;
  } finally { await handle.close(); }
}
let pending: Promise<Uint8Array> | undefined;
export function readEdgeSetupDownload(): Promise<Uint8Array> {
  if (!pending) pending = readVerified().finally(() => { pending = undefined; });
  return pending;
}
