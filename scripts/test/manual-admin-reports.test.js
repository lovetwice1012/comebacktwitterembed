'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const load=require('./helpers/load-dashboard.cjs');
const mapping={analytics:['getAdminDetailedAnalytics','__cbteAdminDetailedAnalyticsCache'], 'guild-preview':['getAdminGuildAnalyticsPreview','__cbteAdminGuildAnalyticsPreviewCache'], 'provider-preview':['getAdminProviderMarketingPreview','__cbteAdminProviderMarketingPreviewCache']};
const rows=new Map();let aggregates=0,failBuild=false;
const query=async(sql,...params)=>{
 if(String(sql).includes('FROM bot_admin_report_snapshots'))return rows.has(params[0])?[rows.get(params[0])]:[];
 aggregates++;if(failBuild)throw new Error('SQL time limit reached');return [];
};
const admin=load('lib/admin-data.ts',{
 '@/lib/prisma':{prisma:{$queryRawUnsafe:query,$queryRaw:query,$executeRawUnsafe:async(sql,...params)=>{rows.set(params[0],{generated_at_ms:params[2],payload_json:params[3]});return 1;}}},
 '@/lib/env':{getDashboardAdminAnalyticsPrewarm:()=>true,getClientId:()=> 'test',getBotToken:()=> 'test',getDatabaseUrl:()=> 'configured'},
 '@/lib/audit-log':{ensureAuditLogTable:async()=>{}},'@/lib/discord':{fetchBotGuildIds:async()=>[]},'@/lib/settings-db':{},
 '@/lib/settings-catalog':{getCatalog:()=>[],getProviderSpecs:()=>[],providerLabel:v=>v,text:v=>v},
});

test('manual report reads never generate; explicit requests deduplicate, persist and keep old results on failure',async()=>{
 const warn=console.warn;console.warn=()=>{};
 try{for(const [kind,[method,stateKey]] of Object.entries(mapping)){
  const before=aggregates;
  const initial=await admin[method]({});
  assert.equal(initial.cache.ready,false);assert.equal(initial.cache.refreshing,false);assert.equal(initial.cache.refreshIntervalMs,0);assert.equal(initial.cache.nextUpdateAt,null);
  assert.equal(aggregates,before,'opening a panel must not aggregate');assert.ok(!globalThis[stateKey].timer);
  await Promise.all([admin[method]({}, {forceRefresh:true}),admin[method]({}, {forceRefresh:true})]);
  const entry=[...globalThis[stateKey].entries.values()][0];await entry.refreshPromise;
  assert.ok(entry.snapshot);assert.ok(aggregates>before);assert.ok(rows.has(kind==='analytics'?'detailed':kind),'completed previews must survive process restart');
  const complete=entry.snapshot;entry.updatedAtMs=Date.now()-86400000;
  const count=aggregates;
  for(let i=0;i<3;i++){const cached=await admin[method]({});assert.equal(cached.cache.ready,true);assert.equal(cached.cache.refreshing,false);}
  assert.equal(aggregates,count,'age alone must never schedule manual reports');
  failBuild=true;await admin[method]({}, {forceRefresh:true});await entry.refreshPromise.catch(()=>{});failBuild=false;
  assert.equal(entry.snapshot,complete);assert.ok(entry.lastError);
  rows.get(kind==='analytics'?'detailed':kind).generated_at_ms=Date.now()-86400000;
  const afterFailure=aggregates;globalThis[stateKey].entries.clear();
  const restored=await admin[method]({});assert.equal(restored.cache.ready,true);assert.equal(restored.cache.refreshing,false);assert.equal(aggregates,afterFailure,'reload reads old persisted data without rebuilding');
 }}finally{console.warn=warn;}
});

test('independent client queues the three reports only for an explicit button request',async()=>{
 const original=global.fetch;const calls=[];let report=null;
 global.fetch=async(url,options)=>{calls.push(options.method);return {ok:true,json:async()=>({report,cache:{ready:!!report,refreshing:false,updatedAt:'2020-01-01T00:00:00Z'}})};};
 try{const client=load('lib/admin-report-client.ts',{'@/lib/admin-agent':{adminAgentEndpoint:p=>new URL('http://127.0.0.1/v1/'+p)}});
  for(const kind of Object.keys(mapping)){
   calls.length=0;report=null;await client.getIndependentAdminReport(kind,{},'owner');assert.deepEqual(calls,['GET']);
   calls.length=0;report={full:true};await client.getIndependentAdminReport(kind,{},'owner');assert.deepEqual(calls,['GET']);
   calls.length=0;await client.getIndependentAdminReport(kind,{},'owner',true);assert.deepEqual(calls,['GET','POST']);
  }
 }finally{global.fetch=original;}
});
