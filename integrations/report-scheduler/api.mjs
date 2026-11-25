import {body as readJsonBody} from '../workspace-api/session.mjs';
import http from 'node:http';import crypto from 'node:crypto';import {fail} from './core.mjs';import {validId} from './service.mjs';
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function createApi({service,reader,verifier,chatService,actionService,spaceService,todoService,auditService,driveService,token,port=0}){
 if(!/^[a-f0-9]{64}$/.test(token||''))fail('AUTH_NOT_CONFIGURED',503);
 const server=http.createServer(async(req,res)=>{
  const requestedAt=new Date();
  const send=(status,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  try{
   if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!=='127.0.0.1:'+server.address().port)fail('LOCAL_ONLY',403);
   // Server-to-server bearer only. No browser origin, CORS, ambient cookies or query token bootstrap.
   if(req.headers.origin!==undefined||req.headers['sec-fetch-site']!==undefined)fail('CSRF_BLOCKED',403);
   if(!equal(req.headers.authorization,'Bearer '+token))fail('AUTH_REQUIRED',401);
   const url=new URL(req.url,'http://127.0.0.1');
   if(reader&&['/api/health','/api/reports','/api/tasks','/api/connections'].includes(url.pathname)){
    if(req.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
    const abort=new AbortController(),cancel=()=>{if(!res.writableEnded)abort.abort();};res.on('close',cancel);
    try{return send(200,await reader.handle(url,{signal:abort.signal}));}finally{res.removeListener('close',cancel);}
   }
   if(url.pathname==='/api/connections/verify'){
    if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);if(url.search)fail('INVALID_REQUEST',400);
    if(!verifier)fail('VERIFICATION_DISABLED',503);
    const abort=new AbortController(),cancel=()=>{if(!res.writableEnded)abort.abort();};res.on('close',cancel);
    try{return send(200,await verifier.verify(await readJsonBody(req),{signal:abort.signal}));}finally{res.removeListener('close',cancel);}
   }
   if(url.pathname.startsWith('/api/chat/messages')){
    if(url.search)fail('INVALID_REQUEST',400);
    if(!chatService)fail('NOT_CONFIGURED',503);
    if(url.pathname==='/api/chat/messages'){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     const b=await readJsonBody(req);
     return send(202,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:chatService.submit(b)});
    }
    const cancelMatch=/^\/api\/chat\/messages\/([a-f0-9-]+)\/cancel$/.exec(url.pathname);
    if(cancelMatch){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:chatService.cancel(cancelMatch[1])});
    }
    const getMatch=/^\/api\/chat\/messages\/([a-f0-9-]+)$/.exec(url.pathname);
    if(getMatch){
     if(req.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
     const d=chatService.get(getMatch[1]);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:d.status==='failed'?'error':'ok',data:d});
    }
    fail('NOT_FOUND',404);
   }
   if(url.pathname.startsWith('/api/actions/')){
    if(url.search)fail('INVALID_REQUEST',400);
    if(!actionService)fail('NOT_CONFIGURED',503);
    if(url.pathname==='/api/actions/prepare'){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     const b=await readJsonBody(req);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:actionService.prepare(b)});
    }
    if(url.pathname==='/api/actions/confirm'){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     const b=await readJsonBody(req);
     const key=req.headers['idempotency-key'];
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:await actionService.confirm(b,key)});
    }
    if(url.pathname==='/api/actions/rollback'){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     const b=await readJsonBody(req);
     const key=req.headers['idempotency-key'];
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:await actionService.rollback(b,key)});
    }
    if(url.pathname==='/api/actions/batch-prepare'){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     const b=await readJsonBody(req);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:actionService.batchPrepare(b)});
    }
    if(url.pathname==='/api/actions/batch-confirm'){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     const b=await readJsonBody(req);
     const key=req.headers['idempotency-key'];
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:await actionService.batchConfirm(b,key)});
    }
    fail('NOT_FOUND',404);
   }
   if(url.pathname==='/api/audit'){
    if(!auditService)fail('NOT_CONFIGURED',503);
    if(req.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
    const limit=url.searchParams.get('limit')||50;
    const action=url.searchParams.get('action')||null;
    return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:auditService.list({limit,action}).data});
   }
   if(url.pathname==='/api/drive/search'){
    if(!driveService)fail('NOT_CONFIGURED',503);
    if(req.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
    const q=url.searchParams.get('q')||'';
    const limit=Number(url.searchParams.get('limit')||20);
    const type=url.searchParams.get('type')||null;
    return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:await driveService.search({q,limit,type})});
   }
   if(url.pathname==='/api/drive/resolve'){
    if(!driveService)fail('NOT_CONFIGURED',503);
    if(req.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
    const ref=url.searchParams.get('ref')||url.searchParams.get('name')||'';
    return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:await driveService.resolve(ref)});
   }
   if(url.pathname.startsWith('/api/spaces')){
    if(url.search)fail('INVALID_REQUEST',400);
    if(!spaceService)fail('NOT_CONFIGURED',503);
    if(url.pathname==='/api/spaces'){
     if(req.method==='GET')return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:spaceService.list()});
     if(req.method==='POST'){
      const b=await readJsonBody(req);
      return send(201,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:spaceService.add(b)});
     }
     fail('METHOD_NOT_ALLOWED',405);
    }
    const m=/^\/api\/spaces\/([a-zA-Z0-9_-]+)(?:\/(verify))?$/.exec(url.pathname);
    if(!m)fail('NOT_FOUND',404);
    const id=m[1],isVerify=Boolean(m[2]);
    if(isVerify){
     if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:await spaceService.verify(id)});
    }
    if(req.method==='PATCH'){
     const b=await readJsonBody(req);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:spaceService.update(id,b)});
    }
    if(req.method==='DELETE'){
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:spaceService.remove(id)});
    }
    if(req.method==='GET'){
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:spaceService.get(id)});
    }
    fail('METHOD_NOT_ALLOWED',405);
   }
   if(url.pathname.startsWith('/api/todos')){
    if(url.search)fail('INVALID_REQUEST',400);
    if(!todoService)fail('NOT_CONFIGURED',503);
    if(url.pathname==='/api/todos'){
     if(req.method==='GET')return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:todoService.list()});
     if(req.method==='POST'){
      const b=await readJsonBody(req);
      return send(201,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:todoService.add(b)});
     }
     fail('METHOD_NOT_ALLOWED',405);
    }
    const m=/^\/api\/todos\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if(!m)fail('NOT_FOUND',404);
    const id=m[1];
    if(req.method==='PATCH'){
     const b=await readJsonBody(req);
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:todoService.toggle(id,b.completed)});
    }
    if(req.method==='DELETE'){
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:todoService.remove(id)});
    }
    if(req.method==='GET'){
     return send(200,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'ok',data:todoService.get(id)});
    }
    fail('METHOD_NOT_ALLOWED',405);
   }
   if(url.search)fail('INVALID_REQUEST',400);
   const prefix='/api/report-schedules',suffix=url.pathname.slice(prefix.length);
   if(!url.pathname.startsWith(prefix))fail('NOT_FOUND',404);
   if(req.method==='GET'){
    if(suffix==='')return send(200,{data:service.list()});
    const id=suffix.slice(1);if(!validId(id))fail('NOT_FOUND',404);return send(200,{data:service.detail(id)});
   }
   if(!['POST','PATCH','DELETE'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
   if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('JSON_REQUIRED',415);
   if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)>32768)fail('BODY_TOO_LARGE',413);
   let raw='';for await(const chunk of req){raw+=chunk.toString('utf8');if(Buffer.byteLength(raw)>32768)fail('BODY_TOO_LARGE',413);}
   let body;try{body=JSON.parse(raw);}catch{fail('INVALID_JSON',400);}
   if(!body||Object.keys(body).some(k=>!['rule','id','operation','expectedVersion','confirmed'].includes(k)))fail('INVALID_REQUEST',400);
   let operation,input;
   if(suffix==='/validate'&&req.method==='POST'){
    operation=body.operation;input={...(body.id?{id:body.id}:{}),...(body.rule?{rule:body.rule}:{})};
    if(!['create','update','pause','resume','delete'].includes(operation))fail('INVALID_OPERATION',400);
    return send(200,{data:service.prepare(operation,input,body.expectedVersion)});
   }
   if(body.id!==undefined||body.operation!==undefined)fail('INVALID_REQUEST',400);
   if(suffix===''&&req.method==='POST'){operation='create';input={rule:body.rule};}
   else{
    const m=/^\/([a-f0-9-]+)(?:\/(pause|resume))?$/.exec(suffix);if(!m||!validId(m[1]))fail('NOT_FOUND',404);
    operation=m[2]&&req.method==='POST'?m[2]:req.method==='PATCH'&&!m[2]?'update':req.method==='DELETE'&&!m[2]?'delete':null;
    if(!operation)fail('METHOD_NOT_ALLOWED',405);
    input={id:m[1],...(operation==='update'?{rule:body.rule}:{})};
   }
   if(!['create','update'].includes(operation)&&body.rule!==undefined)fail('INVALID_REQUEST',400);
   send(operation==='create'?201:200,{data:service.mutate(operation,input,{expectedVersion:body.expectedVersion,confirmed:body.confirmed,idempotencyKey:req.headers['idempotency-key']})});
  }catch(e){if(req.url.split('?')[0]==='/api/connections/verify'||req.url.split('?')[0].startsWith('/api/chat/messages')||req.url.split('?')[0].startsWith('/api/actions/')||req.url.split('?')[0].startsWith('/api/spaces')||req.url.split('?')[0].startsWith('/api/todos')||req.url.split('?')[0]==='/api/audit'||req.url.split('?')[0].startsWith('/api/drive/'))return send(e.status||503,{requestId:crypto.randomUUID(),apiVersion:'v1',status:'error',error:{code:e.code||'INTERNAL_ERROR',message:e.message},meta:{requestedAt:requestedAt.toISOString(),completedAt:new Date().toISOString()}});const error={code:e.code||'INTERNAL_ERROR',...(e.details?{details:e.details}:{})};const read=reader&&['/api/health','/api/reports','/api/tasks','/api/connections'].includes(req.url.split('?')[0]);send(e.status||503,read?{requestId:crypto.randomUUID(),apiVersion:'v0',status:'error',error,meta:{requestedAt:requestedAt.toISOString(),completedAt:new Date().toISOString(),durationMs:Date.now()-requestedAt.getTime(),partial:false,sources:e.details?.sources||[]}}:{error});}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
 return {server,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address()));}),close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
