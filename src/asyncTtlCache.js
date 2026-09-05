'use strict';

class AsyncTtlCache {
    constructor({ maxSize = 2048, ttlMs = 30000, now = Date.now } = {}) {
        this.entries = new Map();
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.now = now;
    }

    get size() { return this.entries.size; }
    clear() { this.entries.clear(); }
    delete(key) { return this.entries.delete(key); }

    getOrLoad(key, load) {
        const cached = this.entries.get(key);
        if (cached && cached.expiresAt > this.now()) {
            this.entries.delete(key);
            this.entries.set(key, cached);
            return cached.promise;
        }
        this.entries.delete(key);
        while (this.entries.size >= this.maxSize) {
            this.entries.delete(this.entries.keys().next().value);
        }
        const entry = { expiresAt: Infinity, promise: null };
        // Publish the promise before starting I/O, sharing cold reads as well as
        // cached values. An invalidation removes this identity even during I/O.
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

module.exports = { AsyncTtlCache };
