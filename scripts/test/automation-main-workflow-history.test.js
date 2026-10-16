 'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict'); const { createHash } = require('node:crypto');
const { createTestDatabase } = require('../lib/automation-test-db'); const { createService } = require('../../src/automation/service');
const { newWorkflow,validateWorkflow } = require('../../src/automation/schema'); const { catalog } = require('../../src/automation/catalog');
const { parseWorkflow,stringifyDraft } = require('../../src/automation/format'); const { dispatch } = require('../../src/automation/api');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
const port=Number(process.env.AUTOMATION_TEST_DB_PORT),actor={userId:'222222222222222222'};
async function seed(service,db,name='History rule'){
 const row=await service.createWorkflow(actor,{definition:newWorkflow(name)});
 const bindings=JSON.stringify({destinations:{},dictionaries:{}});
 for(let revision=2;revision<=102;revision++){const definition=JSON.stringify(newWorkflow(`${name} v${revision}`));await db.queryDatabase('INSERT INTO automation_revisions (workflow_id,revision,definition_json,bindings_json,checksum,actor_user_id,created_at_ms) VALUES (?,?,?,?,?,?,?)',[row.id,revision,definition,bindings,createHash('sha256').update(definition+bindings).digest('hex'),actor.userId,revision]);}
 await db.queryDatabase('UPDATE automation_workflows SET revision=102,draft_json=? WHERE id=?',[JSON.stringify(newWorkflow(`${name} v102`)),row.id]);return service.getWorkflow(actor,row.id);
}
test('MAIN-FRESH-2 SQL history reaches every old edition with stable keysets, legacy arrays, restart and access fences',{skip:!port},async()=>{
 const db=await createTestDatabase(port);try{
 const service=createService(db),row=await seed(service,db),services={db,service};
 assert.equal((await service.history(actor,row.id)).length,102,'legacy callers retain all saved editions');
 const page=async search=>dispatch({method:'GET',path:['workflows',row.id,'history'],search:new URLSearchParams(search)},actor,services);
 const first=await page({page:'1',limit:'50'});assert.deepEqual([first.items[0].revision,first.items.at(-1).revision,first.nextRevision],[102,53,53]);
 await service.updateWorkflow(actor,row.id,{expectedRevision:102,definition:newWorkflow('v103 after first page')});
 const second=await page({page:'1',limit:'50',beforeRevision:String(first.nextRevision)}),last=await page({page:'1',limit:'50',beforeRevision:String(second.nextRevision)});
 assert.deepEqual([...first.items,...second.items,...last.items].map(item=>item.revision),Array.from({length:102},(_,index)=>102-index));assert.equal(last.nextRevision,null);
 assert.deepEqual(await createService(db).history(actor,row.id,{beforeRevision:3}),{items:last.items,nextRevision:null});
 await assert.rejects(service.history({userId:'333333333333333333'},row.id,{limit:50}),{status:404});
 for(const search of [{page:'2'},{limit:'101'},{limit:'0'},{beforeRevision:'-1'},{beforeRevision:'1e2'},{beforeRevision:'1.5'}])await assert.rejects(page(search),{status:400});
 const originalQuery=db.queryDatabase;let failRead=true;
 const faulty=createService({...db,queryDatabase:async(sql,args)=>{if(sql.includes('SELECT revision,checksum')&&failRead){failRead=false;throw new Error('fixture DB outage');}return originalQuery(sql,args);}});
 await assert.rejects(faulty.history(actor,row.id,{beforeRevision:3}),/fixture DB outage/);assert.equal((await faulty.history(actor,row.id,{beforeRevision:3})).items.length,2);
 await service.restoreRevision(actor,row.id,1,103);assert.equal((await service.getWorkflow(actor,row.id)).draft.name,'History rule');
 }finally{await db.close();}
});
const wait=f=>f.act(async()=>new Promise(resolve=>setTimeout(resolve,20)));
async function until(f,check){for(let n=0;n<200&&!check();n++)await wait(f);assert(check(),'UI reached awaited state');}
async function click(f,node){assert(node);assert(!node.disabled);await f.act(async()=>node.click());}
async function uiFixture(mode){
 const db=await createTestDatabase(port),service=createService(db);let f;
 try{
 const row=await seed(service,db),other=await service.createWorkflow(actor,{definition:newWorkflow('Other rule')});
 f=await reactFixture('export { AutomationWorkspace } from "./components/automation/automation-workspace";');
 f.set('SVGElement',f.dom.window.SVGElement);f.set('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});f.set('sessionStorage',f.dom.window.sessionStorage);f.set('confirm',()=>true);f.dom.window.HTMLElement.prototype.scrollIntoView=function(){};
 const calls=[];let failed=false,release,cycle=false;
 f.set('fetch',async(address,options)=>{
 const url=new URL(address,'http://127.0.0.1'),route=url.pathname.slice('/api/automation/'.length),method=options.method||'GET',body=options.body?JSON.parse(options.body):{};calls.push({route,method,search:new URLSearchParams(url.search),body});
 let result;
 if(route==='catalog')result=catalog();
 else if(route==='providers')result={auto:[],price:[],autoRegistration:{eligible:true}};
 else if(route==='entitlements')result={plan:{name:'free',priority:0,slotLimit:5,dayLimit:24,minuteLimit:5},slots:{used:0,max:5,available:5},usage:{entries:[]}};
 else if(route.startsWith('monitors/'))result={items:[],nextCursor:null};
 else if(route==='validate'){const definition=body.text===undefined?body.definition:parseWorkflow(body.text,body.format);result={...validateWorkflow(definition),definition,text:stringifyDraft(definition,body.format)};}
 else {
  result=await dispatch({method,path:route.split('/'),body,search:url.searchParams},actor,{db,service});
  if(route.endsWith('/history')&&Number(url.searchParams.get('beforeRevision'))<=102){
   if(mode==='failure'&&!failed){failed=true;return new Response(JSON.stringify({error:'fixture read failed'}),{status:503});}
   if(mode==='pending'&&!release)await new Promise(resolve=>{release=resolve;});
   if(mode==='cycle'&&!cycle){cycle=true;result={items:result.items,nextRevision:Number(url.searchParams.get('beforeRevision'))};}
  }
 }
 return new Response(JSON.stringify(result),{status:200});
 });
 const render=viewerId=>f.render(f.React.createElement(f.exports.AutomationWorkspace,{viewerId,canEdit:true}));
 await render(actor.userId);await until(f,()=>f.container.querySelector('.notification-center'));
 await f.click('通知ルール');await until(f,()=>[...f.container.querySelectorAll('.studio-rule-card')].some(node=>node.textContent.includes('History rule')));
 await click(f,[...f.container.querySelectorAll('.studio-rule-card')].find(node=>node.textContent.includes('History rule')));await until(f,()=>f.container.querySelector('[aria-label="ルール名"]'));
 if(mode==='concurrent')await service.updateWorkflow(actor,row.id,{expectedRevision:102,definition:newWorkflow('New revision103 from another client')});
 await f.click('変更履歴');await until(f,()=>f.container.querySelectorAll('[data-workflow-revision]').length===50);
 return {f,db,service,row,other,calls,render,release:()=>release?.(),hasRelease:()=>Boolean(release)};
 }catch(error){if(f)await f.close();await db.close();throw error;}
}
for(const mode of ['failure','cycle','concurrent'])test(`MAIN-FRESH-2 actual React+SQL paged history ${mode} recovers without losing pages and restores edition1`,{skip:!port},async()=>{
 const context=await uiFixture(mode),{f,service,row,calls}=context;
 try{
 if(mode!=='concurrent') {
 await f.click('古い版を読み込む');await until(f,()=>f.container.querySelector('[aria-label="変更履歴"] [role="alert"]'));
 assert.equal(f.container.querySelectorAll('[data-workflow-revision]').length,50);
 }
 await f.click('古い版を読み込む');await until(f,()=>f.container.querySelectorAll('[data-workflow-revision]').length===100);
 const pageCalls=calls.filter(call=>call.route.endsWith('/history'));assert.equal(pageCalls[0].search.get('beforeRevision'),'103','first read is bounded to the selected edition');
 if(mode!=='concurrent')assert.equal(pageCalls[1].search.get('beforeRevision'),pageCalls[2].search.get('beforeRevision'),'retry same keyset');
 await f.click('古い版を読み込む');await until(f,()=>f.container.querySelectorAll('[data-workflow-revision]').length===102);
 const first=f.container.querySelector('[data-workflow-revision="1"]');assert(first);
 if(mode==='concurrent'){assert.equal(f.container.querySelector('[data-workflow-revision="103"]'),null);await service.restoreRevision(actor,row.id,1,103);assert.equal((await service.getWorkflow(actor,row.id)).revision,104);return;}
 await click(f,first.querySelector('button'));
 await until(f,()=>f.container.querySelector('[aria-label="ルール名"]')?.value==='History rule');assert.equal((await service.getWorkflow(actor,row.id)).revision,103);
 }finally{context.release();await f.close();await context.db.close();}
});
for(const contextChange of ['workflow','viewer','close'])test(`MAIN-FRESH-2 late history page is discarded after ${contextChange} change`,{skip:!port},async()=>{
 const context=await uiFixture('pending'),{f}=context;
 try{
 await f.click('古い版を読み込む');await until(f,context.hasRelease);
 if(contextChange==='workflow'){await f.click('ルール一覧へ');await click(f,[...f.container.querySelectorAll('.studio-rule-card')].find(node=>node.textContent.includes('Other rule')));await until(f,()=>f.container.querySelector('[aria-label="ルール名"]')?.value==='Other rule');}
 else if(contextChange==='viewer')await context.render('333333333333333333');
 else await f.click('履歴を閉じる');
 await f.act(async()=>context.release());await wait(f);assert.equal(f.container.querySelector('[aria-label="変更履歴"]'),null,'stale history does not reopen under another selection');
 }finally{context.release();await f.close();await context.db.close();}
});
