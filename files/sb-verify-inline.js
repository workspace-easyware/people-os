let docId = null, sessionId = null, lastSummaryText = '', lastSummary = [], lastActions = [], lastDocTitle = '';
let lastAnswer = '', lastQuestion = '', turnstileToken = null, turnstileWidgetId = null;
let personalSessionId = null, lastPersonalAnswer = '', lastPersonalQuestion = '';
const $ = (id) => document.getElementById(id);
const TABS = ['home','email','approval','tasks','upload','coaching','lms','personal','ask','library','obs','admin','about','pitch'];
// 로그인 (2026-11-15): 현재 사용자. null이면 미로그인. 역할이 'user'면 obs·admin 탭을 숨긴다.
let currentUser = null;
const ADMIN_TABS = ['obs', 'admin'];
// 코치 / 코칭 대상 (2026-11-16): 코칭 대상도 회사 직원이라 본인 업무 문서가 있다
// (예: 영업부 Mercer의 업무 문서). 그래서 코칭 대상도 코치와 같은 일반 메뉴를 본다.
// 메뉴 차이는 코칭 리플렉션 모드(코치용 vs 코칭 대상 자기 성찰+액션 플랜)이다.
// hr_admin의 관리자 탭(obs·admin)은 coaching_role과 무관하게 보인다.
const COACHEE_TABS = ['home', 'email', 'approval', 'tasks', 'upload', 'coaching', 'lms', 'personal', 'ask', 'library', 'about', 'pitch'];
function isCoachee() { return !!currentUser && currentUser.coaching_role !== 'coach'; }
function tabAllowed(name) {
  if (!currentUser) return true;
  if (ADMIN_TABS.includes(name)) return currentUser.role === 'hr_admin';
  if (isCoachee()) return COACHEE_TABS.includes(name);
  return true;
}
// S4: 해시는 '<최상위 탭>' 또는 'obs/<하위 경로>' (최상위 탭 = 첫 세그먼트).
function switchTab(name, fromHash) {
  name = String(name || '');
  const slash = name.indexOf('/');
  let sub = slash >= 0 ? name.slice(slash + 1) : '';
  name = slash >= 0 ? name.slice(0, slash) : name;
  if (!TABS.includes(name)) { name = 'home'; sub = ''; }
  // 로그인: 일반 사용자는 HR admin 탭(obs·admin)에 못 들어간다.
  if (currentUser && currentUser.role !== 'hr_admin' && ADMIN_TABS.includes(name)) { name = 'home'; sub = ''; }
  // 코칭 대상: 숨긴 탭(홈·녹음전사·개인 업무 검색·할 일·라이브러리)은 HR 규정 검색으로.
  if (!tabAllowed(name)) { name = 'ask'; sub = ''; }
  if (name !== 'obs' && name !== 'approval' && name !== 'pitch') sub = '';
  else if (name === 'obs' && !sub) sub = 'traces';
  const full = sub ? name + '/' + sub : name; // approval/<docId>는 알림 링크 (결재 문서 상세)
  if (!fromHash && location.hash !== '#' + full) {
    location.hash = full;
    if (name === 'obs' || name === 'approval' || name === 'pitch') return; // hashchange가 다시 불러 한 번만 mount한다
  }
  document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('nav-active'));
  document.querySelectorAll('section').forEach(x => x.classList.remove('active'));
  document.querySelector(`.tabs button[data-tab="${name}"]`).classList.add('nav-active');
  $('tab-' + name).classList.add('active');
  if (name === 'home') loadHome();
  if (name === 'upload') { setUpPane('voice'); loadRecordings(); renderPerspectives(); }
  if (name === 'personal') renderPerspectives();
  if (name === 'tasks') loadTasks();
  if (name === 'library') refreshLib();
  if (name === 'email') emailOpen();
  if (name === 'approval') apvOpen(sub);
  if (name === 'coaching') loadCoachingPickers();
  if (name === 'lms') lmsOpen(); else lmsLeave();
  if (name === 'admin') { adminSetPane('users'); loadAdminUsers(); }
  if (name === 'obs') renderObs(sub); else unmountObs();
  if (name === 'pitch') pitchOpen($('pitchMount'), sub); else if (window.pitchLeave) pitchLeave();
}
// ---- S4 관측 · 평가 하위 탭 라우터 (public/obs/*.js의 mount 계약) ----
// traces.js: 'traces' | 'trace/<id>' · evals.js: 'evals' | 'run/<id>' · gaps.js: 'gaps'
const OBS_SUBS = ['traces', 'evals', 'gaps'];
let obsView = null, obsDsView = null, obsRoute = null;
function obsSubOf(route) {
  if (/^trace(s$|\/)/.test(route)) return 'traces';
  if (/^(evals$|run\/)/.test(route)) return 'evals';
  if (route === 'gaps') return 'gaps';
  return null;
}
function unmountObs() {
  try { if (obsView && obsView.unmount) obsView.unmount(); } catch (e) { console.warn('[obs] unmount', e); }
  obsView = null; obsRoute = null;
  if (obsDsView !== null) { $('obsDatasets').textContent = ''; obsDsView = null; }
}
function renderObs(route) {
  let sub = obsSubOf(route);
  if (!sub) { location.replace('#obs/traces'); return; }
  if (route === obsRoute && obsView) return;
  unmountObs();
  document.querySelectorAll('[data-obs-sub]').forEach(b => {
    const on = b.dataset.obsSub === sub;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  $('obsMount').setAttribute('aria-labelledby', 'obsTab-' + sub);
  const P = window.PeopleOSObs;
  if (!P || !P[sub] || typeof P[sub].mount !== 'function') {
    $('obsMount').innerHTML = '<p class="err">관측 화면 스크립트를 불러오지 못했습니다 (/obs/' + sub + '.js).</p>';
    return;
  }
  obsRoute = route;
  obsView = P[sub].mount($('obsMount'), { route });
  // 평가 목록 아래에 골든 데이터셋 관리(M3)를 붙인다 (실행 상세에서는 숨김).
  if (sub === 'evals' && route === 'evals' && P.datasets && typeof P.datasets.mount === 'function') {
    obsDsView = true;
    P.datasets.mount($('obsDatasets'));
  }
  refreshObsGapCount();
}
function refreshObsGapCount() {
  const P = window.PeopleOSObs;
  if (!P || !P.gaps || typeof P.gaps.openCount !== 'function') return;
  P.gaps.openCount().then(n => { $('obsGapCount').textContent = n > 0 ? '(열린 공백 ' + n + ')' : ''; });
}
document.querySelectorAll('[data-obs-sub]').forEach(b => {
  b.onclick = () => { location.hash = 'obs/' + b.dataset.obsSub; };
  // 키보드: ←/→/Home/End로 하위 탭 이동 (WAI-ARIA tabs 패턴)
  b.onkeydown = (ev) => {
    const i = OBS_SUBS.indexOf(b.dataset.obsSub);
    let j = null;
    if (ev.key === 'ArrowRight') j = (i + 1) % OBS_SUBS.length;
    else if (ev.key === 'ArrowLeft') j = (i - 1 + OBS_SUBS.length) % OBS_SUBS.length;
    else if (ev.key === 'Home') j = 0;
    else if (ev.key === 'End') j = OBS_SUBS.length - 1;
    if (j === null) return;
    ev.preventDefault();
    $('obsTab-' + OBS_SUBS[j]).focus();
    location.hash = 'obs/' + OBS_SUBS[j];
  };
});
// 녹음전사.문서저장: 하위 탭 전환 (voice = 음성파일 전사, doc = 문서 업로드).
function setUpPane(p) {
  for (const k of ['voice', 'doc']) {
    $('upPane-' + k).style.display = k === p ? '' : 'none';
    $('upTab-' + k).setAttribute('aria-selected', k === p ? 'true' : 'false');
  }
  if (p === 'voice') loadRecordings(); else loadUploadedDocs();
}
async function loadUploadedDocs() {
  const j = await api('/api/library');
  if (!j.ok) { $('upDocList').innerHTML = '<p class="err">문서 목록을 불러오지 못했습니다.</p>'; return; }
  const files = (j.documents || []).filter(d => d.kind === 'file');
  $('upDocList').innerHTML = files.length ? files.map(d =>
    `<div class="taskrow"><span class="t-title">${esc(d.title)}</span>${d.extract_status === 'failed' ? '<span class="badge warn">변환 실패</span>' : '<span class="badge ok">변환 완료</span>'}<span class="t-src">${fmtDate(d.created_at)} · ${fmtSize(d.size)}</span><a class="btn-link" href="/api/documents/${esc(d.id)}/download">다운로드</a></div>`
  ).join('') + '<p class="small"><a href="#library" onclick="switchTab(\'library\');return false">라이브러리에서 전체 보기 →</a></p>' : '<p class="empty">아직 업로드한 파일이 없습니다.</p>';
}
function fmtSize(n) {
  n = Number(n) || 0;
  return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? Math.round(n / 1024) + 'KB' : n + 'B';
}
async function loadRecordings() {
  const j = await api('/api/recordings');
  if (!j.ok) { $('recList').innerHTML = '<p class="err">녹음 목록을 불러오지 못했습니다.</p>'; return; }
  $('recList').innerHTML = j.recordings.length ? j.recordings.map(r => {
    const kb = (r.size / 1024).toFixed(0);
    const badge = r.transcript_status === 'ready' ? '<span class="badge ok">전사 완료</span>'
      : r.transcript_status === 'processing' ? '<span class="badge warn">전사 중</span>' : '<span class="badge">전사 대기</span>';
    const prog = r.transcript_status === 'processing' && r.progress ? ` · ${esc(r.progress)}` : '';
    const btn = r.transcript_status === 'ready'
      ? `<button class="secondary" onclick="loadRecording('${r.id}')">불러오기</button>`
      : r.transcript_status === 'processing'
      ? `<button class="secondary" onclick="pollRecording('${r.id}')">진행 확인</button>`
      : `<button class="secondary" onclick="retryRecording('${r.id}')">다시 전사</button>`;
    return `<div class="taskrow"><span class="t-title">${esc(r.title)}</span>${badge}<span class="t-src">${fmtDate(r.created_at)} · ${kb}KB${prog}</span>${btn}</div>${pipelineSteps(r)}`;
  }).join('') : '<p class="empty">아직 음성 파일이 없습니다.</p>';
}
// S1 파이프라인 단계 표시: 전사 → 요약 → 색인 → 완료. 전사 대기(pending) 행은
// 파이프라인이 시작도 안 한 상태라 표시하지 않는다. failed면 사유와 다시 시도 버튼을 단다.
function pipelineSteps(r) {
  if (r.transcript_status === 'pending') return '';
  const stage = r.pipeline_stage || 'queued';
  if (stage === 'failed') {
    return `<div class="steps">파이프라인 실패: ${esc(r.pipeline_error || '알 수 없는 오류')} <button class="secondary" onclick="pipelineRetryRecording('${r.id}')">파이프라인 다시 시도</button></div>`;
  }
  const steps = ['전사', '요약', '색인', '완료'];
  let idx = 0; // 현재 단계
  if (stage === 'done') idx = 4;
  else if (stage === 'indexing') idx = 2;
  else if (stage === 'summarizing') idx = 1;
  else if (stage === 'queued' && r.transcript_status === 'ready') idx = 1; // 전사 끝, 요약 대기
  const label = stage === 'done' ? '완료'
    : stage === 'indexing' ? '색인 중'
    : stage === 'summarizing' ? '요약 중'
    : stage === 'queued' && r.transcript_status === 'ready' ? '요약 대기 중'
    : stage === 'queued' ? '전사 대기 중' : '전사 중';
  const parts = steps.map((s, i) => {
    if (i < idx) return `<span class="done">✓ ${s}</span>`;
    if (i === idx) return `<span class="now">… ${s}</span>`;
    return `<span>${s}</span>`;
  }).join(' → ');
  return `<div class="steps">${parts} · ${label}</div>`;
}
async function pipelineRetryRecording(id) {
  const j = await api('/api/recordings/' + id + '/pipeline-retry', { method: 'POST' });
  if (!j.ok) { alert('파이프라인을 다시 시작하지 못했습니다. ' + (j.error || '')); return; }
  if (j.pipelineStage === 'done') { alert('파이프라인이 이미 완료됐습니다.'); loadRecordings(); return; }
  $('audioResult').innerHTML = '<p class="loading">파이프라인을 다시 시작했습니다… (요약 → 색인)</p>';
  pollRecording(id);
  loadRecordings();
}
async function pollRecording(id) {
  // 전사 진행 상황을 확인하면서 한 번에 1구간씩 이어간다. 백그라운드 작업은
  // 약 2분 뒤에 조용히 죽으므로, 페이지를 열어둔 폴링이 전사를 끌고 가는
  // 경로다 (POST /advance: 잠금이 없으면 다음 1구간을 직접 전사). ready가
  // 되면 전사본을 채우고, S1 파이프라인(요약 → 색인)이 끝날 때까지 GET으로
  // 상태를 확인한다. pending이 되면 실패 사유를 보여준다. 60분 지나도
  // 안 끝나면 중단하고 녹음 목록에서 나중에 확인하라고 안내한다.
  const started = Date.now();
  let filled = false; // 전사본을 입력란에 채웠는지
  while (Date.now() - started < 60 * 60 * 1000) {
    // /advance 호출이 실패해도 루프를 끝내지 않는다: 한 번 끊겼다고 전사가
    // 멈추면 안 된다. 실패하면 5초 뒤 다시 시도한다.
    let j;
    try {
      // 전사가 끝나면 /advance는 할 일이 없어 행만 돌려주므로,
      // 파이프라인 단계는 가벼운 GET으로 확인한다.
      j = filled
        ? await api('/api/recordings/' + id)
        : await api('/api/recordings/' + id + '/advance', { method: 'POST' });
    } catch (e) {
      $('audioResult').innerHTML = '<p class="err">연결이 끊겼습니다. 다시 시도 중입니다…</p>';
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    if (!j.ok) {
      $('audioResult').innerHTML = '<p class="err">전사 상태를 확인할 수 없습니다. 다시 시도 중입니다…</p>';
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    const r = j.recording;
    if (r.transcript_status === 'ready' && r.transcript) {
      if (!filled) {
        docId = r.doc_id; lastDocTitle = r.title.replace(/\.[^.]+$/, '');
        $('docTitle').value = lastDocTitle;
        $('docContent').value = r.transcript;
        $('summarizeBtn').disabled = false;
        filled = true;
      }
      const stage = r.pipeline_stage || 'queued';
      if (stage === 'done') {
        $('audioResult').innerHTML = `<div class="card">전사 · 요약 · 색인 완료</div>`;
        loadRecordings(); loadHome();
        return;
      }
      if (stage === 'failed') {
        $('audioResult').innerHTML = `<div class="card">전사는 완료됐으나 파이프라인이 실패했습니다: ${esc(r.pipeline_error || '')}. <button class="secondary" onclick="pipelineRetryRecording('${r.id}')">파이프라인 다시 시도</button></div>`;
        loadRecordings();
        return;
      }
      $('audioResult').innerHTML = `<div><p class="loading">전사 완료 — 파이프라인 진행 중입니다…</p>${pipelineSteps(r)}</div>`;
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    if (r.transcript_status === 'pending') {
      $('audioResult').innerHTML = `<div class="card">오디오만 저장됐습니다 (전사 대기). ${esc(r.progress || 'Whisper가 텍스트를 못 뽑았습니다')}. 녹음 목록에서 “다시 전사”를 눌러보세요.</div>`;
      loadRecordings();
      return;
    }
    $('audioResult').innerHTML = `<p class="loading">전사하는 중입니다…${r.progress ? ' — ' + esc(r.progress) : ''} · 페이지를 열어두면 이어집니다</p>`;
    await new Promise(res => setTimeout(res, 5000));
  }
  $('audioResult').innerHTML = '<p class="small">아직 전사 중입니다. 녹음 목록에서 이어갈 수 있습니다.</p>';
  loadRecordings();
}
async function loadRecording(id) {
  const j = await api('/api/recordings/' + id);
  if (!j.ok) { alert('전사본이 없습니다.'); return; }
  if (j.recording.transcript_status === 'processing') { $('audioResult').innerHTML = '<p class="loading">전사하는 중입니다…</p>'; pollRecording(id); return; }
  if (!j.recording.transcript) { alert('전사본이 없습니다.'); return; }
  setUpPane('doc');
  docId = j.recording.doc_id; lastDocTitle = j.recording.title.replace(/\.[^.]+$/, '');
  $('docTitle').value = lastDocTitle;
  $('docContent').value = j.recording.transcript;
  $('summarizeBtn').disabled = false;
  $('docResult').innerHTML = `<div class="card">전사본을 불러왔습니다.</div>`;
  // 전사는 끝났는데 파이프라인(요약 → 색인)이 아직 돌고 있으면 진행을 따라간다.
  if (j.recording.pipeline_stage && j.recording.pipeline_stage !== 'done' && j.recording.pipeline_stage !== 'failed') pollRecording(id);
}
async function retryRecording(id) {
  const j = await api('/api/recordings/' + id + '/retry', { method: 'POST' });
  if (!j.ok) { alert('다시 전사를 시작하지 못했습니다. ' + (j.error || '')); return; }
  if (j.transcriptStatus === 'ready') { alert('전사가 완료됐습니다.'); loadRecording(id); }
  else { $('audioResult').innerHTML = '<p class="loading">전사하는 중입니다…</p>'; pollRecording(id); }
  loadRecordings();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
window.addEventListener('hashchange', () => switchTab(location.hash.slice(1), true));
async function api(path, opts) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  return r.json();
}
// ---- 관점 선택 (2026-11-16, 사용자 식별) ----
// 일반 사용자: 관점은 항상 "내 개인 공간" (읽기 전용 표시). HR 관리자: 활성 사용자 드롭다운에서
// 반드시 직접 고른다 (관리자 본인을 기본값으로 두지 않는다 — 관리자는 고른 사용자 대신 처리한다).
let perspectiveUsers = null;
function isAdminUser() { return !!(currentUser && currentUser.role === 'hr_admin'); }
async function getPerspectiveUsers() {
  if (perspectiveUsers) return perspectiveUsers;
  try { const u = await api('/api/users/coaching'); perspectiveUsers = u.ok ? (u.users || []) : []; }
  catch { perspectiveUsers = []; }
  return perspectiveUsers;
}
function perspectiveName(id) {
  const u = (perspectiveUsers || []).find(x => x.id === id);
  return u ? (u.name || u.email) : '';
}
function userOptions(users, placeholder) {
  return `<option value="">${esc(placeholder)}</option>` + users.map(u => `<option value="${esc(u.id)}">${esc(u.name || u.email)} (${esc(u.email)})</option>`).join('');
}
async function renderPerspectives() {
  const admin = isAdminUser();
  const users = admin ? await getPerspectiveUsers() : [];
  const boxes = [
    ['upPerspectiveBox', 'upPerspective', '<option value="__shared__">공용 문서 (모든 사용자 · 파일 업로드만)</option>'],
    ['personalPerspectiveBox', 'personalPerspective', ''],
  ];
  for (const [box, id, extra] of boxes) {
    const keep = $(id) ? $(id).value : '';
    $(box).innerHTML = admin
      ? `<select id="${id}">${userOptions(users, '— 사용자를 선택하세요 —')}${extra}</select>`
      : `<span class="badge">${currentUser ? '내 개인 공간' : '로그인 안 함 · 공용'}</span>`;
    if (admin && keep && (users.some(u => u.id === keep) || keep === '__shared__')) $(id).value = keep;
  }
  if (admin) {
    $('upPerspective').onchange = updatePerspectiveNotes;
    // 다른 사용자 관점으로 바꾸면 대화 문맥이 섞이지 않게 개인 검색 세션을 새로 시작한다.
    $('personalPerspective').onchange = () => { personalSessionId = null; $('personalResult').innerHTML = ''; updatePerspectiveNotes(); };
  }
  updatePerspectiveNotes();
}
function updatePerspectiveNotes() {
  const admin = isAdminUser();
  const up = admin && $('upPerspective') ? $('upPerspective').value : '';
  $('upPerspectiveNote').textContent = !admin
    ? '올린 전사본·음성·문서는 내 개인 공간에 저장되고, 개인 업무 검색에서 찾을 수 있습니다.'
    : up === '__shared__' ? '공용 문서로 올립니다 (파일 업로드만 — 모든 사용자가 봅니다). 전사본·음성 전사는 사용자를 골라야 합니다.'
    : up ? `${perspectiveName(up)}의 개인 공간에 저장합니다 (HR 관리자가 대신 올림).`
    : 'HR 관리자: 누구의 개인 공간에 올릴지 먼저 사용자를 선택하세요. 관리자 본인 계정에는 쌓지 않습니다.';
  const ps = admin && $('personalPerspective') ? $('personalPerspective').value : '';
  $('personalScopeLabel').textContent = !admin
    ? '내 개인 업무에서 검색'
    : ps ? `${perspectiveName(ps)}의 개인 업무에서 검색` : 'HR 관리자: 누구의 개인 업무에서 검색할지 사용자를 선택하세요.';
}
// 업로드 대상. kind: 'transcript' | 'voice' | 'file'. 반환 { ok, asUserId?, shared? }.
function uploadTarget(kind) {
  if (!isAdminUser()) return { ok: true };
  const v = $('upPerspective') ? $('upPerspective').value : '';
  if (!v) { alert('관점: 누구의 개인 공간에 올릴지 사용자를 먼저 선택하세요.'); return { ok: false }; }
  if (v === '__shared__') {
    if (kind !== 'file') { alert('전사본·음성 전사는 공용으로 올릴 수 없습니다. 관점에서 사용자를 선택하세요.'); return { ok: false }; }
    return { ok: true, shared: true };
  }
  return { ok: true, asUserId: v };
}
function ownerNote(j) { return j && j.asUser ? ` · <b>${esc(j.asUser)}</b>의 개인 공간에 저장` : ''; }
// ---- 로그인 (2026-11-15) ----
function applyRole() {
  const isAdmin = currentUser && currentUser.role === 'hr_admin';
  document.querySelectorAll('.tabs button[data-tab="obs"], .tabs button[data-tab="admin"]').forEach(b => {
    b.style.display = isAdmin ? '' : 'none';
  });
  // 개인 업무 검색·메일함은 로그인 사용자만 (익명은 탭을 숨긴다).
  document.querySelectorAll('.tabs button[data-tab="personal"], .tabs button[data-tab="email"], .tabs button[data-tab="approval"], .tabs button[data-tab="lms"]').forEach(b => {
    b.style.display = currentUser ? '' : 'none';
  });
  // 알림 종 + 결재 대기 배지: 로그인했을 때만 (익명은 숨기고 숫자를 비운다).
  $('ntfBell').style.display = currentUser ? '' : 'none';
  if (currentUser) apvHome(); else { $('apvPendingBadge').style.display = 'none'; ntfPaintCount(0); }
  // 코칭 대상: COACHEE_TABS + (hr_admin이면) 관리자 탭만 렌더링한다.
  if (currentUser) {
    document.querySelectorAll('.tabs button[data-tab]').forEach(b => {
      if (!tabAllowed(b.dataset.tab)) b.style.display = 'none';
      else if (!ADMIN_TABS.includes(b.dataset.tab)) b.style.display = '';
    });
  }
  applyCoachingMode();
  // 관점 선택·할 일 관리자 막대: 로그인 사용자가 바뀌면 다시 그린다.
  perspectiveUsers = null;
  renderPerspectives();
  $('taskAdminBar').style.display = isAdmin ? '' : 'none';
  $('homeByUserCard').style.display = isAdmin ? '' : 'none';
  const chip = $('userChip');
  if (currentUser) {
    $('userChipName').textContent = currentUser.name;
    $('userAvatar').textContent = (currentUser.name || '?').trim().charAt(0) || '?';
    $('userAvatar').title = (currentUser.name || '') + ' · 로그아웃';
    $('userChipMeta').textContent = currentUser.email + (isAdmin ? ' · HR 관리자' : ' · 일반 사용자') + (isCoachee() ? ' · 코칭 대상' : ' · 코치');
    chip.style.display = 'flex';
  } else {
    chip.style.display = 'none';
  }
}
function showAuthOverlay(kind) {
  $('authOverlay').classList.add('show');
  $('loginBox').style.display = kind === 'setup' ? 'none' : '';
  $('setupBox').style.display = kind === 'setup' ? '' : 'none';
}
function hideAuthOverlay() { $('authOverlay').classList.remove('show'); }
async function checkAuth() {
  // 설정 링크(#setup=토큰)가 있으면 비밀번호 설정 화면을 먼저 보인다.
  const hash = location.hash.slice(1);
  if (hash.startsWith('setup=')) { showAuthOverlay('setup'); return; }
  let me = null;
  try { me = await api('/api/auth/me'); } catch (e) { me = null; }
  if (me && me.ok && me.user) {
    currentUser = me.user;
    hideAuthOverlay();
    applyRole();
    switchTab(location.hash.slice(1), true);
  } else {
    currentUser = null;
    applyRole();
    showAuthOverlay('login');
  }
}
async function doLogin(e) {
  e.preventDefault();
  $('loginErr').textContent = '';
  $('loginBtn').disabled = true;
  try {
    const j = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: $('loginEmail').value, password: $('loginPassword').value }) });
    if (!j.ok) throw new Error(j.error || '로그인에 실패했습니다.');
    currentUser = j.user;
    $('loginPassword').value = '';
    hideAuthOverlay();
    applyRole();
    switchTab(location.hash.slice(1) || 'home', !!location.hash.slice(1)); // 알림 메일 링크(#approval/<id>)로 들어왔으면 그대로 연다
  } catch (err) {
    $('loginErr').textContent = err.message;
  } finally {
    $('loginBtn').disabled = false;
  }
}
async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  currentUser = null;
  applyRole();
  unmountObs();
  showAuthOverlay('login');
}
async function doSetup(e) {
  e.preventDefault();
  $('setupErr').textContent = ''; $('setupOk').textContent = '';
  const pw = $('setupPassword').value, cf = $('setupConfirm').value;
  if (pw !== cf) { $('setupErr').textContent = '입력한 비밀번호가 일치하지 않습니다.'; return; }
  $('setupBtn').disabled = true;
  try {
    const token = new URLSearchParams(location.hash.slice(1)).get('setup') || '';
    const j = await api('/api/auth/set-password', { method: 'POST', body: JSON.stringify({ token, password: pw }) });
    if (!j.ok) throw new Error(j.error || '비밀번호 설정에 실패했습니다.');
    currentUser = j.user;
    $('setupOk').textContent = '비밀번호를 설정했습니다. 잠시 후 홈으로 이동합니다.';
    history.replaceState(null, '', location.pathname);
    setTimeout(() => { hideAuthOverlay(); applyRole(); switchTab('home'); }, 800);
  } catch (err) {
    $('setupErr').textContent = err.message;
  } finally {
    $('setupBtn').disabled = false;
  }
}
function roleLabel(r) { return r === 'hr_admin' ? 'HR 관리자' : '일반 사용자'; }
function statusLabel(s) { return s === 'active' ? '활성' : s === 'pending' ? '설정 대기' : '비활성'; }
async function loadAdminUsers() {
  const box = $('adminUsers');
  const j = await api('/api/admin/users');
  if (!j.ok) { box.innerHTML = '<p class="err">사용자 목록을 불러오지 못했습니다. ' + esc(j.error || '') + '</p>'; return; }
  if (!j.users.length) { box.innerHTML = '<p class="empty">등록된 사용자가 없습니다.</p>'; return; }
  // 코칭 역할 드롭다운 (2026-11-16): PATCH /api/admin/users/:id {coaching_role}. 자기 계정은 서버가 막으므로 비활성화한다.
  const coachingCell = (u) => {
    const self = currentUser && currentUser.id === u.id;
    const v = u.coaching_role === 'coach' ? 'coach' : 'coachee';
    return `<select aria-label="코칭 역할" ${self ? 'disabled title="자기 계정의 코칭 역할은 바꿀 수 없습니다"' : ''} onchange="setUserCoachingRole('${u.id}', this.value)">` +
      `<option value="coach"${v === 'coach' ? ' selected' : ''}>코치</option><option value="coachee"${v === 'coachee' ? ' selected' : ''}>코칭 대상</option></select>`;
  };
  // 부서 (결재 A2): /api/admin/users는 department_id를 주지 않아서, 활성 사용자 검색(/api/approval/users)으로 현재 부서를 채운다.
  const dj = await api('/api/approval/admin/departments').catch(() => ({ ok: false }));
  const depts = dj.ok ? dj.departments.filter(d => d.is_active) : [];
  const deptOf = {};
  const first = await api('/api/approval/users').catch(() => ({ ok: false }));
  (first.ok ? first.users : []).forEach(u => { deptOf[u.id] = u.department_id || ''; });
  await Promise.all(j.users.filter(u => u.status === 'active' && !(u.id in deptOf)).map(async u => {
    const r = await api('/api/approval/users?q=' + encodeURIComponent(u.email)).catch(() => ({ ok: false }));
    const m = r.ok ? r.users.find(x => x.id === u.id) : null;
    if (m) deptOf[u.id] = m.department_id || '';
  }));
  const deptCell = (u) => !dj.ok ? '—' :
    `<select aria-label="부서" onchange="setUserDept('${u.id}', this.value)">` +
    (u.id in deptOf ? '' : '<option value="" selected disabled>(미확인)</option>') +
    `<option value=""${deptOf[u.id] === '' ? ' selected' : ''}>미지정</option>` +
    depts.map(d => `<option value="${esc(d.id)}"${deptOf[u.id] === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('') + '</select>';
  box.innerHTML = '<table class="admin-table"><thead><tr><th>이메일</th><th>이름</th><th>부서</th><th>역할</th><th>코칭 역할</th><th>상태</th><th>동작</th></tr></thead><tbody>' +
    j.users.map(u => `<tr><td>${esc(u.email)}</td><td>${esc(u.name)}</td><td>${deptCell(u)}</td><td>${roleLabel(u.role)}</td><td>${coachingCell(u)}</td><td>${statusLabel(u.status)}</td>` +
      `<td><div class="rowbtns">` +
      (u.status !== 'inactive' ? `<button type="button" onclick="issueUserLink('${u.id}')">설정 링크</button>` : '') +
      (u.status !== 'inactive' ? `<button type="button" onclick="resetUser('${u.id}')">초기화</button>` : '') +
      (u.role === 'hr_admin'
        ? `<button type="button" onclick="setUserRole('${u.id}','user')">일반으로</button>`
        : `<button type="button" onclick="setUserRole('${u.id}','hr_admin')">관리자로</button>`) +
      (u.status === 'inactive'
        ? `<button type="button" onclick="setUserStatus('${u.id}','active')">활성화</button>`
        : `<button type="button" onclick="setUserStatus('${u.id}','inactive')">비활성화</button>`) +
      `</div></td></tr>`).join('') + '</tbody></table>';
}
async function createAdminUser(e) {
  e.preventDefault();
  $('adminCreateMsg').textContent = '';
  const j = await api('/api/admin/users', { method: 'POST', body: JSON.stringify({ email: $('adminNewEmail').value, name: $('adminNewName').value, role: $('adminNewRole').value, coaching_role: $('adminNewCoachingRole').value }) });
  if (!j.ok) { $('adminCreateMsg').textContent = '계정을 만들지 못했습니다. ' + (j.error || ''); return; }
  $('adminCreateMsg').textContent = '계정을 만들었습니다. 이 설정 링크를 ' + j.user.email + '님께 전달하세요 (1회용, 24시간): ' + location.origin + j.setupPath;
  $('adminNewEmail').value = ''; $('adminNewName').value = '';
  loadAdminUsers();
}
async function issueUserLink(id) {
  const j = await api('/api/auth/issue-link', { method: 'POST', body: JSON.stringify({ userId: id }) });
  if (!j.ok) { alert('설정 링크를 발급하지 못했습니다. ' + (j.error || '')); return; }
  prompt('설정 링크 (1회용, 24시간) — 복사해서 전달하세요:', location.origin + j.setupPath);
}
async function resetUser(id) {
  if (!confirm('이 계정의 비밀번호를 초기화하고 새 설정 링크를 발급할까요? 기존 세션은 모두 로그아웃됩니다.')) return;
  const j = await api('/api/admin/users/' + id + '/reset', { method: 'POST' });
  if (!j.ok) { alert('초기화하지 못했습니다. ' + (j.error || '')); return; }
  prompt('새 설정 링크 (1회용, 24시간) — 복사해서 전달하세요:', location.origin + j.setupPath);
  loadAdminUsers();
}
async function setUserRole(id, role) {
  const j = await api('/api/admin/users/' + id, { method: 'PATCH', body: JSON.stringify({ role }) });
  if (!j.ok) { alert('역할을 바꾸지 못했습니다. ' + (j.error || '')); return; }
  loadAdminUsers();
}
async function setUserCoachingRole(id, coaching_role) {
  const j = await api('/api/admin/users/' + id, { method: 'PATCH', body: JSON.stringify({ coaching_role }) });
  if (!j.ok) alert('코칭 역할을 바꾸지 못했습니다. ' + (j.error || ''));
  loadAdminUsers();
}
async function setUserStatus(id, status) {
  const j = await api('/api/admin/users/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
  if (!j.ok) { alert('상태를 바꾸지 못했습니다. ' + (j.error || '')); return; }
  loadAdminUsers();
}
async function changeMyPassword(e) {
  e.preventDefault();
  $('pwMsg').textContent = '';
  const j = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: $('pwCurrent').value, newPassword: $('pwNew').value }) });
  if (!j.ok) { $('pwMsg').textContent = '변경하지 못했습니다. ' + (j.error || ''); $('pwMsg').style.color = '#b91c1c'; return; }
  $('pwMsg').textContent = '비밀번호를 변경했습니다.';
  $('pwMsg').style.color = '#166534';
  $('pwCurrent').value = ''; $('pwNew').value = '';
}
$('loginForm').addEventListener('submit', doLogin);
$('setupForm').addEventListener('submit', doSetup);
$('adminCreateForm').addEventListener('submit', createAdminUser);
// ---- 부서 관리 (결재 A2, hr_admin): /api/approval/admin/departments ----
function adminSetPane(p) {
  const d = p === 'depts';
  $('adminSub-users').setAttribute('aria-selected', d ? 'false' : 'true');
  $('adminSub-depts').setAttribute('aria-selected', d ? 'true' : 'false');
  $('adminDeptCard').style.display = d ? '' : 'none';
  $('adminUsersCard').style.display = d ? 'none' : '';
  $('adminPwCard').style.display = d ? 'none' : '';
  if (d) loadAdminDepts();
}
async function setUserDept(id, deptId) {
  const j = await api('/api/approval/admin/users/' + encodeURIComponent(id) + '/department', { method: 'PUT', body: JSON.stringify({ department_id: deptId || null }) });
  if (!j.ok) { alert('부서를 바꾸지 못했습니다. ' + (j.error || '')); loadAdminUsers(); }
}
let adminDeptList = [];
async function loadAdminDepts() {
  const [dj, uj] = await Promise.all([api('/api/approval/admin/departments'), api('/api/admin/users')]);
  if (!dj.ok) { $('adminDepts').innerHTML = '<p class="err">부서 목록을 불러오지 못했습니다. ' + esc(dj.error || '') + '</p>'; return; }
  adminDeptList = dj.departments;
  const users = (uj.ok ? uj.users : []).filter(u => u.status === 'active');
  const userOpts = (sel) => '<option value="">(없음)</option>' + users.map(u => `<option value="${esc(u.id)}"${u.id === sel ? ' selected' : ''}>${esc(u.name || u.email)}</option>`).join('');
  const deptOpts = (sel, self) => '<option value="">(최상위)</option>' + dj.departments.filter(d => d.id !== self).map(d => `<option value="${esc(d.id)}"${d.id === sel ? ' selected' : ''}>${esc(d.name)}</option>`).join('');
  $('deptNewParent').innerHTML = deptOpts('', '');
  $('deptNewManager').innerHTML = userOpts('');
  $('adminDepts').innerHTML = dj.departments.length
    ? '<table class="admin-table"><thead><tr><th>코드</th><th>이름</th><th>상위</th><th>부서장</th><th>인원</th><th>사용</th><th></th></tr></thead><tbody>' +
      dj.departments.map(d => `<tr id="deptRow-${esc(d.id)}"><td><input type="text" data-f="code" value="${escAttr(d.code)}" style="width:90px" /></td>
        <td><input type="text" data-f="name" value="${escAttr(d.name)}" style="width:130px" /></td>
        <td><select data-f="parent">${deptOpts(d.parent_id, d.id)}</select></td>
        <td><select data-f="manager">${userOpts(d.manager_user_id)}</select></td>
        <td>${d.member_count}</td>
        <td><input type="checkbox" data-f="active" ${d.is_active ? 'checked' : ''} /></td>
        <td><button type="button" onclick="saveDept('${escAttr(d.id)}')">저장</button></td></tr>`).join('') + '</tbody></table>'
    : '<p class="empty">부서가 없습니다.</p>';
}
async function postDept(body) {
  $('deptMsg').textContent = '';
  const j = await api('/api/approval/admin/departments', { method: 'POST', body: JSON.stringify(body) });
  if (!j.ok) { $('deptMsg').textContent = '저장하지 못했습니다. ' + (j.error || ''); return false; }
  loadAdminDepts();
  return true;
}
function saveDept(id) {
  const row = $('deptRow-' + id), f = (k) => row.querySelector(`[data-f="${k}"]`);
  const old = adminDeptList.find(d => d.id === id) || {};
  postDept({ id, code: f('code').value, name: f('name').value, parent_id: f('parent').value || null, manager_user_id: f('manager').value || null, is_active: f('active').checked, sort_order: old.sort_order || 0 });
}
$('deptCreateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ok = await postDept({ code: $('deptNewCode').value, name: $('deptNewName').value, parent_id: $('deptNewParent').value || null, manager_user_id: $('deptNewManager').value || null });
  if (ok) { $('deptNewCode').value = ''; $('deptNewName').value = ''; }
});
$('changePwForm').addEventListener('submit', changeMyPassword);
function copySummary() {
  const text = lastSummaryText || '요약 결과가 없습니다.';
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => alert('요약을 복사했습니다.'));
  else alert(text);
}
function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// 브리핑 본문(AI가 마크다운으로 쓰기도 함) → 안전한 HTML. 이스케이프 후 제목·목록·굵게만 변환한다 (의존성 없음).
function renderDigestBody(md) {
  const inline = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '$1');
  // 항목 라벨('날짜:', '핵심 요약:' 등)을 굵게 — esc() 이후 적용, 줄 맨 앞 '라벨:'만 대상
  const labeled = (t) => inline(t).replace(/^([^<:]{1,20}:)(?=\s|$)/, '<strong>$1</strong>');
  const out = []; let list = false;
  const close = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const li = line.match(/^[*\-•]\s+(.*)$/);
    if (h) { close(); out.push('<p><strong>' + inline(h[1]) + '</strong></p>'); }
    else if (li) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + labeled(li[1]) + '</li>'); }
    else { close(); out.push('<p>' + labeled(line) + '</p>'); }
  }
  close();
  return out.join('');
}
function fmtDate(s) { return s ? String(s).slice(0, 10) : ''; }
function taskRow(t) {
  // 0021: 담당자 이름 (owner_id NULL → "미지정").
  const owner = `<span class="badge${t.owner_id ? '' : ' warn'}" title="담당자">${esc(t.owner_name || '미지정')}</span>`;
  return `<div class="taskrow${t.done ? ' done' : ''}"><input type="checkbox" ${t.done ? 'checked' : ''} onchange="toggleTask('${t.id}')" />${owner}<span class="t-title">${esc(t.title)}</span>${t.source ? `<span class="t-src">${esc(t.source)}</span>` : ''}<button class="iconbtn" title="삭제" onclick="deleteTask('${t.id}')">×</button></div>`;
}
async function loadHome() {
  const [j, em] = await Promise.all([
    api('/api/home'),
    api('/api/email/inbox?limit=5').catch(() => ({ ok: false })),
  ]);
  apvRenderHomeCard();
  if (!j.ok) return;
  const c = j.counts;
  // 홈 통계도 메뉴 순서에 맞춘다: 안 읽은 메일 → 열린 할 일 → 문서 → 리플렉션.
  $('homeStats').innerHTML =
    `<div class="stat"><b>${em && em.ok ? em.unread : '—'}</b><span>안 읽은 메일</span></div>` +
    `<div class="stat"><b>${c.openTasks}</b><span>열린 할 일</span></div>` +
    `<div class="stat"><b>${c.documents}</b><span>문서</span></div>` +
    `<div class="stat"><b>${c.reflections}</b><span>리플렉션</span></div>`;
  // 메일함 카드 (최근 5건, 안 읽은 것부터 — 클릭하면 해당 메일 상세로).
  if (!em || !em.ok) {
    $('homeEmail').innerHTML = '<p class="empty">로그인하면 내 메일을 볼 수 있습니다.</p>';
  } else if (!em.emails.length) {
    $('homeEmail').innerHTML = '<p class="empty">받은 메일이 없습니다.</p>';
  } else {
    $('homeEmail').innerHTML = em.emails.map(m => {
      const unread = m.direction === 'in' && !m.is_read;
      const who = m.direction === 'out' ? '나 → ' + emailName(m.to_addr) : emailName(m.from_addr);
      return `<div class="taskrow" style="cursor:pointer" onclick="switchTab('email');emailView('${escAttr(m.id)}')"><span class="t-title">${unread ? '<b>● </b>' : ''}${esc(m.subject || '(제목 없음)')}</span><span class="badge">${esc(who)}</span><span class="t-src">${fmtDate(m.received_at)}</span></div>`;
    }).join('');
  }
  const adminHome = isAdminUser();
  $('homeDocs').innerHTML = j.recentDocuments.length
    ? j.recentDocuments.map(d => `<div class="taskrow"><span class="t-title">${esc(d.title)}</span><span class="badge">${esc(d.kind)}</span>${adminHome ? `<span class="badge" title="소유자">${esc(d.owner_name || '공용')}</span>` : ''}<span class="t-src">${fmtDate(d.created_at)}</span></div>`).join('')
    : '<p class="empty">아직 문서가 없습니다.</p>';
  // 0021: 사용자별 집계 (hr_admin 전용 — 서버가 byUser를 hr_admin에게만 준다).
  $('homeByUserCard').style.display = j.byUser ? '' : 'none';
  if (j.byUser) {
    $('homeByUser').innerHTML = j.byUser.length
      ? '<table class="obs-table"><thead><tr><th>사용자</th><th>문서</th><th>할 일</th><th>리플렉션</th></tr></thead><tbody>' +
        j.byUser.map(u => `<tr><td><b>${esc(u.name || u.email)}</b> <span class="small">${esc(u.email)}</span></td><td>${u.documents}</td><td>${u.tasks}</td><td>${u.reflections}</td></tr>`).join('') +
        '</tbody></table>'
      : '<p class="empty">활성 사용자가 없습니다.</p>';
  }
  $('homeTasks').innerHTML = j.openTasks.length
    ? j.openTasks.map(taskRow).join('')
    : '<p class="empty">열린 할 일이 없습니다.</p>';
  $('homeRefl').innerHTML = j.recentReflections.length
    ? j.recentReflections.map(r => {
        let pats = [];
        try { pats = JSON.parse(r.patterns || '[]'); } catch { pats = []; }
        const who = adminHome ? `<span class="badge" title="코치 → 코칭 대상">${esc(r.coach_name || '미지정')} → ${esc(r.coachee_name || '미지정')}</span>` : '';
        return `<div class="taskrow"><span class="t-title">${esc(pats[0] || '리플렉션')}</span>${who}<span class="t-src">${fmtDate(r.created_at)}</span></div>`;
      }).join('')
    : '<p class="empty">아직 리플렉션이 없습니다.</p>';
  lmsHomeCard();
  try {
    const dg = await api('/api/digest');
    $('homeDigest').innerHTML = dg.ok && dg.digest
      ? `<p class="small">${esc(dg.digest.runDate)} · ${dg.digest.engine === 'workers-ai' ? 'AI 생성' : '템플릿 생성'}</p>${renderDigestBody(dg.digest.body)}<p class="small">새 문서 ${dg.digest.counts.documents}건 · 열린 할 일 ${dg.digest.counts.openTasks}건 · 새 리플렉션 ${dg.digest.counts.reflections}건</p>`
      : '<p class="empty">아직 브리핑이 없습니다.</p>';
  } catch { $('homeDigest').innerHTML = '<p class="empty">다이제스트를 불러오지 못했습니다.</p>'; }
}
async function loadTasks() {
  const admin = isAdminUser();
  $('taskAdminBar').style.display = admin ? '' : 'none';
  if (admin) {
    // 사용자 필터·담당자 드롭다운 (관리자 본인을 기본값으로 두지 않는다).
    const users = await getPerspectiveUsers();
    const keepF = $('taskOwnerFilter').value, keepO = $('newTaskOwner').value;
    $('taskOwnerFilter').innerHTML = '<option value="">전체 사용자</option><option value="unassigned">미지정</option>' + users.map(u => `<option value="${esc(u.id)}">${esc(u.name || u.email)} (${esc(u.email)})</option>`).join('');
    $('newTaskOwner').innerHTML = userOptions(users, '— 사용자를 선택하세요 —');
    if (keepF === 'unassigned' || users.some(u => u.id === keepF)) $('taskOwnerFilter').value = keepF;
    if (users.some(u => u.id === keepO)) $('newTaskOwner').value = keepO;
  }
  const f = admin ? $('taskOwnerFilter').value : '';
  const j = await api('/api/tasks' + (f ? '?owner=' + encodeURIComponent(f) : ''));
  if (!j.ok) return;
  $('taskList').innerHTML = j.tasks.length
    ? j.tasks.map(taskRow).join('')
    : '<p class="empty">할 일이 없습니다.</p>';
}
$('taskOwnerFilter').onchange = () => loadTasks();
async function addTask() {
  const title = $('newTaskTitle').value.trim();
  if (!title) return;
  const body = { title };
  if (isAdminUser()) {
    // 관리자는 담당자를 직접 골라 그 사용자의 할 일로 만든다 (본인 계정에 쌓지 않는다).
    const owner = $('newTaskOwner').value;
    if (!owner) { alert('새 할 일 담당자를 선택하세요.'); return; }
    body.ownerId = owner;
  }
  const j = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
  if (!j.ok) { alert('할 일을 만들지 못했습니다: ' + (j.error || '')); return; }
  $('newTaskTitle').value = '';
  loadTasks(); loadHome();
}
async function toggleTask(id) {
  await api('/api/tasks/' + id, { method: 'PATCH', body: JSON.stringify({}) });
  loadTasks(); loadHome();
}
async function deleteTask(id) {
  await api('/api/tasks/' + id, { method: 'DELETE' });
  loadTasks(); loadHome();
}
async function saveActionsAsTasks() {
  if (!lastActions.length) { alert('저장할 액션이 없습니다.'); return; }
  // 관리자: 업로드 관점에서 고른 사용자의 할 일로 저장한다.
  let ownerId;
  if (isAdminUser()) {
    const v = $('upPerspective') ? $('upPerspective').value : '';
    if (!v || v === '__shared__') { alert('관점에서 할 일을 맡을 사용자를 선택하세요.'); return; }
    ownerId = v;
  }
  let n = 0;
  for (const a of lastActions) {
    const j = await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: a, source: lastDocTitle, ownerId }) });
    if (j.ok) n++;
  }
  alert(`액션 ${n}건을 할 일로 저장했습니다.`);
  loadTasks(); loadHome();
}
async function downloadDeck() {
  const box = $('deckResult');
  if (box) box.innerHTML = '<p class="small">PPTX 초안을 만들고 있습니다…</p>';
  const j = await api('/api/deck', { method: 'POST', body: JSON.stringify({ title: lastDocTitle || 'People OS 요약', summary: lastSummary, actions: lastActions, source: docId }) });
  if (j.ok && box) box.innerHTML = renderDeckLink(j);
  else if (box) box.innerHTML = `<p class="small">오류: ${esc(j.error || 'deck 생성 실패')}</p>`;
}
function renderDeckLink(j) {
  return `<p><a class="btn" href="${j.url}" download>PPTX 초안 다운로드 (${j.slides}장 · ${(j.bytes / 1024).toFixed(0)}KB)</a></p><p class="small">R2에 저장됨 · ${esc(j.url)}</p>`;
}
// S3 덱 개요 편집: 요약 결과를 개요(표지 제목 + 슬라이드 제목·불릿)로 보여주고,
// 고친 문구 그대로 POST /api/deck {outline} → .pptx 생성. "PPTX 초안 다운로드"
// (바로 만들기)는 그대로 두고, 이 편집기는 생성 전 단계로만 끼워 넣는다.
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
function outlineBulletRow(value) {
  return `<div class="ol-row"><input type="text" class="ol-bullet" value="${escAttr(value)}" placeholder="불릿 내용을 입력하세요"><button type="button" class="secondary" onclick="removeOutlineRow(this)" title="이 불릿 삭제">✕</button></div>`;
}
function outlineSectionBlock(heading, bullets) {
  return `<div class="ol-section"><input type="text" class="ol-heading" value="${escAttr(heading)}" placeholder="슬라이드 제목"><div class="ol-bullets">${bullets.map(outlineBulletRow).join('')}</div><div class="btnrow"><button type="button" class="secondary" onclick="addOutlineBullet(this)">＋ 불릿 추가</button><button type="button" class="secondary" onclick="removeOutlineSection(this)">슬라이드 삭제</button></div></div>`;
}
function editDeckOutline() {
  const box = $('deckResult');
  if (!box) return;
  const sections = [];
  if (lastSummary.length) sections.push({ heading: '요약', bullets: lastSummary });
  if (lastActions.length) sections.push({ heading: '액션', bullets: lastActions });
  if (!sections.length) { alert('편집할 요약·액션이 없습니다. 먼저 요약해 주세요.'); return; }
  box.innerHTML = `<div class="outline"><h4>덱 개요 편집</h4><p class="small">고친 문구가 그대로 PPTX에 들어갑니다.</p><label class="small">표지 제목</label><input type="text" id="ol-title" value="${escAttr(lastDocTitle || 'People OS 요약')}"><div id="ol-sections">${sections.map(s => outlineSectionBlock(s.heading, s.bullets)).join('')}</div><div class="btnrow"><button type="button" class="secondary" onclick="addOutlineSection()">＋ 슬라이드 추가</button></div><div class="btnrow"><button type="button" class="primary" onclick="createDeckFromOutline()">이 개요로 PPTX 만들기</button><button type="button" class="secondary" onclick="cancelDeckOutline()">취소</button></div></div>`;
}
function addOutlineBullet(btn) {
  const sec = btn.closest('.ol-section');
  const list = sec.querySelector('.ol-bullets');
  const row = document.createElement('div');
  row.innerHTML = outlineBulletRow('');
  list.appendChild(row.firstElementChild);
  list.lastElementChild.querySelector('input').focus();
}
function removeOutlineRow(btn) { btn.closest('.ol-row').remove(); }
function removeOutlineSection(btn) { btn.closest('.ol-section').remove(); }
function addOutlineSection() {
  const list = $('ol-sections');
  const wrap = document.createElement('div');
  wrap.innerHTML = outlineSectionBlock('새 슬라이드', ['']);
  list.appendChild(wrap.firstElementChild);
}
function cancelDeckOutline() { const box = $('deckResult'); if (box) box.innerHTML = ''; }
function collectOutline() {
  const title = ($('ol-title').value || '').trim();
  const slides = [];
  document.querySelectorAll('#ol-sections .ol-section').forEach(sec => {
    const heading = sec.querySelector('.ol-heading').value.trim();
    const bullets = [...sec.querySelectorAll('.ol-bullet')].map(i => i.value.trim()).filter(Boolean);
    if (bullets.length) slides.push({ heading: heading || '내용', bullets });
  });
  return { title: title || 'People OS 요약', slides };
}
async function createDeckFromOutline() {
  const outline = collectOutline();
  if (!outline.slides.length) { alert('불릿을 하나 이상 입력해 주세요. (불릿이 없는 슬라이드는 만들지 않습니다)'); return; }
  const box = $('deckResult');
  if (box) box.innerHTML = '<p class="small">PPTX 초안을 만들고 있습니다…</p>';
  const j = await api('/api/deck', { method: 'POST', body: JSON.stringify({ title: outline.title, outline, source: docId }) });
  if (j.ok && box) box.innerHTML = renderDeckLink(j);
  else if (box) box.innerHTML = `<p class="small">오류: ${esc(j.error || 'deck 생성 실패')}</p>`;
}
function fmtMs(ms) {
  try { return new Date(Number(ms)).toISOString().slice(0, 10); } catch { return ''; }
}
// 지식 공백 큐 (C5-b): 근거 없는 질문·👎 피드백 질문 카드. open이면 답 작성 폼,
// answered/resolved면 게시된 암묵지 문서 제목과 상태를 보여준다.
function gapsSection(gaps) {
  if (!gaps.length) return '<h3>답변 대기 질문</h3><p class="empty">답변 대기 중인 질문이 없습니다.</p>';
  const openN = gaps.filter(g => g.status === 'open').length;
  const cards = gaps.map(gap => {
    const srcBadge = gap.source === 'downvote' ? '<span class="badge">👎 피드백</span>' : '<span class="badge warn">근거 없음</span>';
    const meta = `<div class="meta">${srcBadge} ${fmtMs(gap.asked_at)} · ${gap.count}회 질문됨 · 질문자: <b>${esc(gap.asker_name || '익명')}</b></div>`;
    if (gap.status === 'open') {
      return `<div class="libcard"><h3>${esc(gap.question)}</h3><p class="small">담당자가 답을 달면 같은 질문에 암묵지 출처로 답변합니다.</p>${meta}<textarea id="gap-answer-${gap.id}" placeholder="이유와 예외 조건을 포함해 주세요" style="min-height:90px;margin-top:8px"></textarea><div class="btnrow"><input type="text" id="gap-author-${gap.id}" value="인사팀" style="width:140px" /><button class="primary" onclick="publishGap('${gap.id}')">게시하기</button></div><div id="gap-result-${gap.id}"></div></div>`;
    }
    const badge = gap.status === 'resolved' ? '<span class="badge ok">해결됨 ✓</span>' : '<span class="badge">답변 게시됨</span>';
    const note = gap.status === 'resolved' ? '같은 질문에 암묵지 출처로 답변합니다.' : '검증 중 — 근거가 잡히면 해결됨으로 바뀝니다.';
    return `<div class="libcard"><h3>${esc(gap.question)}</h3>${meta}<p>${badge} ${esc(gap.doc_title || '')}</p><p class="small">${note}</p></div>`;
  }).join('');
  return `<h3>답변 대기 질문 ${openN}건</h3><div class="libgrid">${cards}</div>`;
}
async function publishGap(id) {
  const ans = $('gap-answer-' + id).value.trim();
  const author = $('gap-author-' + id).value.trim() || '인사팀';
  const box = $('gap-result-' + id);
  if (ans.length < 3) { box.innerHTML = '<p class="err">답변을 입력해 주세요.</p>'; return; }
  box.innerHTML = '<p class="loading">게시하고 있습니다…</p>';
  const j = await api('/api/gaps/' + id + '/publish', { method: 'POST', body: JSON.stringify({ answer: ans, author }) });
  if (!j.ok) { box.innerHTML = `<p class="err">게시 실패: ${esc(j.error || '')}</p>`; return; }
  const idxErr = j.indexed && j.indexed.indexError ? ` <span class="err">색인 실패: ${esc(j.indexed.indexError)}</span>` : '';
  const msg = j.status === 'resolved'
    ? '게시됨 · 검증 완료 — 같은 질문에 암묵지 출처로 답변됩니다.'
    : `게시됨 · 검증: 근거가 아직 잡히지 않아 대기 상태로 돌아갔습니다.${idxErr}`;
  box.innerHTML = `<p class="small">${msg}</p>`;
  // refreshLib이 라이브러리 전체를 다시 그려서 box가 사라지므로,
  // 확인 문구는 다시 그려지지 않는 libNotice에 남긴다.
  // 새로고침(F5)·라이브러리 새로고침 뒤에도 남아야 해서 sessionStorage에
  // 저장하고, refreshLib이 렌더링 뒤에 다시 붙인다 (10분 지나면 버린다).
  await refreshLib(); loadHome();
  setPublishNotice(msg);
}
function setPublishNotice(msg) {
  try { sessionStorage.setItem('people-os-publish-notice', JSON.stringify({ msg, at: Date.now() })); } catch {}
  $('libNotice').innerHTML = `<p class="small">${msg}</p>`;
}
function restorePublishNotice() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem('people-os-publish-notice') || 'null'); } catch {}
  if (saved && saved.msg && Date.now() - (saved.at || 0) < 10 * 60 * 1000) {
    $('libNotice').innerHTML = `<p class="small">${saved.msg}</p>`;
  } else {
    $('libNotice').innerHTML = '';
    try { sessionStorage.removeItem('people-os-publish-notice'); } catch {}
  }
}
let libTab = 'files';
function setLibTab(t) {
  libTab = t;
  document.querySelectorAll('#libResult [data-libtab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.libtab === t)));
  document.querySelectorAll('#libResult [data-libpanel]').forEach(p => { p.style.display = p.dataset.libpanel === t ? '' : 'none'; });
}
async function refreshLib() {
  const j = await api('/api/library');
  // 답변 대기 질문 섹션 (C5-b) — 탭으로 분리해 한 번에 하나씩만 보인다.
  let gapsHtml = '';
  let gaps = [];
  try {
    const g = await api('/api/gaps');
    if (g.ok) { gaps = g.gaps || []; gapsHtml = gapsSection(gaps); }
  } catch { gapsHtml = ''; }
  // 파일 목록(리스트 뷰): 문서 + 덱을 한 목록으로 합쳐 유형 필터·날짜 정렬로 보여준다.
  // 기존 문서 카드 뷰는 이 리스트로 대체했다 (규정·리플렉션 카드는 그대로).
  libItems = [
    ...j.documents.map(d => ({ id: d.id, title: d.title, type: d.kind === 'transcript' ? 'transcript' : 'upload', created_at: d.created_at, size: d.size, canDelete: d.canDelete, owner: d.owner, failed: d.extract_status === 'failed', err: d.extract_error, isCoaching: !!d.is_coaching })),
    ...(j.decks || []).map(d => ({ id: d.id, title: d.title, type: 'deck', created_at: d.created_at, size: d.size, canDelete: d.canDelete, owner: d.owner })),
  ];
  const pols = j.policies.map(p => `<div class="libcard"><h3>${esc(p.title)}</h3><p>${esc(p.section)}</p><div class="meta">HR 규정</div></div>`).join('');
  const refls = j.reflections.map(r => {
    let pats = [];
    try { pats = JSON.parse(r.patterns || '[]'); } catch { pats = []; }
    // 참여자 (0020): 둘 다 NULL(기존·익명 리플렉션)이면 날짜만.
    const who = (r.coach_name || r.coachee_name) ? `코치: ${esc(r.coach_name || '—')} · 코칭 대상: ${esc(r.coachee_name || '—')} · ` : '';
    return `<div class="libcard"><h3>${r.mode === 'coachee' ? '코칭 대상 자기 성찰' : '코칭 리플렉션'}</h3><p>${esc(pats[0] || '')}</p><div class="meta">${who}${fmtDate(r.created_at)}</div></div>`;
  }).join('');
  const openGaps = gaps.filter(g => g.status === 'open').length;
  $('libResult').innerHTML =
    `<div class="obs-subtabs" role="tablist" aria-label="라이브러리">
      <button type="button" role="tab" data-libtab="files" aria-selected="true" onclick="setLibTab('files')">파일 목록</button>
      <button type="button" role="tab" data-libtab="policies" aria-selected="false" onclick="setLibTab('policies')">규정 ${j.policies.length}건</button>
      <button type="button" role="tab" data-libtab="reflections" aria-selected="false" onclick="setLibTab('reflections')">리플렉션 ${j.reflections.length}건</button>
      <button type="button" role="tab" data-libtab="gaps" aria-selected="false" onclick="setLibTab('gaps')">답변 대기${openGaps ? ' (' + openGaps + ')' : ''}</button>
    </div>` +
    `<div data-libpanel="files"><h3>파일 목록</h3><div id="libFiles"></div></div>` +
    `<div data-libpanel="policies" style="display:none"><h3>규정 ${j.policies.length}건</h3><div class="libgrid">${pols}</div></div>` +
    `<div data-libpanel="reflections" style="display:none"><h3>리플렉션 ${j.reflections.length}건</h3><div class="libgrid">${refls || '<p class="empty">리플렉션이 없습니다.</p>'}</div></div>` +
    `<div data-libpanel="gaps" style="display:none">${gapsHtml}</div>`;
  setLibTab(libTab);
  renderLibFiles();
  // 게시 확인 문구는 다시 그릴 때마다 복원한다 (없으면 비워둔다).
  restorePublishNotice();
}
let libItems = [], libFilter = 'all';
const LIB_TYPES = { transcript: '전사본', upload: '업로드 문서', deck: '덱' };
function setLibFilter(f) { libFilter = f; renderLibFiles(); }
function renderLibFiles() {
  const el = $('libFiles'); if (!el) return;
  const rows = libItems.filter(x => libFilter === 'all' || x.type === libFilter)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); // 최신순
  const filters = [['all', '전체'], ['transcript', '전사본'], ['upload', '업로드'], ['deck', '덱']]
    .map(([k, l]) => `<button class="${libFilter === k ? 'primary' : 'secondary'}" onclick="setLibFilter('${k}')">${l}</button>`).join(' ');
  const showOwner = !!(currentUser && currentUser.role === 'hr_admin');
  const body = rows.map(x => {
    const dl = x.type === 'deck' ? `/api/deck/${esc(x.id)}` : `/api/documents/${esc(x.id)}/download`;
    const del = x.canDelete ? `<button class="secondary" onclick="deleteLibItem('${x.type}','${esc(x.id)}')">삭제</button>` : '';
    const warn = (x.failed ? ' <span class="badge warn">변환 실패</span>' : '') + (x.isCoaching ? ' <span class="badge ok">코칭</span>' : '');
    // 코칭 지정/해제 (0020): 삭제와 같은 권한(canDelete)일 때만. 덱은 문서가 아니라 제외.
    const coachBtn = x.type !== 'deck' && x.canDelete ? `<button class="secondary" onclick="toggleCoaching('${esc(x.id)}', ${x.isCoaching ? 'false' : 'true'})">${x.isCoaching ? '코칭 해제' : '코칭 지정'}</button> ` : '';
    const ownerCell = showOwner ? `<td>${esc(x.owner || '공용')}</td>` : '';
    return `<tr><td>${esc(x.title)}${warn}</td><td><span class="badge">${LIB_TYPES[x.type]}</span></td>${ownerCell}<td>${fmtDate(x.created_at)}</td><td>${x.size ? fmtSize(x.size) : '-'}</td><td><a href="${dl}">다운로드</a> ${coachBtn}${del}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="btnrow">${filters}</div>` + (rows.length
    ? `<table class="liblist" style="width:100%;border-collapse:collapse"><thead><tr style="text-align:left"><th>이름</th><th>유형</th>${showOwner ? '<th>소유자</th>' : ''}<th>날짜 ▼</th><th>크기</th><th>작업</th></tr></thead><tbody>${body}</tbody></table>`
    : '<p class="empty">해당하는 파일이 없습니다.</p>');
}
async function toggleCoaching(id, on) {
  const j = await api('/api/documents/' + id, { method: 'PATCH', body: JSON.stringify({ is_coaching: on }) });
  if (!j.ok) { alert('코칭 지정을 바꾸지 못했습니다: ' + (j.error || '')); return; }
  const it = libItems.find(x => x.id === id);
  if (it) it.isCoaching = !!j.is_coaching;
  renderLibFiles();
}
async function deleteLibItem(type, id) {
  if (!confirm('이 파일을 삭제할까요? 검색 색인도 함께 지워지며 되돌릴 수 없습니다.')) return;
  const j = await api((type === 'deck' ? '/api/decks/' : '/api/documents/') + id, { method: 'DELETE' });
  if (!j.ok) { alert('삭제하지 못했습니다: ' + (j.error || '')); return; }
  refreshLib();
}
function toggleSidebar() {
  const sb = $('sidebar');
  const collapsed = sb.classList.toggle('collapsed');
  $('collapseBtn').textContent = collapsed ? '»' : '« 접기';
  try { localStorage.setItem('people-os-sidebar-collapsed', collapsed ? '1' : '0'); } catch {}
}
try { if (localStorage.getItem('people-os-sidebar-collapsed') === '1') { $('sidebar').classList.add('collapsed'); $('collapseBtn').textContent = '»'; } } catch {}
fetch('/api/health', { method: 'POST' }).then(r => r.json()).then(j => {
  $('health').textContent = j.ok ? 'health OK · ' + Object.entries(j.bindings).filter(([,v])=>v).map(([k])=>k).join(', ') : 'health 실패';
}).catch(() => $('health').textContent = 'health 실패');
// 로그인 (2026-11-15): 먼저 인증 상태를 확인한다. 미로그인이면 로그인 화면,
// 설정 링크(#setup=)면 비밀번호 설정 화면, 로그인 상태면 역할에 맞게 탭을 연다.
checkAuth();
$('loadSample').onclick = async () => {
  const j = await api('/api/seed');
  $('docTitle').value = '11월 팀 회의 전사본 (샘플)';
  $('docContent').value = j.sampleTranscript;
};
$('transcribeBtn').onclick = async () => {
  const f = $('audioFile').files[0];
  if (!f) { alert('음성 파일을 선택하세요.'); return; }
  const target = uploadTarget('voice');
  if (!target.ok) return;
  $('transcribeBtn').disabled = true;
  $('audioResult').innerHTML = '<p class="loading">전사하는 중입니다…</p>';
  const fd = new FormData();
  fd.append('file', f);
  if ($('audioIsCoaching').checked) fd.append('is_coaching', 'true');
  if (target.asUserId) fd.append('asUserId', target.asUserId);
  const r = await fetch('/api/transcribe', { method: 'POST', body: fd });
  const j = await r.json();
  $('transcribeBtn').disabled = false;
  if (!j.ok) { $('audioResult').innerHTML = `<p class="err">오류: ${esc(j.error || '전사 실패')}</p>`; return; }
  // 전사는 백그라운드에서 진행된다. 폴링으로 완료를 기다린다.
  pollRecording(j.recordingId);
  loadRecordings(); loadHome();
};
$('uploadBtn').onclick = async () => {
  const target = uploadTarget('transcript');
  if (!target.ok) return;
  const j = await api('/api/documents', { method: 'POST', body: JSON.stringify({ title: $('docTitle').value, content: $('docContent').value, kind: 'transcript', is_coaching: $('docIsCoaching').checked, asUserId: target.asUserId }) });
  if (j.ok) { docId = j.id; lastDocTitle = j.title; $('summarizeBtn').disabled = false; $('docResult').innerHTML = `<div class="card">업로드됨 · id <code>${j.id}</code>${ownerNote(j)} · R2 저장: ${j.r2Stored ? '예' : '아니오 (D1 폴백)'}</div>`; }
  else $('docResult').innerHTML = `<div class="card">오류: ${j.error}</div>`;
};
// 문서 파일 업로드 (C5 Phase 3): PDF·DOCX·XLSX·HWPX·이미지·텍스트.
// 서버가 매직 바이트로 형식을 판별해 텍스트를 뽑고 색인한다.
$('docFileBtn').onclick = async () => {
  const f = $('docFile').files[0];
  if (!f) { alert('문서 파일을 선택하세요.'); return; }
  const target = uploadTarget('file');
  if (!target.ok) return;
  $('docFileBtn').disabled = true;
  $('docFileResult').innerHTML = '<p class="loading">파일을 변환하고 색인하는 중입니다…</p>';
  const fd = new FormData();
  fd.append('file', f);
  if ($('docFileIsCoaching').checked) fd.append('is_coaching', 'true');
  // 관점: 관리자는 고른 사용자(asUserId) 또는 공용, 로그인 사용자는 본인 개인 공간(personal).
  if (target.asUserId) fd.append('asUserId', target.asUserId);
  else if (!target.shared && currentUser) fd.append('personal', 'true');
  let j;
  try {
    const r = await fetch('/api/documents', { method: 'POST', body: fd });
    j = await r.json();
  } catch (e) {
    j = { ok: false, error: '서버에 연결할 수 없습니다' };
  }
  $('docFileBtn').disabled = false;
  if (!j.ok) { $('docFileResult').innerHTML = `<p class="err">오류: ${esc(j.error || '업로드 실패')}</p>`; return; }
  if (j.extractStatus === 'failed') {
    $('docFileResult').innerHTML = `<div class="card"><b>${esc(j.title)}</b> · 변환 실패<p class="err">${esc(j.extractError || '변환에 실패했습니다')}</p><p class="small">원본 파일은 저장됐습니다. 다른 형식으로 저장해 다시 올려 주세요.</p></div>`;
    return;
  }
  docId = j.id; lastDocTitle = j.title; $('summarizeBtn').disabled = false;
  $('docFileResult').innerHTML = `<div class="card"><b>${esc(j.title)}</b> · 형식: ${esc(j.format)} · 근거 chunk ${j.chunks}개${ownerNote(j)}${j.indexError ? ` · <span class="err">색인 실패: ${esc(j.indexError)}</span>` : ''}</div>`;
  loadHome();
};
$('summarizeBtn').onclick = async () => {
  const j = await api('/api/documents/' + docId + '/summarize', { method: 'POST' });
  lastSummary = j.summary || []; lastActions = j.actions || [];
  lastSummaryText = '요약\n' + j.summary.map(s => '- ' + s).join('\n') + '\n\n액션\n' + j.actions.map(s => '- ' + s).join('\n');
  $('docResult').innerHTML = `<div class="card"><b>요약</b> <span class="badge">엔진: ${j.engine}</span><ul>${j.summary.map(s => `<li>${esc(s)}</li>`).join('')}</ul><b>액션</b><ul>${j.actions.map(s => `<li>${esc(s)}</li>`).join('')}</ul><div class="btnrow"><button class="secondary" onclick="saveActionsAsTasks()">할 일로 저장</button><button class="primary" onclick="downloadDeck()">PPTX 초안 다운로드</button><button class="secondary" onclick="editDeckOutline()">개요 편집</button><button class="secondary" onclick="copySummary()">요약 복사</button><button class="secondary" onclick="switchTab(\'library\')">라이브러리에서 보기</button></div><div id="deckResult"></div></div>`;
};
// Turnstile (C7): 사이트 키가 설정돼 있을 때만 위젯을 띄운다. 키가 없으면
// 토큰 없이 제출하고 서버가 검증을 건너뛴다 (fail-open). 스크립트도 키가
// 있을 때만 늦게 불러와, 미설정 상태에서는 외부 의존성이 없다.
async function initTurnstile() {
  try {
    const cfg = await api('/api/config');
    if (!cfg.ok || !cfg.turnstileSitekey) return;
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    s.async = true; s.defer = true;
    s.onload = () => {
      turnstileWidgetId = turnstile.render('#turnstileBox', {
        sitekey: cfg.turnstileSitekey,
        callback: (t) => { turnstileToken = t; },
        'expired-callback': () => { turnstileToken = null; },
        'error-callback': () => { turnstileToken = null; },
      });
    };
    document.head.appendChild(s);
  } catch { /* 위젯 실패 시 토큰 없이 진행 */ }
}
initTurnstile();
function timingsPanel(t) {
  if (!t) return '';
  const rows = [
    ['캐시 조회', 'KV', t.cache],
    ['세션 기억', 'Durable Objects', t.session],
    ['질문 임베딩', 'Workers AI (bge-m3)', t.embed],
    ['근거 검색', 'Vectorize', t.vectorize],
    ['게이트·근거 정리', 'D1', t.gate],
    ['질문 라우터', 'Workers AI', t.router, true],
    ['토픽 가드', 'Workers AI', t.topic_guard, true],
    ['재순위', 'Workers AI', t.rerank, true],
    ['답변 생성', 'Workers AI', t.llm],
  ].filter(([, , ms]) => typeof ms === 'number');
  const llmNote = t.llm === 0 ? ' — 호출 안 함 (근거 없음)' : '';
  const items = rows.map(([name, prod, ms, judge]) => `<li><b>${name}</b>${judge ? ' <span class="badge">판단 모델</span>' : ''} · ${prod} · ${ms}ms${name === '답변 생성' ? llmNote : ''}</li>`).join('');
  return `<details class="timings"><summary>처리 과정 (전체 ${t.total ?? '?'}ms)</summary><ul>${items}</ul></details>`;
}
function renderAsk(j, targetId) {
  targetId = targetId || 'askResult';
  const isPersonal = targetId === 'personalResult';
  if (isPersonal) {
    personalSessionId = j.sessionId;
    lastPersonalAnswer = j.answer; lastPersonalQuestion = j.question;
  } else {
    sessionId = j.sessionId;
    lastAnswer = j.answer; lastQuestion = j.question;
  }
  const copyBtn = isPersonal
    ? `<button class="secondary" onclick="copyPersonalAnswer()">답변 복사</button>`
    : `<button class="secondary" onclick="copyAnswer()">답변 복사</button><button class="secondary" onclick="regenAnswer()">다시 생성</button>`;
  const fb = j.eventId ? `<div class="btnrow"><button class="secondary" onclick="sendFeedback('${j.eventId}','up',this)">👍 도움이 됐어요</button><button class="secondary" onclick="sendFeedback('${j.eventId}','down',this)">👎 아쉬워요</button>${copyBtn}</div><div id="fbMsg" class="small"></div>` : '';
  // 근거 없음이면 공백 큐 기록 안내를, 암묵지 근거면 출처 배지를 단다 (C5-b).
  const gapNote = j.grounded === false ? '<p class="small">답변 대기 목록에 기록됐습니다.</p>' : '';
  const srcList = j.sources.map(s => {
    const poolBadge = ` <span class="badge">${s.pool === 'personal' ? '개인' : '공용'}</span>`;
    const tacit = s.kind === 'tacit' ? ` <span class="badge">사내 암묵지 · ${esc(s.author || '인사팀')} · ${esc(s.publishedAt || '')}</span>` : '';
    return `<li>${esc(s.title)} (${esc(s.section)})${poolBadge}${tacit} — ${esc(s.snippet)}${typeof s.score === 'number' && s.score <= 1 ? ` · <span class="sim">유사도 ${s.score.toFixed(2)}</span>` : ''}</li>`;
  }).join('');
  $(targetId).innerHTML = `<div class="card"><b>답변</b> <span class="badge">엔진: ${j.engine} · 검색: ${j.searchEngine} · 세션: ${j.sessionVia}${j.cached ? ' · 캐시됨' : ''}</span><p>${esc(j.answer)}</p>${gapNote}<b>근거</b><ul>${srcList}</ul>${fb}${timingsPanel(j.timings)}</div>`;
}
async function sendFeedback(eventId, rating, btn) {
  const row = btn.closest('.btnrow');
  row.querySelectorAll('button').forEach(b => b.disabled = true);
  const j = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ eventId, rating }) });
  const msg = $('fbMsg');
  if (msg) msg.textContent = j.ok
    ? (rating === 'down' ? '피드백을 기록했습니다.' : '피드백 감사합니다.')
    : `피드백 저장 실패: ${j.error || '다시 시도해 주세요.'}`;
  if (!j.ok) row.querySelectorAll('button').forEach(b => b.disabled = false);
}
function copyAnswer() {
  const text = lastAnswer || '답변이 없습니다.';
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => alert('답변을 복사했습니다.'));
}
function copyPersonalAnswer() {
  const text = lastPersonalAnswer || '답변이 없습니다.';
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => alert('답변을 복사했습니다.'));
}
let asking = false; // 질문 중복 전송 방지 (동시 요청이면 KV 카운터 read-modify-write 경합으로 제한이 1회 늦게 걸림)
async function doAsk(force) {
  if (asking) return;
  const q = force ? lastQuestion : $('question').value;
  if (!q || !q.trim()) return;
  asking = true;
  $('askBtn').disabled = true;
  try {
    $('askResult').innerHTML = '<div class="card"><p class="loading">답변을 만들고 있습니다…</p></div>';
    const body = { question: q.trim(), sessionId, force: !!force };
    if (turnstileToken) body.turnstileToken = turnstileToken;
    const j = await api('/api/ask', { method: 'POST', body: JSON.stringify(body) });
    if (j.ok) renderAsk(j);
    else $('askResult').innerHTML = `<div class="card">오류: ${esc(j.error)}</div>`;
    // 토큰은 1회성이라 질문마다 새로 받는다.
    if (window.turnstile && turnstileWidgetId !== null) { try { turnstile.reset(turnstileWidgetId); } catch {} turnstileToken = null; }
  } finally {
    asking = false;
    $('askBtn').disabled = false;
  }
}
function regenAnswer() { doAsk(true); }
$('askBtn').onclick = () => doAsk(false);
// ---- 개인 업무 검색 (2026-11-16) ----
// 개인 풀만 검색한다. HR 창과 세션을 분리한다 (personalSessionId 별도 관리).
// 미로그인이면 서버가 401을 주고 안내를 보여준다.
let personalAsking = false;
async function doPersonalAsk() {
  if (personalAsking) return;
  const q = $('personalQuestion').value;
  if (!q || !q.trim()) return;
  // 관점: 관리자는 검색할 사용자를 직접 골라야 한다 (기본값 없음).
  let asUserId;
  if (isAdminUser()) {
    asUserId = $('personalPerspective') ? $('personalPerspective').value : '';
    if (!asUserId) { $('personalResult').innerHTML = '<div class="card"><p class="err">관점: 누구의 개인 업무에서 검색할지 사용자를 먼저 선택하세요.</p></div>'; return; }
  }
  personalAsking = true;
  $('personalAskBtn').disabled = true;
  try {
    const who = asUserId ? perspectiveName(asUserId) + '의 문서' : '내 문서';
    $('personalResult').innerHTML = `<div class="card"><p class="loading">${esc(who)}에서 찾고 있습니다…</p></div>`;
    const j = await api('/api/personal/ask', { method: 'POST', body: JSON.stringify({ question: q.trim(), sessionId: personalSessionId, asUserId }) });
    if (j.ok) {
      renderAsk(j, 'personalResult');
      if (j.asUser) $('personalResult').insertAdjacentHTML('afterbegin', `<p class="small">검색 범위: <b>${esc(j.asUser)}</b>의 개인 업무</p>`);
    }
    else $('personalResult').innerHTML = `<div class="card">오류: ${esc(j.error === 'login required' ? '로그인해야 합니다. 로그인 후 다시 물어봐 주세요.' : j.error)}</div>`;
  } finally {
    personalAsking = false;
    $('personalAskBtn').disabled = false;
  }
}
$('personalAskBtn').onclick = () => doPersonalAsk();
$('personalQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPersonalAsk(); });
$('loadCoaching').onclick = async () => {
  const j = await api('/api/seed');
  $('coachingText').value = j.coachingTranscript;
};
// 코칭 리플렉션 모드는 서버가 세션의 coaching_role로 정한다. 프론트는 응답의 mode로 렌더링만 바꾼다.
function applyCoachingMode() {
  const coachee = isCoachee();
  $('coachingTitle').textContent = coachee ? '코칭 리플렉션 — 나의 자기 성찰' : '코칭 리플렉션';
  $('coachingModeDesc').textContent = coachee
    ? '코칭 대상용: 코칭 세션 전사본을 붙여넣으면 나의 자기 성찰 포인트와 액션 플랜(실천 행동 + 권장 기한)을 정리합니다.'
    : '코치용: 세션 전사본에서 핵심 질문·반복 패턴·다음 세션 질문을 뽑습니다.';
}
// 코칭 전사본 선택 + 상대방 (0020). 탭을 열 때마다 다시 불러온다.
let coachingDocs = [];
async function loadCoachingPickers() {
  const coachee = isCoachee();
  $('coachingCounterpartLabel').textContent = coachee ? '코치' : '코칭 대상';
  try {
    const d = await api('/api/documents/coaching');
    coachingDocs = d.ok ? (d.documents || []) : [];
  } catch { coachingDocs = []; }
  const keepDoc = $('coachingDocPick').value;
  // 2026-11-16: #upload의 전사본 전부 (코칭 지정 먼저, 최신순). 코칭 지정 문서는 [코칭] 배지,
  // 관리자에게는 소유자 이름도 보인다. <option> 안에는 HTML을 못 넣어 글자 배지로 표시한다.
  $('coachingDocPick').innerHTML = '<option value="">직접 붙여넣기</option>' +
    coachingDocs.map(x => `<option value="${esc(x.id)}">${x.is_coaching ? '[코칭] ' : ''}${esc(x.title)} · ${fmtDate(x.created_at)}${x.owner_name ? ' · ' + esc(x.owner_name) : ''}</option>`).join('');
  if (coachingDocs.some(x => x.id === keepDoc)) $('coachingDocPick').value = keepDoc;
  let users = [];
  try {
    const u = await api('/api/users/coaching');
    users = u.ok ? (u.users || []) : [];
  } catch { users = []; }
  const me = currentUser ? currentUser.id : null;
  const keepCp = $('coachingCounterpart').value;
  // 반대 역할을 먼저, 같은 역할은 뒤에 (역할이 바뀐 경우도 고를 수 있게 모두 보여준다).
  const want = coachee ? 'coach' : 'coachee';
  const others = users.filter(x => x.id !== me).sort((a, b) => (a.coaching_role === want ? 0 : 1) - (b.coaching_role === want ? 0 : 1));
  $('coachingCounterpart').innerHTML = '<option value="">지정 안 함</option>' +
    others.map(x => `<option value="${esc(x.id)}">${esc(x.name || x.email)} (${esc(x.email)}) · ${x.coaching_role === 'coach' ? '코치' : '코칭 대상'}</option>`).join('');
  if (others.some(x => x.id === keepCp)) $('coachingCounterpart').value = keepCp;
}
$('coachingDocPick').onchange = () => {
  const d = coachingDocs.find(x => x.id === $('coachingDocPick').value);
  if (d) $('coachingText').value = d.content || '';
};
$('reflectBtn').onclick = async () => {
  const counterpartId = $('coachingCounterpart').value || undefined;
  const j = await api('/api/coaching/reflect', { method: 'POST', body: JSON.stringify({ transcript: $('coachingText').value, sessionId, counterpartId }) });
  if (!j.ok) { $('coachingResult').innerHTML = `<p class="err">${esc(j.error || '리플렉션을 만들지 못했습니다.')}</p>`; return; }
  if (j.mode === 'coachee') {
    $('coachingResult').innerHTML = `<div class="card"><p class="small">코칭 대상(나)의 자기 성찰 + 액션 플랜 <span class="badge">엔진: ${esc(j.engine)}</span></p>` +
      `<b>자기 성찰 포인트</b><ul>${j.reflection_points.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` +
      `<b>액션 플랜</b><ol>${j.action_plan.map(a => `<li>${esc(a.action)}${a.timeframe ? ` <span class="badge">${esc(a.timeframe)}</span>` : ''}</li>`).join('')}</ol></div>`;
    return; // 코칭 대상에게는 홈 탭이 없다
  }
  $('coachingResult').innerHTML = `<div class="card"><b>핵심 질문</b> <span class="badge">엔진: ${j.engine}</span><ul>${j.questions.map(s => `<li>${esc(s)}</li>`).join('')}</ul><b>패턴</b><ul>${j.patterns.map(s => `<li>${esc(s)}</li>`).join('')}</ul><b>다음 세션 질문</b><ul>${j.next_questions.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div>`;
  loadHome();
};
$('addTaskBtn').onclick = addTask;
$('newTaskTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });
$('refreshLib').onclick = refreshLib;
