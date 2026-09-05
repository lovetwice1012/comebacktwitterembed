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

export type ReportFailureState = { lastError?: string | null; failedAtMs?: number; retryAfterMs?: number };

export function refreshReportSnapshot<T>(
  entry: ReportFailureState & { snapshot: T | null; updatedAtMs: number; refreshPromise: Promise<T> | null },
  build: () => Promise<T>, persist?: (snapshot: T) => Promise<void>,
): Promise<T> {
  if (!entry.refreshPromise) {
    entry.refreshPromise = Promise.resolve().then(build).then(snapshot => {
      entry.snapshot = snapshot;
      entry.updatedAtMs = Date.now();
      entry.lastError = null;
      entry.failedAtMs = 0;
      entry.retryAfterMs = 0;
      if (persist) void persist(snapshot).catch(error => console.warn('[adminAnalytics] Snapshot persistence failed:', error?.message));
      return snapshot;
    }).catch(error => {
      entry.lastError = /Exact table count/i.test(String(error?.message))
        ? '統計データの初期集計が完了していません。'
        : /time|deadline|interrupted/i.test(String(error?.message))
          ? '集計が実行時間の上限に達しました。' : '統計の更新に失敗しました。';
      entry.failedAtMs = Date.now();
      entry.retryAfterMs = entry.failedAtMs + 60000;
      console.warn('[adminAnalytics] Report update failed:', String(error?.message || error).slice(0, 500));
      throw error;
    }).finally(() => { entry.refreshPromise = null; });
  }
  return entry.refreshPromise;
}
