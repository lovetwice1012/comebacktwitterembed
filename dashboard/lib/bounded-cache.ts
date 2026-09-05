export class BoundedAsyncCache<T> {
  private entries = new Map<string, { promise: Promise<T>; expiresAt: number }>();

  constructor(private maxEntries: number, private ttlMs: number, private now = Date.now) {}
  get size() { return this.entries.size; }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) {
      this.entries.delete(key);
      this.entries.set(key, current);
      return current.promise;
    }
    this.entries.delete(key);
    for (const [oldKey, value] of this.entries) {
      if (value.expiresAt <= this.now()) this.entries.delete(oldKey);
    }
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    const entry = { expiresAt: Infinity, promise: null as unknown as Promise<T> };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.expiresAt = this.now() + this.ttlMs;
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }
}
