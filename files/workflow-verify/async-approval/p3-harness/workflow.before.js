// 워크플로우 빌더 WF-5 (2026-11-17) — 폼 방식 빌더 UI. 마운트 지점: #workflowMount.
// index.html 인라인 스크립트의 전역($, currentUser, switchTab)을 쓴다. 빌드 없음, 바닐라 JS.
// 보안: 서버·사용자 데이터는 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// 해시: #workflow · #workflow/<id> · #workflow/<id>?run=<runId>  (알림 link 형식)

const WF_NODES = {
  ask_rag: { label: 'HR 규정 질문', fields: [['question', 'textarea', '질문', true]] },
  ask_personal: { label: '내 문서 질문', fields: [['question', 'textarea', '질문', true]] },
  transcribe: { label: '전사 확인', hint: '이미 전사가 끝난 문서만 사용할 수 있습니다.', fields: [['docId', 'text', '문서 ID', true]] },
  summarize: { label: '문서 요약', fields: [['docId', 'text', '문서 ID', true]] },
  reflect_coach: { label: '코치 리플렉션', fields: [['docId', 'text', '문서 ID', true]] },
  reflect_coachee: { label: '코칭 대상 리플렉션', fields: [['docId', 'text', '문서 ID', true]] },
  draft_pptx: { label: 'PPTX 초안', fields: [['title', 'text', '제목', true], ['bullets', 'textarea', '내용 (비우면 앞 단계 요약 사용)', false]] },
  email_draft: { label: '메일 초안', fields: [['to', 'text', '받는 사람', true], ['context', 'textarea', '메일 내용·맥락', true]] },
  send_email: { label: '메일 발송 (승인 필요)', approval: true, fields: [['to', 'text', '받는 사람', true], ['subject', 'text', '제목', true], ['body', 'textarea', '본문', true]] },
  create_task: { label: '할 일 만들기', fields: [['title', 'text', '제목', true], ['dueDate', 'date', '기한', false]] },
  llm: { label: '자유 프롬프트', hint: '앞 단계 출력은 {{input.docId}}, {{steps.<단계id>.output.<키>}} 형태로 쓸 수 있습니다.', fields: [['prompt', 'textarea', '프롬프트', true]] },
  create_calendar_event: { label: '일정 만들기', hint: '시각은 한국 시간(KST)으로 입력합니다.', fields: [['title', 'text', '제목', true], ['start', 'datetime-local', '시작', true], ['end', 'datetime-local', '종료', true], ['allDay', 'checkbox', '종일', false]] },
  // WF-7 조건 분기. 폼에서는 간선(next)을 편집하지 않는다 (WF-10 캔버스) — 폼으로 만든 워크플로우는 배열 순서대로 흐른다.
  condition: { label: '조건 분기', hint: '연산자: contains, not_contains, equals, not_equals, exists, not_exists. 갈림길(참/거짓 다음 단계) 지정은 "캔버스 보기"에서 합니다 — 지정 전에는 순서대로 진행됩니다.', fields: [['source', 'textarea', '검사할 값 (예: {{steps.s1.output.text}})', true], ['operator', 'text', '연산자', true], ['value', 'text', '비교 값 (exists/not_exists는 비움)', false]] },
  // WF-9 웹훅. 필드 종류: select(5번째 원소=선택지), headers(키/값 행), json(본문 JSON 텍스트). 저장 시 서버 검증 오류를 그대로 보여준다.
  webhook: { label: '웹훅 호출 (승인 필요)', approval: true, hint: '외부 주소를 호출합니다. localhost·사설 IP·내부 주소는 차단되고, 10초 안에 응답이 없거나 응답이 256KB를 넘으면 실패합니다. URL·헤더 값·본문에 {{input.x}} 같은 변수를 쓸 수 있습니다.', fields: [['url', 'text', 'URL (https://…)', true], ['method', 'select', '메서드', false, ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']], ['headers', 'headers', '헤더 (이름 / 값)', false], ['body', 'json', '본문 (JSON, GET·DELETE는 비움)', false]] },
  // WF-6 에이전트 (최소 폼 — 디자인은 WF-11). tools는 쉼표 구분 노드 이름, 비우면 send_email 뺀 11개.
  agent: { label: '에이전트 (목표만 주기)', hint: '도구 예: ask_rag, create_task. 비우면 메일 발송을 뺀 모든 도구. 메일 발송을 고르면 실행 중 승인이 필요합니다.', fields: [['goal', 'textarea', '목표', true], ['tools', 'csv', '쓸 수 있는 도구 (쉼표 구분)', false], ['maxSteps', 'number', '최대 단계 수 (1~10, 기본 10)', false]] },
};
const WF_STATUS_KO = { draft: '초안', active: '사용 중', paused: '일시정지' };
const WF_RUN_KO = { queued: '대기', running: '실행 중', waiting_approval: '승인 대기', succeeded: '성공', failed: '실패', cancelled: '취소됨' };
const WF_STEP_KO = { pending: '대기', running: '실행 중', succeeded: '성공', failed: '실패', skipped: '건너뜀' };
const WF_KST_MS = 9 * 3600_000;

let wfList = [], wfCur = null /* {id|null, name, description, status, steps[], shared?, canCopy?} */, wfRuns = [], wfRun = null;
let wfShared = [] /* WF-9: 공유받은 워크플로우 + 템플릿 */, wfShares = [] /* 내 워크플로우의 공유 행 */;
const WF_VIA_KO = { department: '부서 공유', all: '전체 공유', template: '템플릿' };
let wfTemplates = [] /* 기업용 템플릿 (GET /api/workflows/templates) */, wfTplInput = null /* {id, json}: 템플릿으로 만든 워크플로우의 실행 입력 예시 */;
let wfEditIdx = null /* null: 폼 닫힘, -1: 새 단계, n: n번째 편집 */, wfSeq = 0, wfPoll = null, wfDirty = false;

// ---------- 작은 DOM 도우미 (textContent만 사용) ----------
function wfEl(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
function wfBtn(text, cls, onclick, extra) { return wfEl('button', Object.assign({ type: 'button', class: cls, onclick, text }, extra)); }
function wfBadge(text, cls) { return wfEl('span', { class: 'badge ' + (cls || ''), text }); }

// ---------- API ----------
async function wfApi(path, opts) {
  let r;
  try { r = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts)); }
  catch { throw new Error('네트워크 오류가 발생했습니다. 연결을 확인하세요.'); }
  let j = null;
  try { j = await r.json(); } catch { /* 본문 없음 */ }
  if (!r.ok) {
    const e = new Error((j && (j.error || j.message)) || `요청에 실패했습니다 (${r.status}).`);
    e.status = r.status;
    throw e;
  }
  return j || {};
}
function wfMsg(text, isErr) {
  const el = $('wfMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'wf-msg' + (isErr ? ' err' : '');
}
function wfFail(e, prefix) {
  if (e && e.status === 401) { wfMsg('로그인이 필요합니다. 로그인 후 다시 시도하세요.', true); return; }
  let m = (e && e.message) || '오류가 발생했습니다.';
  if (e && e.status === 429) m = '동시 실행 3개를 넘었거나 하루 실행 한도(20회)를 초과했습니다. ' + m;
  wfMsg((prefix ? prefix + ': ' : '') + m, true);
}

// ---------- 시간 ----------
function wfFmtTime(iso) {
  if (!iso) return '-';
  const ms = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(ms)) return iso;
  const k = new Date(ms + WF_KST_MS).toISOString();
  return `${k.slice(5, 10).replace('-', '/')} ${k.slice(11, 16)}`;
}
function wfDuration(a, b) {
  if (!a || !b) return '';
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  if (Number.isNaN(s) || s < 0) return '';
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
// datetime-local(KST 벽시계) <-> 엔진이 요구하는 UTC ISO
function wfLocalToUtc(v) {
  const ms = Date.parse(v + ':00Z');
  return Number.isNaN(ms) ? '' : new Date(ms - WF_KST_MS).toISOString().slice(0, 19) + 'Z';
}
function wfUtcToLocal(v) {
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? '' : new Date(ms + WF_KST_MS).toISOString().slice(0, 16);
}

// ---------- 해시 ----------
function wfParseSub(sub) {
  const [id, q] = String(sub || '').split('?');
  const run = q ? new URLSearchParams(q).get('run') : null;
  return { id: id || null, run };
}
function wfSetHash(id, run) {
  const h = '#workflow' + (id ? '/' + id + (run ? '?run=' + run : '') : '');
  if (location.hash !== h) history.replaceState(null, '', h); // hashchange를 일으키지 않는다
}

// ---------- 열기 / 떠나기 ----------
async function workflowOpen(mountEl, sub) {
  const root = mountEl || $('workflowMount');
  if (!root) return;
  const seq = ++wfSeq;
  if (!root.dataset.ready) { wfBuildShell(root); root.dataset.ready = '1'; }
  const { id, run } = wfParseSub(sub);
  await wfLoadList();
  await wfLoadSharedList();
  await wfLoadPending();
  await wfLoadTemplates();
  if (seq !== wfSeq) return;
  if (id) {
    await wfSelect(id, run, true);
  } else if (!wfCur) {
    wfRender();
  }
}
function workflowLeave() {
  wfSeq++;
  if (wfPoll) { clearTimeout(wfPoll); wfPoll = null; }
}

function wfBuildShell(root) {
  root.textContent = '';
  root.append(
    wfEl('div', { class: 'card wf-card' },
      wfEl('h2', { text: '워크플로우' }),
      wfEl('p', { class: 'small', text: '단계를 쌓아 업무를 자동화합니다. 메일 발송 단계는 실행 중 사람의 승인을 거칩니다.' }),
      wfEl('div', { id: 'wfMsg', class: 'wf-msg', role: 'status' }),
      wfEl('div', { id: 'wfPending', class: 'wf-pending' }),
      wfEl('div', { class: 'wf-layout' },
        wfEl('aside', { class: 'wf-side' },
          wfBtn('+ 새 워크플로우', 'primary', wfNew),
          wfBtn('템플릿으로 시작하기', 'secondary', wfShowIntro),
          wfEl('ul', { id: 'wfList', class: 'wf-list' }),
          wfEl('h3', { class: 'wf-side-h', text: '공유받은 워크플로우' }),
          wfEl('ul', { id: 'wfSharedList', class: 'wf-list' })),
        wfEl('div', { class: 'wf-main', id: 'wfMain' }))));
}

// ---------- 목록 ----------
async function wfLoadList() {
  try { wfList = (await wfApi('/api/workflows')).workflows || []; }
  catch (e) { wfList = []; wfFail(e, '목록을 불러오지 못했습니다'); }
  wfRenderList();
}
function wfRenderList() {
  const ul = $('wfList');
  if (!ul) return;
  ul.textContent = '';
  if (!wfList.length) { ul.append(wfEl('li', { class: 'small', text: '아직 워크플로우가 없습니다.' })); return; }
  for (const w of wfList) {
    const li = wfEl('li', { class: 'wf-item' + (wfCur && wfCur.id === w.id ? ' sel' : '') },
      wfEl('button', { type: 'button', class: 'wf-item-btn', onclick: () => wfSelect(w.id) },
        wfEl('span', { class: 'wf-item-name', text: w.name }),
        wfBadge(WF_STATUS_KO[w.status] || w.status, w.status === 'active' ? 'ok' : w.status === 'paused' ? 'warn' : ''),
        w.is_template ? wfBadge('템플릿') : null,
        wfEl('span', { class: 'small wf-item-sub', text: '수정 ' + wfFmtTime(w.updated_at) })));
    ul.append(li);
  }
}

// ---------- 공유받은 목록 (WF-9) ----------
async function wfLoadSharedList() {
  try { wfShared = (await wfApi('/api/workflows/shared')).workflows || []; }
  catch (e) { wfShared = []; if (e.status === 401) wfFail(e); }
  wfRenderSharedList();
}
function wfRenderSharedList() {
  const ul = $('wfSharedList');
  if (!ul) return;
  ul.textContent = '';
  if (!wfShared.length) { ul.append(wfEl('li', { class: 'small', text: '공유받은 워크플로우가 없습니다.' })); return; }
  for (const w of wfShared) {
    ul.append(wfEl('li', { class: 'wf-item' + (wfCur && wfCur.shared && wfCur.id === w.id ? ' sel' : '') },
      wfEl('button', { type: 'button', class: 'wf-item-btn', onclick: () => wfSelect(w.id) },
        wfEl('span', { class: 'wf-item-name', text: w.name }),
        wfBadge(WF_VIA_KO[w.shared_via] || w.shared_via, w.shared_via === 'template' ? 'ok' : ''),
        wfEl('span', { class: 'small wf-item-sub', text: w.can_copy ? '보기 · 복사 가능' : '보기만 가능' }))));
  }
}

// ---------- 승인 대기 ----------
async function wfLoadPending() {
  const box = $('wfPending');
  if (!box) return;
  let items = [];
  try {
    const j = await wfApi('/api/approval/notifications?unread=1');
    items = (j.notifications || []).filter((n) => n.type === 'WORKFLOW_APPROVAL');
  } catch (e) { if (e.status === 401) wfFail(e); }
  box.textContent = '';
  if (!items.length) return;
  box.append(wfEl('h3', { text: `승인 대기 (${items.length})` }));
  for (const n of items) {
    const m = /\/#workflow\/([^?]+)\?run=(.+)$/.exec(n.link || '');
    box.append(wfEl('div', { class: 'wf-pend-row' },
      wfEl('span', { class: 'wf-pend-title', text: n.title }),
      m ? wfBtn('열기', 'secondary', () => wfSelect(m[1], m[2])) : null));
  }
}

// ---------- 선택 / 새로 만들기 ----------
function wfNew() {
  if (!wfConfirmLeave()) return;
  wfCur = { id: null, name: '', description: '', status: 'draft', steps: [] };
  wfRuns = []; wfRun = null; wfEditIdx = null; wfDirty = false; wfShares = [];
  wfSetHash(null);
  wfRender();
}
// ---------- 기업용 템플릿 (2026-11-19) ----------
const WF_APPROVAL_TYPES = ['send_email', 'webhook'];
async function wfLoadTemplates() {
  try { wfTemplates = (await wfApi('/api/workflows/templates')).templates || []; }
  catch (e) { wfTemplates = []; if (e.status === 401) wfFail(e); }
}
function wfShowIntro() {
  if (!wfConfirmLeave()) return;
  wfCur = null; wfRuns = []; wfRun = null; wfEditIdx = null; wfDirty = false;
  wfSetHash(null);
  wfRender();
}
// 빈 화면: 한 줄 설명 + 템플릿 카드
function wfRenderIntro(main) {
  main.append(
    wfEl('div', { class: 'wf-intro' },
      wfEl('h3', { text: '워크플로우가 뭐예요?' }),
      wfEl('p', { class: 'small', text: '할 일을 순서대로 이어붙인 자동화입니다. 템플릿을 골라 시작하거나 빈 워크플로우를 만드세요.' })),
    wfEl('h3', { text: '템플릿으로 시작하기' }),
    wfEl('div', { class: 'wf-tpl-grid', id: 'wfTplGrid' }));
  const grid = $('wfTplGrid');
  if (!wfTemplates.length) { grid.append(wfEl('p', { class: 'small', text: '템플릿을 불러오지 못했습니다. 새로고침하거나 "+ 새 워크플로우"로 시작하세요.' })); return; }
  for (const t of wfTemplates) {
    const needsApproval = t.steps.some((s) => WF_APPROVAL_TYPES.includes(s.type));
    grid.append(wfEl('div', { class: 'wf-tpl-card' },
      wfEl('b', { class: 'wf-tpl-name', text: t.name }),
      wfEl('p', { class: 'small', text: t.description }),
      wfEl('div', { class: 'wf-tpl-meta' },
        wfBadge(`${t.steps.length}단계`),
        needsApproval ? wfBadge('승인이 필요한 단계', 'warn') : ''),
      needsApproval ? wfEl('p', { class: 'small wf-tpl-warn', text: '메일 발송·웹훅 단계는 사람이 승인해야 실행됩니다.' }) : '',
      wfEl('ol', { class: 'small wf-tpl-steps' }, t.steps.map((s) => wfEl('li', { text: s.name }))),
      wfBtn('이 템플릿으로 만들기', 'primary', () => wfUseTemplate(t.id), { 'data-tpl': t.id })));
  }
}
async function wfUseTemplate(tplId) {
  const t = wfTemplates.find((x) => x.id === tplId);
  if (!t) return;
  const btns = () => document.querySelectorAll('.wf-tpl-card button');
  for (const b of btns()) b.disabled = true;
  try {
    const j = await wfApi('/api/workflows', { method: 'POST', body: JSON.stringify({ name: t.name, description: t.description, definition: { version: 1, steps: t.steps } }) });
    const ex = {};
    for (const i of t.inputs || []) ex[i.key] = i.example;
    wfTplInput = { id: j.workflow.id, json: JSON.stringify(ex, null, 2) };
    wfDirty = false;
    await wfLoadList();
    await wfSelect(j.workflow.id, null, true);
    wfMsg(`"${t.name}" 템플릿으로 만들었습니다. 이름을 바꾸고, 각 단계의 설정을 바꾼 뒤 저장하세요. 실행 입력 예시는 "고급 입력"에 채워져 있습니다.`);
  } catch (e) { wfFail(e, '템플릿으로 만들지 못했습니다'); for (const b of btns()) b.disabled = false; }
}
function wfConfirmLeave() { return !wfDirty || confirm('저장하지 않은 변경이 있습니다. 버리고 이동할까요?'); }

async function wfSelect(id, runId, force) {
  if (!force && !wfConfirmLeave()) return;
  const seq = wfSeq;
  try {
    const j = await wfApi('/api/workflows/' + encodeURIComponent(id));
    if (seq !== wfSeq) return;
    const w = j.workflow;
    const shared = j.shared === true; // WF-9: 남의 워크플로우(공유·템플릿) — 보기/복사만, run·공유 API는 부르지 않는다
    wfCur = { id: w.id, name: w.name, description: w.description || '', status: w.status, steps: JSON.parse(JSON.stringify((w.definition && w.definition.steps) || [])), shared, canCopy: j.can_copy === true, is_template: !!w.is_template };
    wfDirty = false; wfEditIdx = null; wfRun = null;
    if (shared) { wfRuns = []; wfShares = []; wfSchedules = []; } else { await wfLoadRuns(); await wfLoadShares(); await wfLoadSchedules(); }
    if (seq !== wfSeq) return;
    wfSetHash(id, shared ? null : runId);
    wfRender();
    if (runId && !shared) await wfOpenRun(runId);
  } catch (e) { wfFail(e, '워크플로우를 열지 못했습니다'); }
}

// ---------- 편집 화면 ----------
function wfRender() {
  wfRenderList();
  wfRenderSharedList();
  const main = $('wfMain');
  if (!main) return;
  main.textContent = '';
  if (!wfCur) { wfRenderIntro(main); return; }
  if (wfCur.shared) { wfRenderSharedView(main); return; }
  const hasSend = wfCur.steps.some((s) => s.type === 'send_email');

  const nameIn = wfEl('input', { type: 'text', id: 'wfName', maxlength: '100', placeholder: '워크플로우 이름' });
  nameIn.value = wfCur.name;
  nameIn.oninput = () => { wfCur.name = nameIn.value; wfDirty = true; };
  const descIn = wfEl('textarea', { id: 'wfDesc', rows: '2', placeholder: '설명 (선택)' });
  descIn.value = wfCur.description;
  descIn.oninput = () => { wfCur.description = descIn.value; wfDirty = true; };
  const stSel = wfEl('select', { id: 'wfStatus' }, Object.entries(WF_STATUS_KO).map(([v, t]) => wfEl('option', { value: v, text: t })));
  stSel.value = wfCur.status;
  stSel.onchange = () => { wfCur.status = stSel.value; wfDirty = true; };

  main.append(
    wfEl('h3', { text: wfCur.id ? '워크플로우 편집' : '새 워크플로우' }),
    wfEl('label', { class: 'wf-label', for: 'wfName', text: '이름' }), nameIn,
    wfEl('label', { class: 'wf-label', for: 'wfDesc', text: '설명' }), descIn,
    wfEl('label', { class: 'wf-label', for: 'wfStatus', text: '상태' }), stSel,
    wfEl('h3', { text: `단계 (${wfCur.steps.length})` }),
    wfcViewToggle(), // WF-10: 폼 보기 / 캔버스 보기 (같은 wfCur.steps)
    wfEl('div', { id: 'wfStepsArea' }),
    wfEl('div', { id: 'wfStepForm' }),
    wfEl('div', { class: 'wf-actions' },
      wfBtn('+ 단계 추가', 'secondary', () => { wfEditIdx = -1; wfRenderStepForm(); }),
      wfBtn('워크플로우 저장', 'primary', wfSave, { id: 'wfSaveBtn' }),
      wfCur.id ? wfBtn('삭제', 'secondary wf-danger', wfDelete) : null,
      hasSend ? wfEl('span', { class: 'wf-note', text: '메일 발송 단계는 실행 중 승인이 필요합니다' }) : null),
    // 주의: Element.append(null)은 글자 "null"을 붙인다 — 조건부 항목은 null 대신 빈 문자열을 쓴다 (브라우저 검증 2026-11-18, 문제 4).
    wfCur.id ? wfEl('div', { id: 'wfShareArea', class: 'wf-sharearea' }) : '',
    wfCur.id ? wfEl('div', { id: 'wfScheduleArea', class: 'wf-sharearea' }) : '',
    wfCur.id ? wfEl('div', { id: 'wfRunArea', class: 'wf-runarea' }) : wfEl('p', { class: 'small', text: '저장하면 실행할 수 있습니다.' }));
  wfRenderStepsArea(); // workflow-canvas.js — 폼 목록(wfRenderSteps) 또는 캔버스
  wfRenderStepForm();
  if (wfCur.id) { wfRenderShareArea(); wfRenderScheduleArea(); wfRenderRunArea(); }
}

// ---------- 공유받은 워크플로우 보기 (WF-9) — 읽기 전용, 실행 버튼 없음 ----------
function wfRenderSharedView(main) {
  main.append(
    wfEl('h3', { text: wfCur.name }),
    wfCur.description ? wfEl('p', { class: 'small', text: wfCur.description }) : '',
    wfEl('p', { class: 'wf-note', text: '공유받은 워크플로우는 직접 실행할 수 없습니다. 복사한 뒤 내 복사본에서 실행하세요.' }),
    wfEl('div', { class: 'wf-actions' },
      wfCur.canCopy ? wfBtn('내 워크플로우로 복사', 'primary wf-copy', wfCopy, { id: 'wfCopyBtn' }) : wfEl('span', { class: 'small', text: '이 워크플로우는 보기만 가능합니다 (복사 권한 없음).' })),
    wfEl('h3', { text: `단계 (${wfCur.steps.length})` }),
    wfcViewToggle(), // WF-10: 캔버스는 읽기 전용으로 열린다
    wfEl('div', { id: 'wfStepsArea' }));
  wfRenderStepsArea();
}
function wfRenderSharedSteps() {
  const box = $('wfSteps');
  if (!box) return;
  wfCur.steps.forEach((s, i) => {
    const def = WF_NODES[s.type] || { label: s.type };
    box.append(wfEl('div', { class: 'wf-step' },
      wfEl('div', { class: 'wf-step-ord', text: String(i + 1) }),
      wfEl('div', { class: 'wf-step-body' },
        wfEl('div', { class: 'wf-step-head' }, wfEl('b', { text: s.name }), ' ', wfBadge(def.label), s.requiresApproval ? wfBadge('승인 필요', 'warn') : null),
        wfEl('div', { class: 'small wf-step-sum', text: wfSummary(s) }),
        wfEl('div', { class: 'small wf-step-next', text: wfcNextLabel(wfCur.steps, i) }))));
  });
}
async function wfCopy() {
  if (!wfCur || !wfCur.shared || !wfCur.canCopy) return;
  const btn = $('wfCopyBtn');
  if (btn) btn.disabled = true;
  try {
    const j = await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/copy`, { method: 'POST' });
    wfDirty = false;
    await wfLoadList();
    await wfSelect(j.workflow.id, null, true);
    wfMsg('내 워크플로우로 복사했습니다. 이제 실행할 수 있습니다.');
  } catch (e) { wfFail(e, '복사하지 못했습니다'); if (btn) btn.disabled = false; }
}

// ---------- 내 워크플로우의 공유 관리 (WF-9) ----------
async function wfLoadShares() {
  if (!wfCur || !wfCur.id || wfCur.shared) { wfShares = []; return; }
  try { wfShares = (await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/shares`)).shares || []; }
  catch (e) { wfShares = []; wfFail(e, '공유 목록을 불러오지 못했습니다'); }
}
function wfRenderShareArea() {
  const area = $('wfShareArea');
  if (!area) return;
  area.textContent = '';
  const scope = wfEl('select', { id: 'wfShScope', 'aria-label': '공유 범위' }, [['department', '같은 부서'], ['all', '전체 조직']].map(([v, t]) => wfEl('option', { value: v, text: t })));
  const perm = wfEl('select', { id: 'wfShPerm', 'aria-label': '권한' }, [['view', '보기만'], ['copy', '보기 + 복사']].map(([v, t]) => wfEl('option', { value: v, text: t })));
  const ul = wfEl('ul', { class: 'wf-shares' });
  if (!wfShares.length) ul.append(wfEl('li', { class: 'small', text: '공유하지 않았습니다 (나만 볼 수 있음).' }));
  for (const s of wfShares) {
    ul.append(wfEl('li', { class: 'wf-share-row' },
      wfEl('span', { text: `${s.scope === 'all' ? '전체 조직' : '같은 부서'} · ${s.permission === 'copy' ? '보기 + 복사' : '보기만'}` }),
      wfBtn('공유 해제', 'secondary wf-danger', () => wfShareDelete(s.id))));
  }
  area.append(
    wfEl('h3', { text: '공유' }),
    wfEl('p', { class: 'small', text: '공유한 사람은 보기·복사만 할 수 있습니다. 실행은 항상 복사한 본인의 권한으로 합니다.' }),
    wfEl('div', { class: 'wf-actions' }, scope, perm, wfBtn('공유 추가', 'secondary', wfShareAdd, { id: 'wfShAddBtn' })),
    ul);
  // WF-11: 조직 템플릿 지정은 HR 관리자에게만 보인다 (서버도 hr_admin만 통과시킨다).
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'hr_admin') {
    const cb = wfEl('input', { type: 'checkbox', id: 'wfTemplateToggle' });
    cb.checked = !!wfCur.is_template;
    cb.onchange = () => wfSetTemplate(cb);
    area.append(wfEl('div', { class: 'wf-template-row' },
      wfEl('label', { for: 'wfTemplateToggle' }, cb, ' 조직 템플릿으로 지정'),
      wfEl('p', { class: 'small', text: '템플릿으로 지정하면 조직 전원이 이 워크플로우를 보고 복사할 수 있습니다.' })));
  }
}
async function wfSetTemplate(cb) {
  const want = cb.checked;
  cb.disabled = true;
  try {
    const j = await wfApi('/api/workflows/' + encodeURIComponent(wfCur.id), { method: 'PATCH', body: JSON.stringify({ is_template: want }) });
    wfCur.is_template = !!j.workflow.is_template;
    await wfLoadList();
    wfMsg(want ? '조직 템플릿으로 지정했습니다.' : '조직 템플릿 지정을 해제했습니다.');
  } catch (e) { cb.checked = !want; wfFail(e, '템플릿 지정을 바꾸지 못했습니다'); }
  finally { cb.disabled = false; }
}

// ---------- 스케줄 (WF-11 — API는 WF-8) ----------
let wfSchedules = [];
const WF_EVENT_KO = { transcript_completed: '전사 완료' };
// 분 필드를 펼쳐 0/15/30/45가 아닌 값이 있으면 true. 해석할 수 없는 식은 false (형식 오류는 서버가 알려 준다).
function wfCronMinuteOffSlot(cron) {
  const field = String(cron || '').trim().split(/\s+/)[0];
  if (!field || field === '*') return false; // 매 분 = 모든 슬롯에서 맞는다
  const vals = new Set();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return false;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!(step >= 1)) return false;
    let lo, hi;
    if (m[1] === '*') { lo = 0; hi = 59; }
    else if (m[1].includes('-')) { [lo, hi] = m[1].split('-').map(Number); }
    else { lo = Number(m[1]); hi = m[2] === undefined ? lo : 59; }
    if (!(lo >= 0 && hi <= 59 && lo <= hi)) return false;
    for (let v = lo; v <= hi; v += step) vals.add(v);
  }
  return [...vals].some((v) => v % 15 !== 0);
}
const WF_CRON_WARN = '크론은 15분마다 돌기 때문에 분이 0·15·30·45가 아니면 실행되지 않을 수 있습니다.';
async function wfLoadSchedules() {
  if (!wfCur || !wfCur.id || wfCur.shared) { wfSchedules = []; return; }
  try { wfSchedules = (await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/schedules`)).schedules || []; }
  catch (e) { wfSchedules = []; wfFail(e, '스케줄을 불러오지 못했습니다'); }
}
function wfRenderScheduleArea() {
  const area = $('wfScheduleArea');
  if (!area) return;
  area.textContent = '';
  const kind = wfEl('select', { id: 'wfSchKind', 'aria-label': '트리거 종류' },
    [['schedule', '정해진 시각에 (크론)'], ['event', '이벤트가 생기면']].map(([v, t]) => wfEl('option', { value: v, text: t })));
  const cron = wfEl('input', { type: 'text', id: 'wfSchCron', placeholder: '분 시 일 월 요일 (예: 0 9 * * 1-5)', 'aria-label': '크론 식' });
  const ev = wfEl('select', { id: 'wfSchEvent', 'aria-label': '이벤트' }, Object.entries(WF_EVENT_KO).map(([v, t]) => wfEl('option', { value: v, text: t })));
  const warn = wfEl('div', { id: 'wfSchWarn', class: 'wf-note', role: 'status' });
  const sync = () => {
    const isCron = kind.value === 'schedule';
    cron.style.display = isCron ? '' : 'none';
    ev.style.display = isCron ? 'none' : '';
    warn.textContent = isCron && wfCronMinuteOffSlot(cron.value) ? WF_CRON_WARN : '';
  };
  kind.onchange = sync;
  cron.oninput = sync;
  const ul = wfEl('ul', { class: 'wf-shares', id: 'wfSchList' });
  if (!wfSchedules.length) ul.append(wfEl('li', { class: 'small', text: '스케줄이 없습니다.' }));
  for (const s of wfSchedules) {
    const cb = wfEl('input', { type: 'checkbox', 'aria-label': '사용' });
    cb.checked = !!s.enabled;
    cb.onchange = () => wfScheduleToggle(s.id, cb);
    ul.append(wfEl('li', { class: 'wf-share-row', 'data-sid': s.id },
      wfEl('span', { text: (s.trigger_type === 'schedule' ? `스케줄 · ${s.cron}` : `이벤트 · ${WF_EVENT_KO[s.event] || s.event}`) + ` · 마지막 실행 ${s.last_run_at ? wfFmtTime(s.last_run_at) : '없음'}` }),
      wfEl('label', {}, cb, ' 사용'),
      wfBtn('삭제', 'secondary wf-danger', () => wfScheduleDelete(s.id))));
  }
  area.append(
    wfEl('h3', { text: '스케줄' }),
    wfEl('p', { class: 'small', text: '크론 시각은 한국 시간(KST) 기준이며 15분 단위로 확인합니다. 이벤트는 "전사 완료" 시 이 워크플로우를 자동 실행합니다.' }),
    wfEl('p', { class: 'small wf-note', text: '워크플로우 상태가 "사용 중"일 때만 스케줄이 돕니다. 일시정지·초안이면 스케줄이 있어도 실행되지 않습니다.' }),
    wfEl('div', { class: 'wf-actions' }, kind, cron, ev, wfBtn('스케줄 추가', 'secondary', wfScheduleAdd, { id: 'wfSchAddBtn' })),
    warn, ul);
  sync();
}
async function wfScheduleAdd() {
  const isCron = $('wfSchKind').value === 'schedule';
  const body = isCron ? { trigger_type: 'schedule', cron: $('wfSchCron').value.trim() } : { trigger_type: 'event', event: $('wfSchEvent').value };
  if (isCron && !body.cron) { wfMsg('크론 식을 입력하세요.', true); return; }
  const btn = $('wfSchAddBtn');
  if (btn) btn.disabled = true;
  try {
    await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/schedules`, { method: 'POST', body: JSON.stringify(body) });
    const offSlot = isCron && wfCronMinuteOffSlot(body.cron);
    await wfLoadSchedules();
    wfRenderScheduleArea();
    wfMsg(offSlot ? '스케줄을 저장했습니다. 주의: ' + WF_CRON_WARN : '스케줄을 저장했습니다.');
  } catch (e) { wfFail(e, '스케줄을 저장하지 못했습니다'); if (btn) btn.disabled = false; }
}
async function wfScheduleToggle(sid, cb) {
  const want = cb.checked;
  cb.disabled = true;
  try {
    await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/schedules/${encodeURIComponent(sid)}`, { method: 'PATCH', body: JSON.stringify({ enabled: want }) });
    const s = wfSchedules.find((x) => x.id === sid);
    if (s) s.enabled = want ? 1 : 0;
    wfMsg(want ? '스케줄을 켰습니다.' : '스케줄을 껐습니다.');
  } catch (e) { cb.checked = !want; wfFail(e, '스케줄을 바꾸지 못했습니다'); }
  finally { cb.disabled = false; }
}
async function wfScheduleDelete(sid) {
  if (!confirm('이 스케줄을 삭제할까요?')) return;
  try {
    await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/schedules/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    await wfLoadSchedules();
    wfRenderScheduleArea();
    wfMsg('스케줄을 삭제했습니다.');
  } catch (e) { wfFail(e, '스케줄을 삭제하지 못했습니다'); }
}

// ---------- 홈 카드 (WF-11) — fail-soft: 어떤 실패든 카드를 비워 둔다 (에러 문구 없음) ----------
async function wfHomeCard(box) {
  if (!box) return;
  try {
    const list = (await wfApi('/api/workflows')).workflows || [];
    if (!list.length) { box.textContent = ''; box.append(wfEl('p', { class: 'empty', text: '아직 워크플로우가 없습니다.' })); return; }
    const recent = [...list].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 3);
    const runLists = await Promise.all(recent.map((w) => wfApi(`/api/workflows/${encodeURIComponent(w.id)}/runs`).then((j) => (j.runs || []).slice(0, 3).map((r) => Object.assign({}, r, { wfName: w.name }))).catch(() => [])));
    const runs = runLists.flat().sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, 3);
    const waiting = new Set(runLists.flat().filter((r) => r.status === 'waiting_approval').map((r) => r.id));
    try {
      const n = (await wfApi('/api/approval/notifications?unread=1')).notifications || [];
      for (const x of n) { const m = x.type === 'WORKFLOW_APPROVAL' && /\?run=(.+)$/.exec(x.link || ''); if (m) waiting.add(m[1]); }
    } catch { /* 알림 조회 실패는 무시 */ }
    box.textContent = '';
    box.append(wfEl('div', { class: 'small', text: `내 워크플로우 ${list.length}개` }),
      waiting.size ? wfEl('div', {}, wfBadge(`승인 대기 ${waiting.size}`, 'err')) : null);
    if (!runs.length) box.append(wfEl('p', { class: 'empty', text: '최근 실행이 없습니다.' }));
    for (const r of runs) {
      box.append(wfEl('div', { class: 'taskrow', style: 'cursor:pointer', onclick: () => switchTab('workflow/' + r.workflow_id + '?run=' + r.id) },
        wfEl('span', { class: 't-title', text: r.wfName }),
        wfBadge(WF_RUN_KO[r.status] || r.status, wfRunCls(r.status)),
        wfEl('span', { class: 't-src', text: wfFmtTime(r.started_at) })));
    }
  } catch { box.textContent = ''; }
}
async function wfShareAdd() {
  const btn = $('wfShAddBtn');
  if (btn) btn.disabled = true;
  try {
    await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/shares`, { method: 'POST', body: JSON.stringify({ scope: $('wfShScope').value, permission: $('wfShPerm').value }) });
    await wfLoadShares();
    wfRenderShareArea();
    wfMsg('공유를 저장했습니다.');
  } catch (e) { wfFail(e, '공유하지 못했습니다'); if (btn) btn.disabled = false; }
}
async function wfShareDelete(shareId) {
  try {
    await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
    await wfLoadShares();
    wfRenderShareArea();
    wfMsg('공유를 해제했습니다.');
  } catch (e) { wfFail(e, '공유를 해제하지 못했습니다'); }
}

function wfSummary(s) {
  const def = WF_NODES[s.type];
  if (!def) return '';
  const parts = [];
  for (const [k, kind, label] of def.fields) {
    let v = s.config ? s.config[k] : undefined;
    if (v === undefined || v === '' || v === false) continue;
    if (k === 'start' || k === 'end') v = wfUtcToLocal(String(v)).replace('T', ' ') || v;
    if (kind === 'checkbox') v = '예';
    if (v !== null && typeof v === 'object') { try { v = JSON.stringify(v); } catch { v = '(표시 불가)'; } }
    if (k === 'headers' && typeof v === 'string') { try { v = Object.keys(JSON.parse(v)).join(', '); } catch { /* 그대로 */ } } // 값(토큰 가능)은 요약에 싣지 않는다
    v = String(v);
    parts.push(`${label}: ${v.length > 60 ? v.slice(0, 60) + '…' : v}`);
  }
  return parts.join(' · ');
}

function wfRenderSteps() {
  const box = $('wfSteps');
  if (!box) return;
  box.textContent = '';
  if (!wfCur.steps.length) { box.append(wfEl('p', { class: 'small', text: '단계가 없습니다. "단계 추가"로 시작하세요.' })); return; }
  wfCur.steps.forEach((s, i) => {
    const def = WF_NODES[s.type] || { label: s.type };
    box.append(wfEl('div', { class: 'wf-step' },
      wfEl('div', { class: 'wf-step-ord', text: String(i + 1) }),
      wfEl('div', { class: 'wf-step-body' },
        wfEl('div', { class: 'wf-step-head' },
          wfEl('b', { text: s.name }), ' ',
          wfBadge(def.label), ' ',
          wfEl('span', { class: 'small', text: s.id }),
          s.type === 'send_email' || s.requiresApproval ? wfBadge('승인 필요', 'warn') : null),
        wfEl('div', { class: 'small wf-step-sum', text: wfSummary(s) }),
        wfEl('div', { class: 'small wf-step-next', text: wfcNextLabel(wfCur.steps, i) })), // WF-10: 간선 1줄
      wfEl('div', { class: 'wf-step-ctl' },
        wfBtn('↑', 'iconbtn', () => wfMove(i, -1), { 'aria-label': '위로', disabled: i === 0 }),
        wfBtn('↓', 'iconbtn', () => wfMove(i, 1), { 'aria-label': '아래로', disabled: i === wfCur.steps.length - 1 }),
        wfBtn('편집', 'iconbtn wf-edit', () => { wfEditIdx = i; wfRenderStepForm(); }, { 'aria-label': '편집' }),
        wfBtn('×', 'iconbtn', () => wfRemove(i), { 'aria-label': '삭제' }))));
  });
}
function wfMove(i, d) {
  const j = i + d;
  if (j < 0 || j >= wfCur.steps.length) return;
  [wfCur.steps[i], wfCur.steps[j]] = [wfCur.steps[j], wfCur.steps[i]];
  wfEditIdx = null; wfDirty = true; wfRenderSteps(); wfRenderStepForm();
}
function wfRemove(i) {
  if (!confirm(`"${wfCur.steps[i].name}" 단계를 삭제할까요?`)) return;
  const removed = wfCur.steps.splice(i, 1)[0]; // id는 다시 부여하지 않는다
  wfCleanupEdgesAfterDelete(removed.id); // WF-10: 삭제된 단계를 가리키던 next 정리 (폼·캔버스 공용) + 1줄 알림
  wfEditIdx = null; wfDirty = true; wfRender();
}
function wfNextId() {
  let max = 0;
  for (const s of wfCur.steps) { const m = /^s(\d+)$/.exec(s.id); if (m) max = Math.max(max, Number(m[1])); }
  return 's' + (max + 1);
}

// ---------- 단계 추가 / 편집 폼 ----------
function wfRenderStepForm() {
  const box = $('wfStepForm');
  if (!box) return;
  box.textContent = '';
  if (wfEditIdx === null) return;
  const editing = wfEditIdx >= 0 ? wfCur.steps[wfEditIdx] : null;
  const typeSel = wfEl('select', { id: 'wfType', disabled: !!editing });
  typeSel.append(wfEl('option', { value: '', text: '— 노드 종류 선택 —' }));
  for (const [t, d] of Object.entries(WF_NODES)) typeSel.append(wfEl('option', { value: t, text: d.label }));
  typeSel.value = editing ? editing.type : '';
  const fieldsBox = wfEl('div', { id: 'wfFields' });
  const nameIn = wfEl('input', { type: 'text', id: 'wfStepName', maxlength: '100', placeholder: '단계 이름' });
  nameIn.value = editing ? editing.name : '';
  const err = wfEl('div', { class: 'wf-msg err', id: 'wfStepErr' });

  const drawFields = () => {
    fieldsBox.textContent = '';
    const t = typeSel.value;
    if (!t) return;
    const def = WF_NODES[t];
    if (!editing && !nameIn.value) nameIn.value = def.label.replace(' (승인 필요)', '');
    if (def.hint) fieldsBox.append(wfEl('p', { class: 'small wf-hint', text: def.hint }));
    if (def.approval) fieldsBox.append(wfEl('p', { class: 'wf-note', text: '이 단계는 실행 중 승인이 필요합니다.' }));
    for (const [k, kind, label, req] of def.fields) {
      const id = 'wff_' + k;
      const cur = editing && editing.config ? editing.config[k] : undefined;
      let inp;
      if (kind === 'textarea') { inp = wfEl('textarea', { id, rows: '3' }); inp.value = cur ?? ''; }
      else if (kind === 'json') {
        inp = wfEl('textarea', { id, rows: '4', placeholder: '{"text": "{{steps.s1.output.text}}"}' });
        inp.value = cur === undefined ? '' : (typeof cur === 'string' ? cur : JSON.stringify(cur, null, 2));
      }
      else if (kind === 'select') {
        inp = wfEl('select', { id }, (def.fields.find((f) => f[0] === k)[4] || []).map((o) => wfEl('option', { value: o, text: o })));
        inp.value = cur || 'POST';
      }
      else if (kind === 'headers') {
        // 이름/값 1쌍 이상. 기존 값이 있으면 채우고, 모자라면 빈 행을 더한다.
        inp = wfEl('div', { id, class: 'wf-hdrs' });
        const addRow = (hk, hv) => {
          const kIn = wfEl('input', { type: 'text', class: 'wf-hdr-k', placeholder: '헤더 이름', 'aria-label': '헤더 이름' });
          const vIn = wfEl('input', { type: 'text', class: 'wf-hdr-v', placeholder: '값', 'aria-label': '헤더 값' });
          kIn.value = hk || ''; vIn.value = hv || '';
          inp.append(wfEl('div', { class: 'wf-hdr-row' }, kIn, vIn));
        };
        const pairs = cur && typeof cur === 'object' ? Object.entries(cur) : [];
        for (const [hk, hv] of pairs) addRow(hk, String(hv));
        if (!pairs.length) addRow('', '');
        inp.append(wfBtn('+ 헤더 추가', 'secondary', () => { const b = inp.lastChild; inp.removeChild(b); addRow('', ''); inp.append(b); }));
      }
      else if (kind === 'checkbox') { inp = wfEl('input', { type: 'checkbox', id }); inp.checked = cur === true; }
      else {
        inp = wfEl('input', { type: kind === 'text' || kind === 'csv' ? 'text' : kind, id });
        inp.value = cur == null ? '' : (kind === 'datetime-local' ? wfUtcToLocal(String(cur)) : String(cur));
      }
      fieldsBox.append(wfEl('label', { class: 'wf-label', for: id, text: label + (req ? ' *' : '') }), inp);
    }
  };
  typeSel.onchange = drawFields;

  const done = () => {
    err.textContent = '';
    const t = typeSel.value;
    if (!t) { err.textContent = '노드 종류를 선택하세요.'; return; }
    const def = WF_NODES[t];
    const name = nameIn.value.trim();
    if (!name) { err.textContent = '단계 이름을 입력하세요.'; return; }
    const config = {};
    for (const [k, kind, label, req] of def.fields) {
      const el = $('wff_' + k);
      if (kind === 'checkbox') { if (el.checked) config[k] = true; continue; }
      if (kind === 'headers') {
        const h = {};
        for (const row of el.querySelectorAll('.wf-hdr-row')) {
          const hk = row.querySelector('.wf-hdr-k').value.trim(), hv = row.querySelector('.wf-hdr-v').value;
          if (!hk) continue;
          h[hk] = hv;
        }
        if (Object.keys(h).length) config[k] = h;
        continue;
      }
      let v = el.value.trim();
      if (kind === 'json' && v) {
        try { config[k] = JSON.parse(v); } catch { err.textContent = `${label}이(가) 올바른 JSON이 아닙니다.`; return; }
        continue;
      }
      if (kind === 'select') { if (v && v !== 'POST') config[k] = v; continue; } // 기본값(POST)은 저장하지 않는다
      if (!v) { if (req) { err.textContent = `${label}을(를) 입력하세요.`; return; } continue; }
      if (kind === 'datetime-local') { v = wfLocalToUtc(v); if (!v) { err.textContent = `${label} 시각이 올바르지 않습니다.`; return; } }
      if (kind === 'csv') { config[k] = v.split(',').map((x) => x.trim()).filter(Boolean); continue; }
      if (kind === 'number') { config[k] = Number(v); continue; }
      config[k] = v;
    }
    const step = { id: editing ? editing.id : wfNextId(), type: t, name, config };
    if (def.approval) step.requiresApproval = true;
    if (editing && editing.next !== undefined) step.next = editing.next; // WF-7: 캔버스에서 만든 간선을 편집 때 잃지 않는다
    if (editing) wfCur.steps[wfEditIdx] = step; else wfCur.steps.push(step);
    wfEditIdx = null; wfDirty = true; wfRender();
  };

  box.append(wfEl('div', { class: 'wf-form' },
    wfEl('h3', { text: editing ? '단계 편집' : '단계 추가' }),
    wfEl('label', { class: 'wf-label', for: 'wfType', text: '노드 종류' }), typeSel,
    wfEl('label', { class: 'wf-label', for: 'wfStepName', text: '단계 이름' }), nameIn,
    fieldsBox, err,
    wfEl('div', { class: 'wf-actions' },
      wfBtn(editing ? '단계 변경' : '단계 넣기', 'primary', done),
      wfBtn('취소', 'secondary', () => { wfEditIdx = null; wfRenderStepForm(); }))));
  drawFields();
}

// ---------- 저장 / 삭제 ----------
async function wfSave() {
  const name = (wfCur.name || '').trim();
  if (!name) { wfMsg('이름을 입력하세요.', true); return; }
  if (!wfCur.steps.length) { wfMsg('단계를 1개 이상 추가하세요.', true); return; }
  const definition = { version: 1, steps: wfCur.steps };
  const btn = $('wfSaveBtn');
  if (btn) btn.disabled = true;
  try {
    let j;
    if (wfCur.id) {
      j = await wfApi('/api/workflows/' + encodeURIComponent(wfCur.id), { method: 'PATCH', body: JSON.stringify({ name, description: wfCur.description, status: wfCur.status, definition }) });
    } else {
      j = await wfApi('/api/workflows', { method: 'POST', body: JSON.stringify({ name, description: wfCur.description, definition }) });
      // 생성은 항상 draft — 사용자가 다른 상태를 골랐다면 바로 반영
      if (wfCur.status !== 'draft') j = await wfApi('/api/workflows/' + encodeURIComponent(j.workflow.id), { method: 'PATCH', body: JSON.stringify({ status: wfCur.status }) });
    }
    const w = j.workflow;
    const wasNew = !wfCur.id;
    wfCur = { id: w.id, name: w.name, description: w.description || '', status: w.status, steps: JSON.parse(JSON.stringify(w.definition.steps)), is_template: !!w.is_template };
    if (wasNew) wfcAdoptLayout(); // WF-10: 저장 전 메모리에 있던 캔버스 위치를 새 id로 localStorage에 옮긴다
    wfDirty = false; wfEditIdx = null;
    await wfLoadList();
    wfSetHash(w.id);
    wfRender();
    if (!wfRuns.length) await wfLoadRuns();
    await wfLoadShares(); wfRenderShareArea();
    await wfLoadSchedules(); wfRenderScheduleArea();
    wfMsg('저장했습니다.');
  } catch (e) { wfFail(e, '저장하지 못했습니다'); }
  finally { const b = $('wfSaveBtn'); if (b) b.disabled = false; }
}
async function wfDelete() {
  if (!wfCur || !wfCur.id) return;
  if (!confirm(`"${wfCur.name}" 워크플로우와 실행 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  try {
    await wfApi('/api/workflows/' + encodeURIComponent(wfCur.id), { method: 'DELETE' });
    wfCur = null; wfRuns = []; wfRun = null; wfDirty = false;
    wfSetHash(null);
    await wfLoadList();
    wfRender();
    wfMsg('삭제했습니다.');
  } catch (e) { wfFail(e, '삭제하지 못했습니다'); }
}

// ---------- 실행 영역 ----------
async function wfLoadRuns() {
  if (!wfCur || !wfCur.id) { wfRuns = []; return; }
  try { wfRuns = (await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/runs`)).runs || []; }
  catch (e) { wfRuns = []; wfFail(e, '실행 기록을 불러오지 못했습니다'); }
}
function wfRenderRunArea() {
  const area = $('wfRunArea');
  if (!area) return;
  area.textContent = '';
  const docIn = wfEl('input', { type: 'text', id: 'wfDocId', placeholder: 'docId (선택)' });
  const adv = wfEl('textarea', { id: 'wfAdv', rows: '3', placeholder: '{"question": "..."}' });
  const tplEx = wfTplInput && wfCur && wfTplInput.id === wfCur.id ? wfTplInput.json : '';
  if (tplEx) adv.value = tplEx;
  area.append(
    wfEl('h3', { text: '실행' }),
    wfEl('label', { class: 'wf-label', for: 'wfDocId', text: '실행 입력: docId' }), docIn,
    wfEl('details', { class: 'wf-adv', open: tplEx ? true : null }, wfEl('summary', { text: '고급 입력(JSON)' }), adv),
    wfEl('div', { class: 'wf-actions' },
      wfBtn('실행', 'primary', wfRunNow, { id: 'wfRunBtn' }),
      wfDirty ? wfEl('span', { class: 'wf-note', text: '저장하지 않은 변경은 실행에 반영되지 않습니다' }) : null),
    wfEl('h3', { text: '실행 기록' }),
    wfEl('ul', { id: 'wfRuns', class: 'wf-runs' }),
    wfEl('div', { id: 'wfRunDetail', class: 'wf-detail' }));
  wfRenderRuns();
  wfRenderRunDetail();
}
function wfRenderRuns() {
  const ul = $('wfRuns');
  if (!ul) return;
  ul.textContent = '';
  if (!wfRuns.length) { ul.append(wfEl('li', { class: 'small', text: '아직 실행 기록이 없습니다.' })); return; }
  for (const r of wfRuns) {
    ul.append(wfEl('li', { class: 'wf-run' + (wfRun && wfRun.id === r.id ? ' sel' : '') },
      wfEl('button', { type: 'button', class: 'wf-run-btn', onclick: () => wfOpenRun(r.id) },
        wfBadge(WF_RUN_KO[r.status] || r.status, wfRunCls(r.status)),
        wfEl('span', { text: ' ' + wfFmtTime(r.started_at) }),
        wfEl('span', { class: 'small', text: ` · 현재 단계 ${(r.current_step ?? 0) + 1}/${wfCur.steps.length}` }))));
  }
}
function wfRunCls(s) { return s === 'succeeded' ? 'ok' : (s === 'failed' || s === 'cancelled') ? 'err' : s === 'waiting_approval' ? 'warn' : ''; }

async function wfRunNow() {
  let input = {};
  const advRaw = ($('wfAdv').value || '').trim();
  if (advRaw) {
    try { input = JSON.parse(advRaw); } catch { wfMsg('고급 입력이 올바른 JSON이 아닙니다.', true); return; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { wfMsg('고급 입력은 JSON 객체여야 합니다.', true); return; }
  }
  const docId = ($('wfDocId').value || '').trim();
  if (docId) input = Object.assign({}, input, { docId });
  const btn = $('wfRunBtn');
  btn.disabled = true;
  try {
    const j = await wfApi(`/api/workflows/${encodeURIComponent(wfCur.id)}/runs`, { method: 'POST', body: JSON.stringify({ input }) });
    wfMsg(j.enqueued === false ? '실행을 만들었지만 대기열 등록에 실패했습니다. 잠시 후 상태를 확인하세요.' : '실행을 시작했습니다.', j.enqueued === false);
    wfRuns.unshift(j.run);
    wfRenderRuns();
    await wfOpenRun(j.run.id);
  } catch (e) { wfFail(e, '실행하지 못했습니다'); }
  finally { const b = $('wfRunBtn'); if (b) b.disabled = false; }
}

async function wfOpenRun(runId) {
  const seq = wfSeq;
  if (wfPoll) { clearTimeout(wfPoll); wfPoll = null; }
  try {
    const j = await wfApi('/api/workflows/runs/' + encodeURIComponent(runId));
    if (seq !== wfSeq) return;
    wfRun = j.run;
    if (wfCur && wfCur.id) wfSetHash(wfCur.id, runId);
    // 목록의 같은 run 상태도 갱신
    const i = wfRuns.findIndex((r) => r.id === runId);
    if (i >= 0) wfRuns[i] = Object.assign({}, wfRuns[i], { status: wfRun.status, current_step: wfRun.current_step });
    wfRenderRuns();
    wfRenderRunDetail();
    if (wfRun.status === 'queued' || wfRun.status === 'running') wfPoll = setTimeout(() => { if (seq === wfSeq && wfRun && wfRun.id === runId) wfOpenRun(runId); }, 3000);
    if (wfRun.status === 'waiting_approval' || wfRun.status === 'succeeded' || wfRun.status === 'failed') wfLoadPending();
  } catch (e) { wfFail(e, '실행을 불러오지 못했습니다'); }
}

function wfOutSummary(o) {
  if (o == null) return '';
  let s;
  if (typeof o === 'string') s = o;
  else { try { s = JSON.stringify(o); } catch { s = String(o); } }
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function wfRenderRunDetail() {
  const box = $('wfRunDetail');
  if (!box) return;
  box.textContent = '';
  if (!wfRun) return;
  const r = wfRun;
  box.append(wfEl('h3', { text: '실행 상세' }),
    wfEl('div', { class: 'wf-run-head' }, wfBadge(WF_RUN_KO[r.status] || r.status, wfRunCls(r.status)),
      wfEl('span', { class: 'small', text: ` 시작 ${wfFmtTime(r.started_at)}${r.finished_at ? ' · 종료 ' + wfFmtTime(r.finished_at) : ''}` })));
  if (r.error) box.append(wfEl('div', { class: 'err', text: r.error }));
  if (r.status === 'waiting_approval') {
    box.append(wfEl('div', { class: 'wf-approve' },
      wfEl('p', { text: '이 실행은 사람의 승인을 기다리고 있습니다. 승인하면 다음 단계(메일 발송 등)가 실제로 실행됩니다.' }),
      wfEl('div', { class: 'wf-actions' },
        wfBtn('승인', 'primary wf-big', () => wfDecide('approve'), { id: 'wfApproveBtn' }),
        wfBtn('거절', 'secondary wf-big wf-danger', () => wfDecide('reject'), { id: 'wfRejectBtn' }))));
  }
  const steps = r.steps || [];
  const tl = wfEl('ol', { class: 'wf-timeline' });
  steps.forEach((s) => {
    const def = WF_NODES[s.node_type];
    tl.append(wfEl('li', { class: 'wf-tl wf-tl-' + s.status },
      wfEl('div', {}, wfEl('b', { text: s.node_name }), ' ', wfBadge(def ? def.label : s.node_type), ' ',
        wfBadge(WF_STEP_KO[s.status] || s.status, wfRunCls(s.status)),
        wfEl('span', { class: 'small', text: ' ' + wfDuration(s.started_at, s.finished_at) })),
      s.output != null ? wfEl('div', { class: 'small wf-out', text: wfOutSummary(s.output) }) : null,
      s.error ? wfEl('div', { class: 'err', text: s.error }) : null));
  });
  if (!steps.length) tl.append(wfEl('li', { class: 'small', text: '아직 실행된 단계가 없습니다.' }));
  box.append(tl);
}

async function wfDecide(action) {
  if (!wfRun) return;
  const label = action === 'approve' ? '승인' : '거절';
  if (action === 'approve' && !confirm('승인하면 메일 발송 등 다음 단계가 실제로 실행됩니다. 승인할까요?')) return;
  for (const id of ['wfApproveBtn', 'wfRejectBtn']) { const b = $(id); if (b) b.disabled = true; }
  const runId = wfRun.id;
  try {
    await wfApi(`/api/workflows/runs/${encodeURIComponent(runId)}/${action}`, { method: 'POST' });
    wfMsg(label + '했습니다.');
  } catch (e) {
    if (e.status === 409) wfMsg('이미 처리됐거나 승인 대기 상태가 아닙니다: ' + e.message, true);
    else if (e.status === 404) wfMsg('실행을 찾을 수 없습니다.', true);
    else wfFail(e, label + '하지 못했습니다');
  }
  await wfOpenRun(runId);
  await wfLoadPending();
}
