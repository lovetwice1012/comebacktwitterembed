'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatch } = require('../../src/automation/api');
const { createService } = require('../../src/automation/service');
const { createTestDatabase } = require('../lib/automation-test-db');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
test('commerce dispatcher authenticates the session actor, routes admin operations and bounds external catalog creation', { skip: !port }, async t => {
    const db = await createTestDatabase(port); t.after(() => db.close());
    const owner = { userId: '222222222222222222' }, admin = { userId: '333333333333333333', isAdmin: true };
    const calls = [], gated = (operation, actor, input) => {
        if (!actor.isAdmin) throw Object.assign(new Error('管理者権限が必要です。'), { name: 'AutomationError', status: 403 });
        calls.push({ operation, userId: actor.userId, input }); return { operation };
    };
    const services = { db, service: createService(db), commerce: {
        getAdmin: actor => gated('admin', actor), getCatalogCreation: (actor, id) => gated('status', actor, id),
        createCatalogQuote: (actor, body) => gated('quote', actor, body), confirmCatalogCreation: (actor, body) => gated('create', actor, body),
        saveCoupon: (actor, body) => gated('coupon', actor, body),
    } };
    const request = (method, route, body = {}) => ({ method, path: route.split('/'), body });
    await assert.rejects(dispatch(request('GET', 'billing/commerce/admin'), null, services), { status: 401 });
    await assert.rejects(dispatch(request('GET', 'billing/commerce/admin'), owner, services), { status: 403 });
    await assert.rejects(dispatch(request('POST', 'billing/catalog/quote', { actor: admin, isAdmin: true }), owner, services), { status: 403 });
    await assert.rejects(dispatch(request('POST', 'billing/coupons', { actor: admin, isAdmin: true }), owner, services), { status: 403 });
    for (const [method, path] of [['GET','billing/commerce/admin'],['GET','billing/catalog/creation-id'],['POST','billing/catalog/quote'],['POST','billing/coupons'],['PATCH','billing/coupons/PATHCODE']]) await dispatch(request(method, path, { code: 'SPOOFED', userId: owner.userId }), admin, services);
    assert.equal(calls.at(-1).input.code, 'PATHCODE');
    assert(calls.every(call => call.userId === admin.userId));
    for (let i = 0; i < 2; i++) await dispatch(request('POST', 'billing/catalog/create'), admin, services);
    await assert.rejects(dispatch(request('POST', 'billing/catalog/create'), admin, services), { code: 'AUTOMATION_RATE_LIMITED', status: 429 });
    assert.equal(calls.filter(call => call.operation === 'create').length, 2);
    await assert.rejects(dispatch(request('GET', 'billing/commerce/admin'), admin, { service: services.service }), { code: 'SQUARE_NOT_CONFIGURED', status: 503 });
    await assert.rejects(dispatch(request('DELETE', 'billing/coupons/CODE'), admin, services), { status: 404 });
});
