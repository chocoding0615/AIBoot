/** Shared full-pipeline lease. Separate from legacy ledger and additional-schedule state. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomic,mutex,alive as processAlive} from './store.mjs';
import {regularProtected,fail} from './core.mjs';
import {selfIdentity,processProof,identityStatus} from './process-proof.mjs';
export function acquireExecution(home,{kind,key,now=Date.now(),isAlive=processAlive,pid=process.pid,inspectProcess=processProof}){
 const file=path.join(home,'report-execution.json'),guard=path.join(home,'report-execution.guard'),token=crypto.randomUUID();
 let accepted=false;
 mutex(guard,()=>{
  let prior;try{prior=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')fail('EXECUTION_STATE_CORRUPT',503);}
  if(prior){if(!Number.isInteger(prior.pid)||!prior.token)fail('EXECUTION_STATE_CORRUPT',503);
   const children=prior.children|| (prior.childPid?[{pid:prior.childPid,birth:prior.childBirth}]:[]);
   if((prior.unregisteredChildren||0)>0||isAlive(prior.pid)!==false||children.some(c=>isAlive(c.pid)!==false))return;
   const parent=inspectProcess(prior.pid);
   if(identityStatus(prior,parent)!=='dead')return;
   if(children.some(c=>identityStatus(c,inspectProcess(c.pid))!=='dead'))return;
   // The corresponding sending ledger remains untouched/unknown. A dead owner never authorizes that occurrence again.
   fs.appendFileSync(path.join(home,'report-execution-recovery.jsonl'),JSON.stringify({key:prior.key,phase:prior.phase,pid:prior.pid,recoveredAt:new Date(now).toISOString()})+'\n',{mode:0o600});
  }
  if(kind==='extra'&&regularProtected(now))return;
  atomic(file,{token,pid,birth:selfIdentity().birth,kind,key,children:[],unregisteredChildren:0,phase:'reading',startedAt:new Date(now).toISOString()});accepted=true;
 });
 if(!accepted)return null;
 const change=fn=>mutex(guard,()=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.token!==token)fail('LEASE_LOST');fn(value);});
 return {token,
 noChild(){change(v=>{if(!(v.unregisteredChildren>0))fail('LEASE_STATE_INVALID',503);v.unregisteredChildren--;atomic(file,v);});},
 phase(phase){change(v=>{if(phase==='sending'&&((v.unregisteredChildren||0)>0||(v.children||[]).length))fail('EXECUTION_CHILD_UNVERIFIED',503);if(phase==='generating')v.unregisteredChildren=(v.unregisteredChildren||0)+1;v.phase=phase;atomic(file,v);});},
 child(childPid,finished=false){change(v=>{
  const children=v.children|| (v.childPid?[{pid:v.childPid,birth:v.childBirth}]:[]);
  if(childPid&&!finished){if(!children.some(c=>c.pid===childPid))children.push({pid:childPid,birth:inspectProcess(childPid).birth});v.unregisteredChildren=Math.max(0,(v.unregisteredChildren||0)-1);}
  v.children=children.filter(c=>{if(!childPid||finished&&c.pid===childPid)return identityStatus(c,inspectProcess(c.pid))!=='dead';return true;});
  v.childPid=v.children[0]?.pid||null;v.childBirth=v.children[0]?.birth||null;atomic(file,v);
 });},
 release(){change(v=>{if((v.unregisteredChildren||0)>0||(v.children||[]).some(c=>identityStatus(c,inspectProcess(c.pid))!=='dead'))fail('EXECUTION_CHILD_UNVERIFIED',503);fs.unlinkSync(file);});}
 };
}

export function executionBusy(home){try{const r=JSON.parse(fs.readFileSync(path.join(home,'report-execution.json'),'utf8'));return !Number.isInteger(r.pid)||(r.unregisteredChildren||0)>0||processAlive(r.pid)!==false||(r.children|| (r.childPid?[{pid:r.childPid}]:[])).some(c=>processAlive(c.pid)!==false);}catch(e){return e.code!=='ENOENT';}}
