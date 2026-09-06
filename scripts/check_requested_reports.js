'use strict';
// Trusted CLI validation of the same manual generation/cache path used by the UI.
// Explain mode captures complete builders without reading or saving user data.
const fs=require('node:fs');const crypto=require('node:crypto');
const load=require('./test/helpers/load-dashboard.cjs');const {connect,option}=require('./lib/counter-database');
const methods={analytics:['getAdminDetailedAnalytics','adminDetailedAnalyticsCacheState'], 'guild-preview':['getAdminGuildAnalyticsPreview','adminGuildAnalyticsPreviewCacheState'], 'provider-preview':['getAdminProviderMarketingPreview','adminProviderMarketingPreviewCacheState']};
async function main(){
 const kind=process.argv[2];if(!methods[kind])throw new Error('Usage: check_requested_reports.js analytics|guild-preview|provider-preview [--explain --database NAME --defaults-file PATH] [--filters-file PATH]');
 const filters={bucket:kind==='analytics'?'hour':'day',limit:kind==='analytics'?50:40,...(kind==='analytics'?{}:{urlVisibility:'raw'})};
 const filterFile=option('--filters-file');if(filterFile)Object.assign(filters,JSON.parse(fs.readFileSync(filterFile,'utf8')));
 if(process.argv.includes('--explain')){
  const queries=new Map();const capture=async(sql,...params)=>{if(Array.isArray(sql))sql=sql.join('?');queries.set(sql,{sql,params});return [];};
  const admin=load('lib/admin-data.ts',{'@/lib/prisma':{prisma:{$queryRaw:capture,$queryRawUnsafe:capture}},'@/lib/discord':{fetchBotGuildIds:async()=>new Set()}});
  await admin.buildAdminReportSnapshot(kind,filters);
  const database=option('--database');if(!database)throw new Error('--database is required for EXPLAIN');
  const db=await connect(database,10000);let failures=0;
  try{for(const {sql,params}of queries.values()){
   try{const rows=await db.query('EXPLAIN FORMAT=JSON '+sql,params.map(v=>v instanceof Date?v.toISOString().slice(0,19).replace('T',' '):v));const plan=JSON.parse(Object.values(rows[0])[0]);const tables=[];
    function visit(v){if(!v||typeof v!=='object')return;if(v.table_name)tables.push({table:v.table_name,access:v.access_type,index:v.key,rows:v.rows_examined_per_scan,produced:v.rows_produced_per_join});Object.values(v).forEach(visit);}visit(plan);
    console.log(JSON.stringify({kind,key:crypto.createHash('sha256').update(sql).digest('hex').slice(0,12),sql:sql.replace(/\s+/g,' ').slice(0,300),tables}));
   }catch(error){failures++;console.log(JSON.stringify({kind,error:error.message,sql:sql.replace(/\s+/g,' ').slice(0,200)}));}
  }}finally{await db.close();}
  if(failures)throw new Error(`${failures} EXPLAIN failures`);return;
 }
 const [method,state]=methods[kind];const admin=load('lib/admin-data.ts',{},['sharedPrisma',state]);const started=Date.now();
 try{
  await admin[method](filters,{forceRefresh:true});const entries=[...admin.__test[state].entries.values()];
  if(entries.length!==1||!entries[0].refreshPromise)throw new Error('Manual request did not create exactly one build');
  const result=await entries[0].refreshPromise;await admin.__test.sharedPrisma.$disconnect();
  console.log(JSON.stringify({kind,success:true,elapsedMs:Date.now()-started,sections:Object.keys(result),previewSections:result.sections?Object.keys(result.sections):undefined,window:result.window},null,2));
 }finally{await admin.__test.sharedPrisma.$disconnect();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
