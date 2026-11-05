#!/usr/bin/env node
/**
 * Builds evidence.local.js for the fixed-expense flow viewer — READ-ONLY.
 *
 * Reads (never writes): the runner source and FIXED-EXPENSES-V1.md of the operating checkout,
 * %USERPROFILE%/.aiboot/{logs,ledger.json,reports}. No network, no Google API, no config secrets.
 * Writes only ./evidence.local.js (git-ignored, this PC only).
 * Output contains no webhook URL, token, space ID, message ID, amount or message text.
 *
 * Usage: node build-evidence.mjs [--repo <AIBoot 운영 폴더>]   (default: AIBOOT_REPO env, else this repo)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const argRepo = process.argv.indexOf('--repo');
const REPO = path.resolve(argRepo > 0 ? process.argv[argRepo + 1] : process.env.AIBOOT_REPO || path.join(HERE, '..', '..'));
const RUNNER = path.join(REPO, 'integrations/local-dual-report/runner.mjs');
const DOC = path.join(REPO, 'docs/FIXED-EXPENSES-V1.md');
const HOME = path.join(os.homedir(), '.aiboot');
const IMMINENT_FALLBACK = 7;

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const kstDate = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(d);
const addDay = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const norm = s => String(s).replace(/[\s()·]/g, '').toLowerCase();

const src = read(RUNNER);
if (!src) { console.error(`runner.mjs를 찾을 수 없음: ${RUNNER}\n운영 폴더를 --repo 로 지정하세요.`); process.exit(1); }

/* ---------- repo: which branch the scheduler actually runs ---------- */
function repoInfo() {
  let gitDir = path.join(REPO, '.git');
  const g = read(gitDir);
  if (g && g.startsWith('gitdir:')) gitDir = path.resolve(REPO, g.slice(7).trim()); // worktree
  const head = (read(path.join(gitDir, 'HEAD')) || '').trim();
  return { path: REPO, branch: head.startsWith('ref:') ? head.replace('ref: refs/heads/', '') : '(detached) ' + head.slice(0, 7) };
}

/* ---------- code checks: what the runner really does (re-evaluated on every build) ---------- */
const m = (re, s = src) => (re.exec(s) || [])[1] || null;
const rangeJP = m(/'JP매월 지출'!([A-Z]+\d+:[A-Z]+\d+)/);
const rangeDaily = m(/'AIBoot_데일리마감'!([A-Z]+\d+:[A-Z]+\d+)/);
const imminentDays = Number(m(/const IMMINENT_DAYS = (\d+)/)) || null;
const checks = [
  { id: 'rangeJP', label: 'JP매월 지출 읽기 범위', ok: !!rangeJP, value: rangeJP },
  { id: 'rangeDaily', label: 'AIBoot_데일리마감 읽기 범위', ok: !!rangeDaily, value: rangeDaily },
  { id: 'readonly', label: '시트 호출은 읽기(get/batchGet)만', ok: !/spreadsheets\.(batchUpdate|values\.(update|append|clear|batchUpdate))/.test(src) },
  { id: 'noSecretTab', label: '`시트내용`(계정정보) 탭 범위 없음', ok: !/'시트내용'!/.test(src) },
  { id: 'gmailOff', label: 'Gmail은 코드에서 `미연결`로 고정', ok: /sources\['회사 Gmail'\]\s*=\s*'미연결'/.test(src) && !/google\.gmail\(/.test(src) },
  { id: 'easySched', label: '일정 계산에서 이지화물 제외', ok: /\/이지화물\/\.test\(vendor\)/.test(src) },
  { id: 'easyValidate', label: '보고 본문에 이지화물이 있으면 발송 차단', ok: /\/이지화물\/\.test\(chat\)/.test(src) },
  { id: 'yellow', label: '연노랑 = 지출결의 표시로만 전달', ok: /isYellow/.test(src) && /\(연노랑\)/.test(src) },
  { id: 'imminent', label: '임박 창(일)', ok: !!imminentDays, value: imminentDays },
  { id: 'ledger', label: '중복 발송 방지(ledger claim)', ok: /function claim\(/.test(src) && /'sending'/.test(src) },
  { id: 'cards', label: 'Cards V2 3장 + 내용 보존 검사', ok: /function toCards\(/.test(src) && /assertSameContent\(chat, cards\)/.test(src) },
  { id: 'codex', label: 'Codex 읽기 전용 샌드박스 실행', ok: /'--sandbox', 'read-only'/.test(src) },
  { id: 'agy', label: 'Antigravity plan 모드 실행', ok: /'--mode', 'plan'/.test(src) }
];

/* ---------- schedule: evaluate the runner's own fixedSchedule() against the operating doc ---------- */
let schedule = { error: null };
try {
  const fnSrc = m(/(function fixedSchedule\(date\) \{[\s\S]*?\n\})/);
  if (!fnSrc) throw new Error('fixedSchedule() 를 찾지 못함 — 코드 구조 변경, 화면 재검토 필요');
  // Pure function: only reads the doc file. Injected fs is read-only wrapper.
  const roFs = { readFileSync: (...a) => fs.readFileSync(...a) };
  const fixedSchedule = new Function('fs', 'path', 'REPO', fnSrc + '\nreturn fixedSchedule;')(roFs, path, REPO);
  const today = kstDate();
  const days = imminentDays ?? IMMINENT_FALLBACK;
  const month = fixedSchedule(today);
  const imminent = [];
  for (let i = 0; i <= days; i++) {
    const d = addDay(today, i);
    for (const s of fixedSchedule(d)) if (s.day === Number(d.slice(8)) && !imminent.some(x => x.vendor === s.vendor)) imminent.push({ vendor: s.vendor, date: d });
  }
  const docRows = (read(DOC) || '').split('\n').map(l => l.split('|').map(x => x.replace(/\*\*/g, '').trim())).filter(c => c.length >= 7 && /^\d+$/.test(c[1]));
  schedule = { asOf: today, windowEnd: addDay(today, days), docRows: docRows.length, active: month.map(s => ({ row: s.row, vendor: s.vendor, day: s.day })),
    excluded: docRows.filter(c => !month.some(s => s.row === Number(c[1]))).map(c => c[2]), imminent, error: null };
} catch (e) { schedule.error = e.message; }

/* ---------- logs: last sheet snapshot, Chat read status, fatal errors ---------- */
const logFiles = (fs.existsSync(path.join(HOME, 'logs')) ? fs.readdirSync(path.join(HOME, 'logs')) : []).filter(f => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
let sheets = { lastOk: null, lastFail: null, okCount: 0 }, chat = { last: null }, agentErrors = [];
for (const f of logFiles) {
  for (const line of (read(path.join(HOME, 'logs', f)) || '').split('\n')) {
    const t = line.slice(0, 24), msg = line.slice(25);
    let x;
    if ((x = /^snapshot (\S+) (\S+) sha=\S+ chars=(\d+)/.exec(msg))) { sheets.lastOk = { at: t, slot: x[2], chars: Number(x[3]) }; sheets.okCount++; }
    else if (/^FATAL/.test(msg)) sheets.lastFail = { at: t, msg: msg.replace(/[A-Za-z0-9_-]{20,}/g, '<id>').slice(0, 160) };
    else if ((x = /^chat read failed \S+: (\S+)/.exec(msg))) chat.last = { at: t, ok: false, code: x[1] };
    else if ((x = /^chat check.*?: (연결|조회 실패|일부[^ ]*)/.exec(msg))) chat.last = { at: t, ok: x[1] === '연결', code: x[1] };
    else if ((x = /^FAILED (\S+): (.*)/.exec(msg))) agentErrors.push({ at: t, key: x[1], reason: x[2].replace(/[A-Za-z0-9_-]{20,}/g, '<id>').slice(0, 200) });
  }
}

/* ---------- ledger: send results (message IDs dropped) ---------- */
const ledger = JSON.parse(read(path.join(HOME, 'ledger.json')) || '{}');
const sends = Object.entries(ledger).map(([key, v]) => ({ key, test: key.split('|').length > 3, status: v.status, attempts: v.attempts, cards: v.cards ?? null, at: v.updatedAt, error: v.error ? String(v.error).slice(0, 200) : null }))
  .sort((a, b) => String(b.at).localeCompare(String(a.at)));

/* ---------- reports: is each vendor named in the CHAT part / INTERNAL part of recent regular reports ---------- */
const flowSrc = read(path.join(HERE, 'flow-data.js')) || '';
const vendorNames = [...flowSrc.matchAll(/name: '([^']+)'(?:, aliases: \[([^\]]*)\])?/g)].map(x => ({ name: x[1], all: [x[1], ...((x[2] || '').match(/'[^']+'/g) || []).map(s => s.slice(1, -1))] }));
const repDir = path.join(HOME, 'reports');
const repFiles = (fs.existsSync(repDir) ? fs.readdirSync(repDir) : []).filter(f => /^\d{4}-\d{2}-\d{2}-(morning|afternoon)-(codex|antigravity)\.md$/.test(f)).sort().reverse().slice(0, 6);
const reports = repFiles.map(f => {
  const text = read(path.join(repDir, f)) || '';
  const ci = text.lastIndexOf('=== CHAT ==='), ni = text.indexOf('=== INTERNAL ===', ci);
  const chatPart = norm(ci >= 0 ? text.slice(ci, ni > ci ? ni : undefined) : ''), notePart = norm(ni >= 0 ? text.slice(ni) : '');
  const sent = ledger[f.replace(/\.md$/, '').replace(/^(\d{4}-\d{2}-\d{2})-(\w+)-(\w+)$/, '$1|$2|$3')]?.status || null;
  return { file: f, sent,
    inChat: vendorNames.filter(v => v.all.some(n => chatPart.includes(norm(n)))).map(v => v.name),
    inInternal: vendorNames.filter(v => v.all.some(n => notePart.includes(norm(n)))).map(v => v.name) };
});

const out = { generatedAt: new Date().toISOString(), repo: repoInfo(), checks, schedule, sheets, chat, agentErrors: agentErrors.slice(-8).reverse(), sends: sends.slice(0, 20), reports };
const file = path.join(HERE, 'evidence.local.js');
fs.writeFileSync(file, '/* 자동 생성 — 이 PC 전용, Git에 올리지 않음 */\nwindow.AIBOOT_EVIDENCE = ' + JSON.stringify(out, null, 1) + ';\n');
console.log(`evidence written: ${file}`);
console.log(`repo=${out.repo.path} [${out.repo.branch}] checks ${checks.filter(c => c.ok).length}/${checks.length} ok · schedule ${schedule.error || `${schedule.docRows} rows → ${schedule.active.length} active, imminent ${schedule.imminent.length}`} · last sheet read ${sheets.lastOk?.at || '-'} · reports ${reports.length}`);
