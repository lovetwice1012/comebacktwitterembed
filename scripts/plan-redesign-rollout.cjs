'use strict';

// Trusted operator CLI. The reviewed cohort is supplied in a protected JSON
// file outside the repository. No credentials or user IDs are printed.
const fs = require('node:fs');
const db = require('../src/db');
const { applyApprovedPlanPolicies } = require('../src/automation/plan-redesign');
const { stagePlanPrices } = require('../src/automation/stage-plan-prices');
const { createSquareBilling } = require('../src/automation/square-billing');
const { createSquareCommerce } = require('../src/automation/square-commerce');

async function main() {
    const [mode, cohortPath, actorId] = process.argv.slice(2);
    if (!['preview', 'apply', 'stage-square'].includes(mode) || !/^\d{1,32}$/.test(actorId || ''))
        throw Object.assign(new Error('Usage: node scripts/plan-redesign-rollout.cjs <preview|apply|stage-square> <cohort-file> <admin-id>'), { code: 'ROLLOUT_ARGUMENT_INVALID' });
    const actor = { userId: actorId, isAdmin: true };
    if (mode === 'stage-square') {
        const cutover = (await db.queryDatabase('SELECT id FROM automation_legacy_donor_cutover WHERE id=1'))[0];
        if (!cutover) throw Object.assign(new Error('Plan cutover is not active'), { code: 'ROLLOUT_CUTOVER_MISSING' });
        const result = await stagePlanPrices({ billing: createSquareBilling(db), commerce: createSquareCommerce(db), actor });
        process.stdout.write(JSON.stringify({ mode, plans: result, purchaseEnabled: false }) + '\n');
        return;
    }
    const ids = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));
    if (!Array.isArray(ids) || ids.length !== 33 || new Set(ids).size !== 33)
        throw Object.assign(new Error('The approved cohort must contain exactly 33 distinct IDs'), { code: 'ROLLOUT_COHORT_MISMATCH' });
    const rollback = Symbol('dry-run rollback'); let result;
    try {
        result = await db.withDatabaseTransaction(async query => {
            const applied = await applyApprovedPlanPolicies(query, { actor, ownerIds: ids, now: Date.now() });
            if (mode === 'preview') throw rollback;
            return applied;
        });
    } catch (error) { if (error !== rollback) throw error; result = { donorCount: ids.length, rolledBack: true }; }
    process.stdout.write(JSON.stringify({ mode, ...result }) + '\n');
}

main().then(() => process.exit(0), error => { process.stderr.write(JSON.stringify({ code: error?.code || 'ROLLOUT_FAILED' }) + '\n'); process.exit(1); });
