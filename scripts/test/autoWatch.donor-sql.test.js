'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMonitors } = require('../../src/automation/monitors');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);

test('real SQL free admission permits direct/API registration, changes and resume while supporter status stays server-owned', { skip: !port }, async () => {
    const db = await createTestDatabase(port), U = '222222222222222222', actor = { userId: U, isAdmin: true, isDonor: true };
    const paths = [require.resolve('../../src/db'), require.resolve('../../src/db_schema'), require.resolve('../../src/providers/autoWatch/store')];
    const originals = paths.map(p => require.cache[p]);
    try {
        await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor) VALUES (?,0,0)', [U]);
        const service = createService(db), monitors = createMonitors(db, service, {});
        const destination = await service.saveDestination(actor, { name: 'DM', kind: 'dm' });
        const input = { name: 'watch', providerId: 'github', source: 'octocat', destinationId: destination.id, is_donor: 1 };
        const created = await monitors.save(actor, 'auto', input);
        require.cache[paths[0]] = { id: paths[0], filename: paths[0], loaded: true, exports: { ...db, ensureUserExistsInDatabase: async () => {} } };
        require.cache[paths[1]] = { ...originals[1], exports: { ...originals[1].exports, ensureDatabaseSchema: async () => {} } };
        delete require.cache[paths[2]];
        const store = require(paths[2]), direct = { userId: U, providerId: 'github', source: 'github', destinationType: 'dm' };
        const registered = await store.registerTarget(direct); assert(registered.id);
        assert.equal((await store.registerTarget(direct)).id, registered.id);
        const changed = await monitors.save(actor, 'auto', { ...input, source: 'microsoft', expectedRevision: 1 }, created.id);
        const paused = await monitors.save(actor, 'auto', { expectedRevision: changed.revision, enabled: false }, created.id);
        const resumed = await monitors.save(actor, 'auto', { expectedRevision: paused.revision, enabled: true }, created.id);
        assert.equal(resumed.revision, 4);
        assert.equal(Number((await db.queryDatabase('SELECT is_donor FROM users WHERE user_id=?', [U]))[0].is_donor), 0);
        assert.equal((await monitors.providers(actor)).autoRegistration.eligible, true);
        await monitors.remove(actor, 'auto', created.id, resumed.revision);
        assert.equal(Number((await db.queryDatabase('SELECT COUNT(*) AS n FROM auto_watch_targets'))[0].n), 1);
    } finally {
        paths.forEach((p, i) => { if (originals[i]) require.cache[p] = originals[i]; else delete require.cache[p]; });
        await db.close();
    }
});
