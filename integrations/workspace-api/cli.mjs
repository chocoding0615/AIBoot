#!/usr/bin/env node
import {ConnectionVerifier} from './accounts.mjs';
import {WorkspaceChatService} from './chat.mjs';
import {WorkspaceActionService} from './actions.mjs';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {WorkspaceReader} from './reader.mjs';import {createSessionBackend} from './session.mjs';import {verifyPrivate,initializeAccess} from './access.mjs';
import {createApi} from '../report-scheduler/api.mjs';import {ScheduleService} from '../report-scheduler/service.mjs';import {openStore} from '../report-scheduler/store.mjs';import {WindowsBackend} from '../report-scheduler/windows.mjs';import {fail} from '../report-scheduler/core.mjs';
const args=process.argv.slice(2),option=(name,def)=>args.includes(name)?args[args.indexOf(name)+1]:def,home=path.resolve(option('--home',path.join(os.homedir(),'.aiboot'))),dir=path.join(home,'workspace-api');
async function main(){
 if(args[0]==='init-access'){initializeAccess(dir);console.log(JSON.stringify({initialized:true,writesEnabled:false,dispatchEnabled:false}));return;}
 if(args[0]!=='serve')fail('COMMAND_REQUIRED',400);
 const file=path.join(dir,'access.json');if(!verifyPrivate(file))fail('ACCESS_ACL_UNVERIFIED',403);
 const access=JSON.parse(fs.readFileSync(file,'utf8'));
 // This bridge deliberately cannot enable dispatch or management writes in v0.
 if(access.version!==1||access.allowWrites!==false||access.allowDispatch!==false)fail('ACTIVATION_NOT_APPROVED',403);
 const controlPort=Number(option('--control-port',17841)),uiPort=Number(option('--ui-port',17842)),uiOrigin=option('--ui-origin','http://127.0.0.1:5173');
 if(![controlPort,uiPort].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||controlPort===uiPort)fail('INVALID_PORT',400);
 let buildVersion='unverified';try{buildVersion=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();}catch{}
 const reader=new WorkspaceReader({home,buildVersion}),service=new ScheduleService({store:openStore(home),windows:new WindowsBackend(),home,writesEnabled:false,dispatchEnabled:()=>false});
 const verifier=new ConnectionVerifier({reader,enabled:args.includes('--enable-account-verification')});
 const chatService=new WorkspaceChatService({reader,home});
 const actionService=new WorkspaceActionService({reader});
 const control=createApi({service,reader,verifier,chatService,actionService,token:access.token,port:controlPort});await control.listen();
 const code=crypto.randomBytes(32).toString('hex'),expires=Date.now()+10*60000,bootstrap=path.join(dir,'pairing.json');
 fs.writeFileSync(bootstrap,JSON.stringify({code,expiresAt:new Date(expires).toISOString()}),{mode:0o600});
 if(!verifyPrivate(bootstrap)){await control.close();fail('ACCESS_ACL_UNVERIFIED',403);}
 const browser=createSessionBackend({controlUrl:'http://127.0.0.1:'+controlPort,controlToken:access.token,pairingCode:code,pairingExpiresAt:expires,uiOrigin,port:uiPort});
 try{await browser.listen();}catch(e){await control.close();throw e;}
 console.log(JSON.stringify({controlHost:'127.0.0.1',controlPort,uiBackendPort:uiPort,uiOrigin,writesEnabled:false,dispatchEnabled:false,pairingFileCreated:true,accountVerificationEnabled:verifier.enabled}));
 const close=async()=>{await browser.close();await control.close();try{fs.unlinkSync(bootstrap);}catch{}};
 process.once('SIGINT',close);process.once('SIGTERM',close);
}
main().catch(e=>{console.error(JSON.stringify({error:e.code||'LOCAL_SETUP_REQUIRED'}));process.exitCode=1;});
