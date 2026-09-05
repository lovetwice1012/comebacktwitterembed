'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('./web/view-data');

test('missing telemetry is not a zero-count or healthy presentation', () => {
  const model = view.measurement({ requestCount:0, coverage:{ measurementState:'not_measured', measurementReason:'no_production_request_records', collectionState:'unobserved' } });
  assert.equal(model.unavailable, true);
  assert.equal(model.countLabel, '未計測');
  assert.match(model.message, /本番の展開要求がまだ記録されていません/);
  assert.match(model.collection, /未観測/);
});
test('historical observations survive stale collection without becoming a health claim', () => {
  const model = view.measurement({requestCount:7,coverage:{measurementState:'observed_records',collectionState:'heartbeat_stale'}});
  assert.equal(model.unavailable,false);
  assert.match(model.collection,/現在の収集継続を確認できません/);
});
test('a missing HTTP status or body is not an invented network failure or empty response', () => {
  assert.equal(view.http({bodyState:'awaiting_headers'}).statusLabel,'応答未確認');
  assert.equal(view.http({status:200,bodyState:'not_consumed'}).bodyState,'not_saved');
  assert.equal(view.http({status:200,body:''}).bodyState,'saved_empty');
  assert.equal(view.http({error:{message:'timeout'}}).statusLabel,'接続・応答前の失敗');
  assert.equal(view.http({status:200,body:'partial',truncated:true}).bodyState,'truncated');
});
test('event summaries retain stage, exact URL, outcome, and actual parser error', () => {
  const data=view.event({payload:{event_id:'e1',stage:'parse',kind:'failed',occurred_at:'2026-09-05T00:00:00Z',details:{url:'https://api.example.test/data',error:{message:'Expected JSON; received HTML'}}}});
  assert.equal(data.kind,'parse.failed');
  assert.equal(data.errorMessage,'Expected JSON; received HTML');
  assert.equal(data.id,'e1');
  assert.match(data.search,/api.example.test/);
});
