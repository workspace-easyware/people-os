// 가짜 DOM/fetch 하네스: public/plaud.js를 vm에 올려 SPA 탭 전환(plaudLoad 두 번)을 흉내 낸다.
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'plaud.js'), 'utf8');
const files = Array.from({ length: 8 }, (_, i) => ({ id: 'f' + i, name: 'rec' + i, duration_ms: 1000 }));
const calls = {}; let active = 0, maxActive = 0, failOnce = new Set(['f7']);
const box = { innerHTML: '', onclick: null, querySelectorAll: () => [] };
const ctx = {
  console, setTimeout, Date, Promise, JSON, encodeURIComponent, Math, Number, Array, Object,
  $: id => (id === 'plaudBox' ? box : null),
  esc: s => String(s), fmtDate: s => String(s), currentUser: null,
  document: { querySelector: () => null },
  fetch: async (url) => {
    const m = url.match(/files\/([^/]+)\/size/);
    const body = async j => ({ status: 200, json: async () => j });
    if (m) {
      calls[m[1]] = (calls[m[1]] || 0) + 1; active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 30)); active--;
      if (failOnce.has(m[1])) { failOnce.delete(m[1]); return body({ ok: false }); }
      return body({ ok: true, size_bytes: 35.5 * 1048576 });
    }
    if (url.startsWith('/api/plaud/status')) return body({ ok: true, status: 'connected', email: 'x' });
    if (url.startsWith('/api/plaud/files?')) { await new Promise(r => setTimeout(r, 5)); return body({ ok: true, files, has_more: false, total: 8 }); }
    return body({ ok: false });
  },
};
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sizes = () => (box.innerHTML.match(/plaud-size/g) || []).length;
(async () => {
  // 1회차: 탭 진입. 목록은 크기 조회를 기다리지 않고 먼저 그려져야 한다.
  const t0 = Date.now(); vm.runInContext('plaudLoad()', ctx);
  await sleep(20);
  const firstPaintHasList = box.innerHTML.includes('taskrow');
  console.log('1) 목록 먼저 그려짐(크기 조회 전):', firstPaintHasList, '크기 표시 수:', sizes());
  await sleep(400);
  console.log('   1회차 끝: 크기 표시', sizes(), '/ 8, 호출', JSON.stringify(calls), 'maxActive', maxActive);
  const callsAfter1 = JSON.stringify(calls);
  // 2회차: 새로고침 없이 탭 재진입
  vm.runInContext('plaudLoad()', ctx);
  await sleep(5);
  console.log('2) 재진입 직후(캐시 렌더) 크기 표시:', sizes(), '/ 8');
  await sleep(400);
  console.log('   2회차 끝: 크기 표시', sizes(), '/ 8, 호출', JSON.stringify(calls));
  const extra = Object.keys(calls).filter(k => calls[k] > 1);
  console.log('3) 두 번 이상 요청된 행(실패 재시도 f7만 기대):', JSON.stringify(extra));
  console.log('4) maxActive <= 4:', maxActive <= 4);
  void callsAfter1;
})();
