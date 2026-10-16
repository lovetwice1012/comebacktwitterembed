'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createMarketplace } = require('../../src/automation/marketplace');
const { newWorkflow } = require('../../src/automation/schema');
const { dispatch } = require('../../src/automation/api');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT);
const admin = { userId: '999999999999999999', isAdmin: true }, owner = { userId: '222222222222222222' }, member = { userId: '333333333333333333' };
const square = { SQUARE_ENVIRONMENT: 'sandbox', SQUARE_MERCHANT_ID: 'MERCHANT_CURRENT', SQUARE_ACCESS_TOKEN: 'synthetic', SQUARE_APPLICATION_ID: 'APP', SQUARE_LOCATION_ID: 'LOCATION', SQUARE_WEBHOOK_SIGNATURE_KEY: 'synthetic', SQUARE_WEBHOOK_NOTIFICATION_URL: 'https://fixture.invalid/webhook' };
const api = (services, actor, method, path, body = {}, search = {}) => dispatch({ method, path: path.split('/'), body, search: new URLSearchParams(search) }, actor, services);
async function fixture() {
    const db = await createTestDatabase(port), service = createService(db, { rateLimiter: { consumeOperation: async () => {} } });
    const market = createMarketplace(db, { service, moderationMatcher: { match: async () => [] } });
    await db.queryDatabase('INSERT IGNORE INTO users(user_id,registered_at_ms) VALUES (?,0),(?,0),(?,0)', [owner.userId, member.userId, admin.userId]);
    return { db, service, market };
}
function publication(name, visibility = 'public') { return { title: name, description: '', visibility, rightsConfirmed: true, bundle: { schemaVersion: 1, kind: 'workflow', workflow: newWorkflow(name), dictionaries: {}, license: 'CC0-1.0' } }; }
async function payment(db, values = {}) {
    const row = { id: randomUUID(), owner: owner.userId, environment: 'sandbox', merchant: 'MERCHANT_CURRENT', amount: 500, at: 2000, ...values };
    await db.queryDatabase(`INSERT INTO automation_square_donation_attempts (id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,payment_id,refunded_amount,verified,expires_at_ms,completed_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [row.id, row.owner, row.environment, row.merchant, 'LOCATION', 'APP', row.amount, 'JPY', 'fixture@example.invalid', 'Synthetic', 1, 'COMPLETED', `PAY_${row.id}`, 0, 1, 9999999999999, row.at, row.at, row.at]);
    return row;
}

test('MAIN-DATA-1: Push payment history is current merchant/environment scoped and binds cursor to scope and owner', { skip: !port, timeout: 90000 }, async () => {
    const original = Object.fromEntries(Object.keys(square).map(key => [key, process.env[key]])); Object.assign(process.env, square);
    const f = await fixture();
    try {
        const current = await payment(f.db);
        await payment(f.db, { environment: 'production', amount: 999 });
        await payment(f.db, { merchant: 'MERCHANT_OLD', amount: 888 });
        await payment(f.db, { owner: member.userId, amount: 777 });
        let history = await api(f, admin, 'GET', 'push-capacity/history', {}, { userId: owner.userId });
        assert.deepEqual(history.payments.map(row => row.attemptId), [current.id]);
        assert.deepEqual(history.paymentScope, { environment: 'sandbox', merchantId: 'MERCHANT_CURRENT' });
        for (let i = 0; i < 101; i++) await payment(f.db, { at: 3000 });
        history = await api(f, admin, 'GET', 'push-capacity/history', {}, { userId: owner.userId });
        assert.equal(history.payments.length, 100); assert(history.paymentNextCursor);
        const next = await api(f, admin, 'GET', 'push-capacity/history', {}, { userId: owner.userId, afterPaymentId: history.paymentNextCursor });
        assert.equal(next.payments.length, 2); assert.equal(next.paymentNextCursor, null);
        assert.equal(new Set([...history.payments, ...next.payments].map(row => row.attemptId)).size, 102);
        await assert.rejects(api(f, admin, 'GET', 'push-capacity/history', {}, { userId: member.userId, afterPaymentId: history.paymentNextCursor }), { code: 'INVALID_CURSOR' });
        process.env.SQUARE_MERCHANT_ID = 'MERCHANT_OLD';
        await assert.rejects(api(f, admin, 'GET', 'push-capacity/history', {}, { userId: owner.userId, afterPaymentId: history.paymentNextCursor }), { code: 'INVALID_CURSOR' });
        process.env.SQUARE_MERCHANT_ID = 'MERCHANT_CURRENT'; process.env.SQUARE_ENVIRONMENT = 'production';
        await assert.rejects(api(f, admin, 'GET', 'push-capacity/history', {}, { userId: owner.userId, afterPaymentId: history.paymentNextCursor }), { code: 'INVALID_CURSOR' });
    } finally { await f.db.close(); for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('MAIN-DATA-2: report resolve rolls back on audit failure and concurrent retries produce one state/audit pair', { skip: !port, timeout: 90000 }, async () => {
    const f = await fixture();
    try {
        const saved = await f.market.save(owner, publication('Atomic report'));
        const pack = await f.market.get(member, saved.id);
        await f.market.feedback(member, pack.id, { kind: 'report', reason: 'Review this edition', version: pack.version, checksum: pack.checksum });
        const report = (await f.market.reviewQueue(admin)).reports[0];
        const broken = createMarketplace(f.db, { service: { ...f.service, audit: async () => { throw new Error('fixture audit write failed'); } } });
        await assert.rejects(api({ ...f, market: broken }, admin, 'POST', `reports/${report.id}`, { note: 'Review completed', expectedUpdatedAtMs:Number(report.updated_at_ms), expectedVersion:pack.version, expectedChecksum:pack.checksum }), /fixture audit write failed/);
        assert.equal((await f.db.queryDatabase('SELECT state FROM automation_feedback WHERE id=?', [report.id]))[0].state, 'open');
        assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='report.resolve'", [report.id]))[0].n), 0);
        const outcomes = await Promise.allSettled([1, 2].map(() => api(f, admin, 'POST', `reports/${report.id}`, { note: 'Confirmed', expectedUpdatedAtMs:Number(report.updated_at_ms), expectedVersion:pack.version, expectedChecksum:pack.checksum })));
        assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'NOT_FOUND');
        assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='report.resolve'", [report.id]))[0].n), 1);
        const audit = JSON.parse((await f.db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='report.resolve'", [report.id]))[0].detail_json);
        assert.equal(audit.packageId, pack.id); assert.equal(audit.version, pack.version); assert.equal(audit.checksum, pack.checksum);
    } finally { await f.db.close(); }
});

test('MAIN-DATA-1: grant cursors share the financial scope/owner boundary, missing credentials preserve local history', { skip: !port, timeout: 90000 }, async () => {
    const original = Object.fromEntries(Object.keys(square).map(key => [key, process.env[key]])); Object.assign(process.env, square);
    const f = await fixture();
    try {
        const grants = require('../../src/automation/push-support-grants');
        for (let i = 0; i < 51; i++) await f.db.withDatabaseTransaction(query => grants.recordHistoricalSupportGrant(query,admin,{ userId:owner.userId,slots:1,idempotencyKey:`history_${i}`,reason:'Verified synthetic purchase',alreadyIncludedInLegacy:true }));
        await payment(f.db);
        const first = await api(f,admin,'GET','push-capacity/history',{}, {userId:owner.userId});
        assert.equal(first.grants.length,50); assert(first.nextCursor);
        const second = await api(f,admin,'GET','push-capacity/history',{}, {userId:owner.userId,cursor:first.nextCursor});
        assert.equal(second.grants.length,1); assert.equal(new Set([...first.grants,...second.grants].map(row=>row.grantId)).size,51);
        await assert.rejects(api(f,admin,'GET','push-capacity/history',{}, {userId:member.userId,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
        process.env.SQUARE_MERCHANT_ID='MERCHANT_OTHER';
        await assert.rejects(api(f,admin,'GET','push-capacity/history',{}, {userId:owner.userId,cursor:first.nextCursor}),{code:'INVALID_CURSOR'});
        process.env.SQUARE_MERCHANT_ID='MERCHANT_CURRENT'; delete process.env.SQUARE_ACCESS_TOKEN;
        const paused = await api(f,admin,'GET','push-capacity/history',{}, {userId:owner.userId});
        assert.equal(paused.payments.length,1); assert.equal(paused.grants.length,50);
        delete process.env.SQUARE_ENVIRONMENT;
        const unscoped = await api(f,admin,'GET','push-capacity/history',{}, {userId:owner.userId});
        assert.equal(unscoped.payments.length,0); assert.equal(unscoped.paymentScope,null); assert.equal(unscoped.grants.length,50);
        for (const bad of ['123:11111111-1111-4111-8111-111111111111','!','a'.repeat(1025),Buffer.from('null').toString('base64url')]) await assert.rejects(api(f,admin,'GET','push-capacity/history',{}, {userId:owner.userId,afterPaymentId:bad}),{code:'INVALID_CURSOR'});
    } finally { await f.db.close(); for (const [key,value] of Object.entries(original)) {if(value===undefined) delete process.env[key];else process.env[key]=value;} }
});

test('MAIN-DATA-1: administrator ACL and SQL faults never expose an unscoped fallback', { skip: !port, timeout: 90000 }, async () => {
    let reads=0;
    await assert.rejects(api({db:{queryDatabase:async()=>{reads++;throw new Error('must not read');}}},member,'GET','push-capacity/history',{}, {userId:owner.userId}),{status:403});
    assert.equal(reads,0);
    const original = Object.fromEntries(Object.keys(square).map(key => [key, process.env[key]])); Object.assign(process.env,square);
    const f=await fixture();
    try {
        const brokenDb={...f.db,queryDatabase:async(sql,params)=>{if(sql.includes('FROM automation_square_donation_attempts'))throw new Error('fixture payment read failed');return f.db.queryDatabase(sql,params);}};
        await assert.rejects(api({...f,db:brokenDb},admin,'GET','push-capacity/history',{}, {userId:owner.userId}),/fixture payment read failed/);
    } finally {await f.db.close();for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('MAIN-DATA-2: real audit SQL and commit failures leave reports retryable and legacy reports retain unknown target', { skip: !port, timeout: 90000 }, async () => {
    const f=await fixture();
    try {
        const saved=await f.market.save(owner,publication('SQL failure report'));
        const id=randomUUID();
        await f.db.queryDatabase("INSERT INTO automation_feedback(id,subject_id,actor_user_id,kind,value_json,created_at_ms,updated_at_ms) VALUES (?,?,?,'report',?,1,1)",[id,saved.id,member.userId,JSON.stringify({reason:'Legacy reason retained'})]);
        await f.db.queryDatabase("CREATE TRIGGER fixture_report_audit_fault BEFORE INSERT ON automation_audit FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture real audit SQL failure'");
        await assert.rejects(api(f,admin,'POST',`reports/${id}`,{note:'Confirmed',expectedUpdatedAtMs:1}),/fixture real audit SQL failure/);
        assert.equal((await f.db.queryDatabase('SELECT state FROM automation_feedback WHERE id=?',[id]))[0].state,'open');
        await f.db.queryDatabase('DROP TRIGGER fixture_report_audit_fault');
        const brokenDb={...f.db,withDatabaseTransaction:work=>f.db.withDatabaseTransaction(async query=>{await work(query);throw new Error('fixture transaction commit unavailable');})};
        const broken=createMarketplace(brokenDb,{service:f.service});
        await assert.rejects(api({...f,market:broken},admin,'POST',`reports/${id}`,{note:'Confirmed',expectedUpdatedAtMs:1}),/fixture transaction commit unavailable/);
        assert.equal((await f.db.queryDatabase('SELECT state FROM automation_feedback WHERE id=?',[id]))[0].state,'open');
        assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='report.resolve'",[id]))[0].n),0);
        await assert.rejects(api(f,admin,'GET',`reports/${id}/content`),{code:'MARKET_REPORT_UNBOUND'});
        const displayed=await f.market.get(member,saved.id);
        await assert.rejects(f.market.feedback(member,saved.id,{kind:'report',reason:'New claim must not guess legacy target',version:1,checksum:displayed.checksum}),{code:'MARKET_REPORT_ALREADY_OPEN'});
        await api(f,admin,'POST',`reports/${id}`,{note:'Legacy report reviewed manually',expectedUpdatedAtMs:1});
        const detail=JSON.parse((await f.db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='report.resolve'",[id]))[0].detail_json);
        assert.equal(detail.version,null);assert.equal(detail.checksum,null);
        assert.deepEqual(JSON.parse((await f.db.queryDatabase('SELECT value_json FROM automation_feedback WHERE id=?',[id]))[0].value_json),{reason:'Legacy reason retained'});
    }finally{await f.db.close();}
});

test('MAIN-POST-2: forged or inaccessible editions fail, an open report cannot be switched and reopen pins a newly displayed edition', { skip: !port, timeout: 90000 }, async () => {
    const f=await fixture();
    try {
        const saved=await f.market.save(owner,publication('Checked v1')),v1=await f.market.get(member,saved.id);
        for(const bad of [{},{version:1,checksum:'f'.repeat(64)},{version:0,checksum:v1.checksum},{version:2,checksum:v1.checksum}])await assert.rejects(f.market.feedback(member,saved.id,{kind:'report',reason:'Bad report',...bad}));
        assert.equal((await f.market.reviewQueue(admin)).reports.length,0);
        await f.market.feedback(member,saved.id,{kind:'report',reason:'Real v1 report',version:1,checksum:v1.checksum});
        const report=(await f.market.reviewQueue(admin)).reports[0];
        await f.market.save(owner,{...publication('Checked v2'),expectedVersion:1},saved.id);
        const v2=await f.market.get(member,saved.id);
        await assert.rejects(f.market.feedback(member,saved.id,{kind:'report',reason:'Different edition',version:2,checksum:v2.checksum}),{code:'MARKET_REPORT_ALREADY_OPEN'});
        assert.equal((await api(f,admin,'GET',`reports/${report.id}/content`)).version,1);
        await api(f,admin,'POST',`reports/${report.id}`,{note:'Resolved original',expectedUpdatedAtMs:Number(report.updated_at_ms),expectedVersion:v1.version,expectedChecksum:v1.checksum});
        await f.market.feedback(member,saved.id,{kind:'report',reason:'New v2 report',version:2,checksum:v2.checksum});
        assert.equal((await api(f,admin,'GET',`reports/${report.id}/content`)).version,2);
        await assert.rejects(api(f,admin,'POST',`reports/${report.id}`,{note:'Stale moderator snapshot',expectedUpdatedAtMs:Number(report.updated_at_ms),expectedVersion:v1.version,expectedChecksum:v1.checksum}),{code:'REVISION_CONFLICT',status:409});
        assert.equal((await f.db.queryDatabase('SELECT state FROM automation_feedback WHERE id=?',[report.id]))[0].state,'open');
        const note=JSON.parse((await f.db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='report.resolve'",[report.id]))[0].detail_json);
        assert.equal(note.version,1);assert.equal(note.checksum,v1.checksum);
        const privatePack=await f.market.save(owner,publication('Never shared','private'));
        await assert.rejects(f.market.feedback(member,privatePack.id,{kind:'report',reason:'Inaccessible',version:1,checksum:v1.checksum}),{status:404});
        await assert.rejects(api(f,member,'GET',`reports/${report.id}/content`),{status:403});
        await assert.rejects(api(f,admin,'GET',`reports/${randomUUID()}/content`),{status:404});
        await f.db.queryDatabase('UPDATE automation_package_versions SET checksum=? WHERE package_id=? AND version=2',['f'.repeat(64),saved.id]);
        await assert.rejects(api(f,admin,'GET',`reports/${report.id}/content`),{code:'BUNDLE_CHECK_FAILED',status:503});
    }finally{await f.db.close();}
});

for(const status of ['withdrawn','revoked'])test(`MAIN-POST-2: moderator inspects the same reported edition after ${status} without reopening normal access`,{skip:!port,timeout:90000},async()=>{
    const f=await fixture();
    try{
        const saved=await f.market.save(owner,publication(`Target before ${status}`)),shown=await f.market.get(member,saved.id);
        await f.market.feedback(member,saved.id,{kind:'report',reason:'Exact target',version:1,checksum:shown.checksum});
        const report=(await f.market.reviewQueue(admin)).reports[0];
        await f.market.setStatus(status==='revoked'?admin:owner,saved.id,{status,expectedVersion:1,note:'Synthetic safety control'});
        const inspected=await api(f,admin,'GET',`reports/${report.id}/content`);
        assert.equal(inspected.version,1);assert.equal(inspected.checksum,shown.checksum);assert.equal(inspected.packageStatus,status);
        if(status==='withdrawn')await assert.rejects(f.market.get(member,saved.id,1),{status:404});
        await assert.rejects(f.market.install(member,saved.id,{version:1}));
    }finally{await f.db.close();}
});

test('MAIN-POST-2 / MAIN-DATA-2: same-edition reason edits and reopened reports advance monotonic CAS even in the same millisecond', {skip:!port,timeout:90000},async()=>{
    const f=await fixture(),systemClock=Date.now;Date.now=()=>1792119999000;
    try{
        const saved=await f.market.save(owner,publication('Same edition CAS')),shown=await f.market.get(member,saved.id);
        const report=reason=>f.market.feedback(member,saved.id,{kind:'report',reason,version:shown.version,checksum:shown.checksum});
        const current=async()=>(await f.market.reviewQueue(admin)).reports[0];
        const resolve=row=>api(f,admin,'POST',`reports/${row.id}`,{note:'Reviewed snapshot',expectedVersion:row.value.version,expectedChecksum:row.value.checksum,expectedUpdatedAtMs:Number(row.updated_at_ms)});
        await report('First reason');const first=await current();
        await report('Edited reason while open');const edited=await current();
        assert.equal(Number(edited.updated_at_ms),Number(first.updated_at_ms)+1);
        await assert.rejects(resolve(first),{code:'REVISION_CONFLICT',status:409});
        assert.equal((await current()).value.reason,'Edited reason while open');
        assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='report.resolve'",[first.id]))[0].n),0);
        await resolve(edited);
        await report('New report after resolution, same edition');const reopened=await current();
        assert.equal(reopened.id,first.id);assert.equal(Number(reopened.updated_at_ms),Number(edited.updated_at_ms)+2);
        await assert.rejects(resolve(edited),{code:'REVISION_CONFLICT',status:409});
        assert.equal((await current()).value.reason,'New report after resolution, same edition');
        assert.equal(Number((await f.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='report.resolve'",[first.id]))[0].n),1);
        await resolve(reopened);
        const audits=await f.db.queryDatabase("SELECT detail_json FROM automation_audit WHERE entity_id=? AND action='report.resolve' ORDER BY id",[first.id]);
        assert.deepEqual(audits.map(row=>JSON.parse(row.detail_json).reportUpdatedAtMs),[Number(edited.updated_at_ms),Number(reopened.updated_at_ms)]);
    }finally{Date.now=systemClock;await f.db.close();}
});

test('MAIN-POST-2: a report binds the displayed immutable edition and moderator can inspect it after newer private edition', { skip: !port, timeout: 90000 }, async () => {
    const f = await fixture();
    try {
        const saved = await f.market.save(owner, publication('Reported v1'));
        const v1 = await f.market.get(member, saved.id);
        await f.market.feedback(member, v1.id, { kind: 'report', reason: 'Reported original content', version: v1.version, checksum: v1.checksum });
        await f.market.save(owner, { ...publication('Private v2', 'private'), expectedVersion: 1 }, v1.id);
        const report = (await f.market.reviewQueue(admin)).reports[0];
        assert.equal(report.value.version, 1); assert.equal(report.value.checksum, v1.checksum);
        const reviewed = await api(f, admin, 'GET', `reports/${report.id}/content`);
        assert.equal(reviewed.version, 1); assert.equal(reviewed.checksum, v1.checksum); assert.equal(reviewed.title, 'Reported v1');
        await assert.rejects(api(f, member, 'GET', `reports/${report.id}/content`), { status: 403 });
        await assert.rejects(f.market.get(admin, v1.id, 1), { status: 404 });
        await assert.rejects(f.market.get(member, v1.id, 1), { status: 404 });
    } finally { await f.db.close(); }
});
