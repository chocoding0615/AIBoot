import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createOfficialReader,CONTRACT_RANGES} from '../official-sources.mjs';
import {parseContractDb,parseContracts,parseLicenses,parseVehicles,parseWelfare} from '../../../tools/fixed-expense-flow/domains.mjs';
import {readSources,fixedRules} from '../../chat-assistant/sources.mjs';
import {readRecurringSource} from '../../local-dual-report/recurring.mjs';
const config={spreadsheetId:'fixed',contractsSpreadsheetId:'contracts',opsSpreadsheetId:'welfare',recurringSpreadsheetId:'recurring',
 sourceSheetIds:{fixed:0,daily:1,contracts:2,licenses:3,welfare:4,recurring:5,history:6,master:7}};
const specs={
 fixed:{title:'[MS] AD_관리비 내역',tabs:[['JP매월 지출',0],['AIBoot_데일리마감',1]]},
 contracts:{title:'[MS] AD_계약서 관리',tabs:[['계약서(DB)',2],['프로그램(2026)',3]]},
 welfare:{title:'[MS] AD_운영 관리',tabs:[['복지포인트 관리(2026)',4]]},
 recurring:{title:'[MS] 김현호',tabs:[['업무',5],['반복업무_처리이력',6],['Master_Sheet',7]]}
};
const sample=[
 {B:true,D:'표시업체',E:'계약서비스',I:'2026-11-20',N:false,O:false},
 {B:false,D:'비노출업체',E:'별도서비스',I:'2026-12-01',N:true,O:false},
 {B:false,D:'종료업체',E:'종료서비스',I:'2026-11-20',N:false,O:true}
];
const columns=rows=>['D','E','I','N','O'].map(c=>rows.map(r=>[r[c]]));
function fixture({hidden=[],titleChange=null,gidChange=null,metadataFailure=false}={}) {
 const calls=[];
 const api={
  get:async args=>{
   calls.push({method:'get',...args});
   if(!args.ranges){
    if(metadataFailure)throw Error('private upstream details');
    const spec=specs[args.spreadsheetId];
    return {data:{properties:{title:titleChange||spec.title},sheets:spec.tabs.map(([title,sheetId])=>({properties:{title,sheetId:gidChange??sheetId,hidden:hidden.includes(title)}}))}};
   }
   if(args.ranges[0].includes('JP매월'))return {data:{sheets:[{properties:{title:'JP매월 지출'},data:[{rowData:[]}]}]}};
   return {data:{sheets:[{data:[{rowData:[],rowMetadata:[]}]}]}};
  },
  values:{
   get:async args=>{calls.push({method:'values.get',...args});return {data:{values:args.range.includes('반복업무_처리이력')?[['업무ID','회차키','상태','처리시각','비고','회차기준일']]:[]}};},
   batchGet:async args=>{
    calls.push({method:'batchGet',...args});
    const data=args.ranges.map(r=>{const i=CONTRACT_RANGES.indexOf(r);return i>=0?columns(sample)[i]:[];});
    return {data:{valueRanges:data.map(values=>({values}))}};
   }
  }
 };
 return {api,calls,reader:createOfficialReader(api,config)};
}
const ranges=CONTRACT_RANGES;
test('official contract DB reads D/E/I/N/O only, both B exposures included, O termination and N renewal retained',()=>{
 const parsed=parseContractDb(columns(sample));
 assert.deepEqual(parsed.rows.map(r=>r.name),['표시업체','비노출업체']);
 assert.deepEqual(parsed.rows.map(r=>r.autoRenew),[false,true]);
 assert.deepEqual(parsed.rows.map(r=>r.row),[5,6]);
 assert.equal(parsed.ended,1);
 assert.ok(ranges.every(r=>!r.includes('B5:')));
});
test('old/new projections preserve ended and expiry facts without search-screen row limit',()=>{
 const old=sample.map(r=>{const a=[];a[2]=r.D;a[3]=r.E;a[7]=r.I;a[12]=String(r.N).toUpperCase();a[13]=String(r.O).toUpperCase();return a;});
 const strip=p=>({ended:p.ended,rows:p.rows.map(({row,...r})=>r)});
 assert.deepEqual(strip(parseContractDb(columns(sample))),strip(parseContracts(old)));
 const many=Array.from({length:350},(_,i)=>({...sample[0],D:'업체'+i}));
 assert.equal(parseContractDb(columns(many)).rows.at(-1).row,354);
 assert.throws(()=>parseContractDb([[]]),/확인 필요/);
});
test('same file metadata reused for contracts/licenses/vehicle reads, no values cache across passes',async()=>{
 const f=fixture();
 await f.reader.values.batchGet({spreadsheetId:'contracts',ranges});
 await f.reader.values.batchGet({spreadsheetId:'contracts',ranges:["'프로그램(2026)'!A5:D60"]});
 await f.reader.values.batchGet({spreadsheetId:'contracts',ranges:["'계약서(DB)'!Q5:Q300"]});
 assert.equal(f.calls.filter(x=>x.method==='get'&&!x.ranges).length,1);
 assert.equal(f.calls.filter(x=>x.method==='batchGet').length,3);
 await createOfficialReader(f.api,config).values.batchGet({spreadsheetId:'contracts',ranges});
 assert.equal(f.calls.filter(x=>x.method==='get'&&!x.ranges).length,2);
});
for(const [label,options,code]of [
 ['wrong file',{titleChange:'같은 탭을 가진 다른 파일'},'SOURCE_FILE_MISMATCH'],
 ['hidden direct tab',{hidden:['계약서(DB)']},'SOURCE_TAB_HIDDEN'],
 ['replacement gid',{gidChange:999},'SOURCE_GID_MISMATCH'],
 ['metadata failed',{metadataFailure:true},'SOURCE_METADATA_FAILED']
])test(label+' fails before any cell read',async()=>{
 const f=fixture(options);await assert.rejects(f.reader.values.batchGet({spreadsheetId:'contracts',ranges}),{code});
 assert.equal(f.calls.filter(x=>x.method!=='get'||x.ranges).length,0);
});
test('unapproved/missing gid, unrelated file, search tab, combined DB and extra fields are blocked',async()=>{
 const f=fixture(),r=createOfficialReader(f.api,{...config,sourceSheetIds:{}});
 await assert.rejects(r.values.batchGet({spreadsheetId:'contracts',ranges}),{code:'SOURCE_GID_UNCONFIRMED'});
 await assert.rejects(f.reader.values.get({spreadsheetId:'other',range:"'JP매월 지출'!D14:D36"}),{code:'SOURCE_NOT_ALLOWED'});
 for(const range of ["'계약서 검색'!A6:N200","'계약서(DB)'!B5:O","'고정비 통합'!A1:Z99","'개별 업무 DB'!A1:Z99"])
  await assert.rejects(f.reader.values.get({spreadsheetId:range.includes('계약')?'contracts':'fixed',range}),{code:'SOURCE_RANGE_NOT_ALLOWED'});
 assert.equal(f.calls.filter(x=>x.method==='batchGet'||x.method==='values.get').length,0);
});
test('next-year welfare requires explicit approval; no year-based fallback',async()=>{
 const f=fixture();
 await assert.rejects(f.reader.values.get({spreadsheetId:'welfare',range:"'복지포인트 관리(2027)'!A8:A"}),{code:'SOURCE_RANGE_NOT_ALLOWED'});
 const rules=fixedRules(new URL('../../../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
 assert.equal(rules.welfareTab('2027-01-01'),'');
});
test('hidden auxiliary history and Master never read; recurring rules remain located by configured file ID',async()=>{
 const f=fixture({hidden:['반복업무_처리이력','Master_Sheet']});
 const source=await readRecurringSource(f.reader,'recurring');
 assert.equal(source.historyState,'조회 실패');assert.equal(source.registered,null);
 assert.equal(f.calls.filter(x=>x.method==='values.get').length,0);
 assert.equal(f.calls.filter(x=>x.ranges?.[0]==="'업무'!A2:E200").length,1);
});
test('hidden daily confirmation blocked independently of unchanged JP ranges',async()=>{
 const f=fixture({hidden:['AIBoot_데일리마감']});
 await f.reader.get({spreadsheetId:'fixed',ranges:["'JP매월 지출'!B1:V37"]});
 await assert.rejects(f.reader.values.get({spreadsheetId:'fixed',range:"'AIBoot_데일리마감'!A1:I300"}),{code:'SOURCE_TAB_HIDDEN'});
 assert.equal(f.calls.filter(x=>x.method==='values.get').length,0);
});
test('read failure is not empty success and upstream details are not propagated',async()=>{
 const f=fixture();f.api.values.batchGet=async()=>{throw Error('private upstream identifier');};
 await assert.rejects(f.reader.values.batchGet({spreadsheetId:'contracts',ranges}),e=>e.code==='SOURCE_READ_FAILED'&&!e.message.includes('private'));
 const bad=fixture({hidden:['계약서(DB)']});
 const result=await readSources(['contracts'],{report:config,sheets:()=>bad.api,rules:{},now:new Date('2026-11-18T03:00:00Z')});
 assert.equal(result.facts.length,0);assert.match(result.sources.contracts,/확인 필요.*SOURCE_TAB_HIDDEN/);
});
const runnerText=fs.readFileSync(new URL('../../local-dual-report/runner.mjs',import.meta.url),'utf8');
const viewerText=fs.readFileSync(new URL('../../../tools/fixed-expense-flow/build-evidence.mjs',import.meta.url),'utf8');
const extract=(src,name,ctx)=>vm.runInNewContext('('+src.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'))[0]+')',ctx);
test('actual report snapshot, assistant and viewer share DB mapping and end/date/renewal facts',async()=>{
 const f=fixture(),c={...config,opsSpreadsheetId:null,recurringSpreadsheetId:null};
 const now='2026-11-18',day=(a,b)=>(Date.parse(b)-Date.parse(a))/86400000;
 const bucket=d=>d>=0&&d<=7?'D-7':d<=30&&d>7?'D-30':d<=60&&d>30?'D-60':null;
 const snap=extract(runnerText,'snapshot',{sheetsClient:()=>({spreadsheets:f.api}),createOfficialReader,CONTRACT_RANGES,parseContractDb,stripPersonal:x=>x,daysBetween:day,bucketOf:bucket,today:()=>now,chatSnapshot:async()=>({status:'미연결'}),log:()=>{}});
 const report=await snap(c);
 assert.deepEqual(Array.from(report.contracts,r=>r.name),['표시업체','비노출업체']);
 assert.equal(report.contracts[1].autoRenew,true);
 const assistant=await readSources(['contracts'],{report:c,sheets:()=>fixture().api,rules:{daysBetween:day,bucketOf:bucket},now:new Date(now+'T03:00:00Z')});
 assert.deepEqual(assistant.facts.filter(x=>x.source==='contracts').map(x=>x.subject),Array.from(report.contracts,r=>r.name));
 const v=fixture(),read=extract(viewerText,'readDomains',{NO_SHEET:false,conf:c,CONTRACT_RANGES,sheetsApi:()=>v.reader,parseContractDb,parseLicenses,parseVehicles,parseWelfare,welfareTab:()=>'',readRecurring:async()=>({error:'not configured'}),errorCode:()=> 'SOURCE_READ_FAILED'});
 const viewer=await read(now);
 assert.deepEqual(viewer.contracts.rows.map(x=>x.name),Array.from(report.contracts,r=>r.name));
 assert.equal(viewer.contracts.ended,1);
 assert.ok(!f.calls.some(x=>(x.ranges||[]).some(r=>r.includes('계약서 검색'))));
});
test('no source formula writes and operating policy inputs/scheduling/dispatch entrypoints remain separate',()=>{
 const guard=fs.readFileSync(new URL('../official-sources.mjs',import.meta.url),'utf8');
 assert.ok(!/\.(?:batchUpdate|append|update|clear)\(/.test(guard));
 assert.ok(runnerText.includes("const RULE_FILES = ['CURRENT.md', 'docs/FIXED-EXPENSES-V1.md']"));
 assert.ok(runnerText.includes('async function main()'));
 assert.ok(!viewerText.includes('"\'계약서 검색\'!A6:N200"'));
});

test('full allowed source pass performs four metadata reads once each, fourteen total read API calls',async()=>{
 const f=fixture();
 const root=new URL('../../../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
 let chatCalls=0;
 const result=await readSources(['fixed','contracts','licenses','welfare','recurring','chat'],{
  report:{...config,chatSpaces:['spaces/a','spaces/b']},sheets:()=>f.api,
  chat:{spaces:{messages:{list:async()=>{chatCalls++;return {data:{messages:[]}};}}}},
  rules:fixedRules(root),home:'/synthetic',now:new Date('2026-11-18T03:00:00Z'),fetcher:async()=>{throw Error('offline fixture');}
 });
 assert.equal(Object.values(result.sources).filter(v=>v==='연결').length,6);
 assert.equal(f.calls.filter(x=>x.method==='get'&&!x.ranges).length,4);
 assert.equal(f.calls.length+chatCalls,14);
 assert.equal(chatCalls,2);
});
test('malformed batch response is a failure, never an empty successful dataset',async()=>{
 const f=fixture();f.api.values.batchGet=async()=>({data:{valueRanges:[]}});
 await assert.rejects(f.reader.values.batchGet({spreadsheetId:'contracts',ranges}),{code:'SOURCE_RESPONSE_INVALID'});
});

test('synthetic old search exposure versus DB: only previously filtered B=false row is newly included',()=>{
 const oldSearch=sample.filter(r=>r.B).map(r=>{const row=[];row[2]=r.D;row[3]=r.E;row[7]=r.I;row[12]=String(r.N).toUpperCase();row[13]=String(r.O).toUpperCase();return row;});
 assert.deepEqual(parseContracts(oldSearch).rows.map(r=>r.name),['표시업체']);
 assert.deepEqual(parseContractDb(columns(sample)).rows.map(r=>r.name),['표시업체','비노출업체']);
});
test('missing official tab and malformed metadata do not trigger fallback or value reads',async()=>{
 const f=fixture();f.api.get=async()=>({data:{properties:{title:'[MS] AD_계약서 관리'},sheets:[]}});
 await assert.rejects(f.reader.values.batchGet({spreadsheetId:'contracts',ranges}),{code:'SOURCE_TAB_MISMATCH'});
 assert.equal(f.calls.length,0);
});
