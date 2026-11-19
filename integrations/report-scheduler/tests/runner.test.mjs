import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import crypto from 'node:crypto';
import {acquireExecution} from '../execution.mjs';import {openStore} from '../store.mjs';import {ScheduleService} from '../service.mjs';import {dispatch,beginScheduled,transitionScheduled,failScheduled,artifactId} from '../engine.mjs';import {runPlan,retryNote} from '../../local-dual-report/operating.mjs';
const source=fs.readFileSync(new URL('../../local-dual-report/runner.mjs',import.meta.url),'utf8');
const extract=(name,ctx)=>vm.runInNewContext('('+source.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'))[0]+')',ctx);
function fixture(t,{extra=true,deliveryError=null}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'aiboot-runner-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 let now=Date.parse('2026-11-19T12:00:00+09:00'),native=null,key=null;
 const clock=()=>now,store=openStore(home),windows={read:()=>structuredClone(native),apply:p=>native=structuredClone(p)},service=new ScheduleService({home,store,windows,clock,writesEnabled:true});
 const ledgerFile=path.join(home,'ledger.json'),baseline={'2026-11-18|morning|antigravity':{status:'sent',attempts:1,chatUntil:'keep-cursor'}};
 fs.writeFileSync(ledgerFile,JSON.stringify(baseline));let generated=0,posted=0,provider;
 const DateClock=class extends Date{constructor(...a){super(...(a.length?a:[now]));}static now(){return now;}};
 const cfg={trialStart:'2026-11-04',trialEnd:'2026-11-10',afterTrialAgents:['antigravity'],webhookUrl:'https://example.invalid/synthetic'};
 const readLedger=()=>JSON.parse(fs.readFileSync(ledgerFile,'utf8'));
 const context={args:extra?{}:{slot:'morning'},HOME:home,SLOTS:{morning:{start:'09:30',end:'11:00',label:'오전'},afternoon:{start:'16:00',end:'17:30',label:'오후'}},AGENTS:{antigravity:'Antigravity',codex:'Codex'},cfg:()=>cfg,today:()=>new Date(now+9*3600000).toISOString().slice(0,10),hm:()=>extra?'13:00':'09:45',Date:DateClock,runPlan,log:()=>{},workday:async()=>({ok:true}),TEST_TAGS:{},
  beginScheduled:(h,k)=>beginScheduled(h,k,now,windows.read,()=>true),transitionScheduled,failScheduled,artifactId,acquireExecution,
  activeReportLease:null,currentReportPhase:'reading',activeReportLeasePhase:()=>context.currentReportPhase,
  snapshot:async()=>({text:'synthetic',contracts:[],licenses:[],welfare:[],recurring:[],chatText:'',sources:{fixed:'연결'},chatReadAt:'cursor'}),
  facts:async()=>({text:'synthetic'}),prompt:()=>'',crypto,path,readLedger,retryNote,
  withLock:fn=>fn(),fs,LEDGER:ledgerFile,
  updateLedger:(k,patch)=>{const l=readLedger();l[k]={...(l[k]||{}),...patch,updatedAt:new Date(now).toISOString()};fs.writeFileSync(ledgerFile,JSON.stringify(l));},
  generate:async agent=>{generated++;provider=agent;return 'synthetic report';},REPORT_DIR:path.join(home,'reports'),splitReport:()=>({chat:'synthetic report'}),toCards:()=>[],assertSameContent:()=>{},
  post:async()=>{posted++;if(deliveryError)throw Error(deliveryError);return{id:'synthetic-message',cards:0};},redact:()=> 'safe failure',process:{exitCode:0},console:{log:()=>{}}
 };
 context.claim=extract('claim',context);
 return {home,store,windows,service,context,baseline,readLedger,counts:()=>({generated,posted,provider}),time:x=>now=x,
  main:()=>extract('main',context)(),async reserve(){const id=service.mutate('create',{rule:{weekdays:[4],time:'13:00'}},{expectedVersion:0,idempotencyKey:'runner_request_123456',confirmed:true}).schedule.id;now=Date.parse('2026-11-19T13:00:00+09:00');await dispatch({store,windows,version:1,clock,launch:async k=>{key=k;}});context.args={'scheduled-run':key};return id;}};
}
test('actual extra main pipeline uses Antigravity, separate artifact and no legacy ledger/cursor write',async t=>{
 const f=fixture(t);await f.reserve();const before=fs.readFileSync(path.join(f.home,'ledger.json'),'utf8');await f.main();
 assert.deepEqual(f.counts(),{generated:1,posted:1,provider:'antigravity'});assert.equal(fs.readFileSync(path.join(f.home,'ledger.json'),'utf8'),before);
 const r=Object.values(f.store.read().runs)[0];assert.equal(r.status,'sent');assert.ok(r.webhookAcceptedAt);assert.ok(r.startedAt);assert.equal(r.scheduledDate,'2026-11-19');assert.equal(fs.readdirSync(path.join(f.home,'reports')).filter(x=>x.startsWith('extra-')).length,1);
 await assert.rejects(f.main(),{code:'RUN_NOT_RESERVED'});assert.equal(f.counts().posted,1);
});
test('actual extra main preserves network outcome unknown; restart cannot resend',async t=>{const f=fixture(t,{deliveryError:'webhook network error'});await f.reserve();await f.main();assert.equal(Object.values(f.store.read().runs)[0].status,'unknown');await assert.rejects(f.main());assert.equal(f.counts().posted,1);});
test('actual extra main records explicit HTTP rejection as known not-sent without automatic retry',async t=>{const f=fixture(t,{deliveryError:'webhook HTTP 503'});await f.reserve();await f.main();assert.equal(Object.values(f.store.read().runs)[0].status,'failed_not_sent');assert.equal(f.counts().posted,1);});
test('actual extra main respects existing non-workday policy',async t=>{const f=fixture(t);await f.reserve();f.context.workday=async()=>({ok:false,reason:'holiday'});await f.main();assert.equal(Object.values(f.store.read().runs)[0].status,'skipped_nonworkday');assert.equal(f.counts().generated,0);});
test('actual extra main holds when common lease is occupied',async t=>{const f=fixture(t);await f.reserve();const lease=acquireExecution(f.home,{kind:'regular',key:'regular'});await f.main();lease.release();assert.equal(Object.values(f.store.read().runs)[0].status,'held');assert.equal(f.counts().generated,0);});
test('actual regular main keeps legacy key, cursor and deduplication',async t=>{const f=fixture(t,{extra:false});await f.main();await f.main();assert.equal(f.counts().posted,1);const l=f.readLedger();assert.equal(l['2026-11-19|morning|antigravity'].status,'sent');assert.equal(l['2026-11-19|morning|antigravity'].attempts,1);assert.equal(l['2026-11-19|morning|antigravity'].chatUntil,'cursor');assert.deepEqual(l['2026-11-18|morning|antigravity'],f.baseline['2026-11-18|morning|antigravity']);assert.equal(fs.existsSync(path.join(f.home,'extra-reports','state.json')),false);});
test('actual regular unknown delivery never generates or sends again',async t=>{const f=fixture(t,{extra:false,deliveryError:'webhook network error'});await f.main();await f.main();assert.equal(f.readLedger()['2026-11-19|morning|antigravity'].status,'sending');assert.equal(f.counts().posted,1);assert.equal(f.counts().generated,1);});
test('additional state damage never enters regular main dependencies',async t=>{const f=fixture(t,{extra:false});fs.mkdirSync(path.join(f.home,'extra-reports'));fs.writeFileSync(path.join(f.home,'extra-reports','state.json'),'corrupt');await f.main();assert.equal(f.counts().posted,1);});
test('sending cannot be downgraded without positive rejection evidence',async t=>{const f=fixture(t);await f.reserve();const key=f.context.args['scheduled-run'];beginScheduled(f.home,key,Date.parse('2026-11-19T13:00:00+09:00'),f.windows.read,()=>true);transitionScheduled(f.home,key,{status:'sending'});assert.throws(()=>transitionScheduled(f.home,key,{status:'failed_not_sent'}),{code:'DELIVERY_UNCERTAIN'});failScheduled(f.home,key,'disk failure');assert.equal(f.store.read().runs[key].status,'unknown');});
test('actual extra main catches upstream failure before send and releases common lease',async t=>{const f=fixture(t);await f.reserve();f.context.snapshot=async()=>{throw Error('upstream')};await assert.rejects(f.main());assert.equal(Object.values(f.store.read().runs)[0].status,'failed_not_sent');assert.equal(fs.existsSync(path.join(f.home,'report-execution.json')),false);assert.equal(f.counts().posted,0);});
