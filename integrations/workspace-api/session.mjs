import http from 'node:http';import crypto from 'node:crypto';
import {fail} from '../report-scheduler/core.mjs';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function body(req){
 if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('JSON_REQUIRED',415);
 if(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)>32768)fail('BODY_TOO_LARGE',413);
 let raw='';for await(const c of req){raw+=c.toString('utf8');if(Buffer.byteLength(raw)>32768)fail('BODY_TOO_LARGE',413);}
 try{const b=JSON.parse(raw);if(!b||typeof b!=='object'||Array.isArray(b))throw Error();return b;}catch{fail('INVALID_JSON',400);}
}
export function createSessionBackend({controlUrl,controlToken,pairingCode,pairingExpiresAt,uiOrigin,port=0,clock=Date.now,fetcher=fetch}){
 const origin=new URL(uiOrigin),control=new URL(controlUrl);
 if(origin.hostname!=='127.0.0.1'||origin.protocol!=='http:'||origin.origin!==uiOrigin||control.hostname!=='127.0.0.1'||control.protocol!=='http:'||control.pathname!=='/'||control.search||control.hash||control.username||control.password||!/^[a-f0-9]{64}$/.test(controlToken)||!/^[a-f0-9]{64}$/.test(pairingCode))fail('LOCAL_SETUP_REQUIRED',503);
 let remaining=5,consumed=false;const sessions=new Map();
 const server=http.createServer(async(req,res)=>{
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'};
  if(req.headers.origin===uiOrigin)Object.assign(headers,{'Access-Control-Allow-Origin':uiOrigin,'Access-Control-Allow-Credentials':'true'});
  const send=(code,value,extra={})=>{if(res.destroyed||res.writableEnded)return;res.writeHead(code,{...headers,...extra});res.end(JSON.stringify(value));};
  try{
   if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!=='127.0.0.1:'+server.address().port)fail('LOCAL_ONLY',403);
   if(req.headers.origin!==undefined&&req.headers.origin!==uiOrigin||['cross-site','none'].includes(req.headers['sec-fetch-site']))fail('CSRF_BLOCKED',403);
   if(req.method==='OPTIONS'){
    if(req.headers.origin!==uiOrigin||!['GET','POST','PATCH','DELETE'].includes(req.headers['access-control-request-method'])||(req.headers['access-control-request-headers']||'').split(',').some(x=>x.trim()&&!['content-type','x-csrf-token','idempotency-key'].includes(x.trim().toLowerCase())))fail('CSRF_BLOCKED',403);
    return send(204,null,{'Access-Control-Allow-Methods':'GET, POST, PATCH, DELETE','Access-Control-Allow-Headers':'Content-Type, X-CSRF-Token, Idempotency-Key'});
   }
   if(!req.url.startsWith('/api/')||req.url.includes('\\'))fail('NOT_FOUND',404);
   const url=new URL(req.url,'http://127.0.0.1');if(url.pathname==='/api/session'){
    if(url.search)fail('INVALID_REQUEST',400);
    if(req.method==='POST'){
     if(req.headers.origin!==uiOrigin)fail('CSRF_BLOCKED',403);
     if(consumed||remaining<=0||clock()>=pairingExpiresAt)fail('PAIRING_EXPIRED',403);
     const b=await body(req);remaining--;
     if(Object.keys(b).length!==1||!equal(b.code,pairingCode))fail('AUTH_REQUIRED',401);
     consumed=true;sessions.clear();const id=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(32).toString('hex');
     sessions.set(id,{csrf,expires:clock()+8*3600000,last:clock()});
     return send(200,{data:{authenticated:true,csrfToken:csrf,expiresAt:new Date(clock()+8*3600000).toISOString()}},{'Set-Cookie':'aiboot_session='+id+'; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800'});
    }
   }
   const cookies=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('aiboot_session='));
   const id=cookies.length===1?cookies[0].slice(15):'',s=sessions.get(id);
   if(!s||clock()>=s.expires||clock()-s.last>=30*60000){sessions.delete(id);fail('AUTH_REQUIRED',401);}
   s.last=clock();
   if(url.pathname==='/api/session'&&req.method==='GET')return send(200,{data:{authenticated:true,csrfToken:s.csrf,expiresAt:new Date(s.expires).toISOString()}});
   if(!equal(req.headers['x-csrf-token'],s.csrf))fail('CSRF_BLOCKED',403);
   if(req.headers.authorization!==undefined)fail('INVALID_REQUEST',400);
   if(url.pathname==='/api/session'&&req.method==='DELETE'){sessions.delete(id);return send(200,{data:{authenticated:false}},{'Set-Cookie':'aiboot_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0'});}
   const read=['/api/health','/api/reports','/api/tasks','/api/connections'].includes(url.pathname);
   const schedules=/^\/api\/report-schedules(?:\/(?:validate|[a-f0-9-]+(?:\/(?:pause|resume))?))?$/.test(url.pathname);
   const verify=url.pathname==='/api/connections/verify';
   const chat=/^\/api\/chat\/messages(?:\/[a-f0-9-]+(?:\/cancel)?)?$/.test(url.pathname);
   const actions=['/api/actions/prepare','/api/actions/confirm','/api/actions/rollback','/api/actions/batch-prepare','/api/actions/batch-confirm'].includes(url.pathname);
   const spaces=/^\/api\/spaces(?:\/[a-zA-Z0-9_-]+(?:\/verify)?)?$/.test(url.pathname);
   const todos=/^\/api\/todos(?:\/[a-zA-Z0-9_-]+)?$/.test(url.pathname);
   const audit=url.pathname==='/api/audit';
   const drive=/^\/api\/drive\/(?:search|resolve)$/.test(url.pathname);
   if(!read&&!schedules&&!verify&&!chat&&!actions&&!spaces&&!todos&&!audit&&!drive)fail('NOT_FOUND',404);
   if(verify&&req.method!=='POST'||read&&req.method!=='GET'||audit&&req.method!=='GET'||drive&&req.method!=='GET'||!['GET','POST','PATCH','DELETE'].includes(req.method))fail('METHOD_NOT_ALLOWED',405);
   if(actions&&req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
   if(spaces){
    const isVerify=/^\/api\/spaces\/[a-zA-Z0-9_-]+\/verify$/.test(url.pathname);
    if(isVerify&&req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
   }
   if(chat){
    const isCancel=/^\/api\/chat\/messages\/[a-f0-9-]+\/cancel$/.test(url.pathname);
    const isSubmit=url.pathname==='/api/chat/messages';
    const isGet=/^\/api\/chat\/messages\/[a-f0-9-]+$/.test(url.pathname);
    if((isSubmit||isCancel)&&req.method!=='POST'||isGet&&req.method!=='GET')fail('METHOD_NOT_ALLOWED',405);
   }
   if(req.method!=='GET'&&req.headers.origin!==uiOrigin)fail('CSRF_BLOCKED',403);
   const hasBody=!['GET','HEAD'].includes(req.method)&&(req.headers['transfer-encoding']||Number(req.headers['content-length']||0)>0);
   const b=hasBody?JSON.stringify(await body(req)):undefined,abort=new AbortController(),timer=setTimeout(()=>abort.abort(),17000);
   const cancel=()=>{if(!res.writableEnded)abort.abort();};res.on('close',cancel);
   try{
    const r=await fetcher(control.origin+url.pathname+url.search,{method:req.method,redirect:'error',signal:abort.signal,headers:{Authorization:'Bearer '+controlToken,...(b?{'Content-Type':'application/json'}:{}),...(req.headers['idempotency-key']?{'Idempotency-Key':req.headers['idempotency-key']}:{})},body:b});
    const value=await r.json();send(r.status,value);
   }catch{fail(abort.signal.aborted?'TIMEOUT':'CONTROL_OFFLINE',abort.signal.aborted?504:503);}
   finally{clearTimeout(timer);res.removeListener('close',cancel);}
  }catch(e){send(e.status||503,{error:{code:e.code||'INTERNAL_ERROR'}});}
 });
 server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
 return {server,listen:()=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server.address()));}),close:()=>new Promise(resolve=>{sessions.clear();server.close(resolve);server.closeAllConnections();})};
}
