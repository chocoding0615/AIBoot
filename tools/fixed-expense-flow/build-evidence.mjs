#!/usr/bin/env node
/**
 * Builds evidence.local.js for the fixed-expense status board — READ-ONLY.
 *
 * Reads (never writes): runner.mjs and FIXED-EXPENSES-V1.md of --repo, %USERPROFILE%/.aiboot/{logs,ledger.json,
 * reports,holidays.json}, the vendor-name column ('JP매월 지출'!D14:D36) and the ranges the runner itself reads for
 * contracts, licenses, welfare, tasks and vehicle insurance. Only the fields in domains.mjs parsers go further.
 * From config.json it uses spreadsheetId, contractsSpreadsheetId, opsSpreadsheetId, googleAuthDir and the number of
 * chatSpaces. No amounts, webhook, Chat API call or message text. Report text stays in memory and is never written out.
 * Writes only ./evidence.local.js (git-ignored, this PC only).
 *
 * Usage: node build-evidence.mjs [--repo <AIBoot 폴더>] [--no-sheet]   (default: AIBOOT_REPO env, else this repo)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fieldPart, fixedPart, judgeFixed, parseDocRows, vendorsIn } from './judge.mjs';
import { judgeChat, judgeContracts, judgeLicenses, judgeRecurring, judgeWelfare, parseContracts, parseLicenses, parseTasks, parseVehicles, parseWelfare, unconnectedIn } from './domains.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argRepo = process.argv.indexOf('--repo');
const REPO = path.resolve(argRepo > 0 ? process.argv[argRepo + 1] : process.env.AIBOOT_REPO || path.join(HERE, '..', '..'));
const RUNNER = path.join(REPO, 'integrations/local-dual-report/runner.mjs');
const DOC = path.join(REPO, 'docs/FIXED-EXPENSES-V1.md');
const HOME = path.join(os.homedir(), '.aiboot');
const IMMINENT_FALLBACK = 7;
const FIELD_TAGS = ['[계약서]', '[라이센스]', '[복지]', '[정기 업무]', '[기타 업무]'];
// The runner's own read ranges. Each is confirmed against runner.mjs below, so a change there shows up as a warning.
const RUNNER_RANGES = ["'계약서 검색'!A6:N200", "'프로그램(2026)'!A5:D60", "'업무'!A1:D150", "'계약서(DB)'!C5:C300", "'계약서(DB)'!E5:E300", "'계약서(DB)'!I5:I300", "'계약서(DB)'!Q5:Q300"];

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const kstDate = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(d);

const src = read(RUNNER);
if (!src) { console.error(`runner.mjs를 찾을 수 없음: ${RUNNER}\n--repo 로 AIBoot 폴더를 지정하세요.`); process.exit(1); }

/* ---------- repo: which branch this evidence was judged against ---------- */
function repoInfo() {
  let gitDir = path.join(REPO, '.git');
  const g = read(gitDir);
  if (g && g.startsWith('gitdir:')) gitDir = path.resolve(REPO, g.slice(7).trim()); // worktree
  const head = (read(path.join(gitDir, 'HEAD')) || '').trim();
  return { path: REPO, branch: head.startsWith('ref:') ? head.replace('ref: refs/heads/', '') : '(detached) ' + head.slice(0, 7) };
}

/* ---------- code checks: what the runner really does (re-evaluated on every build) ---------- */
const m = (re, s = src) => (re.exec(s) || [])[1] || null;
const imminentDays = Number(m(/const IMMINENT_DAYS = (\d+)/)) || null;
const checks = [
  { label: 'JP매월 지출 읽기 범위', ok: !!m(/'JP매월 지출'!([A-Z]+\d+:[A-Z]+\d+)/) },
  { label: '시트 호출은 읽기(get/batchGet)만', ok: !/spreadsheets\.(batchUpdate|values\.(update|append|clear|batchUpdate))/.test(src) },
  { label: '`시트내용`(계정정보) 탭 범위 없음', ok: !/'시트내용'!/.test(src) },
  { label: '일정 계산에서 이지화물 제외', ok: /\/이지화물\/\.test\(vendor\)/.test(src) },
  { label: '보고 본문에 이지화물이 있으면 발송 차단', ok: /\/이지화물\/\.test\(chat\)/.test(src) },
  { label: '임박 창(일)', ok: !!imminentDays },
  ...RUNNER_RANGES.map(r => ({ label: `읽기 범위 ${r}`, ok: src.includes(r) }))
];
const runnerValue = re => { try { return new Function('return ' + m(re))(); } catch { return null; } };
const buckets = runnerValue(/const D_BUCKETS = (\[.*\]);/);
const welfareTab = runnerValue(/const welfareTab = (date => .*?); \/\/ one tab per year/);

/* ---------- logs: last sheet read and recent failures ---------- */
const logFiles = (fs.existsSync(path.join(HOME, 'logs')) ? fs.readdirSync(path.join(HOME, 'logs')) : []).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
const sheets = { lastOk: null, lastFail: null }, agentErrors = [];
for (const f of logFiles) {
  for (const line of (read(path.join(HOME, 'logs', f)) || '').split('\n')) {
    const t = line.slice(0, 24), msg = line.slice(25);
    let x;
    if (/^snapshot /.test(msg)) sheets.lastOk = t;
    else if (/^FATAL/.test(msg)) sheets.lastFail = t;
    else if ((x = /^FAILED (\S+):/.exec(msg))) agentErrors.push({ at: t, key: x[1] }); // the key only: error text may hold anything
  }
}

/* ---------- report: the latest regular slot that was actually sent ---------- */
const ledger = JSON.parse(read(path.join(HOME, 'ledger.json')) || '{}');
const docRows = parseDocRows(read(DOC) || '');
const vendors = docRows.map(d => d.vendor);
const sent = Object.entries(ledger).filter(([k, v]) => v.status === 'sent' && /^\d{4}-\d{2}-\d{2}\|(morning|afternoon)\|(codex|antigravity)$/.test(k)).map(([k]) => k.split('|'));
const order = ([d, s]) => d + (s === 'afternoon' ? '2' : '1');
const latest = sent.sort((a, b) => order(a).localeCompare(order(b))).at(-1);
let report = null;
if (latest) {
  const [date, slot] = latest;
  const agents = sent.filter(([d, s]) => d === date && s === slot).flatMap(([, , agent]) => {
    const text = read(path.join(HOME, 'reports', `${date}-${slot}-${agent}.md`));
    const name = agent === 'codex' ? 'Codex' : 'Antigravity';
    if (!text) return [{ name, unread: true, inChat: [], inInternal: [] }];
    const ci = text.lastIndexOf('=== CHAT ==='), ni = text.indexOf('=== INTERNAL ===', ci);
    const chat = ci >= 0 ? text.slice(ci, ni > ci ? ni : undefined) : '';
    return [{ name, inChat: vendorsIn(fixedPart(chat), vendors), inInternal: vendorsIn(ni >= 0 ? text.slice(ni) : '', vendors), fields: Object.fromEntries(FIELD_TAGS.map(t => [t, fieldPart(chat, t)])) }];
  });
  if (agents.some(a => !a.unread)) report = { date, slot, agents };
}

/* ---------- source sheets (read-only) ---------- */
const NO_SHEET = process.argv.includes('--no-sheet');
const conf = (() => { try { return JSON.parse(read(path.join(HOME, 'config.json'))); } catch { return null; } })();
const errorCode = e => String(e.response?.data?.error?.status || e.code || '조회 실패').slice(0, 60);
function sheetsApi() {
  const c = conf;
  const { google } = createRequire(path.join(c.googleAuthDir, 'package.json'))('googleapis');
  const keys = JSON.parse(read(path.join(c.googleAuthDir, 'dist/gcp-oauth.keys.json'))), k = keys.installed || keys.web;
  const auth = new google.auth.OAuth2(k.client_id, k.client_secret);
  auth.setCredentials(JSON.parse(read(path.join(c.googleAuthDir, 'dist/.gsheets-server-credentials.json'))));
  return google.sheets({ version: 'v4', auth }).spreadsheets;
}
async function readSheetNames() {
  if (NO_SHEET) return null;
  try {
    const r = await sheetsApi().values.get({ spreadsheetId: conf.spreadsheetId, range: "'JP매월 지출'!D14:D36" });
    const rows = {};
    (r.data.values || []).forEach((v, i) => { if (v[0]) rows[14 + i] = String(v[0]).trim(); });
    return { rows };
  } catch (e) {
    return { error: errorCode(e) };
  }
}
/** Each domain fails on its own: a failed read becomes { error }, never an empty target list. */
async function readDomains(basis) {
  if (NO_SHEET) return {};
  const batch = async (spreadsheetId, ranges, parse) => {
    if (!spreadsheetId) return { error: '설정 없음' };
    try {
      const v = await sheetsApi().values.batchGet({ spreadsheetId, ranges });
      return parse(v.data.valueRanges.map(x => x.values || []));
    } catch (e) { return { error: errorCode(e) }; }
  };
  const tab = welfareTab ? welfareTab(basis) : '';
  const expiry = await batch(conf?.contractsSpreadsheetId, ["'계약서 검색'!A6:N200", "'프로그램(2026)'!A5:D60"], ([a, b]) => ({ contracts: parseContracts(a), licenses: parseLicenses(b) }));
  return {
    contracts: expiry.error ? expiry : expiry.contracts,
    licenses: expiry.error ? expiry : expiry.licenses,
    welfare: tab ? await batch(conf?.opsSpreadsheetId, [`'${tab}'!A8:A`, `'${tab}'!E8:E`], ([a, e]) => parseWelfare(a, e)) : { error: '실행기 복지 탭 규칙을 찾지 못함' },
    tasks: await batch(conf?.spreadsheetId, ["'업무'!A1:D150"], ([t]) => parseTasks(t)),
    vehicles: await batch(conf?.contractsSpreadsheetId, ["'계약서(DB)'!C5:C300", "'계약서(DB)'!E5:E300", "'계약서(DB)'!I5:I300", "'계약서(DB)'!Q5:Q300"], ([c, e, i, q]) => parseVehicles(c, e, i, q))
  };
}

/* ---------- chat: only what the runner stored (read cursor, failure log lines) ---------- */
function chatRecord(rep) {
  const spaces = conf?.chatSpaces || [];
  const stored = rep ? Object.entries(ledger).filter(([k]) => k.startsWith(`${rep.date}|${rep.slot}|`) && !k.includes('|test')).map(([, v]) => v.chatUntil).filter(Boolean).sort().at(-1) : null;
  const log = rep ? read(path.join(HOME, 'logs', `${rep.date}.log`)) || '' : '';
  const failed = [...log.matchAll(/chat read failed (\S+):/g)].map(x => spaces.indexOf(x[1])).filter(i => i >= 0);
  const cursor = stored && !Number.isNaN(Date.parse(stored)) ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(stored)) : null;
  return { spaces: spaces.length, cursor, failed, sourceFails: [...log.matchAll(/(contracts\/licenses|welfare|dated tasks|vehicle insurance) read failed/g)].map(x => x[1]) };
}

/* ---------- judge: the runner's own fixedSchedule(), never a second copy of the rules ---------- */
let fixedSchedule = null, scheduleError = null;
try {
  const fnSrc = m(/(function fixedSchedule\(date\) \{[\s\S]*?\n\})/);
  if (!fnSrc) throw new Error('fixedSchedule not found');
  fixedSchedule = new Function('fs', 'path', 'REPO', fnSrc + '\nreturn fixedSchedule;')({ readFileSync: (...a) => fs.readFileSync(...a) }, path, REPO);
} catch { scheduleError = '실행기 일정 계산을 불러오지 못함 — 코드 구조 변경 여부 확인 필요'; }

const generatedAt = new Date().toISOString();
const holidays = JSON.parse(read(path.join(HOME, 'holidays.json')) || '{}').days || [];
const sourceOk = !!sheets.lastOk && !(sheets.lastFail > sheets.lastOk);
const domain = judgeFixed({ fixedSchedule, docRows, windowDays: imminentDays ?? IMMINENT_FALLBACK, report, sheet: await readSheetNames(), sourceOk, holidays, checkedAt: generatedAt, today: kstDate() });

const today = kstDate(), basisDate = report?.date || today;
const common = { report, sourceOk, checkedAt: generatedAt, today };
const src5 = buckets ? await readDomains(basisDate) : Object.fromEntries(['contracts', 'licenses', 'welfare', 'tasks', 'vehicles'].map(k => [k, { error: '실행기 D-구간을 찾지 못함' }]));
const chat = chatRecord(report);
const domains = [domain,
  judgeContracts(src5.contracts, { ...common, buckets }),
  judgeLicenses(src5.licenses, { ...common, buckets }),
  judgeWelfare(src5.welfare, { ...common, imminentDays: imminentDays ?? IMMINENT_FALLBACK }),
  judgeRecurring(src5.tasks, src5.vehicles, common),
  judgeChat(chat, common)];
const readWarnings = [...new Set(chat.sourceFails)].map(x => `기준 보고일에 실행기 원본 읽기 실패 기록: ${x}`);

const out = { generatedAt, repo: repoInfo(), checks, scheduleError, report: report && { date: report.date, slot: report.slot, agents: report.agents.map(a => a.name) },
  errors: agentErrors.slice(-5).reverse(), readWarnings, unconnected: [...unconnectedIn(src), 'Chat 양방향 앱(미배포)'], domains };
const file = path.join(HERE, 'evidence.local.js');
fs.writeFileSync(file, '/* 자동 생성 — 이 PC 전용, Git에 올리지 않음 */\nwindow.AIBOOT_EVIDENCE = ' + JSON.stringify(out, null, 1) + ';\n');
console.log(`evidence written: ${file}`);
console.log(`repo=${out.repo.path} [${out.repo.branch}] 코드 확인 ${checks.filter(x => x.ok).length}/${checks.length} · 기준 보고 ${report ? report.date + ' ' + report.slot : '없음'}`);
for (const d of domains) console.log(`${d.name}: 대상 ${d.summary.total} 정상 ${d.summary.ok} 확인 필요 ${d.summary.check} 미검증 ${d.summary.unverified}${d.warnings.length ? ' · 경고 ' + d.warnings.join(' / ') : ''}`);
