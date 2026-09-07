'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = require('./helpers/load-dashboard.cjs');

test('dashboard delegated access rolls out by stable guild ID bucket over time', () => {
    const start = Date.parse('2026-09-01T00:00:00Z');
    const delegatedAccess = load('lib/delegated-access.ts', {
        '@/lib/env': {
            getDashboardFlag: () => true,
            getDelegatedAccessRolloutStartAt: () => '2026-09-01T00:00:00Z',
            getDelegatedAccessRolloutDurationHours: () => 24,
        },
        '@/lib/prisma': { prisma: {} },
    });

    const guildId = '123456789012345678';
    const bucket = delegatedAccess.delegatedAccessRolloutBucket(guildId);
    let firstDayGuildId = null;
    for (let index = 0; index < 10000; index += 1) {
        const candidate = String(100000000000000000 + index);
        if (delegatedAccess.delegatedAccessRolloutBucket(candidate) < 1 / 14) {
            firstDayGuildId = candidate;
            break;
        }
    }
    assert.ok(firstDayGuildId, 'a first-day guild bucket should exist');
    assert.equal(delegatedAccess.delegatedAccessEnabledForGuild(guildId, start - 1), false);
    assert.equal(delegatedAccess.delegatedAccessEnabledForGuild(guildId, start), false);
    assert.equal(delegatedAccess.delegatedAccessEnabledForGuild(firstDayGuildId, start), true);
    assert.equal(delegatedAccess.delegatedAccessEnabledForGuild(guildId, start + 24 * 60 * 60 * 1000), true);
    assert.equal(delegatedAccess.delegatedAccessEnabledForGuild(guildId, start + bucket * 24 * 60 * 60 * 1000 + 1), true);
});

test('dashboard delegated access remains backward compatible when no rollout start is configured', () => {
    const delegatedAccess = load('lib/delegated-access.ts', {
        '@/lib/env': {
            getDashboardFlag: () => true,
            getDelegatedAccessRolloutStartAt: () => null,
            getDelegatedAccessRolloutDurationHours: () => null,
        },
        '@/lib/prisma': { prisma: {} },
    });

    assert.equal(delegatedAccess.delegatedAccessEnabledForGuild('123456789012345678'), true);
});
