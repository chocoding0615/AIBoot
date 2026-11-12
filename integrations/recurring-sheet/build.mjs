#!/usr/bin/env node
/**
 * Apps Script용 단일 파일 만들기. 회차 계산·처리 계획 코드를 다시 쓰지 않고
 * local-dual-report/recurring.mjs와 recurring-status.mjs 원문을 그대로 감싸서 넣는다.
 * 그래서 시트 메뉴가 계산하는 회차키·기준일은 정기 보고가 계산하는 것과 같다.
 *
 *   node integrations/recurring-sheet/build.mjs          dist/Recurring.gs 다시 만들기
 *   node integrations/recurring-sheet/build.mjs --check  dist가 원본과 같은지만 확인(다르면 종료 코드 1)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.join(here, '..', 'local-dual-report');
export const OUT = path.join(here, 'dist', 'Recurring.gs');

/**
 * ES 모듈 원문 → `var Name = (function () { ... return {...}; })();`
 * import 줄은 지우고(필요한 이름은 deps에서 꺼내 준다), export 키워드만 뗀다.
 * 모듈 끝의 `if (import.meta.url ...)` 실행 줄처럼 Apps Script에서 문법 오류가 되는 줄은 지운다.
 */
export function wrapModule(name, source, deps = {}) {
  const exportsList = [...source.matchAll(/^export (?:async )?(?:function|const|let) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  const body = source.replace(/\r\n/g, '\n').split('\n')
    .filter(l => !/^import /.test(l) && !/import\.meta/.test(l) && !/^#!/.test(l))
    .map(l => l.replace(/^export (async function|function|const|let) /, '$1 '))
    .join('\n');
  const imports = Object.entries(deps).map(([mod, names]) => `  const { ${names.join(', ')} } = ${mod};\n`).join('');
  return `var ${name} = (function () {\n${imports}${body}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

/** recurring-status.mjs가 recurring.mjs에서 가져오는 이름 — 원문의 import 줄에서 읽는다. */
function importedNames(source, from) {
  const m = new RegExp(`^import \\{([^}]+)\\} from '${from.replace('.', '\\.')}';`, 'm').exec(source);
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : [];
}

export function build() {
  const rec = fs.readFileSync(path.join(lib, 'recurring.mjs'), 'utf8');
  const status = fs.readFileSync(path.join(lib, 'recurring-status.mjs'), 'utf8');
  return '// 자동 생성 파일 — 고치지 말 것. 원본: integrations/local-dual-report/recurring.mjs, recurring-status.mjs\n' +
    '// 다시 만들기: node integrations/recurring-sheet/build.mjs\n\n' +
    wrapModule('Recurring', rec) + '\n' +
    wrapModule('RecurringStatus', status, { Recurring: importedNames(status, './recurring.mjs') });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const text = build();
  if (process.argv.includes('--check')) {
    const same = fs.existsSync(OUT) && fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') === text;
    console.log(same ? 'dist 최신' : 'dist가 원본과 다름 — node integrations/recurring-sheet/build.mjs');
    process.exit(same ? 0 : 1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log('생성: ' + path.relative(process.cwd(), OUT));
}
