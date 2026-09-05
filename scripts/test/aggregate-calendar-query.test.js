'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const load=require('./helpers/load-dashboard.cjs');
const {aggregateCalendarQuery}=load('lib/aggregate-calendar-query.ts');
test('JST calendar aggregates retain provider-qualified accounts and exact additive metrics across duplicate rows',()=>{
 const db=new DatabaseSync(':memory:');
 db.function('FROM_UNIXTIME',v=>v);db.function('DAYOFWEEK',v=>new Date(v*1000).getUTCDay()+1);
 const metrics=['content_events','analytics_events','extract_events','extract_successes','send_events','send_successes','enrichment_jobs','enrichment_successes','sensitive_events','media_count_sum','duration_seconds_sum','duration_seconds_count','analytics_duration_sum_ms','analytics_duration_count','enrichment_duration_sum_ms','enrichment_duration_count'];
 db.exec(`CREATE TABLE bot_provider_hourly_aggregates(bucket_start_ms INTEGER,provider_id TEXT,account_key TEXT,${metrics.map(c=>c+' INTEGER').join(',')})`);
 const insert=db.prepare(`INSERT INTO bot_provider_hourly_aggregates VALUES (${Array(3+metrics.length).fill('?').join(',')})`);
 for(let i=0;i<500;i++)insert.run(i*3600000,['p1','p2',''][i%3],['same','a','',null][i%4],...metrics.map((_,n)=>(i+n)%7));
 const normalize=rows=>rows.map(r=>Object.fromEntries(Object.entries(r).sort())).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 try{for(const [grain,provider] of [['hour',false],['weekday',false],['weekday',true],['day',false],['day',true]]){
  const period={hour:'hour_jst',weekday:'weekday_jst',day:'day_start_ms'}[grain];
  const expr={hour:'FLOOR(MOD(FLOOR((bucket_start_ms + 32400000) / ?),24))',weekday:'(MOD(FLOOR((bucket_start_ms + 32400000) / 86400000) + 3, 7) + 1)',day:'FLOOR((bucket_start_ms + 32400000) / ?) * ? - 32400000'}[grain];
  const params=grain==='hour'?[3600000,0]:grain==='day'?[86400000,86400000,0]:[0];
  const original=`SELECT ${provider?'provider_id,':''}${expr} AS ${period},${provider?'':"COUNT(*) AS aggregate_rows,COUNT(DISTINCT NULLIF(provider_id,'')) AS providers,"}COUNT(DISTINCT CASE WHEN NULLIF(account_key,'') IS NULL THEN NULL ELSE CONCAT(provider_id,CHAR(31),account_key) END) AS accounts,${metrics.map(c=>'SUM('+c+') AS '+c).join(',')}
    FROM bot_provider_hourly_aggregates WHERE bucket_start_ms>=? ${provider?"AND provider_id<>''":''} GROUP BY ${provider?'provider_id,':''}${period}
    ${grain==='day'&&provider?'HAVING SUM(content_events)>0':''} ORDER BY ${provider?'content_events DESC':period+(grain==='day'?' DESC':' ASC')} ${provider?'LIMIT '+(grain==='day'?240:160):grain==='day'?'LIMIT 45':''}`;
  assert.deepEqual(normalize(db.prepare(aggregateCalendarQuery(grain,provider).replace(/<=>/g,' IS ')).all(...params)),normalize(db.prepare(original).all(...params)));
 }}finally{db.close();}
});
