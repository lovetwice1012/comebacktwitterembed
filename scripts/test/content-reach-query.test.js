'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const load=require('./helpers/load-dashboard.cjs');
const {contentReachQuery}=load('lib/content-reach-query.ts');
test('content reach ranking preserves repeated events, distinct nullable users/guilds and null URL keys',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE bot_provider_content_events(content_event_id INTEGER,occurred_at_ms INTEGER,provider_id TEXT,account_key TEXT,content_type TEXT,content_url TEXT,normalized_url TEXT,guild_id TEXT,author_user_id TEXT,title TEXT)');
 const insert=db.prepare('INSERT INTO bot_provider_content_events VALUES (?,?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<1500;i++)insert.run(i,i,'p'+i%2,i%4?'a':null,'type'+i%3,i%3?'url'+i%17:null,'normal'+i%7,i%5?'g'+i%3:null,i%5?'u'+i%11:null,'Title'+i%19);
 insert.run(9999,20,'single','a','type','once','once','g1','u1',null);
 insert.run(9998,21,'nulls','a','type','nulls','nulls',null,null,null);
 insert.run(9997,22,'nulls','a','type','nulls','nulls',null,null,null);
 const normalize=rows=>rows.map(row=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 try{for(const kind of ['lifetime','reuse']){
  const keys=kind==='lifetime'?'provider_id,account_key,content_type,content_url,normalized_url':'provider_id,account_key,content_url,normalized_url';
  const original=`SELECT ${keys},MAX(title) AS title,COUNT(*) AS content_events,COUNT(DISTINCT author_user_id) AS users,COUNT(DISTINCT guild_id) AS guilds,MIN(occurred_at_ms) AS first_seen_ms,MAX(occurred_at_ms) AS last_seen_ms
    FROM bot_provider_content_events WHERE occurred_at_ms>=? AND (content_url IS NOT NULL OR normalized_url IS NOT NULL)
    GROUP BY ${keys} HAVING ${kind==='lifetime'?'content_events>1 OR guilds>1':'guilds>1'}
    ORDER BY ${kind==='lifetime'?'(last_seen_ms-first_seen_ms)':'guilds'} DESC,content_events DESC LIMIT 100`;
  // Avoid boundary ties in this semantic comparison; production tie ordering
  // remains unspecified just as in the original query.
  for(const sql of [original,contentReachQuery(kind)])assert.equal((sql.match(/\?/g)||[]).length,1);
  const optimized=contentReachQuery(kind).replace(/<=>/g,' IS ').replace(/LIMIT 100/g,'LIMIT 10000');
  const expected=original.replace(/LIMIT 100/g,'LIMIT 10000');
  assert.deepEqual(normalize(db.prepare(optimized).all(10)),normalize(db.prepare(expected).all(10)));
  assert.deepEqual(db.prepare(optimized).all(999999),[]);
 }}finally{db.close();}
});
