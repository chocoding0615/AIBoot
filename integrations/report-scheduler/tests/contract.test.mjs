import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createApi} from '../api.mjs';import {openStore,atomic} from '../store.mjs';import {ScheduleService} from '../service.mjs';import {firstRun} from '../core.mjs';
const at=s=>Date.parse('2026-11-19T'+s+':00+09:00');
function fixture(t,{persist}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-contract-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 let now=at('12:00'),native=null;const store=openStore(home,persist?{persist}:{}),windows={read:()=>structuredClone(native),apply:v=>native=structuredClone(v)};
 const service=new ScheduleService({store,windows,home,clock:()=>now,writesEnabled:true});
 return {home,store,windows,service,time:v=>now=v};
}
test('current minute cannot silently roll forward by a week',()=>{for(const now of [at('12:00'),at('12:00')+5000])assert.throws(()=>firstRun({weekdays:[4],time:'12:00'},now),{code:'LEAD_TIME'});});
test('20-minute server rule accepts 25 minutes and does not adopt a UI-only 30-minute rule',t=>{const f=fixture(t);const p=f.service.prepare('create',{rule:{weekdays:[4],time:'12:25'}},0);assert.equal(p.after.firstRunAt,new Date(at('12:25')).toISOString());});
test('weekend reservations explicitly advertise execution-time workday evaluation',t=>{const f=fixture(t);const p=f.service.prepare('create',{rule:{weekdays:[7],time:'13:00'}},0);assert.equal(p.after.workdayPolicy,'existing_workday');assert.equal(p.after.workdayEvaluation,'at_execution');assert.equal(p.after.nextRunMeaning,'trigger_attempt');assert.equal(p.after.maySkipNonWorkday,true);});
test('post-save server clock revalidation rolls Windows and settings back',t=>{
 let writes=0,fixtureRef;const f=fixture(t,{persist:(p,v)=>{atomic(p,v);if(++writes===2)fixtureRef.time(at('12:00')+1);}});fixtureRef=f;
 assert.throws(()=>f.service.mutate('create',{rule:{weekdays:[4],time:'12:20'}},{expectedVersion:0,confirmed:true,idempotencyKey:'after_save_clock_12345'}),e=>e.code==='LEAD_TIME'&&e.details.earliestAllowedAt===new Date(at('12:20')+1).toISOString());assert.equal(f.store.read().configVersion,0);assert.equal(f.windows.read(),null);
});
test('server rejects malformed versions and irrelevant operation fields',t=>{const f=fixture(t);for(const version of [undefined,'0',-1,0.5])assert.throws(()=>f.service.prepare('create',{rule:{weekdays:[4],time:'13:00'}},version),{code:'INVALID_REQUEST'});assert.throws(()=>f.service.prepare('create',{id:'client-id',rule:{weekdays:[4],time:'13:00'}},0),{code:'INVALID_REQUEST'});});
test('HTTP validation and error payloads match UI contract and expose no local secrets',async t=>{
 const f=fixture(t),token='c'.repeat(64),api=createApi({service:f.service,token}),address=await api.listen();t.after(()=>api.close());
 const call=async(suffix,body,headers={})=>{const r=await fetch('http://127.0.0.1:'+address.port+'/api/report-schedules'+suffix,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json; charset=utf-8','idempotency-key':'contract_request_123456',...headers},body:JSON.stringify(body)});return {status:r.status,json:await r.json()};};
 const preview=await call('/validate',{operation:'create',rule:{weekdays:[4],time:'13:00'},expectedVersion:0});assert.equal(preview.status,200);assert.equal(preview.json.data.requiresConfirmation,true);assert.equal(f.store.read().configVersion,0);
 const tooSoon=await call('',{rule:{weekdays:[4],time:'12:19'},expectedVersion:0,confirmed:true});assert.equal(tooSoon.status,409);assert.equal(tooSoon.json.error.code,'LEAD_TIME');assert.equal(tooSoon.json.error.details.earliestAllowedAt,new Date(at('12:20')).toISOString());
 const conflict=await call('/validate',{operation:'create',rule:{weekdays:[4],time:'16:00'},expectedVersion:0});assert.equal(conflict.status,409);assert.equal(conflict.json.error.details.reasons[0].kind,'regular_protected');
 const noConfirmation=await call('',{rule:{weekdays:[4],time:'13:00'},expectedVersion:0,confirmed:false});assert.equal(noConfirmation.status,400);assert.equal(noConfirmation.json.error.code,'CONFIRMATION_REQUIRED');
 const saved=await call('',{rule:{weekdays:[4],time:'13:00'},expectedVersion:0,confirmed:true});assert.equal(saved.status,201);assert.equal(saved.json.data.configVersion,1);assert.equal(saved.json.data.schedule.version,1);
 const again=await call('',{rule:{weekdays:[4],time:'13:00'},expectedVersion:0,confirmed:true});assert.deepEqual(again,saved);
 const text=JSON.stringify(saved);for(const forbidden of ['webhookUrl','access.json','sourceSheetIds','googleAuthDir','processId'])assert.ok(!text.includes(forbidden));
});
test('weekly future collision is returned even with a later first occurrence',t=>{const f=fixture(t),r={weekdays:[1,4],time:'13:00'};f.service.mutate('create',{rule:r},{expectedVersion:0,confirmed:true,idempotencyKey:'future_a_request_1234'});assert.throws(()=>f.service.prepare('create',{rule:{weekdays:[1],time:'13:10'}},1),e=>e.code==='SCHEDULE_CONFLICT'&&e.details.reasons.some(r=>r.kind==='extra_overlap'));});
