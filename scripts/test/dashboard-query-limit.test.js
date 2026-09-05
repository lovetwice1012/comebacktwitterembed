'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadDashboard = require('./helpers/load-dashboard.cjs');
const { QueryLimiter, limitAnalyticsReads } = loadDashboard('lib/analytics-query-limit.ts');

test('separately loaded production route modules share one Prisma connection pool', () => {
    const previous = globalThis.prisma;
    const previousEnv = process.env.NODE_ENV;
    delete globalThis.prisma;
    process.env.NODE_ENV = 'production';
    let created = 0;
    const mocks = {
        '@prisma/client': { PrismaClient: class { constructor() { created++; } } },
        '@/lib/env': { getDatabaseUrl: () => 'mysql://test.invalid/test' },
    };
    try {
        const first = loadDashboard('lib/prisma.ts', mocks).prisma;
        const second = loadDashboard('lib/prisma.ts', mocks).prisma;
        assert.equal(first, second);
        assert.equal(created, 1);
    } finally {
        if (previous === undefined) delete globalThis.prisma;
        else globalThis.prisma = previous;
        if (previousEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousEnv;
    }
});

test('nested report reads share four actual database slots and release slots after errors', async () => {
    let active = 0;
    let peak = 0;
    let writes = 0;
    const client = {
        identity: 'prisma',
        async $queryRawUnsafe(index) {
            assert.equal(this.identity, 'prisma');
            peak = Math.max(peak, ++active);
            await new Promise(resolve => setImmediate(resolve));
            active--;
            if (index === 5) throw new Error('query failed');
            return index;
        },
        async $executeRawUnsafe() { writes++; },
    };
    const limiter = new QueryLimiter(4);
    const routes = [limitAnalyticsReads(client, limiter), limitAnalyticsReads(client, limiter)];
    const results = await Promise.all(Array.from({ length: 3 }, (_, report) =>
        Promise.allSettled(Array.from({ length: 12 }, (_, index) => routes[report % 2].$queryRawUnsafe(index))),
    ));
    assert.equal(peak, 4);
    assert.equal(active, 0);
    assert.equal(results.flat().filter(result => result.status === 'rejected').length, 3);
    assert.equal(await routes[0].$queryRawUnsafe(42), 42);
    await routes[0].$executeRawUnsafe();
    assert.equal(writes, 1);
});
