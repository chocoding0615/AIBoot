#!/usr/bin/env node
/**
 * Builds evidence.local.js for the fixed-expense status board — READ-ONLY.
 *
 * Reads (never writes): runner.mjs and FIXED-EXPENSES-V1.md of --repo, %USERPROFILE%/.aiboot/{logs,ledger.json,
 * reports,holidays.json}, and only the vendor-name column of the source sheet ('JP매월 지출'!D14:D36, values.get).
 * From config.json it uses spreadsheetId and googleAuthDir only. No amounts, webhook, Chat or message text.
 * Writes only ./evidence.local.js (git-ignored, this PC only).
 *
 * Usage: node build-evidence.mjs [--repo <AIBoot 폴더>] [--no-sheet]   (default: AIBOOT_REPO env, else this repo)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fixedPart, judgeFixed, parseDocRows, vendorsIn } from './judge.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argRepo = process.argv.indexOf('--repo');
const REPO = path.resolve(argRepo > 0 ? process.argv[argRepo + 1] : process.env.AIBOOT_REPO || path.join(HERE, '..', '..'));
const RUNNER = path.join(REPO, 'integrations/local-dual-report/runner.mjs');
const DOC = path.join(REPO, 'docs/FIXED-EXPENSES-V1.md');
const HOME = path.join(os.homedir(), '.aiboot');
const IMMINENT_FALLBACK = 7;

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
  { label: '임박 창(일)', ok: !!imminentDays }
];

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
    return [{ name, inChat: vendorsIn(fixedPart(ci >= 0 ? text.slice(ci, ni > ci ? ni : undefined) : ''), vendors), inInternal: vendorsIn(ni >= 0 ? text.slice(ni) : '', vendors) }];
  });
  if (agents.some(a => !a.unread)) report = { date, slot, agents };
}

/* ---------- source sheet: vendor names only ---------- */
async function readSheetNames() {
  if (process.argv.includes('--no-sheet')) return null;
  try {
    const c = JSON.parse(read(path.join(HOME, 'config.json')));
    const { google } = createRequire(path.join(c.googleAuthDir, 'package.json'))('googleapis');
    const keys = JSON.parse(read(path.join(c.googleAuthDir, 'dist/gcp-oauth.keys.json'))), k = keys.installed || keys.web;
    const auth = new google.auth.OAuth2(k.client_id, k.client_secret);
    auth.setCredentials(JSON.parse(read(path.join(c.googleAuthDir, 'dist/.gsheets-server-credentials.json'))));
    const r = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({ spreadsheetId: c.spreadsheetId, range: "'JP매월 지출'!D14:D36" });
    const rows = {};
    (r.data.values || []).forEach((v, i) => { if (v[0]) rows[14 + i] = String(v[0]).trim(); });
    return { rows };
  } catch (e) {
    return { error: String(e.response?.data?.error?.status || e.code || '조회 실패').slice(0, 60) };
  }
}

/* ---------- judge: the runner's own fixedSchedule(), never a second copy of the rules ---------- */
let fixedSchedule = null, scheduleError = null;
try {
  const fnSrc = m(/(function fixedSchedule\(date\) \{[\s\S]*?\n\})/);
  if (!fnSrc) throw new Error('fixedSchedule()을 찾지 못함 — 코드 구조 변경, 화면 재검토 필요');
  fixedSchedule = new Function('fs', 'path', 'REPO', fnSrc + '\nreturn fixedSchedule;')({ readFileSync: (...a) => fs.readFileSync(...a) }, path, REPO);
} catch (e) { scheduleError = e.message; }

const generatedAt = new Date().toISOString();
const holidays = JSON.parse(read(path.join(HOME, 'holidays.json')) || '{}').days || [];
const sourceOk = !!sheets.lastOk && !(sheets.lastFail > sheets.lastOk);
const domain = judgeFixed({ fixedSchedule, docRows, windowDays: imminentDays ?? IMMINENT_FALLBACK, report, sheet: await readSheetNames(), sourceOk, holidays, checkedAt: generatedAt, today: kstDate() });

const out = { generatedAt, repo: repoInfo(), checks, scheduleError, report: report && { date: report.date, slot: report.slot, agents: report.agents.map(a => a.name) },
  errors: agentErrors.slice(-5).reverse(), domains: [domain] };
const file = path.join(HERE, 'evidence.local.js');
fs.writeFileSync(file, '/* 자동 생성 — 이 PC 전용, Git에 올리지 않음 */\nwindow.AIBOOT_EVIDENCE = ' + JSON.stringify(out, null, 1) + ';\n');
const c = domain.summary;
console.log(`evidence written: ${file}`);
console.log(`repo=${out.repo.path} [${out.repo.branch}] 코드 확인 ${checks.filter(x => x.ok).length}/${checks.length} · 기준 보고 ${report ? report.date + ' ' + report.slot : '없음'} · 관리대상 ${c.total} 정상 ${c.ok} 확인 필요 ${c.check} 미검증 ${c.unverified}${domain.warnings.length ? ' · 경고 ' + domain.warnings.join(' / ') : ''}`);
