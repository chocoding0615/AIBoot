import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { parseTasks, makeCalendar, recurringLines, recurringOmissions, HISTORY_TAB } from '../../local-dual-report/recurring.mjs';
import { completionTargets, filterCompletedRecurring, completedAction, readReportCompletions, reportRecurring, completedRecommendations } from '../completion.mjs';
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

async function reportFixture(twoCycles=false) {
  const d=data(), spreadsheetId='synthetic-recurring';
  d.scope='recurring:'+crypto.createHash('sha256').update(spreadsheetId).digest('hex').slice(0,24);
  if(twoCycles)d.source.tasks=parseTasks([
    ['법정의무교육(공지)','매년 2회','11-16, 11-20','사용','D-7'],
    ['법정의무교육(이수)','매년 1회','11-20','사용','D-7']
  ],['Tnotice','Tcourse']);
  const c={...config,startAt:'2026-11-17T00:00:00Z'},state=initialState();
  state.identity=`${c.space}|${c.owner}|${c.startAt}`;
  await message(state,'법정의무교육 공지 2026-11-16 완료했어','spaces/test/messages/request',()=>d,c);
  const token=Object.keys(state.completionRequests)[0];
  await message(state,`완료 확인 ${token} 처리일 2026-11-16`,'spaces/test/messages/confirmation',()=>d,c);
  const read=file=>JSON.stringify(file.endsWith('state.json')?state:c);
  return {d,c,state,read,spreadsheetId};
}

const runnerSource=fs.readFileSync(new URL('../../local-dual-report/runner.mjs',import.meta.url),'utf8');
const runnerFunction=(name,context)=>vm.runInNewContext('('+runnerSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]+')',context);
const headings=['내용 요약 및 추천','오늘 완료','오늘 남은 일','내일 업무 (11/18)'];
const fields=['[고정비]','[계약서]','[라이센스]','[복지]','[정기 업무]','[기타 업무]'];
const validateReport=runnerFunction('validate',{completedRecommendations,HEADINGS:()=>headings,FIELDS:fields,REMAINING_FIELDS:fields.slice(0,4),SEP:'--------------------',recurringOmissions,norm:s=>String(s).replace(/[\s()·]/g,'').toLowerCase(),CHAT_MAX:2000});
const reportText=(recurring,summary='공지',due='11/16')=>[
  headings[0],`1. 법정의무교육 ${summary}`,`■ 내용: ${due} ${summary} 확인 필요`,`□ 추천: ${summary}를 준비하세요.`,
  '--------------------',headings[1],'- 오늘 새로 확인된 완료 없음','--------------------',headings[2],
  ...fields.slice(0,4).flatMap(f=>[f,f==='[복지]'?'- 확인 불가(원본 미연결)':'- 해당 없음']),
  ...(recurring.length?['[정기 업무]',...recurring.map(x=>'- '+x)]:[]),
  '--------------------',headings[3],'- 해당 없음'
].join('\n');
const validationFacts=projection=>({nextHeading:headings[3],recurring:projection.lines,completedRecurring:projection.completed,sched:[],imminentDays:[],undated:[],welfareOk:false,welfareImminent:[],chatText:'과거 업무 요청'});

test('report loader reads atomically saved confirmation evidence without writes; absent or damaged evidence never excludes',async t=>{
  const f=await reportFixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-report-read-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.mkdirSync(path.join(dir,'assistant'));fs.writeFileSync(path.join(dir,'assistant/state.json'),JSON.stringify(f.state));fs.writeFileSync(path.join(dir,'assistant.json'),JSON.stringify(f.c));
  const before=fs.readFileSync(path.join(dir,'assistant/state.json'),'utf8');
  assert.equal(readReportCompletions(dir,f.d.today).status,'연결');
  assert.equal(fs.readFileSync(path.join(dir,'assistant/state.json'),'utf8'),before);
  assert.deepEqual(fs.readdirSync(path.join(dir,'assistant')),['state.json']);
  for(const bad of [null,[],{completionHistory:[]},{completionHistory:null},{...f.state,identity:'different'},
    {...f.state,completionRequests:{}},{...f.state,questions:{}},
    {...f.state,completionHistory:{wrong:Object.values(f.state.completionHistory)[0]}}]) {
    const loaded=readReportCompletions(dir,f.d.today,file=>file.endsWith('state.json')?JSON.stringify(bad):JSON.stringify(f.c));
    assert.equal(loaded.status,'조회 실패');assert.deepEqual(loaded.history,{});
  }
  for(const read of [()=>'{broken',()=>{throw Object.assign(Error('secret'),{code:'EACCES'});},file=>file.endsWith('state.json')?JSON.stringify(f.state):'{broken']) {
    assert.deepEqual(readReportCompletions(dir,f.d.today,read),{history:{},status:'조회 실패'});
  }
  for(const change of [r=>r.actor='users/999',r=>r.processedDate='2026-02-30',r=>r.confirmedAt='2027-11-17T03:00:01Z']) {
    const state=structuredClone(f.state);change(Object.values(state.completionHistory)[0]);
    assert.equal(readReportCompletions(dir,f.d.today,file=>JSON.stringify(file.endsWith('state.json')?state:f.c)).status,'조회 실패');
  }
  assert.equal(readReportCompletions(dir,f.d.today,()=>{throw Object.assign(Error(),{code:'ENOENT'});}).status,'없음');
  assert.equal(readReportCompletions(dir,f.d.today,()=>JSON.stringify(initialState())).status,'없음');
});

test('existing snapshot and fact path projects only confirmed action; missing history retains original report facts',async()=>{
  const f=await reportFixture();let loaded={history:{},status:'없음'};
  const snapshot=runnerFunction('snapshot',{
    sheetsClient:()=>({spreadsheets:{get:async()=>({data:{sheets:[]}})}}),
    readRecurringSource:async()=>f.d.source,makeCalendar,holidayData:async()=>null,today:()=>f.d.today,
    recurringLines,readReportCompletions:()=>loaded,reportRecurring,HOME:'/synthetic',log:()=>{},
    chatSnapshot:async()=>({status:'연결',text:'과거 11/16 법정의무교육 공지 요청',readAt:'cursor-unchanged'})
  });
  const c={recurringSpreadsheetId:f.spreadsheetId};
  const before=await snapshot(c);loaded=readReportCompletions('/synthetic',f.d.today,f.read);const after=await snapshot(c);
  assert.deepEqual([...before.recurring],recurringLines(f.d.source,f.d.cal,f.d.today));
  assert.equal(after.recurring.length,before.recurring.length-1);assert.equal(after.completedRecurring.length,1);
  assert.ok(after.recurring.some(x=>x.includes('(이수)')));
  for(const key of ['text','jp','sources','contracts','licenses','welfare','chatText','chatReadAt'])assert.deepEqual(after[key],before[key],key);
  const facts=runnerFunction('facts',{
    workday:async()=>({ok:true}),addDay:(date,n)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10),CHAT_LOOKBACK_MAX_DAYS:45,
    fixedFacts:()=>({sched:[],imminentDays:[],lines:['고정비 원본 유지']}),D_BUCKETS:[['D-7'],['D-30'],['D-60']],welfareTab:()=> '복지 적용일',WELFARE_DAYS:30,IMMINENT_DAYS:7,HISTORY_TAB
  });
  const bf=await facts(f.d.today,c,before),af=await facts(f.d.today,c,after);
  assert.ok(!bf.text.includes('[사용자 확인 완료 행위'));assert.ok(af.text.includes('[사용자 확인 완료 행위'));
  assert.ok(af.text.includes('(이수): 2026-11-20'));assert.ok(af.text.includes('고정비 원본 유지'));
  assert.equal(bf.nextHeading,af.nextHeading);
  assert.equal(validateReport(reportText(before.recurring),bf).length,0);
  assert.ok(validateReport(reportText(before.recurring),af).some(x=>x.startsWith('완료 행위 재추천')));
  assert.equal(validateReport(reportText(after.recurring,'교육 이수','11/20'),af).length,0);
  loaded={history:{},status:'조회 실패'};const failed=await snapshot(c);
  assert.deepEqual([...failed.recurring],[...before.recurring]);
  assert.match(failed.sources['사용자 확인 완료 이력'],/조회 실패/);
});

test('report validation blocks stale Chat re-recommendations across summary/remaining/next, but retains other action and next cycle',async()=>{
  const f=await reportFixture(true),history=readReportCompletions('/synthetic',f.d.today,f.read).history;
  const p=reportRecurring(f.d.source,f.d.cal,f.d.today,f.spreadsheetId,recurringLines(f.d.source,f.d.cal,f.d.today),history);
  assert.equal(p.completed.length,1);assert.ok(p.lines.some(x=>x.startsWith('법정의무교육(공지): 2026-11-20')));
  const vf=validationFacts(p),good=reportText(p.lines,'공지','11/20');
  assert.equal(validateReport(good,vf).length,0);
  for(const [section,text] of [
    ['내용 요약 및 추천','1. 법정의무교육 공지\n■ 내용: 11/16 공지 기한\n□ 추천: 준비하세요.'],
    ['내용 요약 및 추천','1. 업무 안내\n■ 내용: 준비 필요\n□ 추천:\n법정의무교육 11/16 공지를 준비하세요.'],
    ['오늘 남은 일','- 법정의무교육(공지): 2026-11-16 — 다시 공지 필요'],
    [headings[3],'- 법정의무교육 11월 16일 공지 재발송'],
    ['오늘 남은 일','- 법정의무교육 공지 준비'],
    ['오늘 남은 일','- 법정의무교육 11/16\n  공지를 준비하세요.'],
    ['오늘 남은 일','- 법정의무교육(공지): 11/17 — 공지 준비']
  ])assert.ok(completedRecommendations(section+'\n'+text,p.completed,headings[3],p.lines).length,section+text);
  for(const text of [
    '오늘 완료\n- 법정의무교육(공지): 11/16 공지 완료',
    '오늘 남은 일\n- 법정의무교육(이수): 11/20 — 교육 이수 확인 필요',
    '내용 요약 및 추천\n1. 법정의무교육 공지\n■ 내용: 11/16 공지 완료\n□ 추천: 교육 이수 여부를 확인하세요.',
    '오늘 남은 일\n- 법정의무교육 추가공지: 11/16 — 공지 준비'
  ])assert.equal(completedRecommendations(text,p.completed,headings[3],p.lines).length,0,text);
  const other='법정의무교육(공지 추가): 2026-11-16 (D+1) — 완료 여부 확인 필요';
  assert.equal(completedRecommendations('오늘 남은 일\n- '+other,p.completed,headings[3],[...p.lines,other]).length,0);
  const mismatch=structuredClone(f.d.source);mismatch.history.set('Tnotice|2026-1',{basis:'2026-11-16',status:'미처리',hasNote:true});
  const conflicted=reportRecurring(mismatch,f.d.cal,f.d.today,f.spreadsheetId,recurringLines(mismatch,f.d.cal,f.d.today),history);
  assert.equal(conflicted.completed.length,0);assert.ok(conflicted.lines.some(x=>/불일치/.test(x)));
  const failed={...f.d.source,historyState:'조회 실패'};
  assert.equal(reportRecurring(failed,f.d.cal,f.d.today,f.spreadsheetId,recurringLines(failed,f.d.cal,f.d.today),history).completed.length,0);
  for(const change of [r=>r.title='다른 업무',r=>r.occurrenceKey='wrong']) {
    const damaged=structuredClone(history);change(Object.values(damaged)[0]);
    assert.equal(reportRecurring(f.d.source,f.d.cal,f.d.today,f.spreadsheetId,recurringLines(f.d.source,f.d.cal,f.d.today),damaged).completed.length,0);
  }
});
