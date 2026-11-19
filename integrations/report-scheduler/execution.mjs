/** Shared full-pipeline lease. Separate from legacy ledger and additional-schedule state. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomic,mutex,alive as processAlive} from './store.mjs';
import {regularProtected,fail} from './core.mjs';
export function acquireExecution(home,{kind,key,now=Date.now(),isAlive=processAlive,pid=process.pid}){
 const file=path.join(home,'report-execution.json'),guard=path.join(home,'report-execution.guard'),token=crypto.randomUUID();
 let accepted=false;
 mutex(guard,()=>{
  let prior;try{prior=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')fail('EXECUTION_STATE_CORRUPT',503);}
  if(prior){if(!Number.isInteger(prior.pid)||!prior.token)fail('EXECUTION_STATE_CORRUPT',503);
   if(isAlive(prior.pid)!==false||(prior.childPid&&isAlive(prior.childPid)!==false))return;
   // The corresponding sending ledger remains untouched/unknown. A dead owner never authorizes that occurrence again.
   fs.appendFileSync(path.join(home,'report-execution-recovery.jsonl'),JSON.stringify({key:prior.key,phase:prior.phase,pid:prior.pid,recoveredAt:new Date(now).toISOString()})+'\n',{mode:0o600});
  }
  if(kind==='extra'&&regularProtected(now))return;
  atomic(file,{token,pid,kind,key,phase:'reading',startedAt:new Date(now).toISOString()});accepted=true;
 });
 if(!accepted)return null;
 const change=fn=>mutex(guard,()=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.token!==token)fail('LEASE_LOST');fn(value);});
 return {token,phase(phase){change(v=>{v.phase=phase;atomic(file,v);});},child(childPid){change(v=>{v.childPid=childPid||null;atomic(file,v);});},release(){change(()=>fs.unlinkSync(file));}};
}

export function executionBusy(home){try{const r=JSON.parse(fs.readFileSync(path.join(home,'report-execution.json'),'utf8'));return !Number.isInteger(r.pid)||processAlive(r.pid)!==false||!!(r.childPid&&processAlive(r.childPid)!==false);}catch(e){return e.code!=='ENOENT';}}
