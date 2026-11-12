import "server-only";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { requireBotModule } from "@/lib/bot-require";
import { repoRoot } from "@/lib/env";

export type MacChromeArch = "arm64" | "x64";
export type MacChromeRelease = Readonly<{ version: string; filename: string; sha256: string; bytes: number }>;
const registry = requireBotModule<{ getChromeMacRelease: (arch: MacChromeArch) => MacChromeRelease | null }>("src/automation/x-chrome-mac-release.js");
export const getMacChromeRelease = registry.getChromeMacRelease;

// Never accept a path or checksum from a request. Each read rechecks the pinned
// signed release so a replaced file cannot be silently served to users.
async function readVerified(arch: MacChromeArch): Promise<Uint8Array> {
  const release = getMacChromeRelease(arch);
  if (!release) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
  const filename = path.join(repoRoot(), "artifacts", "angelic-setup", release.filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== release.bytes) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
  const handle = await open(filename, "r");
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== info.dev || actual.ino !== info.ino || actual.size !== release.bytes) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
    const bytes = await handle.readFile();
    if (bytes.length !== release.bytes || createHash("sha256").update(bytes).digest("hex") !== release.sha256) throw new Error("X_SETUP_RELEASE_UNAVAILABLE");
    return bytes;
  } finally { await handle.close(); }
}

// Share concurrent reads for the same architecture only. Evict on both
// success and failure so future requests recheck the file and can recover.
const pending = new Map<MacChromeArch, Promise<Uint8Array>>();
export function readMacChromeSetupDownload(arch: MacChromeArch): Promise<Uint8Array> {
  let read = pending.get(arch);
  if (!read) { read = readVerified(arch).finally(() => { pending.delete(arch); }); pending.set(arch, read); }
  return read;
}
