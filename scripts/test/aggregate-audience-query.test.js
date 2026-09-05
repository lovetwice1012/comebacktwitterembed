'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {DatabaseSync}=require('node:sqlite');
const {aggregateAudienceCorrelationQuery}=require('./helpers/load-dashboard.cjs')('lib/aggregate-audience-query.ts');
test('numeric audience groups preserve unique shared users across repeated hours and content types',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE bot_provider_hourly_unique_keys(bucket_start_ms INTEGER,provider_id TEXT,account_key TEXT,content_type TEXT,key_hash TEXT,event_type TEXT,key_type TEXT)');
 const insert=db.prepare('INSERT INTO bot_provider_hourly_unique_keys VALUES (?,?,?,?,?,?,?)');
 for(let i=0;i<500;i++){
  const row=[i%10,'p'+i%3,'a'+i%5,i%4?'type'+i%2:null,'hash'+i%17,'provider_content','author_user'];
  insert.run(...row);insert.run(...row);
 }
 insert.run(1,'','ignored','type','hash0','provider_content','author_user');
 const original=`WITH scoped AS (SELECT DISTINCT provider_id,account_key,content_type,key_hash FROM bot_provider_hourly_unique_keys
   WHERE bucket_start_ms>=? AND event_type='provider_content' AND key_type='author_user' AND provider_id<>'' AND account_key<>''),
   target AS (SELECT DISTINCT provider_id,account_key,key_hash FROM scoped),other AS (SELECT * FROM scoped)
   SELECT target.provider_id AS target_provider_id,target.account_key AS target_account_key,other.provider_id AS interest_provider_id,
     other.account_key AS interest_account_key,other.content_type AS interest_content_type,COUNT(DISTINCT target.key_hash) AS shared_users
   FROM target JOIN other ON other.key_hash=target.key_hash AND (other.provider_id<>target.provider_id OR other.account_key<>target.account_key)
   GROUP BY target.provider_id,target.account_key,other.provider_id,other.account_key,other.content_type ORDER BY shared_users DESC`;
 const normalize=rows=>rows.map(r=>({...r})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 try{assert.deepEqual(normalize(db.prepare(aggregateAudienceCorrelationQuery.replace('LIMIT 160','')).all(1)),normalize(db.prepare(original).all(1)));}
 finally{db.close();}
});
