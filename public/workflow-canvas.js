// 워크플로우 비주얼 캔버스 WF-10 (2026-11-18) — 순수 SVG + 바닐라 JS, 외부 라이브러리·CDN 없음. 빌드 없음.
// 폼 빌더(workflow.js)와 "같은" wfCur.steps 배열을 직접 읽고 쓴다 (복사본 없음). 캔버스는 노드 배치와 간선(next) 편집만 맡고,
// 단계 추가·편집·삭제·저장은 폼의 기존 함수(wfRenderStepForm·wfRemove·wfSave)를 그대로 쓴다.
// 위치(x/y)는 정의 JSON에 넣지 않는다 — localStorage `wf-layout:<workflowId>`에만 둔다 (새 워크플로우는 저장 전까지 메모리).
// 보안: 단계 이름 등 사용자 데이터는 textContent로만 넣는다 (innerHTML 사용 안 함).
//
// 간선 규칙 (types.ts와 같다): next 없음 = 배열 다음 단계(암묵, 점선) · next: "sX" = 명시(실선) · next: null = 여기서 종료.
// condition은 next: { true: id|null, false: id|null } — 두 키가 항상 있어야 한다. 정의는 DAG (순환은 서버 400, 캔버스에서 미리 막는다).

// ===================== 공용 그래프 로직 (순수 함수 — 폼·캔버스·하네스가 같이 쓴다) =====================

function wfcIndexOf(steps, id) { return steps.findIndex((s) => s.id === id); }
function wfcImplicitNextId(steps, i) { return i + 1 < steps.length ? steps[i + 1].id : null; }

/** 간선 목록. { from, port: 'next'|'true'|'false', to: 단계id|null(종료), implicit } — next 없는 단계는 배열 순서 암묵 간선 1개. */
function wfcEdges(steps) {
  const out = [];
  steps.forEach((s, i) => {
    const n = s.next;
    if (n === undefined) out.push({ from: s.id, port: 'next', to: wfcImplicitNextId(steps, i), implicit: true });
    else if (n === null || typeof n === 'string') out.push({ from: s.id, port: 'next', to: n, implicit: false });
    else if (typeof n === 'object') {
      out.push({ from: s.id, port: 'true', to: n.true === undefined ? null : n.true, implicit: false });
      out.push({ from: s.id, port: 'false', to: n.false === undefined ? null : n.false, implicit: false });
    }
  });
  return out;
}

function wfcSuccessors(steps, i) {
  const n = steps[i].next;
  if (n === undefined) return i + 1 < steps.length ? [i + 1] : [];
  const ids = n === null ? [] : typeof n === 'string' ? [n] : [n.true, n.false].filter((x) => typeof x === 'string');
  return ids.map((id) => wfcIndexOf(steps, id)).filter((x) => x >= 0);
}

/** 순환 탐색 (서버 findCycle과 같은 규칙 — 암묵 간선 포함). 있으면 "a → b → a", 없으면 null. */
function wfcFindCycle(steps) {
  const color = new Array(steps.length).fill(0);
  const stack = [];
  const visit = (i) => {
    color[i] = 1; stack.push(i);
    for (const j of wfcSuccessors(steps, i)) {
      if (color[j] === 1) return [...stack.slice(stack.indexOf(j)), j].map((k) => steps[k].id).join(' → ');
      if (color[j] === 0) { const r = visit(j); if (r) return r; }
    }
    stack.pop(); color[i] = 2;
    return null;
  };
  for (let i = 0; i < steps.length; i++) if (color[i] === 0) { const r = visit(i); if (r) return r; }
  return null;
}

function wfcSetNext(step, value) { if (value === undefined) delete step.next; else step.next = value; }

/**
 * 간선 연결: fromId의 port('next' | condition은 'true'/'false')를 toId(단계 id, null이면 종료)로 바꾼다.
 * condition에 아직 next가 없으면 반대쪽 분기는 지금의 암묵 대상(배열 다음 단계, 마지막이면 종료)으로 채운다 — 동작이 바뀌지 않게.
 * 자기 자신·없는 단계·순환은 거부하고 원래 값으로 되돌린다. 반환: { ok, error? }.
 */
function wfcConnect(steps, fromId, port, toId) {
  const i = wfcIndexOf(steps, fromId);
  if (i < 0) return { ok: false, error: '없는 단계입니다.' };
  if (toId !== null && toId === fromId) return { ok: false, error: '단계를 자기 자신에게 연결할 수 없습니다.' };
  if (toId !== null && wfcIndexOf(steps, toId) < 0) return { ok: false, error: `없는 단계입니다: ${toId}` };
  const s = steps[i];
  const old = s.next;
  let next;
  if (s.type === 'condition') {
    if (port !== 'true' && port !== 'false') return { ok: false, error: '조건 단계는 참/거짓 포트에서 연결하세요.' };
    const cur = old && typeof old === 'object' ? old : null;
    const imp = wfcImplicitNextId(steps, i);
    next = { true: cur ? cur.true : imp, false: cur ? cur.false : imp };
    next[port] = toId;
  } else {
    next = toId;
  }
  wfcSetNext(s, next);
  const cyc = wfcFindCycle(steps);
  if (cyc) { wfcSetNext(s, old); return { ok: false, error: `연결하면 순환이 생깁니다 (${cyc}). 워크플로우는 앞 단계로 되돌아가는 연결을 가질 수 없습니다.` }; }
  return { ok: true };
}

/**
 * 간선 삭제 (캔버스에서 간선 클릭).
 * - 일반 단계의 명시 간선 → next를 지운다 (배열 순서로 폴백). 폴백이 순환을 만들면 대신 종료(null).
 * - condition의 참/거짓 간선 → 그쪽을 null(종료)로 (condition next는 두 키가 다 있어야 하므로).
 * - 암묵 간선(배열 순서) → 종료로 바꾼다 (일반: null, condition: 양쪽 null).
 * 반환: { ok, result: 'implicit'|'end', error? }.
 */
function wfcDisconnect(steps, fromId, port) {
  const i = wfcIndexOf(steps, fromId);
  if (i < 0) return { ok: false, error: '없는 단계입니다.' };
  const s = steps[i];
  if (s.next === undefined) {
    wfcSetNext(s, s.type === 'condition' ? { true: null, false: null } : null);
    return { ok: true, result: 'end' };
  }
  if (s.type === 'condition' && s.next && typeof s.next === 'object') {
    if (port !== 'true' && port !== 'false') return { ok: false, error: '조건 단계의 포트가 올바르지 않습니다.' };
    s.next = Object.assign({}, s.next, { [port]: null });
    return { ok: true, result: 'end' };
  }
  const old = s.next;
  delete s.next;
  if (wfcFindCycle(steps)) { s.next = null; return { ok: true, result: 'end' }; }
  return { ok: true, result: 'implicit' };
}

/** 연결 초기화 (우클릭 메뉴): next를 지워 배열 순서로 돌린다. 순환이 생기면 거부. */
function wfcResetNext(steps, fromId) {
  const i = wfcIndexOf(steps, fromId);
  if (i < 0) return { ok: false, error: '없는 단계입니다.' };
  const s = steps[i];
  const old = s.next;
  delete s.next;
  const cyc = wfcFindCycle(steps);
  if (cyc) { wfcSetNext(s, old); return { ok: false, error: `배열 순서로 돌리면 순환이 생깁니다 (${cyc}).` }; }
  return { ok: true };
}

/**
 * 단계 삭제 뒤 간선 정리 (WF-7 한계 2 해결). steps는 이미 삭제된 단계가 빠진 배열이다.
 * - 일반 단계의 next가 삭제된 단계 → next를 지운다 (배열 순서로 폴백). 폴백이 순환을 만들면 그 단계는 종료(null)로 바꾼다.
 * - condition의 true/false 중 삭제된 단계를 가리키는 쪽 → null (그 분기는 종료).
 * 반환: { count: 정리한 간선 수, toImplicit, toEnd }.
 */
function wfcCleanupEdges(steps, deletedId) {
  let toImplicit = 0, toEnd = 0;
  const fellBack = [];
  for (const s of steps) {
    const n = s.next;
    if (n === undefined || n === null) continue;
    if (typeof n === 'string') {
      if (n === deletedId) { delete s.next; fellBack.push(s); toImplicit++; }
    } else if (typeof n === 'object') {
      const c = Object.assign({}, n);
      for (const k of ['true', 'false']) if (c[k] === deletedId) { c[k] = null; toEnd++; }
      s.next = c;
    }
  }
  // 폴백이 순환을 만들면 (드묾: 뒤쪽 단계가 앞쪽을 명시로 가리키던 경우) 폴백한 단계를 종료로 바꾼다.
  for (const s of fellBack) {
    if (!wfcFindCycle(steps)) break;
    s.next = null; toImplicit--; toEnd++;
  }
  return { count: toImplicit + toEnd, toImplicit, toEnd };
}

/** 폼·캔버스 공용 (명세 이름): 삭제된 단계를 가리키던 간선을 wfCur.steps에서 정리하고 1줄로 알린다. 정리한 간선 수를 돌려준다. */
function wfCleanupEdgesAfterDelete(deletedId) {
  if (typeof wfCur === 'undefined' || !wfCur) return 0;
  const r = wfcCleanupEdges(wfCur.steps, deletedId);
  if (r.count && typeof wfMsg === 'function') {
    const how = [r.toEnd ? `${r.toEnd}개는 종료로` : '', r.toImplicit ? `${r.toImplicit}개는 배열 순서로` : ''].filter(Boolean).join(', ');
    wfMsg(`삭제된 단계를 가리키던 간선 ${r.count}개를 정리했습니다 — ${how} 바뀌었습니다. 저장해야 반영됩니다.`);
  }
  return r.count;
}

/** 폼 단계 카드용 1줄 간선 설명. */
function wfcNextLabel(steps, i) {
  const n = steps[i].next;
  if (n === undefined) { const imp = wfcImplicitNextId(steps, i); return imp ? `다음: 배열 순서 (${imp})` : '다음: 종료 (마지막 단계)'; }
  if (n === null) return '다음: 종료';
  if (typeof n === 'string') return `다음: ${n}`;
  const f = (v) => (v === null || v === undefined ? '종료' : v);
  return `다음: 참 → ${f(n.true)} · 거짓 → ${f(n.false)}`;
}

// ===================== 자동 배치 =====================

const WFC = { W: 190, H: 58, COLW: 230, ROWH: 112, PAD: 30 };

/**
 * 간단한 계층 배치: 층 = 루트에서의 최장 경로 길이 (위→아래). 가로 위치는 부모 기준 힌트 — condition의 참은 왼쪽, 거짓은 오른쪽.
 * 같은 층에서 겹치면 오른쪽으로 민다. 반환: { [id]: {x, y} }.
 */
function wfcAutoLayout(steps) {
  const n = steps.length;
  const indeg = new Array(n).fill(0);
  const succ = steps.map((_, i) => wfcSuccessors(steps, i));
  succ.forEach((js) => js.forEach((j) => indeg[j]++));
  const level = new Array(n).fill(0), hintSum = new Array(n).fill(0), hintCnt = new Array(n).fill(0);
  const order = [], q = [];
  let rootSlot = 0;
  for (let i = 0; i < n; i++) if (indeg[i] === 0) q.push(i);
  const deg = indeg.slice();
  while (q.length) {
    const i = q.shift();
    order.push(i);
    for (const j of succ[i]) { level[j] = Math.max(level[j], level[i] + 1); if (--deg[j] === 0) q.push(j); }
  }
  for (let i = 0; i < n; i++) if (!order.includes(i)) order.push(i); // 순환이 있는 잘못된 상태 — 그래도 그린다
  const hint = new Array(n).fill(0);
  for (const i of order) {
    hint[i] = hintCnt[i] ? hintSum[i] / hintCnt[i] : rootSlot++ * 1.2;
    const s = steps[i], nx = s.next;
    for (const j of succ[i]) {
      let d = 0;
      if (s.type === 'condition' && nx && typeof nx === 'object' && nx.true !== nx.false) d = steps[j].id === nx.true ? -0.6 : 0.6;
      hintSum[j] += hint[i] + d; hintCnt[j]++;
    }
  }
  const byLevel = {};
  for (let i = 0; i < n; i++) (byLevel[level[i]] = byLevel[level[i]] || []).push(i);
  const col = new Array(n).fill(0);
  for (const lv of Object.keys(byLevel)) {
    const ids = byLevel[lv].sort((a, b) => hint[a] - hint[b] || a - b);
    let prev = -Infinity;
    for (const i of ids) { col[i] = Math.max(hint[i], prev + 1); prev = col[i]; }
  }
  const minCol = Math.min(0, ...col);
  const pos = {};
  steps.forEach((s, i) => { pos[s.id] = { x: Math.round(WFC.PAD + (col[i] - minCol) * WFC.COLW), y: WFC.PAD + 10 + level[i] * WFC.ROWH }; });
  return pos;
}

// ===================== 캔버스 상태 · 위치 저장 =====================

let wfcView = 'form';      // 'form' | 'canvas'
let wfcPos = {};           // { [stepId]: {x, y} } — 현재 워크플로우
let wfcPosFor = null;      // wfcPos가 속한 wfCur 객체 (객체가 바뀌면 다시 읽는다)
let wfcDrag = null, wfcSvg = null, wfcEdgesG = null, wfcLastTap = { id: null, t: 0 };

function wfcLayoutKey(id) { return 'wf-layout:' + id; }
function wfcLoadLayout(id) {
  try {
    const raw = JSON.parse(localStorage.getItem(wfcLayoutKey(id)) || '{}');
    const out = {};
    if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) out[k] = { x: v.x, y: v.y };
    return out;
  } catch { return {}; }
}
function wfcSaveLayout() {
  if (!wfCur || !wfCur.id || wfCur.shared) return; // 새 워크플로우는 메모리에만, 공유받은 것은 저장 안 함
  const ids = new Set(wfCur.steps.map((s) => s.id));
  const keep = {};
  for (const [k, v] of Object.entries(wfcPos)) if (ids.has(k)) keep[k] = v;
  try { localStorage.setItem(wfcLayoutKey(wfCur.id), JSON.stringify(keep)); } catch { /* 저장 공간 없음 — 무시 */ }
}
/** wfSave가 새 워크플로우를 처음 저장한 직후 부른다: 메모리 위치를 새 id로 옮겨 저장. */
function wfcAdoptLayout() { wfcPosFor = wfCur; wfcSaveLayout(); }

function wfcEnsurePositions() {
  if (wfcPosFor !== wfCur) { wfcPos = wfCur.id ? wfcLoadLayout(wfCur.id) : {}; wfcPosFor = wfCur; }
  const missing = wfCur.steps.filter((s) => !wfcPos[s.id]);
  if (!missing.length) return;
  const auto = wfcAutoLayout(wfCur.steps);
  const hasAny = wfCur.steps.some((s) => wfcPos[s.id]);
  for (const s of missing) {
    const p = Object.assign({}, auto[s.id]);
    if (hasAny) { // 기존 배치와 겹치지 않게 아래로 민다
      const hit = () => Object.values(wfcPos).some((q) => Math.abs(q.x - p.x) < WFC.W + 10 && Math.abs(q.y - p.y) < WFC.H + 20);
      for (let k = 0; k < 60 && hit(); k++) p.y += WFC.ROWH / 2;
    }
    wfcPos[s.id] = p;
  }
}
function wfcRelayout() { wfcPos = wfcAutoLayout(wfCur.steps); wfcPosFor = wfCur; wfcSaveLayout(); wfcDraw(); }

// ===================== 보기 전환 (workflow.js의 wfRender가 부른다) =====================

function wfcViewToggle() {
  const mk = (v, t) => wfBtn(t, 'secondary wfc-tg' + (wfcView === v ? ' on' : ''), () => { if (wfcView !== v) { wfcView = v; wfRenderStepsArea(); } }, { 'aria-pressed': wfcView === v ? 'true' : 'false' });
  return wfEl('div', { class: 'wfc-toggle', role: 'group', 'aria-label': '보기 전환' }, mk('form', '폼 보기'), mk('canvas', '캔버스 보기'));
}
/** #wfStepsArea를 현재 보기(폼 목록 / 캔버스)로 다시 그린다. wfCur.steps는 그대로. */
function wfRenderStepsArea() {
  const area = $('wfStepsArea');
  if (!area) return;
  area.textContent = '';
  const tg = document.querySelector('.wfc-toggle');
  if (tg) tg.replaceWith(wfcViewToggle());
  wfcCloseMenu();
  if (wfcView === 'canvas') { area.append(wfEl('div', { id: 'wfCanvas', class: 'wfc' })); wfcRender(); }
  else { area.append(wfEl('div', { id: 'wfSteps', class: 'wf-steps' })); if (wfCur && wfCur.shared) wfRenderSharedSteps(); else wfRenderSteps(); }
}

// ===================== 렌더링 =====================

const WFC_NS = 'http://www.w3.org/2000/svg';
function wfcS(tag, attrs, ...kids) {
  const e = document.createElementNS(WFC_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v; else e.setAttribute(k, String(v));
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
}
function wfcClip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n) + '…' : t; }
function wfcPortPos(id, port) {
  const p = wfcPos[id] || { x: 0, y: 0 };
  if (port === 'in') return { x: p.x + WFC.W / 2, y: p.y };
  if (port === 'true') return { x: p.x + WFC.W * 0.28, y: p.y + WFC.H };
  if (port === 'false') return { x: p.x + WFC.W * 0.72, y: p.y + WFC.H };
  return { x: p.x + WFC.W / 2, y: p.y + WFC.H };
}
function wfcCurve(a, b) {
  const dy = Math.max(40, Math.abs(b.y - a.y) / 2);
  return { d: `M${a.x},${a.y} C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`, mid: { x: (a.x + 3 * a.x + 3 * b.x + b.x) / 8, y: (a.y + 3 * (a.y + dy) + 3 * (b.y - dy) + b.y) / 8 } };
}

function wfcRender() {
  const box = $('wfCanvas');
  if (!box || !wfCur) return;
  box.textContent = '';
  const ro = !!wfCur.shared;
  const bar = wfEl('div', { class: 'wfc-bar' });
  if (ro) {
    bar.append(wfEl('span', { class: 'wf-note', text: '공유받은 워크플로우는 캔버스에서 보기만 할 수 있습니다 (이동·연결·삭제·추가 불가).' }));
  } else {
    const sel = wfEl('select', { id: 'wfcAddType', 'aria-label': '추가할 노드 종류' }, wfEl('option', { value: '', text: '— 노드 종류 —' }),
      Object.entries(WF_NODES).map(([t, d]) => wfEl('option', { value: t, text: d.label })));
    bar.append(sel, wfBtn('+ 단계 추가', 'secondary', () => wfcAddStep(sel.value)), wfBtn('자동 정렬', 'secondary', wfcRelayout),
      wfEl('div', { class: 'wfc-endzone', 'data-end': '1', title: '출력 포트를 여기로 끌어 놓으면 그 경로가 여기서 끝납니다' }, wfEl('span', { class: 'wfc-endico', text: '■' }), ' 종료 (여기로 끌어 놓기)'));
  }
  const help = ro
    ? '실선 = 지정한 연결 · 점선 = 배열 순서 · 초록 = 조건 참 · 빨강 = 조건 거짓'
    : '아래 포트(●)를 끌어 다른 단계에 놓으면 연결 · 간선 클릭 = 삭제 · 두 번 클릭 = 편집 · 오른쪽 클릭 = 메뉴 · 실선 = 지정한 연결, 점선 = 배열 순서';
  box.append(bar, wfEl('p', { class: 'small wfc-help', text: help }), wfEl('div', { id: 'wfcWrap', class: 'wfc-wrap' + (ro ? ' wfc-ro' : '') }));
  wfcDraw();
}

function wfcDraw() {
  const wrap = $('wfcWrap');
  if (!wrap || !wfCur) return;
  wrap.textContent = '';
  wfcSvg = null; wfcEdgesG = null;
  if (!wfCur.steps.length) { wrap.append(wfEl('p', { class: 'small wfc-empty', text: '단계가 없습니다. 위에서 노드 종류를 골라 "단계 추가"로 시작하세요.' })); return; }
  wfcEnsurePositions();
  const ro = !!wfCur.shared;
  let w = 600, h = 240;
  for (const s of wfCur.steps) { const p = wfcPos[s.id]; w = Math.max(w, p.x + WFC.W + WFC.PAD); h = Math.max(h, p.y + WFC.H + WFC.PAD + 24); }
  const mk = (id, cls) => wfcS('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, wfcS('path', { d: 'M0,0 L10,5 L0,10 z', class: cls }));
  const svg = wfcS('svg', { class: 'wfc-svg', width: w, height: h, viewBox: `0 0 ${w} ${h}`, role: 'img', 'aria-label': `워크플로우 그래프 (${wfCur.steps.length}단계)` },
    wfcS('defs', {}, mk('wfcArr', 'wfc-arr'), mk('wfcArrT', 'wfc-arr-t'), mk('wfcArrF', 'wfc-arr-f'), mk('wfcArrI', 'wfc-arr-i')));
  wfcEdgesG = wfcS('g', { class: 'wfc-edges' });
  const nodesG = wfcS('g', { class: 'wfc-nodes' });
  svg.append(wfcEdgesG, nodesG);
  wfcSvg = svg;
  wfCur.steps.forEach((s, i) => nodesG.append(wfcNode(s, i, ro)));
  wrap.append(svg);
  wfcDrawEdges();
  if (!ro) {
    svg.addEventListener('pointerdown', wfcOnDown);
    svg.addEventListener('contextmenu', wfcOnContext);
  }
}

function wfcNode(s, i, ro) {
  const p = wfcPos[s.id];
  const def = WF_NODES[s.type] || { label: s.type };
  const appr = s.type === 'send_email' || s.type === 'webhook' || s.requiresApproval;
  const g = wfcS('g', { class: `wfc-node wfc-t-${s.type}${appr ? ' wfc-appr' : ''}`, transform: `translate(${p.x},${p.y})`, 'data-id': s.id },
    wfcS('title', { text: `${s.name} (${s.id}) — ${def.label}${ro ? '' : '\n두 번 클릭: 편집 · 오른쪽 클릭: 메뉴'}` }),
    wfcS('rect', { class: 'wfc-box', width: WFC.W, height: WFC.H, rx: 8 }),
    wfcS('text', { class: 'wfc-type', x: 10, y: 18, text: wfcClip(def.label.replace(' (승인 필요)', ''), 13) + (appr ? ' · 승인' : '') }),
    wfcS('text', { class: 'wfc-id', x: WFC.W - 8, y: 18, 'text-anchor': 'end', text: s.id }),
    wfcS('text', { class: 'wfc-name', x: 10, y: 40, text: wfcClip(s.name, 12) }),
    wfcS('circle', { class: 'wfc-in', cx: WFC.W / 2, cy: 0, r: 6 }));
  const endBadge = (cx) => wfcS('g', { class: 'wfc-endb', transform: `translate(${cx - 20},${WFC.H + 9})` },
    wfcS('rect', { width: 40, height: 17, rx: 8 }), wfcS('text', { x: 20, y: 12.5, 'text-anchor': 'middle', text: '종료' }));
  const n = s.next;
  if (s.type === 'condition' && n && typeof n === 'object') {
    for (const [port, fx, lab] of [['true', 0.28, '참'], ['false', 0.72, '거짓']]) {
      g.append(wfcS('circle', { class: `wfc-out wfc-out-${port}`, cx: WFC.W * fx, cy: WFC.H, r: 7, 'data-port': port }, wfcS('title', { text: `${lab} 분기 — 끌어서 연결` })),
        wfcS('text', { class: `wfc-plab wfc-plab-${port}`, x: WFC.W * fx + (port === 'true' ? -11 : 11), y: WFC.H - 6, 'text-anchor': port === 'true' ? 'end' : 'start', text: lab }));
      if (n[port] === null || n[port] === undefined) g.append(endBadge(WFC.W * fx));
    }
  } else if (s.type === 'condition') {
    // 아직 분기 지정 전(next 없음): 두 포트를 보여 주되 지금은 배열 순서로 진행한다.
    for (const [port, fx, lab] of [['true', 0.28, '참'], ['false', 0.72, '거짓']]) {
      g.append(wfcS('circle', { class: `wfc-out wfc-out-${port}`, cx: WFC.W * fx, cy: WFC.H, r: 7, 'data-port': port }, wfcS('title', { text: `${lab} 분기 — 끌어서 연결` })),
        wfcS('text', { class: `wfc-plab wfc-plab-${port}`, x: WFC.W * fx + (port === 'true' ? -11 : 11), y: WFC.H - 6, 'text-anchor': port === 'true' ? 'end' : 'start', text: lab }));
    }
    if (i === wfCur.steps.length - 1) g.append(endBadge(WFC.W / 2));
  } else {
    g.append(wfcS('circle', { class: 'wfc-out', cx: WFC.W / 2, cy: WFC.H, r: 7, 'data-port': 'next' }, wfcS('title', { text: '끌어서 다음 단계에 연결' })));
    if (n === null || (n === undefined && i === wfCur.steps.length - 1)) g.append(endBadge(WFC.W / 2));
  }
  return g;
}

function wfcDrawEdges() {
  if (!wfcEdgesG) return;
  wfcEdgesG.textContent = '';
  const ro = !!wfCur.shared;
  for (const e of wfcEdges(wfCur.steps)) {
    if (e.to === null || !wfcPos[e.to] || !wfcPos[e.from]) continue;
    const a = wfcPortPos(e.from, e.port), b = wfcPortPos(e.to, 'in');
    const c = wfcCurve(a, b);
    const cls = e.implicit ? 'wfc-implicit' : e.port === 'true' ? 'wfc-true' : e.port === 'false' ? 'wfc-false' : '';
    const marker = e.implicit ? 'wfcArrI' : e.port === 'true' ? 'wfcArrT' : e.port === 'false' ? 'wfcArrF' : 'wfcArr';
    const tip = e.implicit ? '배열 순서 (점선)' : e.port === 'true' ? '조건 참' : e.port === 'false' ? '조건 거짓' : '지정한 연결';
    const g = wfcS('g', { class: 'wfc-e', 'data-from': e.from, 'data-port': e.port },
      wfcS('title', { text: `${e.from} → ${e.to}: ${tip}${ro ? '' : e.implicit ? ' — 클릭하면 여기서 종료로 바꿉니다' : ' — 클릭하면 삭제'}` }),
      wfcS('path', { class: 'wfc-hit', d: c.d }),
      wfcS('path', { class: `wfc-edge ${cls}`, d: c.d, 'marker-end': `url(#${marker})` }));
    if (e.port === 'true' || e.port === 'false') g.append(wfcS('text', { class: `wfc-elab wfc-elab-${e.port}`, x: c.mid.x, y: c.mid.y - 4, 'text-anchor': 'middle', text: e.port === 'true' ? '참' : '거짓' }));
    if (!ro) g.addEventListener('click', (ev) => { ev.stopPropagation(); wfcEdgeClick(e); });
    wfcEdgesG.append(g);
  }
}

// ===================== 편집 동작 =====================

function wfcChanged(msg, isErr) {
  if (!isErr) wfDirty = true;
  if (msg) wfMsg(msg, isErr);
  wfcDraw();
}
function wfcEdgeClick(e) {
  const r = wfcDisconnect(wfCur.steps, e.from, e.port);
  if (!r.ok) { wfMsg(r.error, true); return; }
  const what = e.port === 'true' ? '참 분기' : e.port === 'false' ? '거짓 분기' : '연결';
  wfcChanged(r.result === 'end' ? `${e.from}의 ${what}을(를) 끊었습니다 — 그 경로는 여기서 종료됩니다. 저장해야 반영됩니다.` : `${e.from} → ${e.to} 연결을 지웠습니다 — 배열 순서로 진행합니다. 저장해야 반영됩니다.`);
}
function wfcLink(fromId, port, toId) {
  const r = wfcConnect(wfCur.steps, fromId, port, toId);
  if (!r.ok) { wfMsg(r.error, true); return; }
  const lab = port === 'true' ? ' (참)' : port === 'false' ? ' (거짓)' : '';
  wfcChanged(toId === null ? `${fromId}${lab} 경로가 여기서 종료되도록 했습니다. 저장해야 반영됩니다.` : `${fromId}${lab} → ${toId} 연결했습니다. 저장해야 반영됩니다.`);
}
function wfcEditStep(id) {
  const i = wfcIndexOf(wfCur.steps, id);
  if (i < 0 || wfCur.shared) return;
  wfEditIdx = i; wfRenderStepForm();
  const f = $('wfStepForm'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function wfcAddStep(type) {
  if (!type) { wfMsg('추가할 노드 종류를 고르세요.', true); return; }
  wfEditIdx = -1; wfRenderStepForm();
  const sel = $('wfType');
  if (sel) { sel.value = type; if (sel.onchange) sel.onchange(); }
  const f = $('wfStepForm'); if (f && f.scrollIntoView) f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ---------- 포인터: 노드 이동 / 포트에서 간선 끌기 ----------
function wfcPt(ev) { const r = wfcSvg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; }
function wfcOnDown(ev) {
  if (!wfCur || wfCur.shared || ev.button !== 0) return;
  wfcCloseMenu();
  const node = ev.target.closest && ev.target.closest('.wfc-node');
  if (!node) return;
  const id = node.getAttribute('data-id');
  const out = ev.target.closest('.wfc-out');
  const p = wfcPt(ev);
  if (out) {
    const port = out.getAttribute('data-port');
    const tmp = wfcS('path', { class: 'wfc-edge wfc-temp' + (port === 'true' ? ' wfc-true' : port === 'false' ? ' wfc-false' : '') });
    wfcEdgesG.append(tmp);
    wfcDrag = { kind: 'link', from: id, port, a: wfcPortPos(id, port), tmp };
  } else {
    const pos = wfcPos[id];
    wfcDrag = { kind: 'move', id, node, dx: p.x - pos.x, dy: p.y - pos.y, sx: p.x, sy: p.y, moved: false };
  }
  ev.preventDefault();
  window.addEventListener('pointermove', wfcOnMove);
  window.addEventListener('pointerup', wfcOnUp, { once: true });
}
function wfcOnMove(ev) {
  if (!wfcDrag || !wfcSvg) return;
  const p = wfcPt(ev);
  if (wfcDrag.kind === 'move') {
    if (!wfcDrag.moved && Math.abs(p.x - wfcDrag.sx) + Math.abs(p.y - wfcDrag.sy) < 4) return;
    wfcDrag.moved = true;
    const np = { x: Math.max(0, Math.round(p.x - wfcDrag.dx)), y: Math.max(8, Math.round(p.y - wfcDrag.dy)) };
    wfcPos[wfcDrag.id] = np;
    wfcDrag.node.setAttribute('transform', `translate(${np.x},${np.y})`);
    wfcDrawEdges();
  } else {
    wfcDrag.tmp.setAttribute('d', wfcCurve(wfcDrag.a, p).d);
    const hot = document.elementFromPoint(ev.clientX, ev.clientY);
    const ez = document.querySelector('.wfc-endzone');
    if (ez) ez.classList.toggle('hot', !!(hot && hot.closest && hot.closest('[data-end]')));
  }
}
function wfcOnUp(ev) {
  window.removeEventListener('pointermove', wfcOnMove);
  const d = wfcDrag; wfcDrag = null;
  if (!d) return;
  if (d.kind === 'move') {
    if (d.moved) { wfcSaveLayout(); wfcDraw(); return; }
    const now = Date.now(); // 두 번 클릭 → 편집 (포인터 이벤트 기반 — dblclick에 기대지 않는다)
    if (wfcLastTap.id === d.id && now - wfcLastTap.t < 400) { wfcLastTap = { id: null, t: 0 }; wfcEditStep(d.id); }
    else wfcLastTap = { id: d.id, t: now };
    return;
  }
  d.tmp.remove();
  const ez = document.querySelector('.wfc-endzone'); if (ez) ez.classList.remove('hot');
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  if (!el || !el.closest) return;
  if (el.closest('[data-end]')) { wfcLink(d.from, d.port, null); return; }
  const tn = el.closest('.wfc-node');
  if (!tn) return; // 빈 곳에 놓으면 취소
  const to = tn.getAttribute('data-id');
  if (to === d.from) { wfMsg('단계를 자기 자신에게 연결할 수 없습니다.', true); return; }
  wfcLink(d.from, d.port, to);
}

// ---------- 오른쪽 클릭 메뉴 ----------
function wfcCloseMenu() { const m = document.querySelector('.wfc-menu'); if (m) m.remove(); document.removeEventListener('pointerdown', wfcMenuOutside, true); document.removeEventListener('keydown', wfcMenuKey, true); }
function wfcMenuOutside(ev) { if (!(ev.target.closest && ev.target.closest('.wfc-menu'))) wfcCloseMenu(); }
function wfcMenuKey(ev) { if (ev.key === 'Escape') wfcCloseMenu(); }
function wfcOnContext(ev) {
  const node = ev.target.closest && ev.target.closest('.wfc-node');
  if (!node || !wfCur || wfCur.shared) return;
  ev.preventDefault();
  wfcCloseMenu();
  const id = node.getAttribute('data-id');
  const i = wfcIndexOf(wfCur.steps, id);
  const s = wfCur.steps[i];
  const wrap = $('wfcWrap');
  const r = wrap.getBoundingClientRect();
  const item = (text, fn, cls) => wfBtn(text, 'wfc-mi' + (cls ? ' ' + cls : ''), () => { wfcCloseMenu(); fn(); });
  const items = [];
  if (s.type === 'condition') {
    items.push(item('참 분기 여기서 종료', () => wfcLink(id, 'true', null)), item('거짓 분기 여기서 종료', () => wfcLink(id, 'false', null)));
  } else {
    items.push(item('여기서 종료', () => wfcLink(id, 'next', null)));
  }
  if (s.next !== undefined) items.push(item('연결 초기화 (배열 순서)', () => { const x = wfcResetNext(wfCur.steps, id); if (!x.ok) wfMsg(x.error, true); else wfcChanged(`${id}의 연결을 지웠습니다 — 배열 순서로 진행합니다. 저장해야 반영됩니다.`); }));
  items.push(item('단계 편집', () => wfcEditStep(id)), item('단계 삭제', () => wfRemove(i), 'wf-danger'));
  const menu = wfEl('div', { class: 'wfc-menu', role: 'menu' }, wfEl('div', { class: 'wfc-mh', text: `${s.name} (${s.id})` }), items);
  menu.style.left = `${ev.clientX - r.left + wrap.scrollLeft}px`;
  menu.style.top = `${ev.clientY - r.top + wrap.scrollTop}px`;
  wrap.append(menu);
  setTimeout(() => { document.addEventListener('pointerdown', wfcMenuOutside, true); document.addEventListener('keydown', wfcMenuKey, true); }, 0);
}

// 하네스(Node/Workers 번들)에서 순수 그래프 로직만 쓸 수 있게 한다. 브라우저(document 있음)에서는 아무것도 하지 않는다
// (브라우저에서는 위 함수들이 이미 전역이다).
if (typeof document === 'undefined') {
  const api = { wfcEdges, wfcFindCycle, wfcConnect, wfcDisconnect, wfcResetNext, wfcCleanupEdges, wfcNextLabel, wfcAutoLayout, wfcImplicitNextId };
  globalThis.WFC_GRAPH = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
}
