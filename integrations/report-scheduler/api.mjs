import http from 'node:http';import crypto from 'node:crypto';import {fail} from './core.mjs';import {validId} from './service.mjs';
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export function createApi({service,token,port=0}){
 if(!/^[a-f0-9]{64}$/.test(token||''))fail('AUTH_NOT_CONFIGURED',503);
 const server=http.createServer(async(req,res)=>{
  const send=(status,data)=>{if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
  try{
   if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!=='127.0.0.1:'+server.address().port)fail('LOCAL_ONLY',403);
   // Server-to-server bearer only. No browser origin, CORS, ambient cookies or query token bootstrap.
   if(req.headers.origin!==undefined||req.headers['sec-fetch-site']!==undefined)fail('CSRF_BLOCKED',403);
   if(!equal(req.headers.authorization,'Bearer '+token))fail('AUTH_REQUIRED',401);
   const url=new URL(req.url,'http://127.0.0.1');if(url.search)fail('INVALID_REQUEST',400);
   const prefix='/api/report-schedules',suffix=url.pathname.slice(prefix.length);
   if(!url.pathname.startsWith(prefix))fail('NOT_FOUND',404);
   if(req.method==='GET'){
    if(suffix==='')return send(200,{data:service.list()});
    const id=suffix.slice(1);if(!validId(id))fail('NOT_FOUND',404);return send(200,{data:service.detail(id)});
   }
   if(!['POST','PATCH','DELETE'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
   if(req.headers['content-type']!=='application/json')fail('JSON_REQUIRED',415);
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
  }catch(e){send(e.status||503,{error:{code:e.code||'INTERNAL_ERROR',...(e.details?{details:e.details}:{})}});}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
 return {server,listen:()=>new Promise(resolve=>server.listen(port,'127.0.0.1',()=>resolve(server.address()))),close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
