// [검증] pitch.js 순수 함수 단위 확인 — 검증 Worker의 GET /__verify/unit 이 실행한다.
// (이 VM의 -p 세션은 node 실행이 막혀 있어 workerd에서 돌린다.)
// DOM 동작은 여기서 볼 수 없다. 해시 해석·href·현재 섹션 계산·전역 계약만 본다.
import './unit-setup.mjs';
import '../../public/pitch.js';

export function runUnit() {
  const T = globalThis.__pitchTest;
  const out = [];
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? pass++ : fail++;
    out.push((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`));
  };
  eq('window.pitchOpen is function', typeof globalThis.pitchOpen, 'function');
  eq('window.pitchLeave is function', typeof globalThis.pitchLeave, 'function');
  eq('pitchLeave() before open is a no-op', globalThis.pitchLeave(), undefined);
  // 앱 모드 해시
  eq('app #pitch', T.parseHash('#pitch', 'app'), '');
  eq('app #pitch/data', T.parseHash('#pitch/data', 'app'), 'data');
  eq('app #pitch/pt-data', T.parseHash('#pitch/pt-data', 'app'), 'data');
  eq('app #obs/traces → null (not ours)', T.parseHash('#obs/traces', 'app'), null);
  eq('app #home → null', T.parseHash('#home', 'app'), null);
  eq('app #pitch/<bad> → top', T.parseHash('#pitch/<img>', 'app'), '');
  // 독립 모드 해시
  eq('sa #agentic', T.parseHash('#agentic', 'standalone'), 'agentic');
  eq('sa #pt-agentic', T.parseHash('#pt-agentic', 'standalone'), 'agentic');
  eq('sa #pitch/agentic', T.parseHash('#pitch/agentic', 'standalone'), 'agentic');
  eq('sa #pitch', T.parseHash('#pitch', 'standalone'), '');
  eq('sa empty', T.parseHash('', 'standalone'), '');
  eq('sa encoded', T.parseHash('#%61gentic', 'standalone'), 'agentic');
  eq('sa upper-case normalised', T.parseHash('#Data', 'standalone'), 'data');
  eq('sa javascript: rejected', T.parseHash('#javascript:alert(1)', 'standalone'), '');
  eq('sa bad %-escape tolerated', T.parseHash('#%E0%A4%A', 'standalone'), '');
  // href
  eq('href app key', T.hrefFor('data', 'app'), '#pitch/data');
  eq('href app top', T.hrefFor('', 'app'), '#pitch');
  eq('href sa key', T.hrefFor('data', 'standalone'), '#data');
  eq('href sa top', T.hrefFor('', 'standalone'), '#');
  eq('tab app', T.tabHref('upload', 'app'), '#upload');
  eq('tab sa', T.tabHref('upload', 'standalone'), '/#upload');
  // 현재 섹션 계산 (line = 내비 아래 + 24)
  eq('active: first when above all', T.pickActive([100, 900, 1800], 68, false), 0);
  eq('active: middle', T.pickActive([-500, 40, 900], 68, false), 1);
  eq('active: exactly on line', T.pickActive([-500, 68, 900], 68, false), 1);
  eq('active: last passed', T.pickActive([-2000, -1000, -10], 68, false), 2);
  eq('active: bottom forces last', T.pickActive([-2000, 10, 400], 68, true), 2);
  eq('active: empty', T.pickActive([], 68, false), -1);
  out.push(`\n${pass} passed, ${fail} failed`);
  return { text: out.join('\n'), fail };
}
