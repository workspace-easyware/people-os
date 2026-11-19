// 결재함 (2026-11-17) — /api/approval/* 화면. index.html 인라인 스크립트의 전역($, api, esc, escAttr, currentUser, switchTab)을 쓴다.
// 권한은 서버가 판단한다 (결재선 밖 문서는 404). 화면은 서버가 준 doc.actions / doc.editable만 따른다.
const APV = '/api/approval';
const APV_TABS = [
  ['PENDING', '대기'], ['UPCOMING', '예정'], ['DRAFTING', '기안'], ['DONE', '완료'], ['DRAFTS', '임시저장'],
];
const APV_STATUS = { DRAFT: '임시저장', IN_PROGRESS: '진행 중', COMPLETED: '완료', REJECTED: '반려', RECALLED: '회수' };
const APV_ROUTE = { PENDING: '대기', APPROVING: '결재 중', APPROVED: '승인', REJECTED: '반려', SKIPPED: '건너뜀' };
const APV_ACTION = {
  SUBMIT: '상신', REQUEST_RE_APPROVAL: '재상신', RECALL: '회수', APPROVE: '승인', REJECT: '반려', FORCE_REJECT: '강제 반려',
  SAVE: '임시저장', CREATE: '기안 작성', EDIT: '수정',
};
let apvTab = 'PENDING', apvDoneSub = 'DONE', apvPage = 1, apvForms = null, apvDraft = null, apvDoc = null;

function apvFmt(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(s).slice(0, 16); }
}
function apvShow(which) {
  $('apvListCard').style.display = which === 'list' ? '' : 'none';
  $('apvDetailCard').style.display = which === 'detail' ? '' : 'none';
  $('apvEditCard').style.display = which === 'edit' ? '' : 'none';
}
function apvStatusBadge(s) {
  const cls = s === 'COMPLETED' ? ' ok' : s === 'REJECTED' ? ' warn' : '';
  return `<span class="badge${cls}">${esc(APV_STATUS[s] || s)}</span>`;
}

// ---- 라우팅: #approval · #approval/<docId> ----
function apvOpen(sub) {
  sub = String(sub || '');
  if (sub) { try { sub = decodeURIComponent(sub); } catch { /* 그대로 */ } apvView(sub); return; }
  apvShow('list');
  apvRenderTabs();
  apvLoad(1);
}
function apvGo(type) { // 홈 카드 → 결재함의 해당 탭
  if (type === 'APPROVED_BY_ME') { apvTab = 'DONE'; apvDoneSub = type; } else { apvTab = type; }
  if (location.hash === '#approval') switchTab('approval', true); else switchTab('approval');
}
function apvSetTab(t) { apvTab = t; apvShow('list'); apvRenderTabs(); apvLoad(1); }
function apvRenderTabs() {
  $('apvTabs').innerHTML = APV_TABS.map(([k, label]) =>
    `<button type="button" role="tab" aria-selected="${apvTab === k}" onclick="apvSetTab('${k}')">${label}${k === 'PENDING' ? ' <span class="nav-count" id="apvTabPending" style="display:none"></span>' : ''}</button>`).join('');
  apvPaintPending();
  $('apvSub').innerHTML = apvTab === 'DONE'
    ? [['DONE', '내 기안 완료·반려'], ['APPROVED_BY_ME', '내가 결재한 문서']].map(([k, l]) =>
      `<button type="button" aria-pressed="${apvDoneSub === k}" onclick="apvDoneSub='${k}';apvRenderTabs();apvLoad(1)">${l}</button>`).join('')
    : '';
  $('apvSub').style.display = apvTab === 'DONE' ? '' : 'none';
}
let apvPendingN = 0;
function apvPaintPending() {
  const t = $('apvTabPending');
  if (t) { t.textContent = apvPendingN; t.style.display = apvPendingN ? '' : 'none'; }
}
async function apvLoad(page) {
  apvPage = page || 1;
  const type = apvTab === 'DONE' ? apvDoneSub : apvTab;
  $('apvList').innerHTML = '<p class="loading">불러오는 중…</p>';
  let j;
  try { j = await api(`${APV}/box?type=${type}&page=${apvPage}`); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { $('apvList').innerHTML = `<p class="small">${esc(j.error || '불러오지 못했습니다.')}</p>`; $('apvPager').innerHTML = ''; return; }
  const empty = { PENDING: '결재할 문서가 없습니다.', UPCOMING: '결재 예정 문서가 없습니다.', DRAFTING: '진행 중인 기안이 없습니다.', DONE: '문서가 없습니다.', APPROVED_BY_ME: '내가 결재한 문서가 없습니다.', DRAFTS: '임시저장·회수한 문서가 없습니다.' };
  $('apvList').innerHTML = j.documents.length
    ? '<div class="apv-list">' + j.documents.map(d => {
      const mid = type === 'PENDING' || type === 'UPCOMING' || type === 'APPROVED_BY_ME' ? '기안 ' + (d.drafter_name || '') : d.current_approver_name ? '결재 ' + d.current_approver_name : (d.doc_number || '');
      return `<div class="apv-row" onclick="apvToDoc('${escAttr(d.id)}')">
        <div class="apv-title">${d.is_urgent ? '<span class="apv-urgent">긴급</span>' : ''}<b>${esc(d.title)}</b> <span class="small">${esc(d.form_name || '')}</span></div>
        <div class="apv-meta">${esc(mid)}</div>
        <div class="apv-meta">${esc(apvFmt(d.submitted_at || d.updated_at))}</div>
        <div>${apvStatusBadge(d.status)}</div></div>`;
    }).join('') + '</div>'
    : `<p class="small">${empty[type] || '문서가 없습니다.'}</p>`;
  $('apvPager').innerHTML =
    (apvPage > 1 ? `<button class="secondary" type="button" onclick="apvLoad(${apvPage - 1})">← 이전</button>` : '') +
    (j.hasMore ? `<button class="secondary" type="button" onclick="apvLoad(${apvPage + 1})">다음 →</button>` : '');
}
function apvToDoc(id) {
  const h = 'approval/' + encodeURIComponent(id);
  if (location.hash === '#' + h) switchTab(h, true); else location.hash = h;
}
function apvBack() { if (location.hash === '#approval') apvOpen(''); else location.hash = 'approval'; }

// ---- 문서 상세 ----
async function apvView(id) {
  apvShow('detail');
  $('apvDetailCard').innerHTML = '<p class="loading">불러오는 중…</p>';
  let j;
  try { j = await api(`${APV}/documents/${encodeURIComponent(id)}`); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) {
    $('apvDetailCard').innerHTML = `<div class="btnrow"><button class="secondary" type="button" onclick="apvBack()">← 목록</button></div><p class="small">${esc(j.error || '문서를 열 수 없습니다.')}</p>`;
    return;
  }
  apvRenderDetail(j.document);
}
function apvRenderDetail(d, msg) {
  apvDoc = d;
  const acts = d.actions || [];
  const needComment = acts.some(a => a === 'APPROVE' || a === 'REJECT' || a === 'FORCE_REJECT' || a === 'RECALL');
  const btn = (a, cls) => `<button type="button" class="${cls}" onclick="apvAct('${a}')">${APV_ACTION[a]}</button>`;
  const actionBox = (acts.length || d.editable) ? `<div class="apv-actions">
      ${needComment ? '<textarea id="apvComment" placeholder="의견 (반려·강제 반려는 필수)" maxlength="2000"></textarea>' : ''}
      <div class="btnrow">
        ${acts.includes('APPROVE') ? btn('APPROVE', 'primary') : ''}${acts.includes('REJECT') ? btn('REJECT', 'secondary') : ''}
        ${acts.includes('SUBMIT') ? btn('SUBMIT', 'primary') : ''}${acts.includes('REQUEST_RE_APPROVAL') ? btn('REQUEST_RE_APPROVAL', 'primary') : ''}
        ${d.editable ? '<button type="button" class="secondary" onclick="apvEditCurrent()">수정</button>' : ''}
        ${acts.includes('RECALL') ? btn('RECALL', 'secondary') : ''}${acts.includes('FORCE_REJECT') ? btn('FORCE_REJECT', 'secondary') : ''}
      </div><div class="apv-err" id="apvActErr">${esc(msg || '')}</div></div>` : (msg ? `<div class="apv-err">${esc(msg)}</div>` : '');
  const routes = (d.routes || []).filter(r => r.role === 'APPROVER');
  const line = routes.length
    ? '<ol class="apv-line">' + routes.map(r => `<li class="${esc(r.status)}"><span class="who">${esc(r.actor_name || '')}</span> <span class="badge${r.status === 'APPROVED' ? ' ok' : r.status === 'REJECTED' ? ' warn' : ''}">${esc(APV_ROUTE[r.status] || r.status)}</span>
        <div class="small">${esc(r.actor_dept_name || '')}${r.acted_at ? ' · ' + esc(apvFmt(r.acted_at)) : ''}</div>${r.comment ? `<div class="cm">${esc(r.comment)}</div>` : ''}</li>`).join('') + '</ol>'
    : '<p class="small">결재선이 없습니다.</p>';
  const audit = (d.audit || []).length
    ? '<details><summary class="small">처리 이력 (' + d.audit.length + ')</summary><ul class="apv-audit">' + d.audit.map(a =>
      `<li>${esc(apvFmt(a.created_at))} · ${esc(a.actor_name || '')} · ${esc(APV_ACTION[a.action] || a.action)}${a.comment ? ' — ' + esc(a.comment) : ''}</li>`).join('') + '</ul></details>' : '';
  $('apvDetailCard').innerHTML = `<div class="btnrow"><button class="secondary" type="button" onclick="apvBack()">← 목록</button></div>
    <h2>${d.is_urgent ? '<span class="apv-urgent">긴급</span>' : ''}${esc(d.title)} ${apvStatusBadge(d.status)}</h2>
    <div class="apv-detail"><div>
      <dl class="apv-hdr"><dt>양식</dt><dd>${esc((d.form && d.form.name) || '')}</dd>
        <dt>기안자</dt><dd>${esc((d.drafter && d.drafter.name) || '')}${d.drafter && d.drafter.department_name ? ' · ' + esc(d.drafter.department_name) : ''}</dd>
        ${d.doc_number ? `<dt>문서번호</dt><dd>${esc(d.doc_number)}</dd>` : ''}
        <dt>상신</dt><dd>${esc(apvFmt(d.submitted_at) || '—')}</dd>${d.completed_at ? `<dt>완료</dt><dd>${esc(apvFmt(d.completed_at))}</dd>` : ''}</dl>
      <pre class="apv-body">${esc(d.body_text || '')}</pre>
      ${actionBox}
    </div><aside><h3>결재선</h3>${line}${audit}</aside></div>`;
}
async function apvAct(action) {
  const d = apvDoc; if (!d) return;
  const c = $('apvComment'); const comment = c ? c.value.trim() : '';
  const err = (m) => { $('apvActErr').textContent = m; };
  if ((action === 'REJECT' || action === 'FORCE_REJECT') && !comment) { err('반려 의견을 입력하세요.'); return; }
  if (action === 'FORCE_REJECT' && !confirm('완료된 문서를 강제 반려합니다. 계속할까요?')) return;
  if (action === 'RECALL' && !confirm('회수하면 결재선이 처음으로 돌아갑니다. 계속할까요?')) return;
  document.querySelectorAll('#apvDetailCard .apv-actions button').forEach(b => b.disabled = true);
  let j;
  try { j = await api(`${APV}/documents/${encodeURIComponent(d.id)}/actions`, { method: 'POST', body: JSON.stringify({ action, comment, version: d.version }) }); }
  catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { apvRenderDetail(d, j.error || '처리하지 못했습니다.'); return; }
  if (j.document) apvRenderDetail(j.document); else apvBack();
  apvHome();
}

// ---- 새 기안 · 수정 ----
async function apvLoadForms() {
  if (apvForms) return apvForms;
  const j = await api(`${APV}/forms`);
  apvForms = j.ok ? j.forms : [];
  return apvForms;
}
async function apvNew() {
  apvShow('edit');
  $('apvEditCard').innerHTML = '<p class="loading">양식을 불러오는 중…</p>';
  const forms = await apvLoadForms();
  if (!forms.length) { $('apvEditCard').innerHTML = '<p class="small">사용할 수 있는 양식이 없습니다.</p>'; return; }
  $('apvEditCard').innerHTML = `<div class="btnrow"><button class="secondary" type="button" onclick="apvBack()">← 목록</button></div>
    <h2>새 기안 — 양식 선택</h2>
    <div class="apv-list">${forms.map(f => `<div class="apv-row" style="grid-template-columns:1fr" onclick="apvPickForm('${escAttr(f.id)}')">
      <div class="apv-title"><b>${esc(f.name)}</b> <span class="small">${esc(f.description || '')}</span></div></div>`).join('')}</div>`;
}
function apvPickForm(formId) {
  const f = apvForms.find(x => x.id === formId); if (!f) return;
  apvDraft = {
    id: null, version: null, form: f, title: '', body: f.body_template || '', urgent: false, dirty: false,
    routes: (f.route_preview || []).map(r => ({ user_id: r.user_id, name: r.name, tag: r.source === 'DEPT_MANAGER' ? '부서장' : r.source === 'HR_ADMIN' ? 'HR' : '' })),
    routeError: f.route_error || null,
  };
  apvRenderEdit();
}
function apvEditCurrent() {
  const d = apvDoc; if (!d) return;
  apvDraft = {
    id: d.id, status: d.status, version: d.version, form: { id: d.form_id, name: d.form ? d.form.name : '' }, title: d.title, body: d.body_text || '', urgent: !!d.is_urgent, dirty: false,
    routes: (d.routes || []).filter(r => r.role === 'APPROVER').map(r => ({ user_id: r.actor_user_id, name: r.actor_name, tag: r.source === 'DEPT_MANAGER' ? '부서장' : r.source === 'HR_ADMIN' ? 'HR' : '' })),
    routeError: null,
  };
  apvShow('edit'); apvRenderEdit();
}
function apvRenderEdit(msg) {
  const x = apvDraft;
  const rl = x.routes.map((r, i) => `<li><span class="badge">${i + 1}</span><span class="nm">${esc(r.name)} ${r.tag ? `<span class="small">${esc(r.tag)}</span>` : ''}</span>
    <button type="button" title="위로" onclick="apvRouteMove(${i},-1)">↑</button><button type="button" title="아래로" onclick="apvRouteMove(${i},1)">↓</button><button type="button" title="삭제" onclick="apvRouteDel(${i})">×</button></li>`).join('');
  $('apvEditCard').innerHTML = `<div class="btnrow"><button class="secondary" type="button" onclick="apvBack()">← 목록</button></div>
    <h2>${x.id ? '기안 수정' : '새 기안'} — ${esc(x.form.name)}</h2>
    <div class="apv-edit">
      <input type="text" id="apvTitle" maxlength="200" placeholder="제목" value="${escAttr(x.title)}" />
      <textarea id="apvBody" placeholder="본문">${esc(x.body)}</textarea>
      <label class="small"><input type="checkbox" id="apvUrgent" ${x.urgent ? 'checked' : ''} /> 긴급</label>
      <h3>결재선</h3>
      ${x.routeError ? `<p class="apv-err">${esc(x.routeError)} 결재자를 직접 지정하면 기안할 수 있습니다.</p>` : ''}
      <ol class="apv-route-edit" id="apvRouteList">${rl || '<li class="small">결재자가 없습니다.</li>'}</ol>
      <input type="text" id="apvUserQ" placeholder="결재자 추가 — 이름·이메일 검색" oninput="apvUserSearch()" autocomplete="off" />
      <div class="apv-found" id="apvFound" style="display:none"></div>
      <div class="apv-err" id="apvEditErr">${esc(msg || '')}</div>
      <div class="btnrow"><button class="primary" type="button" onclick="apvSave(true)">상신</button><button class="secondary" type="button" onclick="apvSave(false)">임시저장</button></div>
    </div>`;
}
function apvSnap() { // 입력값을 상태에 옮긴다 (결재선 편집으로 다시 그리기 전에).
  if (!apvDraft || !$('apvTitle')) return;
  apvDraft.title = $('apvTitle').value; apvDraft.body = $('apvBody').value; apvDraft.urgent = $('apvUrgent').checked;
}
function apvRouteMove(i, d) { apvSnap(); const r = apvDraft.routes, j = i + d; if (j < 0 || j >= r.length) return; [r[i], r[j]] = [r[j], r[i]]; apvDraft.dirty = true; apvRenderEdit(); }
function apvRouteDel(i) { apvSnap(); apvDraft.routes.splice(i, 1); apvDraft.dirty = true; apvRenderEdit(); }
let apvUserTimer = null, apvFoundUsers = [];
function apvUserSearch() {
  clearTimeout(apvUserTimer);
  apvUserTimer = setTimeout(async () => {
    const q = $('apvUserQ') ? $('apvUserQ').value.trim() : '';
    const box = $('apvFound'); if (!box) return;
    if (!q) { box.style.display = 'none'; return; }
    const j = await api(`${APV}/users?q=${encodeURIComponent(q)}`);
    apvFoundUsers = j.ok ? j.users : [];
    box.style.display = '';
    box.innerHTML = apvFoundUsers.length
      ? apvFoundUsers.map((u, i) => `<div onclick="apvRouteAdd(${i})">${esc(u.name)} <span class="small">${esc(u.email)}${u.department_name ? ' · ' + esc(u.department_name) : ''}</span></div>`).join('')
      : '<div class="small">검색 결과가 없습니다.</div>';
  }, 200);
}
function apvRouteAdd(i) {
  const u = apvFoundUsers[i]; if (!u) return;
  apvSnap();
  if (currentUser && u.id === currentUser.id) { apvRenderEdit('본인을 결재자로 지정할 수 없습니다.'); return; }
  if (apvDraft.routes.some(r => r.user_id === u.id)) { apvRenderEdit('이미 결재선에 있는 사람입니다.'); return; }
  apvDraft.routes.push({ user_id: u.id, name: u.name, tag: '' }); apvDraft.dirty = true; apvRenderEdit();
}
async function apvSave(submit) {
  apvSnap();
  const x = apvDraft;
  const err = (m) => { $('apvEditErr').textContent = m; };
  if (!x.title.trim()) { err('제목을 입력하세요.'); return; }
  if (submit && !x.routes.length) { err('결재자를 지정하세요.'); return; }
  document.querySelectorAll('#apvEditCard .btnrow button').forEach(b => b.disabled = true);
  // 결재선은 기안자가 고쳤거나 양식 기본 결재선을 못 풀었을 때만 보낸다 (아니면 서버가 기본값을 적용).
  const sendRoutes = x.dirty || !!x.routeError;
  const routes = sendRoutes ? x.routes.map(r => ({ user_id: r.user_id })) : undefined;
  let j;
  try {
    if (!x.id) {
      j = await api(`${APV}/documents`, { method: 'POST', body: JSON.stringify({ form_id: x.form.id, title: x.title, body: x.body, is_urgent: x.urgent, routes, submit }) });
      if (j.ok) { x.id = j.id; x.version = j.document && j.document.version; }
    } else {
      j = await api(`${APV}/documents/${encodeURIComponent(x.id)}`, { method: 'PATCH', body: JSON.stringify({ title: x.title, body: x.body, is_urgent: x.urgent, routes, version: x.version }) });
      if (j.ok && submit) {
        j = await api(`${APV}/documents/${encodeURIComponent(x.id)}/actions`, { method: 'POST', body: JSON.stringify({ action: x.status === 'RECALLED' ? 'REQUEST_RE_APPROVAL' : 'SUBMIT', version: j.document.version }) });
      }
    }
  } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { apvRenderEdit(j.error || '저장하지 못했습니다.'); return; }
  apvHome();
  apvToDoc(x.id);
}

// ---- 홈 카드 · 배지 · 종 아이콘 ----
let apvHomeData = null;
async function apvHome() {
  if (!currentUser) return null;
  ntfWsStart(); // 로그인 상태면 알림 소켓 연결 (이미 있으면 그대로). 폴링은 그대로 둔다 — 푸시의 폴백.
  let j;
  try { j = await api(`${APV}/home`); } catch { return apvHomeData; }
  if (!j || !j.ok) return null;
  apvHomeData = j;
  apvPendingN = j.counts.PENDING || 0;
  const b = $('apvPendingBadge');
  if (b) { b.textContent = apvPendingN > 99 ? '99+' : String(apvPendingN); b.style.display = apvPendingN ? '' : 'none'; }
  apvPaintPending();
  ntfPaintCount(j.unreadNotifications || 0);
  return j;
}
async function apvRenderHomeCard() {
  const box = $('homeApproval'); if (!box) return;
  const j = await apvHome();
  if (!j) { box.innerHTML = '<p class="empty">로그인하면 결재 현황을 볼 수 있습니다.</p>'; return; }
  box.innerHTML = `<div class="stats" style="grid-template-columns:repeat(2,1fr);margin:0 0 12px">
      <div class="stat" style="cursor:pointer" onclick="apvGo('PENDING')"><b>${j.counts.PENDING}</b><span>결재 대기</span></div>
      <div class="stat" style="cursor:pointer" onclick="apvGo('DRAFTING')"><b>${j.counts.DRAFTING}</b><span>내 기안 진행 중</span></div></div>` +
    (j.pending.length ? j.pending.map(d => `<div class="taskrow" style="cursor:pointer" onclick="apvToDoc('${escAttr(d.id)}')"><span class="t-title">${d.is_urgent ? '<span class="apv-urgent">긴급</span>' : ''}${esc(d.title)}</span><span class="badge">${esc(d.drafter_name || '')}</span><span class="t-src">${fmtDate(d.submitted_at)}</span></div>`).join('') : '<p class="empty">결재할 문서가 없습니다.</p>');
}
let ntfCountN = 0;
function ntfPaintCount(n) {
  ntfCountN = n;
  if (!currentUser) ntfWsStop(); // 로그아웃(applyRole이 0으로 비운다) → 알림 소켓도 닫는다
  const c = $('ntfCount'); if (!c) return;
  c.textContent = n > 99 ? '99+' : String(n); c.style.display = n ? '' : 'none';
}
async function ntfToggle(ev) {
  if (ev) ev.stopPropagation();
  const p = $('ntfPanel');
  if (p.classList.contains('open')) { p.classList.remove('open'); return; }
  p.classList.add('open');
  $('ntfList').innerHTML = '<p class="loading" style="padding:12px">불러오는 중…</p>';
  let j;
  try { j = await api(`${APV}/notifications?limit=15`); } catch { j = { ok: false }; }
  if (!j.ok) { $('ntfList').innerHTML = '<p class="small" style="padding:12px">알림을 불러오지 못했습니다.</p>'; return; }
  $('ntfList').innerHTML = j.notifications.length
    ? j.notifications.map(n => `<div class="ntf-item${n.read_at ? '' : ' unread'}" onclick="ntfClick('${escAttr(n.id)}','${escAttr(n.link || '')}')">${esc(n.title)}<span class="t">${esc(apvFmt(n.created_at))}</span></div>`).join('')
    : '<p class="small" style="padding:12px">알림이 없습니다.</p>';
}
async function ntfClick(id, link) {
  $('ntfPanel').classList.remove('open');
  api(`${APV}/notifications/read`, { method: 'POST', body: JSON.stringify({ ids: [id] }) }).then(apvHome).catch(() => {});
  // 화상회의 V1 (2026-11-19): 통화 알림 링크(/meet?m=…)는 해시 탭이 아니라 별도 페이지 — 새 탭으로 연다.
  if (/^\/meet(\?|$)/.test(String(link || ''))) { const w = window.open(String(link), '_blank'); if (w) { try { w.opener = null; } catch (e) { /* 무시 */ } } else location.href = String(link); return; }
  const h = String(link || '').replace(/^.*#/, '');
  if (!h) return;
  if (location.hash === '#' + h) switchTab(h, true); else location.hash = h;
}
async function ntfReadAll() {
  await api(`${APV}/notifications/read`, { method: 'POST', body: '{}' });
  $('ntfPanel').classList.remove('open');
  apvHome();
}
document.addEventListener('click', (e) => {
  const p = $('ntfPanel');
  if (p && p.classList.contains('open') && !p.contains(e.target)) p.classList.remove('open');
});
setInterval(() => { if (currentUser && !document.hidden) apvHome(); }, 60000);

// ---- 실시간 알림 푸시 (DO-2, 2026-11-18) ----
// /api/notifications/ws 에 소켓 1개. 서버→클라이언트 {type:'notify', notification:{id,type,title,body,link,created_at}} 1종.
// 푸시 수신: 토스트 + 미읽음 +1 + (결재함 목록이 열려 있으면) 재조회. 끊기면 5초 뒤 재연결, 최대 5회 후 중단 — 그 뒤는 기존 폴링이 커버한다.
// 서버 데이터는 textContent로만 넣는다 (innerHTML 금지).
const NTF_RETRY_MS = 5000, NTF_MAX_RETRY = 5, NTF_TOAST_MS = 5000;
let ntfWs = null, ntfWsUser = '', ntfWsTries = 0, ntfWsTimer = null, ntfWsGaveUp = false;
function ntfWsUrl() { return (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/api/notifications/ws'; }
function ntfWsStop() {
  if (ntfWsTimer) { clearTimeout(ntfWsTimer); ntfWsTimer = null; }
  const w = ntfWs; ntfWs = null; ntfWsUser = ''; ntfWsTries = 0; ntfWsGaveUp = false;
  if (w) { w.onclose = null; try { w.close(1000, 'bye'); } catch { /* 이미 닫힘 */ } }
}
function ntfWsStart() {
  if (!currentUser || typeof WebSocket === 'undefined') return;
  if (ntfWsUser && ntfWsUser !== currentUser.id) ntfWsStop(); // 다른 사용자로 로그인
  if (ntfWsGaveUp || ntfWs || ntfWsTimer) return;
  ntfWsUser = currentUser.id;
  let w;
  try { w = new WebSocket(ntfWsUrl()); } catch { ntfWsSchedule(); return; }
  ntfWs = w;
  w.onopen = () => { ntfWsTries = 0; };
  w.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m && m.type === 'notify' && m.notification) ntfOnPush(m.notification);
  };
  w.onclose = () => { if (ntfWs === w) { ntfWs = null; ntfWsSchedule(); } };
  w.onerror = () => { /* onclose가 이어서 온다 */ };
}
function ntfWsSchedule() {
  if (!currentUser || ntfWsTimer) return;
  if (ntfWsTries >= NTF_MAX_RETRY) { ntfWsGaveUp = true; return; } // 중단 — 폴링이 커버
  ntfWsTries++;
  ntfWsTimer = setTimeout(() => { ntfWsTimer = null; ntfWsStart(); }, NTF_RETRY_MS);
}
function ntfOnPush(n) {
  ntfToast(n);
  ntfPaintCount(ntfCountN + 1); // 다음 apvHome 폴링이 서버 값으로 바로잡는다
  const listOpen = /^#approval$/.test(location.hash) && $('apvListCard') && $('apvListCard').style.display !== 'none';
  if (listOpen) { apvLoad(apvPage); apvHome(); }
}
function ntfToast(n) {
  let box = $('ntfToastBox');
  if (!box) {
    box = document.createElement('div'); box.id = 'ntfToastBox';
    box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;max-width:320px';
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = 'ntf-toast'; t.setAttribute('role', 'status');
  t.style.cssText = 'background:#fff;color:#222;border:1px solid #ccc;border-left:4px solid #f6821f;border-radius:6px;padding:10px 12px;box-shadow:0 4px 12px rgba(0,0,0,.18);cursor:pointer;font-size:14px';
  const h = document.createElement('div'); h.style.fontWeight = '600'; h.textContent = String(n.title || '');
  t.appendChild(h);
  if (n.body) { const b = document.createElement('div'); b.style.cssText = 'margin-top:4px;font-size:13px;white-space:pre-line'; b.textContent = String(n.body); t.appendChild(b); }
  const gone = () => { if (t.parentNode) t.parentNode.removeChild(t); };
  t.onclick = () => { gone(); if (n.link) ntfClick(n.id, n.link); };
  box.appendChild(t);
  setTimeout(gone, NTF_TOAST_MS);
}
