import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { sendToWebhook, processNotification, calcBackoff, listen } from '../dist/listener.js';
import { buildRegistrationRequest, register } from '../dist/legacy/twitter-registration.js';
import { AckCode } from '../dist/autopush.js';
import { AngelicAngelError } from '../dist/errors.js';
const fixture = JSON.parse(await readFile(new URL('fixtures/crypto-golden.json',import.meta.url),'utf8'));
const keys = fixture.keys;
const registration = { endpoint: 'https://push.example.invalid/TEST_ONLY', autopush: { uaid: 'TEST_ONLY_UAID',channel_id: 'TEST_ONLY_CHID' }, keys };
async function server(t, handler) {
  const instance=http.createServer(handler); await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{instance.closeAllConnections();instance.close(resolve);}));
  return `http://127.0.0.1:${instance.address().port}`;
}
async function body(request) { let text='';for await (const chunk of request)text+=chunk;return JSON.parse(text); }
test('legacy X exact request shape, headers, base64url values and successful JSON response',async t=>{
  let received;
  const endpoint=await server(t,async(req,res)=>{received={headers:req.headers,body:await body(req),method:req.method};res.setHeader('Content-Type','application/json');res.end('{}');});
  const twitter={auth_token:'TEST_ONLY_AUTH',ct0:'TEST_ONLY_CT0'};
  await register(twitter,registration,{allowLegacyX:true,endpoint});
  const expected=buildRegistrationRequest(twitter,registration);
  assert.equal(received.method,'POST');assert.deepEqual(received.body,expected.body);
  for(const [name,value] of Object.entries(expected.headers))assert.equal(received.headers[name.toLowerCase()],value);
});
test('legacy default disabled before any request; response failures do not leak response body',async t=>{
  let count=0;const endpoint=await server(t,(_req,res)=>{count++;res.statusCode=403;res.end('RESPONSE_SECRET_NEVER_LOG');});
  const twitter={auth_token:'TEST_AUTH',ct0:'TEST_CT0'};
  await assert.rejects(register(twitter,registration,{endpoint}),{code:'TwitterApi'});assert.equal(count,0);
  await assert.rejects(register(twitter,registration,{endpoint,allowLegacyX:true}),error=>error.code==='TwitterApi'&&!error.message.includes('RESPONSE_SECRET_NEVER_LOG'));
  assert.equal(count,1);
  await assert.rejects(register(twitter,registration,{endpoint:'https://example.invalid',allowLegacyX:true}),{code:'TwitterApi'});
});
test('legacy rejects non-JSON success and never follows redirects with credentials',async t=>{
  let redirected=0;
  const target=await server(t,(_req,res)=>{redirected++;res.end('{}');});
  const endpoint=await server(t,(_req,res)=>{res.writeHead(302,{Location:target});res.end();});
  await assert.rejects(register({auth_token:'DUMMY',ct0:'DUMMY'},registration,{endpoint,allowLegacyX:true}),{code:'Http'});assert.equal(redirected,0);
  const malformed=await server(t,(_req,res)=>res.end('not-json'));
  await assert.rejects(register({auth_token:'DUMMY',ct0:'DUMMY'},registration,{endpoint:malformed,allowLegacyX:true}),{code:'Http'});
});
test('webhook success posts JSON once; errors and timeout are typed',async t=>{
  let observed;
  const endpoint=await server(t,async(req,res)=>{observed=await body(req);res.statusCode=204;res.end();});
  await sendToWebhook({test:'TEST_ONLY'}, {env:{WEBHOOK_ENDPOINT:endpoint}});assert.deepEqual(observed,{test:'TEST_ONLY'});
  for(const status of [400,429,500]){
    const failure=await server(t,(_req,res)=>{res.statusCode=status;res.end('WEBHOOK_BODY_SECRET');});
    await assert.rejects(sendToWebhook({}, {env:{WEBHOOK_ENDPOINT:failure}}),error=>error.code==='Http'&&!error.message.includes('WEBHOOK_BODY_SECRET'));
  }
  const hanging=await server(t,()=>{});
  await assert.rejects(sendToWebhook({}, {env:{WEBHOOK_ENDPOINT:hanging},webhookTimeoutMs:20}),{code:'Http'});
  const broken=await server(t,req=>req.socket.destroy());
  await assert.rejects(sendToWebhook({}, {env:{WEBHOOK_ENDPOINT:broken}}),{code:'Http'});
  await assert.rejects(sendToWebhook({}, {env:{}}),{code:'Config'});
});
test('webhook URL Basic auth and redirects preserve same-origin credentials and remove cross-origin credentials',async t=>{
  const seen=[];
  const other=await server(t,async(req,res)=>{seen.push({origin:'other',auth:req.headers.authorization,method:req.method,payload:await body(req)});res.end('{}');});
  const endpoint=await server(t,async(req,res)=>{
    if(req.url==='/same'){req.resume();res.writeHead(307,{Location:'/final'});res.end();}
    else if(req.url==='/cross'){req.resume();res.writeHead(307,{Location:other});res.end();}
    else {seen.push({origin:'same',auth:req.headers.authorization,method:req.method,payload:await body(req)});res.end('{}');}
  });
  const authenticated=path=>endpoint.replace('http://','http://dummy%20user:dummy%40pass@')+path;
  await sendToWebhook({value:'test'},{env:{WEBHOOK_ENDPOINT:authenticated('/same')}});
  await sendToWebhook({value:'test'},{env:{WEBHOOK_ENDPOINT:authenticated('/cross')}});
  assert.deepEqual(seen,[{origin:'same',auth:`Basic ${Buffer.from('dummy user:dummy@pass').toString('base64')}`,method:'POST',payload:{value:'test'}},{origin:'other',auth:undefined,method:'POST',payload:{value:'test'}}]);
});
test('ACK101 for decrypt failure, ACK102 for webhook/config failure, ACK100 for no-data',async()=>{
  const acks=[];const client={ack:async(...values)=>acks.push(values)};
  const notification={channel_id:'test',version:'1',data:'%%%',headers:null};
  assert.equal(await processNotification(client,notification,keys),AckCode.DecryptionError);
  assert.equal(await processNotification(client,{...notification,data:null},keys),AckCode.Delivered);
  assert.deepEqual(acks.map(item=>item[2]),[101,100]);
});
test('Web Push decrypt→JSON webhook→ACK and non-2xx ACK102 correction',async t=>{
  const sample=fixture.cases.find(item=>item.expected_plaintext_hex&&!item.expected_error && !item.keys);
  assert.ok(sample);
  let deliveries=0;
  const endpoint=await server(t,async(req,res)=>{await body(req);deliveries++;res.end('{}');});
  const acks=[];const client={ack:async(...values)=>acks.push(values)};
  const notification={channel_id:'test',version:'1',data:sample.data,headers:sample.headers};
  assert.equal(await processNotification(client,notification,keys,{env:{WEBHOOK_ENDPOINT:endpoint}}),100);assert.equal(deliveries,1);
  assert.equal(await processNotification(client,notification,keys,{env:{}}),102);
  const failure=await server(t,(_req,res)=>{res.statusCode=500;res.end();});
  assert.equal(await processNotification(client,notification,keys,{env:{WEBHOOK_ENDPOINT:failure}}),102);
  assert.deepEqual(acks.map(item=>item[2]),[100,102,102]);
});
test('Firefox backoff upper cap and successful session reset, 4774 delay',async()=>{
  assert.deepEqual([0,1,2,3,7,8,100,2**32-1].map(calcBackoff),[5,5,10,20,300,300,300,300]);
  const controller=new AbortController(), waits=[];let tries=0;
  const client={nextNotification:async()=>{throw new AngelicAngelError('AutoPush','BACKOFF: server requested backoff');},close:async()=>{},ack:async()=>{}};
  await listen(structuredClone(registration),'unused',{signal:controller.signal,
    connect:async()=>{tries++;if(tries<3||tries===4)throw new AngelicAngelError('WebSocket','connection failed');return{kind:'Connected',client};},
    sleep:async ms=>{waits.push(ms);if(waits.length===4)controller.abort();}});
  assert.deepEqual(waits,[5000,10000,1800000,20000]);
});
test('normal close resets failure counter; fatal UAID exits without retry',async()=>{
  const controller=new AbortController(),waits=[];let tries=0;
  const client={nextNotification:async()=>null,close:async()=>{},ack:async()=>{}};
  await listen(structuredClone(registration),'unused',{signal:controller.signal,
    connect:async()=>{if(++tries===2)return{kind:'Connected',client};throw new AngelicAngelError('WebSocket','connection failed');},
    sleep:async ms=>{waits.push(ms);if(waits.length===3)controller.abort();}});
  assert.deepEqual(waits,[5000,1000,5000]);
  await assert.rejects(listen(structuredClone(registration),'unused',{connect:async()=>{throw new AngelicAngelError('AutoPush','UAID invalid');},sleep:async()=>assert.fail('must not retry')}),{code:'AutoPush'});
});
