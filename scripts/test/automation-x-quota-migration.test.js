'use strict';
process.env.X_NOTIFICATION_ROLLOUT = 'public';
const test=require('node:test'), assert=require('node:assert/strict');
const {createTestDatabase}=require('../lib/automation-test-db');
const {ensurePlanIntervalColumn}=require('../../src/automation/quota-migration');
const grants=require('../../src/automation/push-support-grants');
const {createXMonitorQuota}=require('../../src/automation/x-monitor-quota');
const plans=require('../../src/automation/entitlements');
const port=Number(process.env.AUTOMATION_TEST_DB_PORT);
test('safe legacy migration and feature-off rollback retain plan rows, purchased counts, registry data and user interval settings',async t=>{
    const db=await createTestDatabase(port);t.after(()=>db.close());
    const actor={userId:'222222222222222222'},admin={userId:'444444444444444444',isAdmin:true};
    await db.queryDatabase('INSERT INTO users (user_id,registered_at_ms,is_donor,additional_auto_extract_slots,auto_watch_interval_minutes) VALUES (?,0,1,2,7)',[actor.userId]);
    await db.queryDatabase('INSERT INTO automation_notification_plans (plan_id,label,slot_limit,minute_limit,day_limit,priority,enabled,actor_user_id,updated_at_ms) VALUES (\'ExistingBasic\',\'既存Basic\',9,13,123,17,1,?,1)',[admin.userId]);
    await db.queryDatabase('ALTER TABLE automation_notification_plans DROP COLUMN confirmation_interval_minutes');
    const before=await db.queryDatabase('SELECT * FROM automation_notification_plans');
    assert.deepEqual(await ensurePlanIntervalColumn(db.queryDatabase),{added:true});
    assert.deepEqual(await ensurePlanIntervalColumn(db.queryDatabase),{added:false});
    const after=await db.queryDatabase('SELECT * FROM automation_notification_plans');
    assert.equal(after[0].confirmation_interval_minutes,null);
    delete after[0].confirmation_interval_minutes;assert.deepEqual(after,before);
    await db.withDatabaseTransaction(query=>grants.migrateLegacyGrants(query,actor.userId));
    assert.equal((await grants.getSupporterHolding(db.queryDatabase,actor.userId)).totalSupporterSlots,2);
    await db.withDatabaseTransaction(query=>plans.setUserPlan(query,admin,actor.userId,'ExistingBasic'));
    const active=createXMonitorQuota(db,{registrationEnabled:true});
    const registration=await active.register(actor,{accountId:'12345',name:'保持する監視'});
    const beforeRollback=await db.queryDatabase('SELECT * FROM automation_x_monitors');
    const off=createXMonitorQuota(db);
    await assert.rejects(off.register(actor,{accountId:'12346'}),{code:'X_MONITOR_UNAVAILABLE'});
    assert.equal((await off.list(actor)).items[0].id,registration.id);
    assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_monitors'),beforeRollback);
    assert.equal((await off.summary(actor)).personal.totalLimit,11);
    assert.equal((await db.queryDatabase('SELECT auto_watch_interval_minutes FROM users WHERE user_id=?',[actor.userId]))[0].auto_watch_interval_minutes,7);
});

test('admin diagnostics retain corrupt registration IDs without leaking settings, preserve corrupt holdings and propagate DB failures',async t=>{
    const db=await createTestDatabase(port);t.after(()=>db.close());
    const owner={userId:'222222222222222222'},other={userId:'333333333333333333'},admin={userId:'444444444444444444',isAdmin:true};
    const quota=createXMonitorQuota(db,{registrationEnabled:true});
    await assert.rejects(quota.register(owner,{accountId:'111',notificationSettings:{workflowId:{toString:()=> '00000000-0000-0000-0000-000000000000'}}}),{code:'X_MONITOR_INVALID_INPUT'});
    const badMetadata=await quota.register(owner,{accountId:'111'}),badHolding=await quota.register(other,{accountId:'222'});
    assert.equal((await quota.summary(owner)).personal.registeredCount,1);
    await db.withDatabaseTransaction(query=>grants.recordHistoricalSupportGrant(query,admin,{userId:other.userId,slots:1,idempotencyKey:'fixture-corrupt',reason:'検証済み旧購入1回のfixture'}));
    await db.queryDatabase("UPDATE automation_push_support_grants SET slots=9007199254740992 WHERE owner_user_id=?",[other.userId]);
    const sentinel='FAKE_SECRET_METADATA_DO_NOT_RENDER';
    await db.queryDatabase('UPDATE automation_x_monitors SET notification_settings_json=? WHERE id=?',[JSON.stringify({auth_token:sentinel}),badMetadata.id]);
    const before=await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id');
    const result=await quota.adminSummary(admin);
    assert.equal(result.registrations.length,0);
    assert.deepEqual(result.invalidOwners,[{userId:other.userId,errorCode:'INVALID_SUPPORT_HOLDING'}]);
    assert.deepEqual(result.invalidRegistrations.map(row=>row.id).sort(),[badMetadata.id,badHolding.id].sort());
    assert.ok(result.integrity.issues.some(row=>row.code==='INVALID_NOTIFICATION_SETTINGS'&&row.id===badMetadata.id));
    assert.ok(result.integrity.issues.some(row=>row.code==='INVALID_PERSONAL_ALLOWANCE'&&row.ownerUserId===other.userId));
    assert.equal(JSON.stringify(result).includes(sentinel),false);
    assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id'),before);
    const outage=Object.assign(new Error('fixture DB unavailable'),{code:'ER_SERVER_SHUTDOWN'});
    const failed={...db,queryDatabase:async(sql,params)=>{
        if(sql.includes('automation_push_support_grants')) throw outage;
        return db.queryDatabase(sql,params);
    }};
    await assert.rejects(createXMonitorQuota(failed).adminSummary(admin),cause=>cause===outage);
    assert.match(db.schema,/^cbte_automation_test_[0-9a-f]{20}$/);
    await db.withDatabaseTransaction(async query=>{
        // Simulate corrupt storage only in this guarded fixture connection.
        // Production CHECK constraints and policies remain unchanged.
        await query('SET SESSION check_constraint_checks=OFF');
        try {await query('UPDATE automation_push_pool_policy SET free_pool_limit=2000000000,supporter_pool_limit=2000000000 WHERE id=1');}
        finally {await query('SET SESSION check_constraint_checks=ON');}
    });
    const invalidCapacity=await quota.summary(owner);
    assert.equal(invalidCapacity.pools.free.limit,0);assert.equal(invalidCapacity.pools.supporter.limit,0);
    assert.equal(invalidCapacity.x.available,0);
    // MariaDB may reject even the mutex's no-op upsert because the corrupt
    // stored row violates CHECK; either boundary must prevent admission.
    await assert.rejects(quota.register({userId:'555555555555555555'},{accountId:'333'}),cause=>cause.code==='X_MONITOR_POOL_FULL'||cause.errno===4025);
    assert.equal((await quota.integrity(admin)).issues.filter(row=>row.code==='INVALID_POOL_POLICY').length,2);
    assert.deepEqual(await db.queryDatabase('SELECT * FROM automation_x_monitors ORDER BY id'),before);
});
