export type SnapshotLoadState = {
  persistentSnapshotLoaded: boolean;
  persistentSnapshotLoadPromise?: Promise<void> | null;
};

export async function loadSnapshotOnce(state: SnapshotLoadState, load: () => Promise<void>) {
  if (state.persistentSnapshotLoaded) return;
  if (!state.persistentSnapshotLoadPromise) {
    state.persistentSnapshotLoadPromise = Promise.resolve().then(load).then(() => {
      state.persistentSnapshotLoaded = true;
    }).catch(() => {
      // A temporary database failure is retryable on the next request.
    }).finally(() => { state.persistentSnapshotLoadPromise = null; });
  }
  await state.persistentSnapshotLoadPromise;
}

export function pruneReportEntries<Entry extends { lastAccessedAtMs: number; refreshPromise: Promise<unknown> | null }>(
  entries: Map<string, Entry>, maxEntries: number, activeMs: number, now = Date.now(),
) {
  const removable = [...entries.entries()].filter(([, entry]) => !entry.refreshPromise)
    .sort((left, right) => left[1].lastAccessedAtMs - right[1].lastAccessedAtMs);
  for (const [key, entry] of removable) {
    if (entries.size <= maxEntries && now - entry.lastAccessedAtMs <= activeMs) break;
    entries.delete(key);
  }
}

// Snapshot data was already converted to JSON-safe values when it was built.
// Polling should attach metadata without recursively copying the entire report.
export function withReportCacheMetadata<Snapshot, Metadata>(snapshot: Snapshot, cache: Metadata) {
  return { ...snapshot, cache };
}
