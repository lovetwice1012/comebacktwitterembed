 'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { reactFixture } = require('./helpers/react-dom-fixture.cjs');
for (const failure of ['null', 'throw']) test(`MAIN-UI-2 committed cadence ${failure} read requires explicit recovery before the next write`, async () => {
 const f = await reactFixture('export { MonitorCadenceEditor } from "./components/automation/monitor-cadence-editor";');
 let stored = { id:'101',name:'101',revision:1,slotCost:1,baseIntervalMinutes:30,intervalMinutes:30,cadenceUpdatedAtMs:null,canAllocateCadence:true }, reads=0, writes=0;
 let setRow;
 function Fixture(){ const [row,update]=f.React.useState(stored); setRow=update; return f.React.createElement(f.exports.MonitorCadenceEditor,{row,pool:{used:1,max:10,available:9},api:async (_path,_method,body)=>{ assert.equal(body.expectedRevision,stored.revision); assert.equal(body.expectedUpdatedAtMs,stored.cadenceUpdatedAtMs); writes++; stored={...stored,revision:stored.revision+1,slotCost:body.slotCost,intervalMinutes:30/body.slotCost,cadenceUpdatedAtMs:writes*1000}; return {...stored,intervalMs:stored.intervalMinutes*60000}; },onDraft:()=>{},onReload:async()=>{ if(++reads===1){if(failure==='throw')throw new Error('read failed');return null;} setRow(stored);return stored; }}); }
 try {await f.render(f.React.createElement(Fixture));await f.click('確認間隔・使用枠');await f.fill(f.field('この通知で使う枠数'),'2');await f.submit();await f.click('この枠配分で保存');assert.equal(writes,1);assert.match(f.container.textContent,/枠配分は保存済みです/);assert.doesNotMatch(f.container.textContent,/枠配分を保存しました/);await f.submit();assert.equal(writes,1);await f.click('通知・利用枠を再取得');await f.fill(f.field('この通知で使う枠数'),'3');await f.submit();await f.click('この枠配分で保存');assert.equal(writes,2);assert.equal(stored.slotCost,3);}finally{await f.close();}
});
