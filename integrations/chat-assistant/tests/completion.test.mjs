import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTasks, makeCalendar, recurringLines } from '../../local-dual-report/recurring.mjs';
import { completionTargets, filterCompletedRecurring, completedAction } from '../completion.mjs';
import { initialState, answerPending, proposals, prompt, collect } from '../core.mjs';
import { openStore } from '../store.mjs';

const now = new Date('2026-11-17T03:00:00Z');
const config = {space:'spaces/test', owner:'users/123', maxDailyCalls:null, completionRecordingApproved:true};
const data = () => ({today:'2026-11-17',scope:'recurring:test',cal:makeCalendar(null),source:{
  tasks:parseTasks([
    ['법정의무교육(공지)','매년 1회','11-16','사용','D-7'],
    ['법정의무교육(이수)','매년 1회','11-20','사용','D-7']
  ], ['Tnotice','Tcourse']), history:new Map(), historyState:'연결'
}});
const io = get => ({now:()=>now, save:()=>{}, reportLedger:()=>({}), readCompletionSource:async()=>get(),
  generate:async()=>{throw Error('completion must not call AI');}, post:async()=>{throw Error('must not post');}});
async function message(state, text, id, get = data, c = config) {
  state.questions[id] = {id,text,status:'pending',at:new Date(now.getTime()+Object.keys(state.questions).length*1000).toISOString()};
  await answerPending(state,c,io(get));
  return state.questions[id].answer;
}
async function confirmed(state, get = data, c = config) {
  const preview = await message(state,'법정의무교육 공지 완료했어','request',get,c);
  const token = /완료 확인 ([a-f0-9]{24})/.exec(preview)[1];
  return message(state,`완료 확인 ${token} 처리일 2026-11-16`,'confirmation',get,c);
}

test('owner statement asks exact action/occurrence confirmation; no record or AI before confirmation',async()=>{
  const state=initialState();
  const preview=await message(state,'법정의무교육 공지 완료했어','q');
  assert.match(preview,/2026-11-16/);assert.match(preview,/완료 행위: 공지/);
  assert.equal(state.completionHistory,undefined);assert.deepEqual(state.usage,{});
  assert.equal(state.questions.q.status,'preview');
});

test('confirmed notice is atomic, restorable, duplicate-safe and independent of course completion',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-completion-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let store=openStore(dir);
  await confirmed(store.state);store.save();store.close();store=openStore(dir);
  try {
    const records=Object.values(store.state.completionHistory);
    assert.equal(records.length,1);assert.equal(records[0].action,'공지');
    assert.equal(records[0].basis,'2026-11-16');assert.equal(records[0].processedDate,'2026-11-16');
    assert.equal(records[0].actor,config.owner);assert.equal(records[0].confirmationId,'confirmation');
    assert.match(await message(store.state,'법정의무교육 공지 완료했어','repeat'),/이미 완료/);
    const d=data(), targets=completionTargets(d.source,d.cal,d.today,d.scope);
    assert.ok(completedAction(targets.find(t=>t.action==='공지'),store.state.completionHistory));
    assert.equal(completedAction(targets.find(t=>t.action==='교육 이수'),store.state.completionHistory),false);
    const lines=filterCompletedRecurring(recurringLines(d.source,d.cal,d.today),targets,store.state.completionHistory);
    assert.ok(!lines.some(x=>x.text.includes('(공지): 2026-11-16')));
    assert.ok(lines.some(x=>x.text.includes('(이수): 2026-11-20')));
    assert.equal(Object.keys(store.state.completionHistory).length,1);
  } finally {store.close();}
});

test('recording defaults OFF and missing processing date or forged confirmation cannot write',async()=>{
  const state=initialState();
  assert.match(await confirmed(state,data,{...config,completionRecordingApproved:false}),/저장하지/);
  assert.equal(state.completionHistory,undefined);
  const token=Object.keys(state.completionRequests)[0];
  assert.match(await message(state,`완료 확인 ${token}`,'no-date'),/실제 처리일/);
  assert.match(await message(state,`완료 확인 ${'0'.repeat(24)} 처리일 2026-11-16`,'forged'),/유효하지/);
  assert.match(await message(state,`완료 확인 ${token} 처리일 2026-02-30`,'bad-date'),/실제 처리일/);
  assert.match(await message(state,`완료 확인 ${token} 처리일 2026-11-18`,'future'),/실제 처리일/);
  assert.equal(state.completionHistory,undefined);
});

test('ambiguous names/occurrences, changed rules, different actor or stale confirmation never write',async()=>{
  for (const get of [()=>{const d=data();d.source.tasks[0].sameTitle=true;return d;},()=>{const d=data();d.source.tasks[0].rule={kind:'dates',dates:['11-16','12-01']};return d;}]) {
    const s=initialState();assert.match(await message(s,'법정의무교육 공지 완료했어','q',get),/하나로 확인할 수 없습니다/);
    assert.equal(s.completionRequests,undefined);
  }
  for (const scenario of ['changed','owner','stale']) {
    const s=initialState();await message(s,'법정의무교육 공지 완료했어','q');
    const token=Object.keys(s.completionRequests)[0];
    if(scenario==='stale')s.completionRequests[token].at='2026-11-10T00:00:00Z';
    const get=()=>{const d=data();if(scenario==='changed')d.source.tasks[0].basis='11-15';return d;};
    await message(s,`완료 확인 ${token} 처리일 2026-11-16`,'confirm',get,scenario==='owner'?{...config,owner:'users/999'}:config);
    assert.equal(s.completionHistory,undefined);
  }
});

test('missing Sheet IDs use rule identity without Sheet writes, row movement stable, next cycle remains',async()=>{
  const get=()=>{const d=data();d.source.tasks[0].id=null;return d;};
  const state=initialState();await confirmed(state,get);
  assert.match(Object.values(state.completionHistory)[0].taskId,/^local:/);
  const d=get();d.source.tasks[0].row=99;
  assert.ok(completedAction(completionTargets(d.source,d.cal,d.today,d.scope)[0],state.completionHistory));
  const next=completionTargets(d.source,d.cal,'2027-11-17',d.scope).find(t=>t.action==='공지');
  assert.equal(completedAction(next,state.completionHistory),false);
  assert.equal(completedAction({...next,scope:'other-sheet'},state.completionHistory),false);
});

test('explicit source discrepancy or failed history read retains recommendation as confirmation needed',async()=>{
  const state=initialState();await confirmed(state);
  const d=data();d.source.history.set('Tnotice|2026',{basis:'2026-11-16',status:'미처리',hasNote:true});
  const targets=completionTargets(d.source,d.cal,d.today,d.scope);
  const lines=filterCompletedRecurring(recurringLines(d.source,d.cal,d.today),targets,state.completionHistory);
  assert.ok(lines.some(x=>/완료 기록과 원본 불일치/.test(x.text)));
  const s=initialState();assert.match(await message(s,'법정의무교육 공지 완료했어','q',()=>({...d,source:{...d.source,historyState:'조회 실패'}})),/조회 실패/);
  assert.equal(s.completionRequests,undefined);
});

test('three report examples retain separate actions and unknown status; proposals exclude only exact completion',async()=>{
  const state=initialState();await confirmed(state);
  const d=data(),target=completionTargets(d.source,d.cal,d.today,d.scope).find(t=>t.action==='공지');
  const notice={...target,id:'notice',source:'recurring',subject:target.title,date:target.basis,text:'공지 완료 여부 확인 필요'};
  const peer={id:'chat',source:'chat',subject:target.title,date:target.basis,text:'원문 공지'};
  const snapshot={sources:{recurring:'연결',chat:'연결'},facts:[notice,peer]};
  assert.equal(proposals(snapshot,{verified:true,texts:[]},state,now).candidates.length,0);
  const fixed=['코웨이(본사)','쿠쿠(매장)','코웨이(양주)'].map(subject=>({source:'fixed',subject,date:'2026-11-20',action:'지출결의 작성',text:'지출결의 작성·실제 납부 여부 확인 필요'}));
  const licenses=['셀메이트','채널톡'].map(subject=>({source:'licenses',subject,date:'2026-12-04',action:'갱신 검토',text:'검토·확정·만료 상태 확인 필요'}));
  for(const f of [...fixed,...licenses])assert.equal(completedAction(f,state.completionHistory),false);
  assert.equal(completedAction({...target,action:'교육 이수'},state.completionHistory),false);
  assert.equal(completedAction({...target,action:'실제 납부'},state.completionHistory),false);
  assert.equal(completedAction({...target,action:'갱신 계약'},state.completionHistory),false);
});

test('stdin prompt budget retains full mandatory policy and >32767 characters of actual-shaped evidence',()=>{
  const policy='필수 업무 규칙\n'.repeat(1000);
  const snapshot={sources:{chat:'연결'},facts:Array.from({length:25},(_,i)=>({id:`chat:${i}`,source:'chat',text:'최신 업무 자료 '.repeat(150)}))};
  const original=structuredClone(snapshot);const text=prompt('전체 업무 정리',snapshot,initialState(),policy);
  assert.ok(text.length>32767);assert.ok(text.length<=64000);assert.ok(text.includes(policy));
  assert.deepEqual(snapshot,original);
});

test('Google Chat collection accepts only owner confirmation and replay cannot duplicate history',async()=>{
  const state=initialState(), c={...config,startAt:'2026-11-17T00:00:00Z'};
  const request={name:'spaces/test/messages/request',text:'법정의무교육 공지 완료했어',createTime:'2026-11-17T01:00:00Z',sender:{type:'HUMAN',name:c.owner}};
  await collect(state,c,async()=>({messages:[request]}),()=>{},now);
  await answerPending(state,c,io(data));
  const token=Object.keys(state.completionRequests)[0];
  const text=`완료 확인 ${token} 처리일 2026-11-16`;
  const confirm={name:'spaces/test/messages/confirmation',text,createTime:'2026-11-17T02:00:00Z',sender:{type:'HUMAN',name:c.owner}};
  const other={...confirm,name:'spaces/test/messages/other',sender:{type:'HUMAN',name:'users/999'}};
  await collect(state,c,async()=>({messages:[other,{...other,name:'spaces/test/messages/bot',sender:{type:'BOT',name:c.owner}}]}),()=>{},now);
  assert.equal(Object.keys(state.questions).length,1);assert.equal(state.completionHistory,undefined);
  await collect(state,c,async()=>({messages:[confirm]}),()=>{},now);
  await answerPending(state,c,io(data));
  assert.equal(Object.keys(state.completionHistory).length,1);
  await collect(state,c,async()=>({messages:[request,confirm]}),()=>{},now);
  assert.equal((await answerPending(state,c,io(data))).status,'대기 질문 없음');
  assert.equal(Object.keys(state.completionHistory).length,1);
  assert.deepEqual(state.usage,{});
});
