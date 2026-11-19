import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fail,validateRule} from './core.mjs';
import {selfIdentity} from './process-proof.mjs';
export function alive(pid){if(!Number.isInteger(pid)||pid<1)return null;try{process.kill(pid,0);return true;}catch(e){return e.code==='ESRCH'?false:null;}}
/** Short commit guard; recovery marker prevents an ABA race with explicit offline recovery. */
export function mutex(directory,fn){
 fs.mkdirSync(path.dirname(directory),{recursive:true,mode:0o700});
 const recovery=directory+'.recovery',owner={...selfIdentity(),token:crypto.randomUUID(),phase:'commit',at:new Date().toISOString()};
 if(fs.existsSync(recovery))fail('RECOVERY_IN_PROGRESS');
 try{fs.mkdirSync(directory,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('STORE_BUSY');throw e;}
 try{
  fs.writeFileSync(path.join(directory,'owner.json'),JSON.stringify(owner),{mode:0o600});
  if(fs.existsSync(recovery))fail('RECOVERY_IN_PROGRESS');
  return fn();
 }finally{
  // Recovery never removes a live owner; nevertheless do not delete a replacement guard.
  try{const current=JSON.parse(fs.readFileSync(path.join(directory,'owner.json'),'utf8'));if(current.token===owner.token)fs.rmSync(directory,{recursive:true,force:true});}catch{}
 }
}
export function atomic(file,value,{write=fs.writeFileSync,rename=fs.renameSync}={}){
 const tmp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(tmp,'wx',0o600);write(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;rename(tmp,file);}
 finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(tmp);}catch{}}
}
export const emptyState=()=>({schema:1,configVersion:0,schedules:{},runs:{},requests:{},native:null,pending:null});
export function validateState(s){
 if(!s||s.schema!==1||!Number.isSafeInteger(s.configVersion)||s.configVersion<0||!s.schedules||!s.runs||!s.requests||Array.isArray(s.schedules)||Array.isArray(s.runs)||Array.isArray(s.requests)||Object.values(s.schedules).some(x=>!x||typeof x.id!=='string'))fail('STORE_CORRUPT',503);
 for(const value of Object.values(s.schedules)){validateRule(value.rule);if(!Number.isSafeInteger(value.version)||!Number.isFinite(value.firstRunAt)||typeof value.enabled!=='boolean')fail('STORE_CORRUPT',503);}
 return s;
}
export function openStore(home,{persist=atomic}={}){
 const dir=path.join(home,'extra-reports'),file=path.join(dir,'state.json');
 return {file,home,read(){try{return validateState(JSON.parse(fs.readFileSync(file,'utf8')));}catch(e){if(e.code==='ENOENT')return emptyState();if(e.code==='STORE_CORRUPT')throw e;fail('STORE_CORRUPT',503);}},
 transaction(fn){return mutex(path.join(dir,'mutation.guard'),()=>{let state=this.read();const save=()=>persist(file,state);return fn(state,save);});}};
}
