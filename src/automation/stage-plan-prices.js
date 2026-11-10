'use strict';
const { PLANS } = require('./plan-redesign');

// Stage reviewed monthly prices without ever enabling a purchase binding.
// A persisted creation is reused after an unknown network result.
async function stagePlanPrices({ billing, commerce, actor, expectedEnvironment = 'production' }) {
    if (actor?.isAdmin !== true) throw Object.assign(new Error('Administrator required'), { code: 'AUTOMATION_FORBIDDEN' });
    const admin = await billing.getAdmin(actor), catalog = await commerce.getAdmin(actor);
    if (!admin.configured || !catalog.configured || admin.environment !== expectedEnvironment || catalog.environment !== expectedEnvironment || catalog.locationCurrency !== 'JPY')
        throw Object.assign(new Error('Square account or currency mismatch'), { code: 'PLAN_PRICE_ACCOUNT_MISMATCH' });
    const result = [];
    for (const plan of PLANS.filter(item => item.amountYen > 0)) {
        const binding = admin.bindings.find(item => item.planId === plan.planId && item.cadence === 'MONTHLY');
        if (binding) {
            if (binding.enabled || binding.amount !== plan.amountYen || binding.currency !== 'JPY')
                throw Object.assign(new Error('Existing Square price differs or is public'), { code: 'PLAN_PRICE_BINDING_MISMATCH' });
            const checked = await billing.saveBinding(actor, plan.planId, { variationId: binding.variationId, cadence: 'MONTHLY', enabled: false, expectedVerifiedAtMs: binding.verifiedAtMs });
            if (checked.enabled || checked.cadence !== 'MONTHLY' || checked.amount !== plan.amountYen || checked.currency !== 'JPY')
                throw Object.assign(new Error('Square price changed while verifying'), { code: 'PLAN_PRICE_BINDING_MISMATCH' });
            result.push({ planId: plan.planId, amountYen: plan.amountYen, state: 'verified' });
            continue;
        }
        let creation = catalog.creations.find(item => item.planId === plan.planId && item.cadence === 'MONTHLY');
        if (creation && (creation.amount !== plan.amountYen || creation.currency !== 'JPY' || creation.enabled !== false || !['QUOTED', 'SUBMITTING', 'UNKNOWN'].includes(creation.state)))
            throw Object.assign(new Error('Existing Square price creation requires review'), { code: 'PLAN_PRICE_CREATION_CONFLICT' });
        if (!creation) creation = await commerce.createCatalogQuote(actor, { planId: plan.planId, name: plan.label, cadence: 'MONTHLY', amount: plan.amountYen, currency: 'JPY', enabled: false });
        const completed = await commerce.confirmCatalogCreation(actor, { creationId: creation.creationId, consent: true });
        if (completed.state !== 'COMPLETE' || completed.enabled !== false || completed.amount !== plan.amountYen || completed.currency !== 'JPY' || completed.cadence !== 'MONTHLY')
            throw Object.assign(new Error('Square price creation not verified'), { code: 'PLAN_PRICE_CREATION_UNVERIFIED' });
        result.push({ planId: plan.planId, amountYen: plan.amountYen, state: 'created' });
    }
    const after = await billing.getAdmin(actor);
    for (const plan of PLANS.filter(item => item.amountYen > 0)) {
        const match = after.bindings.find(item => item.planId === plan.planId && item.cadence === 'MONTHLY');
        if (!match || match.enabled || match.amount !== plan.amountYen || match.currency !== 'JPY')
            throw Object.assign(new Error('Square binding verification failed'), { code: 'PLAN_PRICE_BINDING_MISMATCH' });
    }
    return result;
}

module.exports = { stagePlanPrices };
