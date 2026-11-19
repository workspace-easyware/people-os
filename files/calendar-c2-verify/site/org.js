// 조직관리 (2026-11-17, HR admin 전용) — 부서·부서장·구성원 소속·이름.
// index.html 인라인 스크립트의 전역($, api, esc, escAttr, currentUser)을 쓴다. 권한은 서버가 판단한다 (hr_admin).
//   부서:   GET/POST /api/approval/admin/departments (upsert)
//   구성원: GET /api/admin/users (department_id·department_name 포함) · PATCH /api/admin/users/:id {name}
//           PUT /api/approval/admin/users/:id/department {department_id}
// 역할·코칭 역할·상태 변경은 "사용자 관리" 메뉴에서 한다 (여기서는 표시만).
let orgPane = 'depts', orgDepts = [], orgUsers = [], orgEditId = null;

function orgRoleLabel(r) { return r === 'hr_admin' ? 'HR 관리자' : '일반 사용자'; }
function orgCoachLabel(r) { return r === 'coach' ? '코치' : '코칭 대상'; }
function orgStatusLabel(s) { return s === 'active' ? '활성' : s === 'pending' ? '설정 대기' : '비활성'; }
function orgMsg(text, ok) {
  const el = $('orgMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'org-msg' + (ok ? ' ok' : '');
}

async function orgOpen() {
  const root = $('orgMount');
  if (!root.dataset.ready) {
    root.innerHTML =
      '<div class="obs-subtabs" role="tablist" aria-label="조직관리">' +
      '<button type="button" role="tab" id="orgSub-depts" onclick="orgSetPane(\'depts\')">부서</button>' +
      '<button type="button" role="tab" id="orgSub-members" onclick="orgSetPane(\'members\')">구성원</button></div>' +
      '<div class="org-msg" id="orgMsg" role="status"></div>' +
      '<div id="orgDeptPane"></div><div id="orgMemberPane"></div>';
    root.dataset.ready = '1';
  }
  orgSetPane(orgPane);
}

function orgSetPane(p) {
  orgPane = p === 'members' ? 'members' : 'depts';
  $('orgSub-depts').setAttribute('aria-selected', orgPane === 'depts' ? 'true' : 'false');
  $('orgSub-members').setAttribute('aria-selected', orgPane === 'members' ? 'true' : 'false');
  $('orgDeptPane').style.display = orgPane === 'depts' ? '' : 'none';
  $('orgMemberPane').style.display = orgPane === 'members' ? '' : 'none';
  orgMsg('');
  orgLoad();
}

async function orgLoad() {
  const [dj, uj] = await Promise.all([
    api('/api/approval/admin/departments').catch(e => ({ ok: false, error: e.message })),
    api('/api/admin/users').catch(e => ({ ok: false, error: e.message })),
  ]);
  orgDepts = dj.ok ? (dj.departments || []) : [];
  orgUsers = uj.ok ? (uj.users || []) : [];
  if (orgPane === 'depts') orgRenderDepts(dj, uj); else orgRenderMembers(dj, uj);
}

// ---------- 부서 ----------
function orgDeptName(id) { const d = orgDepts.find(x => x.id === id); return d ? d.name : ''; }
/** id의 하위 부서 전부 (상위 부서 선택에서 순환을 막는다). */
function orgDescendants(id) {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    orgDepts.forEach(d => { if (d.parent_id && out.has(d.parent_id) && !out.has(d.id)) { out.add(d.id); grew = true; } });
  }
  return out;
}
function orgManagerOpts(sel) {
  const active = orgUsers.filter(u => u.status === 'active');
  const extra = sel && !active.some(u => u.id === sel) ? orgUsers.filter(u => u.id === sel) : [];
  return '<option value="">(부서장 없음)</option>' + active.concat(extra).map(u =>
    `<option value="${escAttr(u.id)}"${u.id === sel ? ' selected' : ''}>${esc(u.name || u.email)}${u.status !== 'active' ? ' (비활성)' : ''}</option>`).join('');
}
function orgParentOpts(sel, selfId) {
  const block = selfId ? orgDescendants(selfId) : new Set();
  return '<option value="">(최상위)</option>' + orgDepts.filter(d => !block.has(d.id)).map(d =>
    `<option value="${escAttr(d.id)}"${d.id === sel ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
}

function orgRenderDepts(dj, uj) {
  const pane = $('orgDeptPane');
  if (!dj.ok) { pane.innerHTML = '<div class="card"><p class="err">부서 목록을 불러오지 못했습니다. ' + esc(dj.error || '') + '</p></div>'; return; }
  const noMgr = orgDepts.filter(d => d.is_active && !d.manager_user_id);
  const warn = noMgr.length
    ? `<div class="org-warn"><b>부서장 미지정:</b> ${noMgr.map(d => esc(d.name)).join(', ')} — 이 부서의 부서원은 기안할 수 없습니다. 부서장을 지정하세요.</div>`
    : '';
  const rows = orgDepts.map(d => `<tr class="${d.is_active ? '' : 'org-off'}">
      <td><b>${esc(d.name)}</b></td><td><code>${esc(d.code)}</code></td>
      <td><select aria-label="${escAttr(d.name)} 부서장" onchange="orgSetManager('${escAttr(d.id)}', this.value)">${orgManagerOpts(d.manager_user_id)}</select>
        ${d.manager_user_id ? '' : '<span class="badge warn">미지정</span>'}</td>
      <td>${Number(d.member_count) || 0}</td>
      <td>${d.parent_id ? esc(orgDeptName(d.parent_id) || d.parent_id) : '<span class="muted">—</span>'}</td>
      <td>${d.is_active ? '<span class="badge ok">사용</span>' : '<span class="badge">미사용</span>'}</td>
      <td><button type="button" onclick="orgEditDept('${escAttr(d.id)}')">수정</button></td></tr>`).join('');
  pane.innerHTML =
    '<div class="card"><h2>부서</h2>' +
    '<p class="muted org-rule">결재선은 <b>부서장 → HR 관리자</b> 순서입니다. 부서원이 기안하면 부서장이 먼저 결재하고, 부서장이 기안하면 부서장 칸을 건너뛰고 HR 관리자가 결재합니다. ' +
    '<b>부서장이 없는 부서의 부서원은 기안할 수 없습니다.</b></p>' + warn +
    (orgDepts.length
      ? '<div class="org-scroll"><table class="admin-table org-table"><thead><tr><th>이름</th><th>코드</th><th>부서장</th><th>인원</th><th>상위 부서</th><th>사용 여부</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="empty">부서가 없습니다. 아래에서 추가하세요.</p>') +
    '<p class="small muted">인원은 활성 구성원 수입니다.</p></div>' +
    '<div class="card" id="orgDeptFormCard"></div>';
  orgRenderDeptForm();
  if (!uj.ok) orgMsg('구성원 목록을 불러오지 못해 부서장 선택지가 비어 있습니다. ' + (uj.error || ''));
}

function orgRenderDeptForm() {
  const d = orgEditId ? orgDepts.find(x => x.id === orgEditId) : null;
  if (orgEditId && !d) orgEditId = null;
  const v = d || { name: '', code: '', manager_user_id: '', parent_id: '', sort_order: 0, is_active: 1 };
  $('orgDeptFormCard').innerHTML =
    `<h2>${d ? '부서 수정 — ' + esc(d.name) : '부서 추가'}</h2>
    <form class="org-form" id="orgDeptForm">
      <label>이름<input id="orgFName" type="text" required maxlength="100" value="${escAttr(v.name)}" /></label>
      <label>코드<input id="orgFCode" type="text" required maxlength="50" value="${escAttr(v.code)}" placeholder="예: HR" /></label>
      <label>부서장<select id="orgFManager">${orgManagerOpts(v.manager_user_id || '')}</select></label>
      <label>상위 부서<select id="orgFParent">${orgParentOpts(v.parent_id || '', d ? d.id : '')}</select></label>
      <label>정렬<input id="orgFSort" type="number" step="1" value="${escAttr(v.sort_order ?? 0)}" style="width:80px" /></label>
      <label class="org-check"><input id="orgFActive" type="checkbox" ${v.is_active ? 'checked' : ''} /> 사용</label>
      <div class="org-form-btns"><button class="primary" type="submit">${d ? '저장' : '부서 추가'}</button>
      ${d ? '<button type="button" onclick="orgEditDept(null)">취소</button>' : ''}</div>
    </form>`;
  $('orgDeptForm').addEventListener('submit', orgSubmitDept);
}

function orgEditDept(id) {
  orgEditId = id;
  orgMsg('');
  orgRenderDeptForm();
  if (id) $('orgDeptFormCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function orgPostDept(body) {
  const j = await api('/api/approval/admin/departments', { method: 'POST', body: JSON.stringify(body) }).catch(e => ({ ok: false, error: e.message }));
  if (!j.ok) { orgMsg('저장하지 못했습니다. ' + (j.error || '')); return null; }
  return j;
}

async function orgSubmitDept(e) {
  e.preventDefault();
  const sort = parseInt($('orgFSort').value, 10);
  const body = {
    code: $('orgFCode').value.trim(), name: $('orgFName').value.trim(),
    manager_user_id: $('orgFManager').value || null, parent_id: $('orgFParent').value || null,
    sort_order: Number.isFinite(sort) ? sort : 0, is_active: $('orgFActive').checked,
  };
  if (orgEditId) body.id = orgEditId;
  const j = await orgPostDept(body);
  if (!j) return;
  orgMsg(orgEditId ? '부서를 저장했습니다.' : '부서를 추가했습니다.', true);
  orgEditId = null;
  orgLoad();
}

/** 목록에서 부서장만 바로 지정 (나머지 필드는 현재 값 그대로 upsert). */
async function orgSetManager(id, managerId) {
  const d = orgDepts.find(x => x.id === id);
  if (!d) return;
  const j = await orgPostDept({
    id, code: d.code, name: d.name, parent_id: d.parent_id || null, manager_user_id: managerId || null,
    sort_order: d.sort_order || 0, is_active: !!d.is_active,
  });
  if (j) orgMsg(`${d.name} 부서장을 ${managerId ? '지정' : '해제'}했습니다.`, true);
  orgLoad();
}

// ---------- 구성원 ----------
function orgRenderMembers(dj, uj) {
  const pane = $('orgMemberPane');
  if (!uj.ok) { pane.innerHTML = '<div class="card"><p class="err">구성원 목록을 불러오지 못했습니다. ' + esc(uj.error || '') + '</p></div>'; return; }
  const managerOf = {};
  orgDepts.forEach(d => { if (d.manager_user_id) (managerOf[d.manager_user_id] = managerOf[d.manager_user_id] || []).push(d.name); });
  const deptCell = (u) => {
    if (!dj.ok) return esc(u.department_name || '—');
    const known = !u.department_id || orgDepts.some(d => d.id === u.department_id);
    return `<select aria-label="${escAttr(u.name)} 부서" onchange="orgSetDept('${escAttr(u.id)}', this.value)">` +
      `<option value=""${u.department_id ? '' : ' selected'}>미지정</option>` +
      (known ? '' : `<option value="${escAttr(u.department_id)}" selected>${esc(u.department_name || u.department_id)}</option>`) +
      orgDepts.filter(d => d.is_active || d.id === u.department_id).map(d =>
        `<option value="${escAttr(d.id)}"${d.id === u.department_id ? ' selected' : ''}>${esc(d.name)}${d.is_active ? '' : ' (미사용)'}</option>`).join('') +
      '</select>';
  };
  const rows = orgUsers.map(u => {
    const self = currentUser && currentUser.id === u.id;
    const mgr = managerOf[u.id] ? ` <span class="badge ok" title="${escAttr(managerOf[u.id].join(', '))} 부서장">부서장</span>` : '';
    return `<tr class="${u.status === 'inactive' ? 'org-off' : ''}">
      <td><form class="org-name" onsubmit="orgSaveName(event, '${escAttr(u.id)}')">
        <input type="text" required maxlength="100" value="${escAttr(u.name)}" aria-label="이름" data-orig="${escAttr(u.name)}" />
        <button type="submit">저장</button></form>${self ? '<span class="small muted">(나)</span>' : ''}${mgr}</td>
      <td>${esc(u.email)}</td><td>${orgRoleLabel(u.role)}</td><td>${orgCoachLabel(u.coaching_role)}</td>
      <td>${deptCell(u)}</td><td>${orgStatusLabel(u.status)}</td></tr>`;
  }).join('');
  const unassigned = orgUsers.filter(u => u.status === 'active' && !u.department_id).length;
  pane.innerHTML =
    '<div class="card"><h2>구성원</h2>' +
    '<p class="muted">이름을 고치고 <b>저장</b>을 누르거나, 부서를 고르면 바로 반영됩니다. 역할·코칭 역할·상태는 <a href="#admin" onclick="switchTab(\'admin\');return false">사용자 관리</a>에서 바꿉니다.</p>' +
    (unassigned ? `<p class="small muted">부서 미지정 활성 구성원: ${unassigned}명</p>` : '') +
    (dj.ok ? '' : '<p class="err">부서 목록을 불러오지 못해 부서를 바꿀 수 없습니다. ' + esc(dj.error || '') + '</p>') +
    (orgUsers.length
      ? '<div class="org-scroll"><table class="admin-table org-table"><thead><tr><th>이름</th><th>이메일</th><th>역할</th><th>코칭 역할</th><th>부서</th><th>상태</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
      : '<p class="empty">등록된 사용자가 없습니다.</p>') + '</div>';
}

async function orgSaveName(e, id) {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const name = input.value.trim();
  if (!name || name.length > 100) { orgMsg('이름은 1~100자로 입력하세요.'); return; }
  if (name === input.dataset.orig) { orgMsg('바뀐 내용이 없습니다.', true); return; }
  const j = await api('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ name }) }).catch(err => ({ ok: false, error: err.message }));
  if (!j.ok) { orgMsg('이름을 바꾸지 못했습니다. ' + (j.error || '')); return; }
  if (currentUser && currentUser.id === id) {
    currentUser.name = name;
    if ($('userChipName')) $('userChipName').textContent = name;
    if ($('userAvatar')) $('userAvatar').textContent = name.charAt(0) || '?';
  }
  orgMsg('이름을 저장했습니다.', true);
  orgLoad();
}

async function orgSetDept(id, deptId) {
  const j = await api('/api/approval/admin/users/' + encodeURIComponent(id) + '/department', { method: 'PUT', body: JSON.stringify({ department_id: deptId || null }) })
    .catch(err => ({ ok: false, error: err.message }));
  if (!j.ok) orgMsg('부서를 바꾸지 못했습니다. ' + (j.error || ''));
  else {
    const d = orgDepts.find(x => x.id === deptId);
    orgMsg(deptId ? `부서를 ${d ? d.name : deptId}(으)로 지정했습니다.` + (d && !d.manager_user_id ? ' 이 부서는 부서장이 없어 기안할 수 없습니다.' : '') : '부서 지정을 해제했습니다.', true);
  }
  orgLoad();
}
