// 강의실 (2026-11-17, LMS S2) — /api/lms/* 화면. index.html 인라인 스크립트의 전역($, api, esc, escAttr, currentUser, switchTab)을 쓴다.
// 플레이어는 lms-player.js의 lmsPlayerMount/lmsPlayerUnmount만 부른다.
let lmsCourse = null, lmsLessons = [], lmsCurId = null, lmsCourseId = null, lmsSeq = 0;

function lmsShow(which) {
  $('lmsListCard').style.display = which === 'list' ? '' : 'none';
  $('lmsCourseCard').style.display = which === 'course' ? '' : 'none';
  const sc = $('lmsSettingsCard');
  if (sc) sc.style.display = which === 'settings' ? '' : 'none';
}
function lmsPct(done, total) { return total > 0 ? Math.round((done / total) * 100) : 0; }
function lmsBar(done, total) {
  const p = lmsPct(done, total);
  return `<div class="lms-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><i style="width:${p}%"></i></div>`;
}
function lmsDur(l) {
  let s = null;
  if (l.end_sec != null && l.start_sec != null) s = l.end_sec - l.start_sec;
  else if (l.duration_sec != null) s = l.duration_sec;
  if (s == null || !(s > 0)) return '';
  const m = Math.round(s / 60);
  return m >= 1 ? m + '분' : s + '초';
}
function lmsErr(j) { return `<p class="small">${esc((j && j.error) || '불러오지 못했습니다.')}</p>`; }

// 탭 진입 (switchTab에서 호출). 재생 중이던 과정이 있으면 그대로 두고 목록만 새로 고치지 않는다.
function lmsOpen() {
  if (lmsCourseId && lmsCourse) { lmsShow('course'); lmsRenderCourse(true); return; } // 이어보기 위치로 다시 올림(자동 재생 없음)
  lmsBack();
}
// 탭 이탈 — 소리 정리. 화면 상태(과정·강의)는 유지하고 플레이어만 내린다.
function lmsLeave() {
  if (typeof lmsPlayerUnmount === 'function') lmsPlayerUnmount();
  lmsSeq++; // 진행 중이던 응답이 늦게 와도 화면을 건드리지 않게
  const box = $('lmsPlayer');
  if (box) box.innerHTML = '';
}
// 과정 목록으로.
async function lmsBack() {
  if (typeof lmsPlayerUnmount === 'function') lmsPlayerUnmount();
  lmsCourse = null; lmsLessons = []; lmsCurId = null; lmsCourseId = null;
  lmsShow('list');
  lmsPaintSettingsBtn();
  const seq = ++lmsSeq;
  $('lmsList').innerHTML = '<p class="loading">불러오는 중…</p>';
  let j;
  try { j = await api('/api/lms/courses'); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (seq !== lmsSeq) return;
  if (!j.ok) { $('lmsList').innerHTML = lmsErr(j); return; }
  if (!j.courses.length) { $('lmsList').innerHTML = '<p class="empty">아직 등록된 과정이 없습니다.</p>'; return; }
  $('lmsList').innerHTML = '<div class="lms-grid">' + j.courses.map(c => {
    const done = c.lesson_count > 0 && c.completed_count >= c.lesson_count;
    const thumb = c.thumbnail
      ? `<div class="lms-thumb"><img src="${escAttr(c.thumbnail)}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`
      : '<div class="lms-thumb lms-thumb-ph" aria-hidden="true"><svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor"><polygon points="8 5 19 12 8 19"/></svg></div>';
    const status = c.status && c.status !== 'PUBLISHED' ? ` <span class="badge warn">${esc(c.status)}</span>` : '';
    return `<div class="card lms-course" tabindex="0" role="button" onclick="lmsOpenCourse('${escAttr(c.id)}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();lmsOpenCourse('${escAttr(c.id)}')}">
      ${thumb}
      <div class="lms-course-body">
        <b>${esc(c.title)}</b>${status}${done ? ' <span class="badge ok">수료</span>' : ''}
        <p class="small">강의 ${c.lesson_count}개 · ${done ? '완료' : c.completed_count + '/' + c.lesson_count + ' 완료'}</p>
        ${lmsBar(c.completed_count, c.lesson_count)}
      </div>
    </div>`;
  }).join('') + '</div>';
}

// 과정 상세. lessonId를 주면 그 강의를, 아니면 첫 미완료 강의를 선택한다(자동 재생 안 함).
async function lmsOpenCourse(id, lessonId) {
  if (typeof lmsPlayerUnmount === 'function') lmsPlayerUnmount();
  lmsShow('course');
  lmsCourseId = id; lmsCourse = null; lmsCurId = null;
  const seq = ++lmsSeq;
  $('lmsPlayer').innerHTML = '';
  $('lmsLessonList').innerHTML = '<p class="loading">불러오는 중…</p>';
  $('lmsTitle').textContent = '';
  $('lmsActions').innerHTML = '';
  let j;
  try { j = await api('/api/lms/courses/' + encodeURIComponent(id)); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (seq !== lmsSeq) return;
  if (!j.ok) { lmsCourseId = null; $('lmsLessonList').innerHTML = lmsErr(j); return; }
  lmsCourse = j.course; lmsLessons = j.lessons || [];
  const want = lessonId && lmsLessons.find(l => l.id === lessonId);
  const first = want || lmsLessons.find(l => !l.completed) || lmsLessons[0] || null;
  lmsCurId = first ? first.id : null;
  lmsRenderCourse(true);
}

function lmsRenderCourse(mount) {
  const c = lmsCourse;
  if (!c) return;
  $('lmsCourseTitle').textContent = c.title;
  $('lmsCourseProg').innerHTML = `<span class="small">${c.completed_count}/${c.lesson_count} 완료</span>${lmsBar(c.completed_count, c.lesson_count)}`;
  if (!lmsLessons.length) {
    $('lmsLessonList').innerHTML = '<p class="empty">이 과정에는 아직 강의가 없습니다.</p>';
    $('lmsPlayer').innerHTML = ''; $('lmsTitle').textContent = ''; $('lmsActions').innerHTML = '';
    return;
  }
  $('lmsLessonList').innerHTML = lmsLessons.map(l => {
    const cur = l.id === lmsCurId;
    return `<button type="button" class="lms-lesson${cur ? ' cur' : ''}${l.completed ? ' done' : ''}" onclick="lmsSelect('${escAttr(l.id)}')"${cur ? ' aria-current="true"' : ''}>
      <span class="lms-mark">${l.completed ? '✓' : cur ? '▶' : ''}</span>
      <span class="lms-lt">${esc(l.ord)}. ${esc(l.title)}</span>
      <span class="lms-ld">${esc(lmsDur(l))}</span>
    </button>`;
  }).join('');
  const l = lmsLessons.find(x => x.id === lmsCurId);
  if (!l) return;
  $('lmsTitle').innerHTML = `${esc(l.ord)}. ${esc(l.title)}` + (l.curator_note ? `<p class="small">${esc(l.curator_note)}</p>` : '');
  lmsRenderActions(l);
  if (mount) lmsMount(l);
}
function lmsRenderActions(l) {
  const idx = lmsLessons.findIndex(x => x.id === l.id);
  const next = lmsLessons[idx + 1];
  $('lmsActions').innerHTML =
    `<button type="button" id="lmsDoneBtn" class="${l.completed ? 'secondary' : ''}" onclick="lmsToggleDone()">${l.completed ? '완료 취소' : '수강 완료'}</button>` +
    (next ? `<button type="button" class="secondary" onclick="lmsSelect('${escAttr(next.id)}')">다음 강의 →</button>` : '');
}
function lmsMount(l) {
  if (typeof lmsPlayerMount !== 'function') { $('lmsPlayer').innerHTML = '<p class="empty">플레이어를 불러오지 못했습니다.</p>'; return; }
  lmsPlayerMount($('lmsPlayer'), l, { onComplete: lmsAutoComplete });
}
function lmsSelect(id) {
  if (id === lmsCurId) return;
  lmsCurId = id;
  lmsRenderCourse(true);
}

// 서버 응답을 화면에 반영한다.
function lmsApply(lessonId, r) {
  const l = lmsLessons.find(x => x.id === lessonId);
  if (l) { l.completed = !!r.completed; l.completed_at = r.completed_at; l.position_sec = r.position_sec; }
  if (lmsCourse && r.course) { lmsCourse.lesson_count = r.course.lesson_count; lmsCourse.completed_count = r.course.completed_count; }
}
async function lmsPost(lessonId, body) {
  let j;
  try { j = await api('/api/lms/lessons/' + encodeURIComponent(lessonId) + '/progress', { method: 'POST', body: JSON.stringify(body) }); }
  catch { j = { ok: false, error: '네트워크 오류' }; }
  return j;
}
// 수강 완료 / 완료 취소. 플레이어는 다시 올리지 않는다(재생 위치 유지).
async function lmsToggleDone() {
  const l = lmsLessons.find(x => x.id === lmsCurId);
  if (!l) return;
  const btn = $('lmsDoneBtn'); if (btn) btn.disabled = true;
  const cid = lmsCourseId;
  const j = await lmsPost(l.id, { completed: !l.completed });
  if (cid !== lmsCourseId) return;
  if (!j.ok) { if (btn) btn.disabled = false; alert(j.error || '저장하지 못했습니다.'); return; }
  lmsApply(l.id, j);
  lmsRenderCourse(false);
}
// 플레이어 자동 완료(R2 ended 등). 이미 완료면 다시 보내지 않는다.
async function lmsAutoComplete(lesson) {
  const l = lmsLessons.find(x => x.id === lesson.id);
  if (!l || l.completed) return;
  const cid = lmsCourseId;
  const j = await lmsPost(l.id, { completed: true });
  if (!j.ok || cid !== lmsCourseId) return;
  lmsApply(l.id, j);
  if (lmsCurId === l.id) lmsRenderCourse(false);
}

// 홈 카드 "이어서 듣기" — GET /api/lms/summary 1건. 익명·과정 없음·오류면 카드를 숨긴다.
async function lmsHomeCard() {
  const card = $('homeLmsCard');
  if (!card) return;
  let j;
  try { j = await api('/api/lms/summary'); } catch { j = { ok: false }; }
  if (!j || !j.ok || !j.lesson_count) { card.style.display = 'none'; return; }
  card.style.display = '';
  const n = j.next;
  $('homeLms').innerHTML =
    `<p><b>${j.completed_count}/${j.lesson_count}</b> 강의 완료</p>${lmsBar(j.completed_count, j.lesson_count)}` +
    (n
      ? `<p class="small" style="margin-top:8px">다음 강의: ${esc(n.course_title)} · ${esc(n.lesson_title)}</p>
         <div class="btnrow"><button type="button" onclick="lmsOpenNext('${escAttr(n.course_id)}','${escAttr(n.lesson_id)}')">강의실 열기 →</button></div>`
      : '<p class="small" style="margin-top:8px">모든 강의를 마쳤습니다.</p><div class="btnrow"><button type="button" class="secondary" onclick="switchTab(\'lms\')">강의실 열기 →</button></div>');
}
function lmsOpenNext(courseId, lessonId) {
  switchTab('lms');
  lmsOpenCourse(courseId, lessonId);
}

// ================= 설정 (HR Admin 전용, 2026-11-17) =================
// index.html은 건드리지 않으므로 설정 버튼·카드는 여기서 동적으로 만든다. 서버도 /admin/* 에서 권한을 다시 확인한다.
let lmsSetCourses = [], lmsSetCourse = null; // 설정 화면 상태: 과정 캐시, 강의 관리 중인 과정
const lmsIsAdmin = () => typeof isAdminUser === 'function' && isAdminUser();

function lmsPaintSettingsBtn() {
  const old = $('lmsSettingsBtn');
  if (!lmsIsAdmin()) { if (old) old.remove(); return; }
  if (old) return;
  const h2 = $('lmsListCard') && $('lmsListCard').querySelector('h2');
  if (!h2) return;
  const b = document.createElement('button');
  b.type = 'button'; b.id = 'lmsSettingsBtn'; b.className = 'secondary lms-setbtn'; b.textContent = '⚙ 설정';
  b.onclick = lmsSettingsOpen;
  h2.insertAdjacentElement('afterend', b);
}
function lmsEnsureSettingsCard() {
  let sc = $('lmsSettingsCard');
  if (sc) return sc;
  sc = document.createElement('div');
  sc.className = 'card'; sc.id = 'lmsSettingsCard'; sc.style.display = 'none';
  $('lmsCourseCard').insertAdjacentElement('afterend', sc);
  return sc;
}
function lmsSettingsOpen() {
  if (!lmsIsAdmin()) return;
  if (typeof lmsPlayerUnmount === 'function') lmsPlayerUnmount();
  lmsEnsureSettingsCard();
  lmsShow('settings');
  lmsSetCourse = null;
  lmsSetCoursesLoad();
}
const lmsSetHelp = `<div class="lms-help">
  <b>영상 등록 안내</b>
  <ul>
    <li><b>유튜브 강의</b>: 유튜브 ID(11자) 또는 URL만 넣으면 임베드로 재생됩니다. 시작/종료 초로 챕터 구간만 보여줄 수 있습니다.</li>
    <li><b>R2 강의</b>: 화면에서 파일을 올리지 않습니다. 관리자가 터미널에서 <code>wrangler r2 object put &lt;버킷&gt;/lms/sample.mp4 --file ./sample.mp4</code> 로 먼저 올린 뒤, 이미 올라간 키(<code>lms/sample.mp4</code> 형식)를 R2 키 칸에 넣습니다. 재생은 Worker가 Range 스트리밍으로 서빙합니다.</li>
    <li>삭제해도 R2에 올라간 영상 파일은 지워지지 않습니다.</li>
  </ul></div>`;
function lmsSetBox(html) { $('lmsSettingsCard').innerHTML = html; }
function lmsSetBadge(st) { return `<span class="badge ${st === 'PUBLISHED' ? 'ok' : 'warn'}">${esc(st || '')}</span>`; }
async function lmsSetCoursesLoad() {
  lmsSetBox('<p class="loading">불러오는 중…</p>');
  let j;
  try { j = await api('/api/lms/courses'); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { lmsSetBox('<div class="btnrow"><button type="button" class="secondary" onclick="lmsBack()">← 과정 목록</button></div>' + lmsErr(j)); return; }
  lmsSetCourses = j.courses;
  lmsRenderCoursesAdmin();
}
function lmsRenderCoursesAdmin(formHtml) {
  const rows = lmsSetCourses.map(c => `<tr>
    <td>${esc(c.title)}</td><td>${esc(c.category)}</td><td>${lmsSetBadge(c.status)}</td><td>${c.lesson_count}</td>
    <td class="lms-set-act">
      <button type="button" class="secondary" onclick="lmsSetLessons('${escAttr(c.id)}')">강의 관리</button>
      <button type="button" class="secondary" onclick="lmsCourseForm('${escAttr(c.id)}')">수정</button>
      <button type="button" class="secondary" onclick="lmsCourseDelete('${escAttr(c.id)}')">삭제</button>
    </td></tr>`).join('');
  lmsSetBox(`<div class="lms-head"><button type="button" class="secondary" onclick="lmsBack()">← 과정 목록</button><h2>강의실 설정 · 과정 관리</h2>
      <button type="button" onclick="lmsCourseForm('')">+ 과정 추가</button></div>
    ${lmsSetHelp}
    <div id="lmsFormSlot">${formHtml || ''}</div>
    ${lmsSetCourses.length ? `<div class="lms-tablewrap"><table class="lms-table"><thead><tr><th>제목</th><th>카테고리</th><th>상태</th><th>강의</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">등록된 과정이 없습니다.</p>'}`);
}
function lmsOpts(list, cur) { return list.map(v => `<option value="${escAttr(v)}"${v === cur ? ' selected' : ''}>${esc(v)}</option>`).join(''); }
function lmsCourseForm(id) {
  const c = lmsSetCourses.find(x => x.id === id) || { title: '', description: '', category: 'JOB', status: 'DRAFT' };
  const html = `<form class="lms-form" onsubmit="event.preventDefault();lmsCourseSave('${escAttr(id)}')">
    <h3>${id ? '과정 수정' : '과정 추가'}</h3>
    <label>제목<input id="lmsFcTitle" required value="${escAttr(c.title)}"></label>
    <label>설명<textarea id="lmsFcDesc" rows="2">${esc(c.description || '')}</textarea></label>
    <label>카테고리<select id="lmsFcCat">${lmsOpts(['JOB', 'LEGAL', 'SAFETY', 'COACHING'], c.category)}</select></label>
    <label>순서${id ? ' (비우면 유지)' : ''}<input id="lmsFcOrd" type="number" min="0" step="1" placeholder="0"></label>
    <label>상태<select id="lmsFcStatus">${lmsOpts(['PUBLISHED', 'DRAFT'], c.status === 'ARCHIVED' ? 'DRAFT' : c.status)}</select></label>
    <div class="btnrow"><button type="submit">저장</button><button type="button" class="secondary" onclick="lmsRenderCoursesAdmin()">취소</button></div>
    <p class="small" id="lmsFormMsg"></p></form>`;
  lmsRenderCoursesAdmin(html);
  const el = $('lmsFcTitle'); if (el) el.focus();
}
async function lmsCourseSave(id) {
  const body = { title: $('lmsFcTitle').value.trim(), description: $('lmsFcDesc').value, category: $('lmsFcCat').value, status: $('lmsFcStatus').value };
  if (id) body.id = id;
  const o = $('lmsFcOrd').value.trim();
  if (o !== '') body.ord = Number(o);
  if (!body.title) { $('lmsFormMsg').textContent = '제목을 입력하세요.'; return; }
  let j;
  try { j = await api('/api/lms/admin/courses', { method: 'POST', body: JSON.stringify(body) }); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { $('lmsFormMsg').textContent = j.error || '저장하지 못했습니다.'; return; }
  await lmsSetCoursesLoad();
}
async function lmsCourseDelete(id) {
  const c = lmsSetCourses.find(x => x.id === id);
  if (!c || !confirm(`과정 "${c.title}"을(를) 삭제할까요?\n소속 강의 ${c.lesson_count}개와 모든 사용자의 진도가 함께 삭제됩니다. (R2 영상 파일은 남습니다)`)) return;
  let j;
  try { j = await api('/api/lms/admin/courses/' + encodeURIComponent(id), { method: 'DELETE' }); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { alert(j.error || '삭제하지 못했습니다.'); return; }
  await lmsSetCoursesLoad();
}

// ---- 강의 관리 ----
async function lmsSetLessons(courseId) {
  lmsSetBox('<p class="loading">불러오는 중…</p>');
  let j;
  try { j = await api('/api/lms/courses/' + encodeURIComponent(courseId)); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { lmsSetBox('<div class="btnrow"><button type="button" class="secondary" onclick="lmsSetCoursesLoad()">← 과정 관리</button></div>' + lmsErr(j)); return; }
  lmsSetCourse = { course: j.course, lessons: j.lessons || [] };
  lmsRenderLessonsAdmin();
}
function lmsRenderLessonsAdmin(formHtml) {
  const { course, lessons } = lmsSetCourse;
  const rows = lessons.map(l => `<tr>
    <td>${esc(l.ord)}</td><td>${esc(l.title)}</td><td>${esc(l.source)}</td>
    <td>${l.source === 'youtube' ? esc(l.youtube_id || '') + (l.start_sec != null || l.end_sec != null ? ` <span class="small">(${l.start_sec ?? 0}~${l.end_sec ?? '끝'}초)</span>` : '') : '<span class="small">R2</span>'}</td>
    <td class="lms-set-act">
      <button type="button" class="secondary" onclick="lmsLessonForm('${escAttr(l.id)}')">수정</button>
      <button type="button" class="secondary" onclick="lmsLessonDelete('${escAttr(l.id)}')">삭제</button>
    </td></tr>`).join('');
  lmsSetBox(`<div class="lms-head"><button type="button" class="secondary" onclick="lmsSetCoursesLoad()">← 과정 관리</button>
      <h2>${esc(course.title)} ${lmsSetBadge(course.status)}</h2>
      <button type="button" onclick="lmsLessonForm('')">+ 강의 추가</button></div>
    ${lmsSetHelp}
    <div id="lmsFormSlot">${formHtml || ''}</div>
    ${lessons.length ? `<div class="lms-tablewrap"><table class="lms-table"><thead><tr><th>순서</th><th>제목</th><th>출처</th><th>유튜브 ID / 구간</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="empty">이 과정에는 아직 강의가 없습니다.</p>'}`);
}
function lmsLessonForm(id) {
  const l = lmsSetCourse.lessons.find(x => x.id === id);
  const nextOrd = lmsSetCourse.lessons.reduce((m, x) => Math.max(m, x.ord), 0) + 1;
  const d = l || { title: '', source: 'youtube', youtube_id: '', start_sec: null, end_sec: null, ord: nextOrd, curator_note: '' };
  const v = x => x == null ? '' : escAttr(x);
  const html = `<form class="lms-form" onsubmit="event.preventDefault();lmsLessonSave('${escAttr(id)}')">
    <h3>${l ? '강의 수정' : '강의 추가'}</h3>
    <label>제목<input id="lmsFlTitle" required value="${escAttr(d.title)}"></label>
    <label>순서<input id="lmsFlOrd" type="number" min="0" step="1" required value="${v(d.ord)}"></label>
    <label>출처<select id="lmsFlSrc" onchange="lmsLessonSrcToggle()">${lmsOpts(['youtube', 'r2'], d.source)}</select></label>
    <label class="lms-yt">유튜브 ID 또는 URL<input id="lmsFlYt" value="${v(d.youtube_id)}" placeholder="예: dQw4w9WgXcQ"></label>
    <label class="lms-yt">시작 초 (선택)<input id="lmsFlStart" type="number" min="0" step="1" value="${v(d.start_sec)}"></label>
    <label class="lms-yt">종료 초 (선택)<input id="lmsFlEnd" type="number" min="0" step="1" value="${v(d.end_sec)}"></label>
    <label class="lms-r2">R2 키<input id="lmsFlR2" placeholder="lms/sample.mp4"></label>
    <p class="small lms-r2">이미 <code>wrangler r2 object put</code>으로 올린 객체 키를 넣으세요. 서버가 R2에 객체가 있는지 확인합니다.${l && l.source === 'r2' ? ' 수정할 때는 R2 키를 다시 입력해야 합니다 (화면에 키를 내려주지 않습니다).' : ''}</p>
    <label>큐레이터 메모 (선택)<input id="lmsFlNote" value="${escAttr(d.curator_note || '')}"></label>
    <div class="btnrow"><button type="submit">저장</button><button type="button" class="secondary" onclick="lmsRenderLessonsAdmin()">취소</button></div>
    <p class="small" id="lmsFormMsg"></p></form>`;
  lmsRenderLessonsAdmin(html);
  lmsLessonSrcToggle();
  const el = $('lmsFlTitle'); if (el) el.focus();
}
function lmsLessonSrcToggle() {
  const r2 = $('lmsFlSrc').value === 'r2';
  document.querySelectorAll('#lmsFormSlot .lms-yt').forEach(e => { e.style.display = r2 ? 'none' : ''; });
  document.querySelectorAll('#lmsFormSlot .lms-r2').forEach(e => { e.style.display = r2 ? '' : 'none'; });
}
async function lmsLessonSave(id) {
  const msg = t => { $('lmsFormMsg').textContent = t; };
  const body = { course_id: lmsSetCourse.course.id, title: $('lmsFlTitle').value.trim(), ord: Number($('lmsFlOrd').value), curator_note: $('lmsFlNote').value };
  if (id) body.id = id;
  if (!body.title) return msg('제목을 입력하세요.');
  if ($('lmsFlSrc').value === 'r2') {
    const k = $('lmsFlR2').value.trim();
    if (!k) return msg('R2 키를 입력하세요 (예: lms/sample.mp4).');
    body.r2_key = k;
  } else {
    const y = $('lmsFlYt').value.trim();
    if (!y) return msg('유튜브 ID 또는 URL을 입력하세요.');
    body.youtube_url = y;
    const s = $('lmsFlStart').value.trim(), e = $('lmsFlEnd').value.trim();
    if (s !== '') body.start_sec = Number(s);
    if (e !== '') body.end_sec = Number(e);
  }
  let j;
  try { j = await api('/api/lms/admin/lessons', { method: 'POST', body: JSON.stringify(body) }); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) return msg(j.error || '저장하지 못했습니다.');
  await lmsSetLessons(lmsSetCourse.course.id);
}
async function lmsLessonDelete(id) {
  const l = lmsSetCourse.lessons.find(x => x.id === id);
  if (!l || !confirm(`강의 "${l.title}"을(를) 삭제할까요?\n모든 사용자의 이 강의 진도도 삭제됩니다. (R2 영상 파일은 남습니다)`)) return;
  let j;
  try { j = await api('/api/lms/admin/lessons/' + encodeURIComponent(id), { method: 'DELETE' }); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { alert(j.error || '삭제하지 못했습니다.'); return; }
  await lmsSetLessons(lmsSetCourse.course.id);
}
