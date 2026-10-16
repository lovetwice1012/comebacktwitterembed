'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {reactFixture}=require('./helpers/react-dom-fixture.cjs');
const {createTestDatabase}=require('../lib/automation-test-db');
const {createService}=require('../../src/automation/service');
const {createMarketplace}=require('../../src/automation/marketplace');
const {newWorkflow}=require('../../src/automation/schema');
const {dispatch}=require('../../src/automation/api');
const port=Number(process.env.AUTOMATION_TEST_DB_PORT);
const admin={userId:'999999999999999999',isAdmin:true},owner={userId:'222222222222222222'},member={userId:'333333333333333333'};
const env={SQUARE_ENVIRONMENT:'sandbox',SQUARE_MERCHANT_ID:'MERCHANT_CURRENT'};
const publication=(title,visibility='public')=>({title,description:'',visibility,rightsConfirmed:true,bundle:{schemaVersion:1,kind:'workflow',workflow:newWorkflow(title),dictionaries:{},license:'CC0-1.0'}});
const wait=f=>f.act(async()=>new Promise(resolve=>setTimeout(resolve,25)));
async function services(){
    const db=await createTestDatabase(port),service=createService(db,{rateLimiter:{consumeOperation:async()=>{}}}),market=createMarketplace(db,{service,moderationMatcher:{match:async()=>[]}});
    await db.queryDatabase('INSERT IGNORE INTO users(user_id,registered_at_ms) VALUES (?,0),(?,0),(?,0)',[owner.userId,member.userId,admin.userId]);
    return{db,service,market};
}
async function marketplace(s,actor){
    const f=await reactFixture('export { MarketplaceManager } from "./components/automation/marketplace-manager";');
    f.calls=[];f.pending=new Set();f.api=async(route,method='GET',body)=>{
        f.calls.push({route,method,body});if(route==='starter')return null;
        const url=new URL(route,'https://fixture.invalid/');
        const work=dispatch({method,path:url.pathname.slice(1).split('/'),body,search:url.searchParams},actor,s);f.pending.add(work);
        try{return await work;}finally{f.pending.delete(work);}
    };
    f.drain=async()=>{for(let i=0;i<40;i++){await f.act(async()=>{await Promise.allSettled([...f.pending]);});await f.settle();if(!f.pending.size)return;}throw new Error('API did not settle');};
    const click=f.click;f.click=async label=>{await click(label);await f.drain();};
    await f.render(f.React.createElement(f.exports.MarketplaceManager,{api:f.api,scope:'private',canEdit:true,rules:[],dictionaries:[],refresh:async()=>{},openRule:async()=>{}}));await wait(f);await f.drain();return f;
}

test('MAIN-POST-2 actual React/SQL/API: displayed v1 is reported after v2 and moderator opens/reloads the exact edition after private v3', {skip:!port,timeout:90000},async()=>{
    const s=await services();let f;
    try{
        const saved=await s.market.save(owner,publication('Reported original v1'));
        f=await marketplace(s,member);
        await f.act(async()=>f.container.querySelector(`[data-package-id="${saved.id}"]`).click());
        await f.drain();
        const original=await s.market.get(member,saved.id,1);
        await s.market.save(owner,{...publication('Replacement v2'),expectedVersion:1},saved.id);
        await f.fill(f.container.querySelector('textarea[aria-label="通報理由"]'),'Please check this displayed edition');await f.click('通報する');
        const sent=f.calls.find(row=>row.route.endsWith('/feedback'));
        assert.equal(sent.body.version,1);assert.equal(sent.body.checksum,original.checksum);
        const report=(await s.market.reviewQueue(admin)).reports[0];assert.equal(report.value.version,1);
        await f.close();f=await marketplace(s,admin);await f.click('通報を確認');
        assert.match(f.container.textContent,/通報された版 1/);await f.click('共有内容を確認');
        assert.equal(f.container.querySelector('h2.text-base').textContent,'Reported original v1');
        assert(f.calls.some(row=>row.route===`reports/${report.id}/content`));
        assert(!f.calls.some(row=>row.route===`marketplace/${saved.id}/open`));
        await s.market.save(owner,{...publication('Private v3','private'),expectedVersion:2},saved.id);
        await f.click('共有内容を更新');
        assert.equal(f.container.querySelector('h2.text-base').textContent,'Reported original v1');
        assert.equal(f.calls.filter(row=>row.route===`reports/${report.id}/content`).length,2);
        assert.match(f.container.textContent,new RegExp(original.checksum));
        const inspection=f.container.querySelector('h2.text-base').closest('section');
        assert([...inspection.querySelectorAll('button')].find(node=>node.textContent==='通報する').closest('[hidden]'));
        f.set('confirm',()=>true);await f.fill(f.field('停止理由'),'Synthetic review takedown');await f.click('配布・実行を停止');
        assert.match(f.container.textContent,/安全上の停止を適用しました/);
        assert.equal((await s.db.queryDatabase('SELECT status FROM automation_packages WHERE id=?',[saved.id]))[0].status,'revoked');
        assert.equal(f.container.querySelector('h2.text-base').textContent,'Reported original v1');
        await f.click('対応済みにする');assert.equal((await s.market.reviewQueue(admin)).reports.length,0);
    }finally{if(f)await f.close();await s.db.close();}
});

test('MAIN-POST-2 actual React/SQL/API: legacy reports show unknown edition and retain an explicit resolve action', {skip:!port,timeout:90000},async()=>{
    const s=await services();let f;
    try{
        const saved=await s.market.save(owner,publication('Current content is not a historical target')),id=randomUUID();
        await s.db.queryDatabase("INSERT INTO automation_feedback(id,subject_id,actor_user_id,kind,value_json,created_at_ms,updated_at_ms) VALUES (?,?,?,'report',?,1,1)",[id,saved.id,member.userId,JSON.stringify({reason:'Historical report reason'})]);
        f=await marketplace(s,admin);await f.click('通報を確認');assert.match(f.container.textContent,/この通報の対象版は記録されていません。/);
        const open=[...f.container.querySelectorAll('button')].find(node=>node.textContent==='共有内容を確認');assert.equal(open.disabled,true);
        assert(!f.calls.some(row=>row.route.endsWith('/open')||row.route.endsWith('/content')));
        await f.click('対応済みにする');assert.equal((await s.market.reviewQueue(admin)).reports.length,0);
    }finally{if(f)await f.close();await s.db.close();}
});

test('MAIN-POST-2 / MAIN-DATA-2 actual React/SQL/API: stale same-edition report resolution preserves the new reason and refresh retries the current CAS', {skip:!port,timeout:90000},async()=>{
    const s=await services();let f;
    try{
        const saved=await s.market.save(owner,publication('Reason editing control')),shown=await s.market.get(member,saved.id);
        const report=reason=>s.market.feedback(member,saved.id,{kind:'report',reason,version:shown.version,checksum:shown.checksum});
        await report('Original reason');f=await marketplace(s,admin);await f.click('通報を確認');
        const original=(await s.market.reviewQueue(admin)).reports[0];
        await report('Additional evidence for the same edition');await f.click('対応済みにする');
        assert.match(f.container.textContent,/通報が更新されています。通報を読み直してください。/);
        assert.equal((await s.market.reviewQueue(admin)).reports[0].value.reason,'Additional evidence for the same edition');
        assert.equal(Number((await s.db.queryDatabase("SELECT COUNT(*) n FROM automation_audit WHERE entity_id=? AND action='report.resolve'",[original.id]))[0].n),0);
        await f.click('通報を確認');assert.match(f.container.textContent,/Additional evidence for the same edition/);await f.click('対応済みにする');
        const writes=f.calls.filter(row=>row.route===`reports/${original.id}`&&row.method==='POST');
        assert.equal(writes.length,2);assert(writes[1].body.expectedUpdatedAtMs>writes[0].body.expectedUpdatedAtMs);
        assert.equal((await s.market.reviewQueue(admin)).reports.length,0);
    }finally{if(f)await f.close();await s.db.close();}
});

test('MAIN-DATA-1 actual React/SQL/API: payment history displays current scope and excludes both foreign environments and merchants', {skip:!port,timeout:90000},async()=>{
    const prior=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
    const s=await services();let f;
    try{
        for(const [environment,merchant,amount]of [['sandbox','MERCHANT_CURRENT',500],['production','MERCHANT_CURRENT',999],['sandbox','MERCHANT_FOREIGN',888]])await s.db.queryDatabase(`INSERT INTO automation_square_donation_attempts(id,owner_user_id,environment,merchant_id,location_id,application_id,amount,currency,email,name,policy_updated_at_ms,state,refunded_amount,verified,expires_at_ms,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,1,'COMPLETED',0,1,9999999999999,1,1)`,[randomUUID(),owner.userId,environment,merchant,'LOCATION','APP',amount,'JPY','fixture@example.invalid','Synthetic']);
        f=await reactFixture('export { PushCapacityDiagnostics } from "./components/admin/push-capacity-diagnostics";');
        const summary={pools:{free:{limit:50,used:0,available:50},supporter:{limit:100,used:0,available:100}},owners:[],registrations:[],audits:[],integrity:{issues:[]}};
        const api=async route=>{if(route==='push-capacity/admin')return summary;const url=new URL(route,'https://fixture.invalid/');return dispatch({method:'GET',path:url.pathname.slice(1).split('/'),search:url.searchParams},admin,s);};
        await f.render(f.React.createElement(f.exports.PushCapacityDiagnostics,{api}));await f.click('使用状況・付与履歴を確認');await f.settle();
        await f.fill(f.field('履歴を確認する利用者ID'),owner.userId);await f.click('履歴を取得');await wait(f);
        const section=f.container.querySelector('section[aria-label="支援決済・付与履歴"]');
        assert.match(section.textContent,/500円/);assert.doesNotMatch(section.textContent,/999円|888円/);
        assert.match(section.textContent,/決済環境テスト/);assert.match(section.textContent,/加盟店MERCHANT_CURRENT/);
    }finally{if(f)await f.close();await s.db.close();for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('MAIN-DATA-1 UI: scope changes during pagination clear the old financial records instead of merging scopes',async()=>{
    const f=await reactFixture('export { PushCapacityDiagnostics } from "./components/admin/push-capacity-diagnostics";');let changed=false;
    const summary={pools:{free:{limit:50,used:0,available:50},supporter:{limit:100,used:0,available:100}},owners:[],registrations:[],audits:[],integrity:{issues:[]}};
    const api=async route=>route==='push-capacity/admin'?summary:{grants:[],payments:[{attemptId:changed?'new':'old',amount:changed?999:500,currency:'JPY',verified:true,state:'COMPLETED',createdAtMs:1}],paymentScope:{environment:changed?'production':'sandbox',merchantId:changed?'OTHER':'CURRENT'},nextCursor:null,paymentNextCursor:changed?null:'opaque-current-scope'};
    try{
        await f.render(f.React.createElement(f.exports.PushCapacityDiagnostics,{api}));await f.click('使用状況・付与履歴を確認');await f.settle();await f.fill(f.field('履歴を確認する利用者ID'),owner.userId);await f.click('履歴を取得');
        assert.match(f.container.textContent,/500円/);changed=true;await f.click('決済履歴の続きを取得');
        assert.match(f.container.textContent,/決済環境が変わりました。履歴を先頭から取得してください。/);assert.doesNotMatch(f.container.querySelector('section[aria-label="支援決済・付与履歴"]').textContent,/500円|999円/);
        await f.click('履歴を取得');assert.match(f.container.textContent,/999円/);assert.match(f.container.textContent,/決済環境本番/);
    }finally{await f.close();}
});
