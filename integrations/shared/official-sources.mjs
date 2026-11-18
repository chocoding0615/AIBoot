/** Official source identity and hidden-tab gate. One metadata read per configured file per query pass; no persistent cache or writes. */
const GUARDED = Symbol('officialReader');
const ROLES = {
  fixed: ['spreadsheetId', '[MS] AD_관리비 내역', 'JP매월 지출'],
  daily: ['spreadsheetId', '[MS] AD_관리비 내역', 'AIBoot_데일리마감'],
  contracts: ['contractsSpreadsheetId', '[MS] AD_계약서 관리', '계약서(DB)'],
  licenses: ['contractsSpreadsheetId', '[MS] AD_계약서 관리', '프로그램(2026)'],
  welfare: ['opsSpreadsheetId', '[MS] AD_운영 관리', '복지포인트 관리(2026)'],
  recurring: ['recurringSpreadsheetId', '[MS] 김현호', '업무'],
  history: ['recurringSpreadsheetId', '[MS] 김현호', '반복업무_처리이력'],
  master: ['recurringSpreadsheetId', '[MS] 김현호', 'Master_Sheet']
};
export const CONTRACT_RANGES = ['D', 'E', 'I', 'N', 'O'].map(col => "'계약서(DB)'!" + col + '5:' + col);
const ALLOWED = {
  fixed: new Set(['B1:V37', 'D14:D36']), daily: new Set(['A1:I300']),
  contracts: new Set([...['D','E','I','N','O'].map(c => c+'5:'+c), 'C5:C300','E5:E300','I5:I300','Q5:Q300']),
  licenses: new Set(['A5:D60']), welfare: new Set(['A8:A','E8:E']),
  recurring: new Set(['A2:E200']), history: new Set(['A:F']), master: new Set(['B1:D60'])
};
const fail = code => Object.assign(new Error('확인 필요 — ' + code), { code });
export function createOfficialReader(api, config) {
  if (api[GUARDED]) return api;
  const cache = new Map();
  async function metadata(id) {
    if (!id) throw fail('SOURCE_NOT_CONFIGURED');
    const roles = Object.entries(ROLES).filter(([,r]) => config[r[0]] === id);
    if (!roles.length) throw fail('SOURCE_NOT_ALLOWED');
    const titles = new Set(roles.map(([,r]) => r[1]));
    if (titles.size !== 1) throw fail('SOURCE_FILE_AMBIGUOUS');
    if (!cache.has(id)) cache.set(id, (async () => {
      let value;
      try { value = await api.get({spreadsheetId:id, fields:'properties(title),sheets(properties(sheetId,title,hidden))'}); }
      catch { throw fail('SOURCE_METADATA_FAILED'); }
      if (value.data?.properties?.title !== [...titles][0] || !Array.isArray(value.data?.sheets)) throw fail('SOURCE_FILE_MISMATCH');
      return value;
    })());
    return cache.get(id);
  }
  async function check(id, ranges) {
    const value = await metadata(id);
    for (const range of ranges) {
      const match = /^'([^']+)'!([A-Z0-9:]+)$/.exec(range);
      if (!match) throw fail('SOURCE_RANGE_NOT_ALLOWED');
      const role = Object.keys(ROLES).find(k => config[ROLES[k][0]] === id && ROLES[k][2] === match[1]);
      if (!role || !ALLOWED[role].has(match[2])) throw fail('SOURCE_RANGE_NOT_ALLOWED');
      const matches = value.data.sheets.filter(s => s.properties?.title === match[1]);
      if (matches.length !== 1 || !Number.isInteger(matches[0].properties.sheetId) || matches[0].properties.sheetId < 0 || (matches[0].properties.hidden !== undefined && typeof matches[0].properties.hidden !== 'boolean')) throw fail('SOURCE_TAB_MISMATCH');
      if (matches[0].properties.hidden === true) throw fail('SOURCE_TAB_HIDDEN');
      const pinned = config.sourceSheetIds?.[role];
      if (!Number.isInteger(pinned) || pinned < 0) throw fail('SOURCE_GID_UNCONFIRMED');
      if (pinned !== matches[0].properties.sheetId) throw fail('SOURCE_GID_MISMATCH');
    }
  }
  return {
    [GUARDED]: true,
    get: async args => {
      if (!args.ranges) return metadata(args.spreadsheetId);
      await check(args.spreadsheetId, args.ranges);
      try { return await api.get(args); } catch { throw fail('SOURCE_READ_FAILED'); }
    },
    values: {
      get: async args => { await check(args.spreadsheetId,[args.range]); try { return await api.values.get(args); } catch { throw fail('SOURCE_READ_FAILED'); } },
      batchGet: async args => { await check(args.spreadsheetId,args.ranges); try {
        const value = await api.values.batchGet(args);
        if (!Array.isArray(value.data?.valueRanges) || value.data.valueRanges.length !== args.ranges.length || value.data.valueRanges.some(r => !r || (r.values !== undefined && !Array.isArray(r.values)))) throw fail('SOURCE_RESPONSE_INVALID');
        return value;
      } catch (error) { throw fail(error.code === 'SOURCE_RESPONSE_INVALID' ? error.code : 'SOURCE_READ_FAILED'); } }
    }
  };
}
