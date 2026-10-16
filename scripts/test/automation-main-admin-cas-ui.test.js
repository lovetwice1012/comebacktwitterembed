 'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const { createTestDatabase } = require('../lib/automation-test-db');
const { createService } = require('../../src/automation/service');
const { createSquareCommerce } = require('../../src/automation/square-commerce');
const { savePlanPolicy, listPlanPolicies } = require('../../src/automation/entitlements');
const { dispatch } = require('../../src/automation/api');
const port = Number(process.env.AUTOMATION_TEST_DB_PORT), admin = { userId:'999999999999999999',isAdmin:true };
const env = { SQUARE_ENVIRONMENT:'sandbox',SQUARE_ACCESS_TOKEN:'fixture',SQUARE_APPLICATION_ID:'APP',SQUARE_LOCATION_ID:'LOCATION',SQUARE_MERCHANT_ID:'MERCHANT',SQUARE_WEBHOOK_SIGNATURE_KEY:'fixture',SQUARE_WEBHOOK_NOTIFICATION_URL:'https://fixture.invalid/webhook' };
const clone = value => structuredClone(value);
const wait = f => f.act(async()=>new Promise(resolve=>setTimeout(resolve,30)));
const field = (root,label)=>[...root.querySelectorAll('label')].find(node=>node.textContent.trim().startsWith(label))?.querySelector('input,select,textarea');
const submit = (f,root)=>f.act(async()=>root.querySelector('form').dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true})));
const click = (f,root,label)=>f.act(async()=>{const target=[...root.querySelectorAll('button')].find(node=>node.textContent.trim()===label);assert(target,label);assert(!target.disabled,`enabled ${label}`);target.click();});
for(const kind of ['coupon','plan']) for(const oldRead of ['success','failure']) test(`MAIN-POST-1 real SQL ${kind} canonical CAS survives precommit ${oldRead} list response`,{skip:!port},async()=>{
 const db=await createTestDatabase(port);let f,releaseWrite,releaseRead;
 try{
  await db.queryDatabase('INSERT IGNORE INTO users (user_id,registered_at_ms) VALUES (?,0)',[admin.userId]);
  await db.withDatabaseTransaction(query=>savePlanPolicy(query,admin,{planId:'paid_saved',label:'Initial paid plan',slotLimit:12,minuteLimit:8,dayLimit:96,priority:2,enabled:true,intervalMinutes:60,expectedUpdatedAtMs:0}));
  const plan=(await listPlanPolicies(db.queryDatabase,admin)).find(item=>item.planId==='paid_saved');
  let clock=100,reads=0,writes=[];
  const commerce=createSquareCommerce(db,{env,clock:()=>clock,fetch:async url=>{assert.equal(new URL(url).pathname,'/v2/locations/LOCATION');return {ok:true,status:200,json:async()=>({location:{id:'LOCATION',merchant_id:'MERCHANT',status:'ACTIVE',currency:'JPY',timezone:'Asia/Tokyo'}})};}});
  const services={db,commerce,service:createService(db),xQuota:{mutatePolicy:(_actor,work)=>db.withDatabaseTransaction(work)}};
  if(kind==='coupon')await commerce.saveCoupon(admin,{code:'WELCOME',label:'Initial coupon',type:'percent',value:20,currency:null,planIds:[plan.planId],enabled:true,expiresAtMs:null,totalLimit:50,userLimit:1,expectedUpdatedAtMs:null});
  const target=kind==='coupon'?'billing/coupons/WELCOME':'plans/paid_saved',list=kind==='coupon'?'billing/commerce/admin':'plans';
  const api=async(route,method='GET',body)=>{
   if(route==='billing/admin')return {configured:false,environment:null,missing:[],bindings:[],availableVariations:[]};
   if(route===list&&method==='GET'){
    const snapshot=clone(await dispatch({method,path:route.split('/')},admin,services));
    if(++reads===2)return new Promise((resolve,reject)=>{releaseRead=()=>oldRead==='failure'?reject(new Error('old list failed')):resolve(snapshot);});
    return snapshot;
   }
   if(route===target&&method==='PATCH'){
    writes.push(clone(body));const run=()=>{clock++;return dispatch({method,path:route.split('/'),body},admin,services);};
    if(writes.length===1)return new Promise((resolve,reject)=>{releaseWrite=async()=>{try{resolve(await run());}catch(error){reject(error);}};});
    return run();
   }
   throw new Error(`unexpected ${method} ${route}`);
  };
  f=await reactFixture(kind==='coupon'?'export { SquareCouponManager } from "./components/admin/square-commerce-manager";':'export { NotificationPlanManager } from "./components/admin/notification-plan-manager";');
  await f.render(f.React.createElement(kind==='coupon'?f.exports.SquareCouponManager:f.exports.NotificationPlanManager,kind==='coupon'?{plans:[plan],configured:true,api}:{api}));
  if(kind==='coupon')await f.click('割引クーポンを管理');await wait(f);
  const article=kind==='coupon'?f.container.querySelector('[aria-label="WELCOMEの設定"]'):[...f.container.querySelectorAll('article')].find(node=>node.textContent.includes('Initial paid plan'));assert(article);
  const label=kind==='coupon'?'割引率':'表示名',confirm=kind==='coupon'?'このクーポン設定で保存':'この内容で保存';
  await f.fill(field(article,label),kind==='coupon'?'25':'Committed plan');await submit(f,article);await click(f,article,confirm);assert.equal(typeof releaseWrite,'function');
  await f.click(kind==='coupon'?'クーポン一覧を更新':'設定を更新');for(let attempt=0;attempt<100&&typeof releaseRead!=='function';attempt++)await wait(f);assert.equal(typeof releaseRead,'function');
  await f.act(async()=>releaseWrite());await wait(f);
  const baseline=kind==='coupon'?Number((await db.queryDatabase("SELECT updated_at_ms FROM automation_square_coupons WHERE code='WELCOME'"))[0].updated_at_ms):Number((await db.queryDatabase("SELECT updated_at_ms FROM automation_notification_plans WHERE plan_id='paid_saved'"))[0].updated_at_ms);
  await f.act(async()=>releaseRead());await wait(f);
  assert.doesNotMatch(article.textContent,/ほかの管理者による変更があります|old list failed/);
  await f.fill(field(article,label),kind==='coupon'?'30':'Second committed plan');await submit(f,article);await click(f,article,confirm);await wait(f);
  assert.equal(writes.length,2);assert.equal(writes[1].expectedUpdatedAtMs,baseline);
  const rows=kind==='coupon'?await db.queryDatabase("SELECT discount_value FROM automation_square_coupons WHERE code='WELCOME'"):await db.queryDatabase("SELECT label FROM automation_notification_plans WHERE plan_id='paid_saved'");
  assert.equal(kind==='coupon'?Number(rows[0].discount_value):rows[0].label,kind==='coupon'?30:'Second committed plan');
 }finally{if(f)await f.close();await db.close();}
});

for(const kind of ['coupon','plan'])test(`MAIN-POST-1 ${kind} same IDs in a new API context adopt its lower canonical revision`,async()=>{
 const f=await reactFixture(kind==='coupon'?'export { SquareCouponManager } from "./components/admin/square-commerce-manager";':'export { NotificationPlanManager } from "./components/admin/notification-plan-manager";');
 const plan={tier:'paid',planId:'same',label:'Old context plan',slotLimit:12,minuteLimit:8,dayLimit:96,priority:2,enabled:true,isBuiltin:false,updatedAtMs:999,intervalMinutes:60};
 const coupon={code:'SAME',label:'Old context coupon',type:'percent',value:20,currency:null,planIds:['same'],enabled:true,expiresAtMs:null,totalLimit:50,userLimit:1,updatedAtMs:999,used:0,reserved:0};
 const writes=[];
 const makeAPI=old=>async(route,method='GET',body)=>{
  if(route==='billing/admin')return {configured:false,environment:null,missing:[],bindings:[],availableVariations:[]};
  if(route==='plans'&&method==='GET')return {items:[{...plan,...(!old?{label:'New context plan',updatedAtMs:100}:{})}]};
  if(route==='billing/commerce/admin')return {configured:true,environment:'sandbox',locationCurrency:'JPY',minorUnitDigits:0,coupons:[{...coupon,...(!old?{label:'New context coupon',updatedAtMs:100}:{})}],creations:[]};
  if(method==='PATCH'){writes.push(body);return {...(kind==='coupon'?coupon:plan),...body,updatedAtMs:101};}
  throw new Error(`unexpected ${route}`);
 };
 const render=api=>f.render(f.React.createElement(kind==='coupon'?f.exports.SquareCouponManager:f.exports.NotificationPlanManager,kind==='coupon'?{plans:[plan],configured:true,api}:{api}));
 try{
  await render(makeAPI(true));if(kind==='coupon')await f.click('割引クーポンを管理');await wait(f);
  await render(makeAPI(false));if(kind==='coupon')await f.click('クーポン一覧を更新');await wait(f);
  const article=kind==='coupon'?f.container.querySelector('[aria-label="SAMEの設定"]'):[...f.container.querySelectorAll('article')].find(node=>node.textContent.includes('New context plan'));assert(article,'new context is rendered');
  assert.match(article.textContent,/New context/);
  await f.fill(field(article,kind==='coupon'?'割引率':'表示名'),kind==='coupon'?'25':'New change');await submit(f,article);await click(f,article,kind==='coupon'?'このクーポン設定で保存':'この内容で保存');
  assert.equal(writes.length,1);assert.equal(writes[0].expectedUpdatedAtMs,100);
 }finally{await f.close();}
});
