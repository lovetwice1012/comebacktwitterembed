'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stagePlanPrices } = require('../../src/automation/stage-plan-prices');
const { PLANS } = require('../../src/automation/plan-redesign');

function fixture() {
    const bindings = PLANS.filter(p => p.amountYen > 0).slice(0, 2).map(p => ({ planId: p.planId, cadence: 'MONTHLY', amount: p.amountYen, currency: 'JPY', enabled: false, variationId: p.planId, verifiedAtMs: 1 }));
    const creations = [], calls = [];
    return { calls, bindings, creations,
        billing: { getAdmin: async () => ({ configured: true, environment: 'sandbox', bindings }), saveBinding: async (_actor, planId, input) => {
            calls.push({ planId, input }); const old = bindings.find(row => row.planId === planId); return { ...old, enabled: input.enabled };
        } },
        commerce: { getAdmin: async () => ({ configured: true, environment: 'sandbox', locationCurrency: 'JPY', creations }),
            createCatalogQuote: async (_actor, terms) => { const row = { ...terms, creationId: terms.planId, state: 'QUOTED' }; creations.push(row); return row; },
            confirmCatalogCreation: async (_actor, { creationId }) => { const row = creations.find(item => item.creationId === creationId); row.state = 'COMPLETE'; bindings.push({ ...row, amount: row.amount, variationId: creationId, enabled: row.enabled, verifiedAtMs: 2 }); return row; } },
    };
}

test('all reviewed monthly prices are staged without enabling any binding', async () => {
    const f = fixture();
    const result = await stagePlanPrices({ ...f, actor: { isAdmin: true }, expectedEnvironment: 'sandbox' });
    assert.equal(result.length, 4); assert.equal(f.bindings.length, 4);
    assert(f.bindings.every(row => row.enabled === false));
    assert(f.calls.every(row => row.input.enabled === false));
    assert(f.creations.every(row => row.enabled === false));
});

test('staging refuses wrong prices, enabled bindings, or a different Square account', async () => {
    for (const mutate of [f => { f.bindings[0].amount = 1; }, f => { f.bindings[0].enabled = true; }]) {
        const f = fixture(); mutate(f);
        await assert.rejects(stagePlanPrices({ ...f, actor: { isAdmin: true }, expectedEnvironment: 'sandbox' }), { code: 'PLAN_PRICE_BINDING_MISMATCH' });
        assert.equal(f.calls.length, 0); assert.equal(f.creations.length, 0);
    }
    const f = fixture();
    await assert.rejects(stagePlanPrices({ ...f, actor: { isAdmin: true }, expectedEnvironment: 'production' }), { code: 'PLAN_PRICE_ACCOUNT_MISMATCH' });
});
