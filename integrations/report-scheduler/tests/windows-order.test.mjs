import test from 'node:test';import assert from 'node:assert/strict';import {WindowsBackend,nativePlan,fingerprint} from '../windows.mjs';
test('Windows may return weekly triggers in reverse order without a real mismatch',()=>{
 const state={configVersion:1,schedules:{a:{id:'a',enabled:true,rule:{weekdays:[6],time:'00:00'},firstRunAt:Date.parse('2026-11-21T00:00:00+09:00')},b:{id:'b',enabled:true,rule:{weekdays:[6],time:'00:30'},firstRunAt:Date.parse('2026-11-21T00:30:00+09:00')}}};
 const expected=nativePlan(state,'synthetic-home'),native=structuredClone(expected);native.triggers.reverse();
 const windows=new WindowsBackend({invoke:()=>JSON.stringify(native)});assert.equal(fingerprint(windows.read()),fingerprint(expected));
});
test('same clock time on different weekdays has deterministic native ordering',()=>{
 const state={configVersion:1,schedules:{a:{id:'a',enabled:true,rule:{weekdays:[6],time:'00:00'},firstRunAt:Date.parse('2026-11-21T00:00:00+09:00')},b:{id:'b',enabled:true,rule:{weekdays:[7],time:'00:00'},firstRunAt:Date.parse('2026-11-22T00:00:00+09:00')}}};
 const expected=nativePlan(state,'synthetic-home'),native=structuredClone(expected);native.triggers.reverse();
 const windows=new WindowsBackend({invoke:()=>JSON.stringify(native)});assert.equal(fingerprint(windows.read()),fingerprint(expected));
});
test('real trigger changes still fail equality after order normalization',()=>{
 const state={configVersion:1,schedules:{a:{id:'a',enabled:true,rule:{weekdays:[6],time:'00:00'},firstRunAt:Date.parse('2026-11-21T00:00:00+09:00')}}};
 const expected=nativePlan(state,'synthetic-home'),native=structuredClone(expected);native.triggers[0].days=[7];
 const windows=new WindowsBackend({invoke:()=>JSON.stringify(native)});assert.notEqual(fingerprint(windows.read()),fingerprint(expected));
});
