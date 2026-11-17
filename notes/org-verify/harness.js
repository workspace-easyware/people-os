// 조직관리 로컬 검증 하네스 (2026-11-17). 배포에 포함되지 않는 notes/ 아래.
// public/org.js를 최소 DOM 스텁 + 실제 로컬 API(wrangler dev --local)로 돌려 렌더·저장 경로를 확인한다.
// 사용: node notes/org-verify/harness.js <base-url> <hr_admin session token>
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const [base, token] = process.argv.slice(2);
const els = {};
function el(id) {
  return els[id] || (els[id] = {
    id, innerHTML: '', textContent: '', className: '', value: '', checked: false, style: {}, dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, fn) { this['on' + t] = fn; }, scrollIntoView() {},
  });
}
const ctx = {
  console, Number, Set, JSON, parseInt,
  $: el,
  esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  currentUser: { id: '7610f8aa-bf09-46ff-834f-aa89f18a4136', name: '강준호', role: 'hr_admin' },
  api: async (p, opts = {}) => {
    const r = await fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', cookie: 'people_os_session=' + token } });
    return r.json();
  },
};
ctx.escAttr = (s) => ctx.esc(s).replace(/"/g, '&quot;');
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/org.js'), 'utf8'), ctx);
const tick = () => new Promise(r => setTimeout(r, 400));
const check = (label, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + label); if (!cond) process.exitCode = 1; };

(async () => {
  await vm.runInContext('orgOpen()', ctx); await tick();
  const d = el('orgDeptPane').innerHTML;
  check('부서 탭 표시', el('orgDeptPane').style.display === '' && el('orgMemberPane').style.display === 'none');
  check('부서 목록에 인사팀', d.includes('인사팀') && d.includes('<code>HR</code>'));
  check('결재선 규칙 안내', d.includes('부서장이 없는 부서의 부서원은 기안할 수 없습니다'));
  check('부서 추가 폼', el('orgDeptFormCard').innerHTML.includes('부서 추가'));

  // 부서 추가 (부서장 없음) → 미지정 경고
  Object.assign(el('orgFCode'), { value: 'HARN' }); Object.assign(el('orgFName'), { value: '하네스팀' });
  Object.assign(el('orgFManager'), { value: '' }); Object.assign(el('orgFParent'), { value: '' });
  Object.assign(el('orgFSort'), { value: '20' }); Object.assign(el('orgFActive'), { checked: true });
  await vm.runInContext('orgSubmitDept({ preventDefault() {} })', ctx); await tick();
  check('부서 추가 메시지', el('orgMsg').textContent === '부서를 추가했습니다.');
  check('부서장 미지정 경고에 하네스팀', el('orgDeptPane').innerHTML.includes('org-warn') && /부서장 미지정:.*하네스팀/.test(el('orgDeptPane').innerHTML));
  const harn = vm.runInContext("orgDepts.find(x => x.code === 'HARN')", ctx);

  // 부서장 지정 (목록 드롭다운 경로)
  await vm.runInContext(`orgSetManager('${harn.id}', '6dbab006-ed51-4660-a005-8d52e4691ae0')`, ctx); await tick();
  check('부서장 지정 메시지', el('orgMsg').textContent.includes('부서장을 지정'));
  check('부서장 반영', vm.runInContext(`orgDepts.find(x => x.id === '${harn.id}').manager_name`, ctx) === '사용자B');

  // 수정 폼 (상위 부서 선택에서 자기 자신 제외)
  vm.runInContext(`orgEditDept('${harn.id}')`, ctx);
  const f = el('orgDeptFormCard').innerHTML;
  check('수정 폼 제목', f.includes('부서 수정 — 하네스팀'));
  check('상위 부서 옵션에 자기 자신 없음', !f.match(new RegExp(`orgFParent[\\s\\S]*value="${harn.id}"`)));

  // 구성원 탭
  vm.runInContext("orgSetPane('members')", ctx); await tick();
  const m = el('orgMemberPane').innerHTML;
  check('구성원 탭 표시', el('orgMemberPane').style.display === '' && el('orgDeptPane').style.display === 'none');
  check('구성원 목록 컬럼', ['이름', '이메일', '역할', '코칭 역할', '부서', '상태'].every(h => m.includes(`<th>${h}</th>`)));
  check('부서장 배지', m.includes('결재 부서장') && m.includes('>부서장</span>'));

  // 부서 지정 (PUT)
  await vm.runInContext(`orgSetDept('6dbab006-ed51-4660-a005-8d52e4691ae0', '${harn.id}')`, ctx); await tick();
  check('부서 지정 메시지', el('orgMsg').textContent.includes('하네스팀'));
  const ub = vm.runInContext("orgUsers.find(u => u.id === '6dbab006-ed51-4660-a005-8d52e4691ae0')", ctx);
  check('부서 지정 반영 (department_name)', ub.department_name === '하네스팀');

  // 이름 수정 (자기 계정)
  const form = { querySelector: () => ({ value: ' 강준호 ', dataset: { orig: '강준호(테스트)' } }) };
  ctx.__ev = { preventDefault() {}, target: form };
  await vm.runInContext("orgSaveName(__ev, '7610f8aa-bf09-46ff-834f-aa89f18a4136')", ctx); await tick();
  check('이름 저장 메시지', el('orgMsg').textContent === '이름을 저장했습니다.');
  check('사이드바 이름 갱신', el('userChipName').textContent === '강준호');
  const me = vm.runInContext("orgUsers.find(u => u.id === '7610f8aa-bf09-46ff-834f-aa89f18a4136')", ctx);
  check('이름 반영', me.name === '강준호');

  // 정리: 하네스 부서 비활성화, 사용자B 부서 해제
  await vm.runInContext(`orgSetDept('6dbab006-ed51-4660-a005-8d52e4691ae0', '')`, ctx); await tick();
  await ctx.api('/api/approval/admin/departments', { method: 'POST', body: JSON.stringify({ id: harn.id, code: 'HARN', name: '하네스팀', manager_user_id: null, parent_id: null, sort_order: 20, is_active: false }) });
  console.log('done');
})().catch(e => { console.error(e); process.exitCode = 1; });
