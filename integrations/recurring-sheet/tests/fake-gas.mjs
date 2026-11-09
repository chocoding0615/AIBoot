/**
 * 테스트용 가짜 Apps Script 환경. 실제 시트에는 개발 테스트를 쓰지 않으므로 여기서 재현한다.
 * 재현하는 실제 동작:
 *   - 행 개발자 메타데이터는 행을 넣고 지우면 행과 함께 움직이고, 행을 지우면 사라진다.
 *   - setValues는 글자 형식(@)이 아닌 셀에 '2026-11' 같은 글자를 넣으면 날짜로 바꾼다.
 *   - 날짜 셀의 표시값은 연도를 숨긴 MM-dd다(실제 7행처럼).
 *   - setValues는 `=`로 시작하는 글자를 수식으로 받는다(공식 문서). 서식 있는 텍스트(setRichTextValues)는 글자 그대로다.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pad = n => String(n).padStart(2, '0');
const kst = d => new Date(d.getTime() + 9 * 3600000);
const fmt = (d, f) => { const k = kst(d); return f.replace('yyyy', k.getUTCFullYear()).replace('MM', pad(k.getUTCMonth() + 1)).replace('dd', pad(k.getUTCDate()))
  .replace('HH', pad(k.getUTCHours())).replace('mm', pad(k.getUTCMinutes())).replace('ss', pad(k.getUTCSeconds())); };
export const kstDate = ymd => new Date(Date.parse(ymd + 'T00:00:00+09:00'));
const isDate = v => Object.prototype.toString.call(v) === '[object Date]';

export class FakeSheet {
  constructor(name, rows = [], id = Math.floor(Math.random() * 1e9)) {
    this.name = name; this.id = id; this.hidden = false;
    this.cells = rows.map(r => r.map(v => ({ v, text: false })));
    this.meta = rows.map(() => []); // 행마다 [{key, value}]
    this.maxRows = Math.max(rows.length, 1000);
    this.writes = 0;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  hideSheet() { this.hidden = true; return this; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { this.maxRows += n; return this; }
  cell(r, c) { while (this.cells.length < r) { this.cells.push([]); this.meta.push([]); } const row = this.cells[r - 1]; while (row.length < c) row.push({ v: '', text: false }); return row[c - 1]; }
  getLastRow() { for (let r = this.cells.length; r > 0; r--) if (this.cells[r - 1].some(c => c.v !== '' && c.v != null)) return r; return 0; }
  /** 행 삽입·삭제: 메타데이터가 행과 함께 움직인다. */
  insertRowBefore(r) { this.cells.splice(r - 1, 0, []); this.meta.splice(r - 1, 0, []); return this; }
  deleteRow(r) { this.cells.splice(r - 1, 1); this.meta.splice(r - 1, 1); return this; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const m = /^(\d+):(\d+)$/.exec(a); if (!m || m[1] !== m[2]) throw new Error('fake: 행 전체 A1만 지원'); return new FakeRange(this, Number(m[1]), 1, 1, 26, true); }
    return new FakeRange(this, a, b, c ?? 1, d ?? 1, false);
  }
  createDeveloperMetadataFinder() {
    let key = null; const sheet = this;
    return { withKey(k) { key = k; return this; }, find() {
      const out = [];
      sheet.meta.forEach((list, i) => list.filter(m => m.key === key).forEach(m => out.push({ getValue: () => m.value,
        remove: () => { if (sheet.failWrites) throw new Error(sheet.failWrites); sheet.writes++; const l = sheet.meta.find(x => x.includes(m)); l.splice(l.indexOf(m), 1); },
        getLocation: () => ({ getLocationType: () => 'ROW', getRow: () => ({ getRow: () => i + 1 }) }) })));
      return out;
    } };
  }
  values() { return this.cells.map(r => r.map(c => c.v)); }
}

class FakeRange {
  constructor(sheet, row, col, nr, nc, wholeRow) { Object.assign(this, { sheet, row, col, nr, nc, wholeRow }); }
  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getLastRow() { return this.row + this.nr - 1; }
  grid(f, read = false) { const out = []; for (let i = 0; i < this.nr; i++) { const r = []; for (let j = 0; j < this.nc; j++) r.push(f(read ? (this.sheet.cells[this.row + i - 1]?.[this.col + j - 1] || { v: '' }) : this.sheet.cell(this.row + i, this.col + j))); out.push(r); } return out; }
  getValues() { return this.grid(c => c.v, true); }
  getDisplayValues() { return this.grid(c => isDate(c.v) ? fmt(c.v, 'MM-dd') : c.v && c.v.formula ? '(수식 결과)' : String(c.v ?? ''), true); }
  setNumberFormat(f) { this.grid(c => { c.text = f === '@'; }); return this; }
  setValues(rows) {
    if (this.sheet.failWrites) throw new Error(this.sheet.failWrites);
    this.sheet.writes++;
    rows.forEach((r, i) => r.forEach((v, j) => { const c = this.sheet.cell(this.row + i, this.col + j);
      c.v = typeof v === 'string' && v.startsWith('=') ? { formula: v } : !c.text && typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(v) ? kstDate(v.length === 7 ? v + '-01' : v) : v; }));
    return this;
  }
  setRichTextValues(rows) {
    if (this.sheet.failWrites) throw new Error(this.sheet.failWrites);
    this.sheet.writes++;
    rows.forEach((r, i) => r.forEach((v, j) => { this.sheet.cell(this.row + i, this.col + j).v = v.text; }));
    return this;
  }
  addDeveloperMetadata(key, value) {
    if (!this.wholeRow) throw new Error('fake: 행 전체 범위가 아님');
    if (this.sheet.failWrites) throw new Error(this.sheet.failWrites);
    this.sheet.writes++;
    this.sheet.cell(this.row, 1); this.sheet.meta[this.row - 1].push({ key, value });
    return this;
  }
}

export class FakeSpreadsheet {
  constructor(name, sheets) { this.name = name; this.sheets = sheets; }
  getName() { return this.name; }
  getSpreadsheetTimeZone() { return 'Asia/Seoul'; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n, []); this.sheets.push(s); return s; }
}

/** dist/Recurring.gs + Sheet.gs를 가짜 서비스와 함께 불러온다. now는 KST 'YYYY-MM-DD HH:mm'. */
export function loadGas({ ss, now = '2026-11-09 10:00', ics = '', lockFails = false, fetchFails = false, active = null }) {
  const fixed = Date.parse(now.replace(' ', 'T') + ':00+09:00');
  class FixedDate extends Date { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  const log = { alerts: [], dialogs: [], fetches: 0, locks: 0 };
  const cache = new Map();
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, Map, Set, Object, JSON, Math, String, Number, Array, RegExp, Error, Date: FixedDate, Intl,
    Utilities: { formatDate: (d, tz, f) => fmt(d, f), getUuid: () => crypto.randomUUID() },
    LockService: { getDocumentLock: () => ({ tryLock: () => { log.locks++; return !lockFails; }, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    UrlFetchApp: { fetch: () => { log.fetches++; if (fetchFails) throw new Error('fetch denied'); return { getResponseCode: () => 200, getContentText: () => ics }; } },
    HtmlService: { createTemplateFromFile: () => ({ evaluate: () => ({ setWidth() { return this; }, setHeight() { return this; } }) }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, flush() {}, getActiveRange: () => active,
      newRichTextValue: () => { let t = ''; return { setText(x) { t = x; return this; }, build: () => ({ text: t }) }; },
      DeveloperMetadataVisibility: { DOCUMENT: 'DOCUMENT' },
      getUi: () => ({ alert: m => log.alerts.push(m), showModalDialog: (h, t) => log.dialogs.push(t),
        createMenu: () => ({ addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }) })
    }
  };
  vm.createContext(ctx);
  for (const f of ['dist/Recurring.gs', 'Sheet.gs']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  return { gas: ctx, log };
}

export const ICS = ['2026-01-01:신정', '2026-02-17:설날', '2026-09-25:추석', '2026-10-09:한글날', '2026-12-25:기독탄신일', '2027-01-01:신정', '2027-02-07:설날', '2027-09-15:추석']
  .map(s => { const [d, n] = s.split(':'); return `BEGIN:VEVENT\nDTSTART;VALUE=DATE:${d.replace(/-/g, '')}\nSUMMARY:${n}\nDESCRIPTION:공휴일\nEND:VEVENT`; }).join('\n');

/** 가짜 시트 → Sheets API 응답 모양. 정기 보고의 readRecurringSource를 그대로 부르기 위한 것. */
export function sheetsApi(ss) {
  const fv = v => isDate(v) ? fmt(v, 'MM-dd') : String(v ?? '');
  return {
    get: async ({ ranges }) => {
      if (!ranges) return { data: { properties: { title: ss.name }, sheets: ss.sheets.map(s => ({ properties: { sheetId: s.id, title: s.name } })) } };
      const t = ss.getSheetByName('업무'), rows = t.cells.slice(1, 200);
      return { data: { sheets: [{ data: [{
        rowMetadata: rows.map((_, i) => ({ developerMetadata: (t.meta[i + 1] || []).map(m => ({ metadataKey: m.key, metadataValue: m.value })) })),
        rowData: rows.map(r => ({ values: r.map(c => isDate(c.v) ? { formattedValue: fv(c.v), effectiveValue: { numberValue: (c.v.getTime() + 9 * 3600000) / 86400000 + 25569 }, effectiveFormat: { numberFormat: { type: 'DATE' } } } : { formattedValue: fv(c.v) }) }))
      }] }] } };
    },
    values: { get: async ({ range }) => {
      if (range.startsWith("'Master_Sheet'")) throw new Error('no Master_Sheet in fake');
      const h = ss.getSheetByName('반복업무_처리이력');
      return { data: { values: h.cells.map(r => r.map(c => fv(c.v))) } };
    } }
  };
}
