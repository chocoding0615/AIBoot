import fs from 'node:fs';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {clients,fixedRules,readSources,readCompletionSource} from '../chat-assistant/sources.mjs';
import {completionTargets,readReportCompletions} from '../chat-assistant/completion.mjs';
import {kst,reportBlocked} from '../chat-assistant/core.mjs';
import {occurrences} from '../local-dual-report/recurring.mjs';
import {fail} from '../report-scheduler/core.mjs';
import {createOfficialReader} from '../shared/official-sources.mjs';
import {opaque,evidenceSource,compareEvidence} from './evidence.mjs';
export const SOURCE_IDS=['fixed','contracts','licenses','welfare','recurring','chat'];
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const day=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const missing=()=>evidenceSource();
function json(file){try{if(fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>8*1024*1024)fail('MALFORMED_SOURCE',502);return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.status)throw e;fail(e.code==='ENOENT'?'SOURCE_UNAVAILABLE':'MALFORMED_SOURCE',e.code==='ENOENT'?503:502);}}
function sources(q,required=false){const raw=q.get('sources');if(raw===null){if(required)fail('INVALID_SCOPE',400);return SOURCE_IDS;}const ids=raw.split(',');if(!ids.length||ids.some(x=>!SOURCE_IDS.includes(x))||new Set(ids).size!==ids.length)fail('INVALID_SCOPE',400);return ids;}
function integer(q,key,def,max){if(!q.has(key))return def;const s=q.get(key);if(!/^[1-9]\d*$/.test(s)||Number(s)>max)fail('INVALID_REQUEST',400);return Number(s);}
function params(url,allowed){for(const k of url.searchParams.keys())if(!allowed.includes(k)||url.searchParams.getAll(k).length!==1)fail('INVALID_REQUEST',400);}
const sourceMeta=(sourceId,readStatus='not_checked',at=null,errorCode=null)=>({sourceId,readStatus,queriedAt:at,lastSuccessfulReadAt:readStatus==='ok'?at:null,sourceUpdatedAt:null,cachedAt:null,freshness:'unknown',errorCode,truncated:false});
const business=status=>status==='완료'?'confirmed_completed':status==='보류'?'confirmed_deferred':'unknown';
export class WorkspaceReader{
 constructor({home,buildVersion='unverified',clock=()=>new Date(),makeClients=clients,rules=fixedRules(repo),fetcher=fetch,budgetMs=15000,callMs=10000}={}){Object.assign(this,{home,buildVersion,clock,makeClients,rules,fetcher,budgetMs,callMs});this.busy=false;}
 config(){return json(path.join(this.home,'config.json'));}
 ledger(){const value=json(path.join(this.home,'ledger.json'));if(!value||typeof value!=='object'||Array.isArray(value))fail('MALFORMED_SOURCE',502);return value;}
 protected(){return reportBlocked(this.clock(),this.ledger(),['ledger.lock','report-execution.json','report-execution.guard','report-execution.guard.recovery'].some(x=>fs.existsSync(path.join(this.home,x))))||Object.values(this.ledger()).some(x=>x?.status==='unknown');}
 check(){if(this.protected())fail('REPORT_PROTECTED',409);}
 async handle(url,{signal}={}){
  const start=this.clock(),requestId=opaque('request',[start.toISOString(),Math.random()]);let data,status='ok',metas=[];
  const p=url.pathname,q=url.searchParams;
  if(p==='/api/health'){params(url,[]);data={adapterStatus:'ready',buildVersion:this.buildVersion,capabilities:{reports:true,tasks:true,connections:true,write:false,ai:false}};}
  else if(p==='/api/reports'){params(url,['date','slot','agent','limit']);data=this.reports(q);}
  else if(p==='/api/connections'){params(url,['sources']);const ids=sources(q),c=this.config();data={items:ids.map(sourceId=>({...sourceMeta(sourceId),configured:sourceId==='chat'?Array.isArray(c.chatSpaces)&&c.chatSpaces.length===2:!!c[({fixed:'spreadsheetId',contracts:'contractsSpreadsheetId',licenses:'contractsSpreadsheetId',welfare:'opsSpreadsheetId',recurring:'recurringSpreadsheetId'})[sourceId]],evidenceRef:null}))};}
  else if(p==='/api/tasks'){params(url,['sources','limit']);const ids=sources(q,true),limit=integer(q,'limit',50,100);const r=await this.tasks(ids,limit,signal);({data,status,metas}=r);}
  else fail('NOT_FOUND',404);
  const end=this.clock();return {requestId,apiVersion:'v0',status,data,meta:{requestedAt:start.toISOString(),completedAt:end.toISOString(),durationMs:end-start,partial:status==='partial',sources:metas}};
 }
 reports(q){
  if(q.has('date')&&!day(q.get('date'))||q.has('slot')&&!['morning','afternoon'].includes(q.get('slot'))||q.has('agent')&&!['codex','antigravity'].includes(q.get('agent')))fail('INVALID_REQUEST',400);
  const limit=integer(q,'limit',2,20),ledger=this.ledger(),entries=Object.entries(ledger).filter(([key,v])=>/^\d{4}-\d{2}-\d{2}\|(morning|afternoon)\|(codex|antigravity)$/.test(key)&&v?.status==='sent').filter(([key])=>{const [date,slot,agent]=key.split('|');return day(date)&&(!q.has('date')||q.get('date')===date)&&(!q.has('slot')||q.get('slot')===slot)&&(!q.has('agent')||q.get('agent')===agent);}).sort(([a],[b])=>b.slice(0,10).localeCompare(a.slice(0,10))||(a.includes('|afternoon|')?-1:1)).slice(0,limit);
  if(q.has('date')&&!entries.length)fail('NOT_FOUND',404);
  const dir=path.join(this.home,'reports');
  const items=entries.map(([key,entry])=>{
   const [date,slot,agent]=key.split('|'),file=path.join(dir,date+'-'+slot+'-'+agent+'.md');let text,stat;
   try{if(fs.lstatSync(dir).isSymbolicLink()||fs.lstatSync(file).isSymbolicLink())throw Error();stat=fs.statSync(file);if(stat.size>2*1024*1024)throw Error();const raw=fs.readFileSync(file,'utf8'),a=raw.indexOf('=== CHAT ==='),b=raw.indexOf('=== INTERNAL ===',a);if(a<0||raw.indexOf('=== CHAT ===',a+1)>=0)throw Error();text=raw.slice(a+12,b<0?undefined:b).trim();if(!text)throw Error();}catch{fail('MALFORMED_SOURCE',502);}
   return {reportId:key,date,slot,agent,deliveryStatus:'sent',receiptEvidencePresent:!!entry.messageId,userReceiptVerified:null,historicalReportOnly:true,text,storedAt:stat.mtime.toISOString()};
  });return {items};
 }
 async tasks(ids,limit,parentSignal){
  this.check();if(this.busy)fail('RATE_LIMITED',429);this.busy=true;
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort('TIMEOUT'),this.budgetMs);
  const cancel=()=>abort.abort(parentSignal?.reason||'CANCELLED');parentSignal?.addEventListener('abort',cancel,{once:true});if(parentSignal?.aborted)cancel();
  const monitor=setInterval(()=>{try{this.check();}catch{abort.abort('REPORT_PROTECTED');}},100);
  const items=[],metas=[],now=this.clock();let apiCalls=0,historyRows=[],activeSource=null;const failures=new Map();
  const finish=()=>{const truncated=items.length>limit;if(truncated)for(const m of metas)m.truncated=true;return {status:truncated||metas.some(s=>s.readStatus!=='ok')?'partial':'ok',data:{items:items.slice(0,limit),truncated,hasMore:truncated},metas};};
  const bounded=async(fn,args)=>{this.check();abort.signal.throwIfAborted();apiCalls++;try{const value=await fn(args,{signal:abort.signal,timeout:Math.min(this.callMs,this.budgetMs),retry:false});abort.signal.throwIfAborted();return value;}catch(e){const status=e.response?.status||e.status;failures.set(activeSource,[401,403].includes(status)?'ACCESS_DENIED':e.code==='ETIMEDOUT'?'TIMEOUT':'UPSTREAM_FAILED');throw e;}};
  try{
   const c=this.config(),io=this.makeClients(c,this.home),raw=io.sheets(),boundedSheets={get:(a)=>bounded(raw.get.bind(raw),a),values:{get:async a=>{const r=await bounded(raw.values.get.bind(raw.values),a);if(a.range==="'반복업무_처리이력'!A:F")historyRows=r.data.values||[];return r;},batchGet:a=>bounded(raw.values.batchGet.bind(raw.values),a)}};
   const official=createOfficialReader(boundedSheets,c),sheets=()=>official;
   const chat={spaces:{messages:{list:a=>bounded(io.chat.spaces.messages.list.bind(io.chat.spaces.messages),a)}}};
   const fetcher=async url=>{this.check();abort.signal.throwIfAborted();apiCalls++;return this.fetcher(url,{signal:abort.signal});};
   for(const id of ids){
    activeSource=id;this.check();abort.signal.throwIfAborted();
    if(id==='recurring'){
     try{
      const d=await readCompletionSource({report:c,sheets,home:this.home,now,fetcher}),targets=completionTargets(d.source,d.cal,d.today,d.scope),local=readReportCompletions(this.home,d.today);
      const tasks=d.source.tasks.filter(t=>t.use.active);
      for(const task of tasks){
       const os=occurrences(task.rule,d.cal,d.today);const rows=os.filter(o=>o.due);if(!rows.length)rows.push({key:null,due:null});
       for(const o of rows){
        const t=targets.find(t=>t.taskId===(task.id||t.taskId)&&t.title===task.title&&t.occurrenceKey===o.key&&t.basis===o.due);
        const identity=!!t&&!!task.id&&!task.idConflict&&!task.sameTitle,comparisonKey={scopeRef:opaque('scope',d.scope),taskRef:task.id?opaque('task',task.id):null,occurrenceKey:o.key,basisDate:o.due,action:t?.action||null};
        const h=t?.history,matching=h&&h.basis===o.due,valid=!!matching&&!h.duplicate&&(h.hasNote||h.status==='미처리')&&['완료','보류','미처리'].includes(h.status);
        const rawHistory=historyRows.slice(1).find(r=>String(r[0]).trim()===task.id&&String(r[1]).trim()===o.key),processed=rawHistory?.[3]?String(rawHistory[3]).slice(0,10):null;
        const record=(kind,status,date,reference)=>({evidenceKind:kind,...comparisonKey,taskId:comparisonKey.taskRef,businessStatus:status,processedDate:day(date)?date:null,evidenceRef:opaque('evidence',reference)});
        const sr=h&&matching?[record('sheet_history',business(h.status),processed,[task.id,o.key,h.row])]:[];
        const lr=Object.values(local.history).filter(r=>t&&r.scope===t.scope&&r.taskId===t.taskId&&r.ruleHash===t.ruleHash&&r.title===t.title&&r.occurrenceKey===t.occurrenceKey&&r.basis===t.basis&&r.action===t.action).map(r=>record('local_confirmed_history','confirmed_completed',r.processedDate,[r.taskId,r.occurrenceKey,r.confirmationId]));
        const sheet=evidenceSource({readStatus:d.source.historyState==='연결'?'ok':'failed',records:sr,verified:(!matching||valid)&&identity,queriedAt:now.toISOString(),errorCode:d.source.historyState==='연결'?null:'SOURCE_READ_FAILED'});
        const loc=evidenceSource({readStatus:local.status==='조회 실패'?'failed':local.status==='없음'?'not_checked':'ok',records:lr,queriedAt:now.toISOString(),errorCode:local.status==='조회 실패'?'SOURCE_READ_FAILED':null});
        const result=compareEvidence(comparisonKey,sheet,loc,{identityVerified:identity});
        items.push({id:opaque('recurring',[task.row,o.key]),sourceId:id,title:task.title,dueDate:o.due,occurrenceKey:o.key,action:t?.action||null,...result});
       }
      }
      metas.push(sourceMeta(id,d.source.historyState==='연결'?'ok':'partial',now.toISOString(),d.source.historyState==='연결'?null:'SOURCE_READ_FAILED'));
     }catch{metas.push(sourceMeta(id,'failed',now.toISOString(),'SOURCE_READ_FAILED'));}
    }else{
     const r=await readSources([id],{report:c,chat,sheets,rules:this.rules,home:this.home,now,fetcher});
     const ok=r.sources[id]==='연결';metas.push(sourceMeta(id,ok?'ok':'failed',now.toISOString(),ok?null:failures.get(id)||'SOURCE_READ_FAILED'));
     for(const f of r.facts)items.push({id:f.id,sourceId:id,title:f.subject,dueDate:f.date||null,occurrenceKey:null,action:null,businessStatus:'unknown',needsConfirmation:true,evidence:[],comparisonKey:null,evidenceBySource:{sheet_history:missing(),local_confirmed_history:missing()},confirmationReasons:['SOURCE_NOT_CHECKED']});
    }
   }
   abort.signal.throwIfAborted();this.check();
   if(metas.every(s=>s.readStatus==='failed'))fail(metas.every(s=>s.errorCode==='ACCESS_DENIED')?'ACCESS_DENIED':'UPSTREAM_FAILED',metas.every(s=>s.errorCode==='ACCESS_DENIED')?403:502,{sources:metas});
   return finish();
  }catch(e){if(abort.signal.aborted&&abort.signal.reason==='TIMEOUT'&&metas.some(s=>s.readStatus==='ok')){for(const id of ids){const m=metas.find(s=>s.sourceId===id);if(!m)metas.push(sourceMeta(id,'failed',now.toISOString(),'TIMEOUT'));else if(m.readStatus==='failed')m.errorCode='TIMEOUT';}return finish();}if(abort.signal.aborted)fail(abort.signal.reason==='REPORT_PROTECTED'?'REPORT_PROTECTED':'TIMEOUT',abort.signal.reason==='REPORT_PROTECTED'?409:504);throw e;}
  finally{clearTimeout(timer);clearInterval(monitor);parentSignal?.removeEventListener('abort',cancel);this.busy=false;}
 }
}
