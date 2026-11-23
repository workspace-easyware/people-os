// Plaud 연동 UI (2026-11-19). 녹음전사·문서저장 > 음성파일 전사 탭의 "Plaud" 카드.
// API: /api/plaud/{status,connect,disconnect,files,files/:id/transcript,import}. 토큰은 서버 밖으로 나오지 않는다 —
// 화면은 연결 상태·마스킹 이메일·녹음 메타데이터만 본다. index.html의 api/esc/$ 헬퍼를 쓴다.
const PLAUD_AUTH_PREFIX = 'https://mcp.plaud.ai/';
let plaudState = { status: null, email: null, files: [], page: 1, hasMore: false, loading: false, err: '', msg: '', rows: {}, recs: {}, whisper: null };
// rows[fileId] = { tr: 'unknown' | 'checking' | 'yes' | 'no', busy: bool, imported: bool, note: string }

function plaudFmtDur(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}시간 ${m}분` : m ? `${m}분 ${r}초` : `${r}초`;
}

async function plaudCall(path, opts) {
  let r;
  try { r = await fetch(path, { headers: { 'content-type': 'application/json' }, cache: 'no-store', ...opts }); }
  catch { return { ok: false, error: '네트워크 오류', _status: 0 }; }
  const j = await r.json().catch(() => ({ ok: false }));
  j._status = r.status;
  return j;
}

async function plaudLoad() {
  const box = $('plaudBox');
  if (!box) return;
  const j = await plaudCall('/api/plaud/status');
  if (j._status === 503) plaudState.status = 'unconfigured';
  else if (j._status === 401) plaudState.status = 'login';
  else if (!j.ok) plaudState.status = 'error';
  else { plaudState.status = j.status; plaudState.email = j.email || null; }
  plaudState.err = '';
  plaudRenderSeq++; // 탭에 들어올 때마다 새 회차 — 이전에 실패한 크기 조회를 다시 시도한다
  plaudRender();
  if (plaudState.status === 'connected') plaudLoadFiles(1);
}

async function plaudLoadFiles(page) {
  if (plaudState.loading) return;
  plaudState.loading = true; plaudState.err = ''; plaudRender();
  const j = await plaudCall('/api/plaud/files?page=' + page + '&page_size=20');
  plaudState.loading = false;
  if (!j.ok) {
    if (j.code === 'NOT_CONNECTED') { plaudState.status = 'not_connected'; plaudState.msg = j.error || ''; plaudState.files = []; }
    else plaudState.err = j.error || '목록을 불러오지 못했습니다.';
    plaudRender(); return;
  }
  plaudState.page = page; plaudState.hasMore = !!j.has_more;
  plaudState.total = typeof j.total === 'number' ? j.total : null;
  plaudState.files = page === 1 ? j.files : plaudState.files.concat(j.files);
  await plaudLoadRecs(j.files);
  for (const f of j.files) {
    const row = plaudState.rows[f.id] || (plaudState.rows[f.id] = { tr: 'unknown', busy: false, imported: false, note: '' });
    row.imported = !!f.imported;
    // 전사 진행 중인 녹음(전사 없는 녹음을 People OS Whisper로 보낸 것)은 새로고침 후에도 이어서 보여 준다.
    if (f.recording_id && !f.imported && !row.polling) { row.tr = 'no'; row.busy = true; row.recId = f.recording_id; plaudPoll(f.id); }
  }
  plaudRender();
  plaudPumpSizes(); // 목록을 먼저 그린 뒤 백그라운드로 크기 조회
}

// ---- 파일 크기 (제목 옆 "(35.5MB)") ----
// Plaud API는 크기를 주지 않아 서버가 presigned URL의 Range GET으로 읽는다. 목록 렌더링과 별개로 백그라운드에서 동시 4개까지 조회하고 rows에 캐시한다.
const PLAUD_MAX_IMPORT_BYTES = 40 * 1024 * 1024;
let plaudSizeActive = 0;
// 목록을 (탭 전환 등으로) 새로 그린 회차 번호. 실패한 행은 다음 회차에 한 번 다시 조회한다.
let plaudRenderSeq = 0;

function plaudFmtSize(b) {
  if (typeof b !== 'number' || !isFinite(b) || b <= 0) return '';
  return b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
}

function plaudSizeHtml(st) {
  if (!st || typeof st.size !== 'number') return '';
  const over = st.size > PLAUD_MAX_IMPORT_BYTES;
  return ` <span class="small plaud-size"${over ? ' style="color:#c62828;font-weight:600" title="가져오기 상한 40MB를 넘습니다"' : ''}>(${esc(plaudFmtSize(st.size))})</span>`;
}

function plaudPumpSizes() {
  for (const f of plaudState.files) {
    if (plaudSizeActive >= 4) return;
    const st = plaudState.rows[f.id];
    if (!st || typeof st.size === 'number') continue; // 캐시된 행은 다시 묻지 않는다
    if (st.sizeState === 'loading' && Date.now() - (st.sizeAt || 0) < 60000) continue; // 조회 중 (60초 넘게 멈춘 행만 재시도)
    if (st.sizeState === 'failed' && st.sizeFailRender === plaudRenderSeq) continue; // 같은 렌더 회차에서는 실패를 되풀이하지 않는다
    st.sizeState = 'loading'; st.sizeAt = Date.now(); plaudSizeActive++;
    plaudCall('/api/plaud/files/' + encodeURIComponent(f.id) + '/size').then(j => {
      if (j.ok && typeof j.size_bytes === 'number' && j.size_bytes > 0) {
        st.size = j.size_bytes; st.sizeState = 'done';
        const el = document.querySelector('[data-plaud-title="' + (window.CSS && CSS.escape ? CSS.escape(f.id) : f.id) + '"]');
        if (el) { el.querySelectorAll('.plaud-size').forEach(x => x.remove()); el.insertAdjacentHTML('beforeend', plaudSizeHtml(st)); }
      } else { st.sizeState = 'failed'; st.sizeFailRender = plaudRenderSeq; } // 표시하지 않는다 (에러 토스트 없음)
    }).catch(() => { st.sizeState = 'failed'; st.sizeFailRender = plaudRenderSeq; }).finally(() => { plaudSizeActive--; plaudPumpSizes(); });
  }
}

// 파이프라인·예상 뉴런 표시용: Whisper로 전사한 Plaud 행(linked_recording_id)이 있을 때만 녹음 목록을 받아 id로 찾는다.
async function plaudLoadRecs(files) {
  if (!(files || plaudState.files).some(f => f.linked_recording_id)) return;
  const j = await plaudCall('/api/recordings');
  if (!j.ok || !Array.isArray(j.recordings)) return;
  plaudState.whisper = j.whisper || null;
  for (const r of j.recordings) plaudState.recs[r.id] = r;
}

// 행 아래 파이프라인(index.html pipelineSteps 재사용) + Whisper 예상 뉴런(추정). 연결된 녹음이 없으면 빈 문자열.
// 전사 중(processing)에는 기존 진행 표시(note)만 두고, 전사가 끝난 뒤부터 파이프라인을 붙인다.
function plaudPipelineHtml(f, st) {
  const r = f.linked_recording_id && plaudState.recs[f.linked_recording_id];
  if (!r || st.busy || r.transcript_status === 'processing' || typeof pipelineSteps !== 'function') return '';
  const w = plaudState.whisper, npm = w && typeof w.neuronsPerMin === 'number' ? w.neuronsPerMin : null;
  const upm = w && typeof w.usdPerMin === 'number' ? w.usdPerMin : null;
  const neu = npm && typeof r.duration_ms === 'number' && r.duration_ms > 0 ? Math.round(r.duration_ms / 60000 * npm) : null;
  const usd = upm && typeof r.duration_ms === 'number' && r.duration_ms > 0 ? r.duration_ms / 60000 * upm : null;
  const usdStr = usd != null ? '$' + usd.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : null;
  return pipelineSteps(r) + (neu != null ? `<div class="steps">Whisper 약 ${neu.toLocaleString('ko-KR')} 뉴런${usdStr ? ' · ' + usdStr : ''} (추정)</div>` : '');
}

function plaudRender() {
  const box = $('plaudBox');
  if (!box) return;
  const s = plaudState.status;
  const isAdmin = typeof currentUser !== 'undefined' && currentUser && currentUser.role === 'hr_admin';
  let html = '';
  if (s === 'unconfigured') {
    html = isAdmin ? '<p class="small">Plaud 연동이 아직 설정되지 않았습니다. (Worker 설정 PLAUD_CLIENT_ID · GCAL_TOKEN_KEY)</p>' : '<p class="small">Plaud 연동은 준비 중입니다.</p>';
  } else if (s === 'login') {
    html = '<p class="small">로그인하면 Plaud 녹음을 가져올 수 있습니다.</p>';
  } else if (s === 'error' || s === null) {
    html = '<p class="err">Plaud 연결 상태를 확인하지 못했습니다.</p><div class="btnrow"><button class="secondary" id="plaudRetry">다시 시도</button></div>';
  } else if (s === 'not_connected') {
    html = '<p class="small">Plaud 계정을 연결하면 내 녹음 목록을 보고, 전사문을 내 개인 문서로 가져와 개인 업무 검색에서 찾을 수 있습니다. 녹음·전사는 <b>읽기만</b> 하며 Plaud 쪽 데이터는 바꾸지 않습니다.</p>' +
      (plaudState.msg ? `<p class="err">${esc(plaudState.msg)}</p>` : '') +
      '<div class="btnrow"><button class="primary" id="plaudConnect">Plaud 연결</button></div><div id="plaudErr" class="err"></div>';
  } else if (s === 'connected') {
    html = `<div class="btnrow"><span class="badge ok">Plaud 연결됨</span>${plaudState.email ? ` <span class="small">${esc(plaudState.email)}</span>` : ''}` +
      ' <button class="secondary" id="plaudDisconnect">연결 해제</button> <button class="secondary" id="plaudRefresh">새로고침</button></div>' +
      (plaudState.err ? `<p class="err">${esc(plaudState.err)}</p>` : '') +
      (plaudState.msg ? `<p class="small">${esc(plaudState.msg)}</p>` : '') +
      plaudListHtml();
  }
  box.innerHTML = html;
  // 목록이 그려질 때마다(탭 전환 포함) 크기가 없는 행을 백그라운드로 조회한다. 렌더링은 기다리지 않는다.
  if (s === 'connected' && plaudState.files.length) plaudPumpSizes();
  const on =(id, fn) => { const x = $(id); if (x) x.onclick = fn; };
  on('plaudRetry', plaudLoad);
  on('plaudRefresh', () => { plaudState.msg = ''; plaudLoadFiles(1); });
  on('plaudConnect', plaudConnect);
  on('plaudDisconnect', plaudDisconnect);
  on('plaudMore', () => plaudLoadFiles(plaudState.page + 1));
  box.querySelectorAll('[data-plaud-import]').forEach(b => { b.onclick = () => plaudImport(b.getAttribute('data-plaud-import')); });
  box.querySelectorAll('[data-plaud-check]').forEach(b => { b.onclick = () => plaudCheck(b.getAttribute('data-plaud-check')); });
}

function plaudListHtml() {
  if (plaudState.loading && !plaudState.files.length) return '<p class="loading">Plaud 녹음 목록을 불러오는 중…</p>';
  if (!plaudState.files.length) return plaudState.err ? '' : '<p class="empty">Plaud에 표시할 녹음이 없습니다. (Plaud Cloud Sync가 켜져 있어야 합니다.)</p>';
  const rows = plaudState.files.map(f => {
    const st = plaudState.rows[f.id] || { tr: 'unknown', busy: false, imported: false, note: '' };
    const when = f.start_at || f.created_at;
    let badge, btn;
    if (st.imported) {
      badge = '<span class="badge ok">가져옴</span>';
      btn = '<button class="secondary" disabled>가져옴</button>';
    } else if (st.tr === 'no') {
      badge = '<span class="badge warn">전사 없음</span>';
      btn = st.busy
        ? '<button class="primary" disabled>전사 중…</button>'
        : `<button class="primary" data-plaud-import="${esc(f.id)}" title="Plaud에 전사가 없어 People OS Whisper로 직접 전사해서 가져옵니다 (오래 걸릴 수 있습니다)">가져와서 전사하기</button>`;
    } else {
      badge = st.tr === 'yes' ? '<span class="badge ok">전사 있음</span>'
        : st.tr === 'checking' ? '<span class="small">확인 중…</span>'
        : `<button type="button" class="btn-link" data-plaud-check="${esc(f.id)}">전사 확인</button>`;
      btn = `<button class="primary" data-plaud-import="${esc(f.id)}"${st.busy ? ' disabled' : ''}>${st.busy ? '가져오는 중…' : '가져오기'}</button>`;
    }
    return `<div class="taskrow"><span class="t-title" data-plaud-title="${esc(f.id)}">${esc(f.name)}${plaudSizeHtml(st)}</span>${badge}` +
      `<span class="t-src">${esc(when ? fmtDate(when) : '')}${f.duration_ms != null ? ' · ' + esc(plaudFmtDur(f.duration_ms)) : ''}</span>${btn}` +
      (st.note ? `<div class="small" style="flex-basis:100%">${esc(st.note)}</div>` : '') + '</div>' + plaudPipelineHtml(f, st);
  }).join('');
  return (plaudState.total != null ? `<p class="small" id="plaudTotal">총 ${plaudState.total}개</p>` : '') +
    `<div id="plaudList">${rows}</div>` +
    (plaudState.hasMore ? `<div class="btnrow"><button class="secondary" id="plaudMore"${plaudState.loading ? ' disabled' : ''}>더 보기</button></div>` : '');
}

async function plaudCheck(id) {
  const st = plaudState.rows[id]; if (!st) return;
  st.tr = 'checking'; plaudRender();
  const j = await plaudCall('/api/plaud/files/' + encodeURIComponent(id) + '/transcript');
  if (j.ok) st.tr = j.has_transcript ? 'yes' : 'no';
  else { st.tr = 'unknown'; st.note = j.error || '전사를 확인하지 못했습니다.'; if (j.code === 'NOT_CONNECTED') { plaudState.status = 'not_connected'; plaudState.msg = j.error; } }
  plaudRender();
}

async function plaudImport(id) {
  const st = plaudState.rows[id]; if (!st || st.busy) return;
  st.busy = true; st.note = ''; plaudRender();
  const j = await plaudCall('/api/plaud/import', { method: 'POST', body: JSON.stringify({ file_id: id }) });
  if (j.ok && j.transcribing) {
    st.tr = 'no'; st.busy = true; st.recId = j.recording_id;
    st.note = '오디오를 받아 전사를 시작했습니다. 길이에 따라 수십 분 걸릴 수 있습니다 — 이 페이지를 열어 두면 이어서 진행됩니다.';
    plaudRender(); plaudPoll(id); return;
  }
  if (j.code === 'TRANSCRIBING' && j.recording_id && j.recording_status !== 'pending') {
    st.tr = 'no'; st.busy = true; st.recId = j.recording_id; plaudRender(); plaudPoll(id); return;
  }
  st.busy = false;
  if (j.ok) {
    st.imported = true;
    st.note = '개인 문서로 가져왔습니다' + (j.indexError ? ' (색인은 실패 — 나중에 다시 색인됩니다)' : ' — 개인 업무 검색에서 찾을 수 있습니다') + '.';
    if (typeof loadUploadedDocs === 'function') { /* 문서 업로드 탭은 열 때 다시 불러온다 */ }
  } else if (j.code === 'ALREADY_IMPORTED') { st.imported = true; st.note = '이미 가져온 녹음입니다.'; }
  else if (j.code === 'NO_TRANSCRIPT') { st.tr = 'no'; st.note = ''; } // (서버는 이제 전사 없음이면 202로 전사를 시작한다 — 옛 응답 호환)
  else if (j.code === 'NOT_CONNECTED') { plaudState.status = 'not_connected'; plaudState.msg = j.error || ''; }
  else st.note = j.error || '가져오지 못했습니다.';
  plaudRender();
}

// 전사 없는 녹음: People OS Whisper 전사 진행 확인. POST /api/recordings/:id/advance가 한 번에 1구간씩 전사를 이어간다 (녹음 목록과 같은 경로).
async function plaudPoll(fileId) {
  const st = plaudState.rows[fileId]; if (!st || st.polling || !st.recId) return;
  st.polling = true;
  const started = Date.now();
  while (Date.now() - started < 90 * 60 * 1000) {
    const j = await plaudCall('/api/recordings/' + encodeURIComponent(st.recId) + '/advance', { method: 'POST', body: '{}' });
    if (j.ok && j.recording) {
      const r = j.recording;
      if (r.transcript_status === 'ready' && r.doc_id) {
        st.polling = false; st.busy = false; st.imported = true;
        st.note = '전사가 끝나 개인 문서로 저장했습니다 — 요약·색인이 끝나면 개인 업무 검색에서 찾을 수 있습니다.';
        const lf = plaudState.files.find(x => x.id === fileId);
        if (lf) lf.linked_recording_id = st.recId;
        await plaudLoadRecs(plaudState.files);
        plaudRender();
        if (typeof loadRecordings === 'function') loadRecordings();
        return;
      }
      if (r.transcript_status === 'pending') {
        st.polling = false; st.busy = false;
        st.note = '전사에 실패했습니다' + (r.progress ? ' (' + r.progress + ')' : '') + '. 아래 녹음 목록에서 “다시 전사”를 눌러 보세요.';
        plaudRender();
        if (typeof loadRecordings === 'function') loadRecordings();
        return;
      }
      st.note = '전사 중… ' + (r.progress || '준비 중') + ' · 페이지를 열어 두면 이어집니다';
      plaudRender();
    } else if (j._status === 401 || j._status === 403 || j._status === 404) {
      st.polling = false; st.busy = false; st.note = '전사 상태를 확인할 수 없습니다.'; plaudRender(); return;
    }
    await new Promise(res => setTimeout(res, 5000));
  }
  st.polling = false;
  st.note = '아직 전사 중입니다. 녹음 목록에서 이어갈 수 있습니다.'; plaudRender();
}

async function plaudConnect() {
  const b = $('plaudConnect'); if (b) b.disabled = true;
  const r = await plaudCall('/api/plaud/connect', { method: 'POST', body: '{}' });
  if (!r.ok || typeof r.url !== 'string' || !(r.url.startsWith(PLAUD_AUTH_PREFIX) || /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(r.url))) {
    if (b) b.disabled = false;
    const e = $('plaudErr'); if (e) e.textContent = '연결을 시작하지 못했습니다. ' + (r.error || '');
    return;
  }
  location.assign(r.url); // Plaud 동의 화면 → /api/plaud/callback → /#upload
}

async function plaudDisconnect() {
  if (!(await uiConfirm('Plaud 연결을 해제할까요? 이미 가져온 문서는 그대로 남습니다.', { title: 'Plaud 연결 해제', okText: '연결 해제', danger: true }))) return;
  const r = await plaudCall('/api/plaud/disconnect', { method: 'POST', body: '{}' });
  if (!r.ok) { plaudState.err = r.error || '연결을 해제하지 못했습니다.'; plaudRender(); return; }
  plaudState = { status: 'not_connected', email: null, files: [], page: 1, hasMore: false, loading: false, err: '', msg: 'Plaud 연결을 해제했습니다.', rows: {}, recs: {}, whisper: null };
  plaudRender();
}
