// 캘린더 C2 (2026-11-17) — /api/calendar/* 화면. 계획서 calendar-plan.md 5장.
// index.html 인라인 스크립트의 전역($, api, esc, escAttr, currentUser)을 쓴다. 마운트 지점: #calendarMount.
// FullCalendar는 캘린더 탭을 처음 열 때만 동적으로 불러온다 (index.html에 <script>를 넣지 않는다).
//
// 시간대: 저장은 UTC, 화면은 항상 KST(Asia/Seoul, +9 고정). FullCalendar는 timeZone:'UTC'로 두고
// KST 벽시계 값('YYYY-MM-DDTHH:MM:SS', 오프셋 없음)을 넘긴다 → 브라우저 시간대와 무관하게 KST로 보인다.
// 아래 cal* 순수 함수(시간 변환)는 DOM 없이 검증할 수 있게 분리했다.
const CAL_KST_MS = 9 * 3600_000;
const CAL_CATS = { general: '일반', meeting: '회의', coaching: '코칭', training: '교육', deadline: '기한' };
const CAL_REMIND_TIMED = [[null, '없음'], [15, '15분 전'], [30, '30분 전'], [60, '1시간 전'], [1440, '1일 전']];
const CAL_REMIND_ALLDAY = [[null, '없음'], [-540, '당일 오전 9시'], [900, '전날 오전 9시']]; // 시작(00:00 KST) 기준 분
const CAL_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const CAL_LIB = '/vendor/fullcalendar/index.global.min.js';
const CAL_LIB_KO = '/vendor/fullcalendar/ko.global.min.js';

let calObj = null, calMode = 'month', calLibPromise = null, calMq = null, calSeq = 0;
let calFilter = { mine: true, team: true, tasks: true, google: true };
// C4: 구글 일정은 별도 이벤트 소스. 구글 호출은 탭 열기·새로고침 버튼·보이는 기간 이동 때만 (자동 폴링 없음).
// 같은 기간은 캐시를 재사용해, 필터 토글·일정 저장 같은 자체 일정 갱신이 구글을 다시 부르지 않는다.
let calGCache = null; // { key, events, status } — status: 'connected' | 'needs_reconnect' | 'not_connected' | 'unconfigured' | 'error'
let calGForce = false, calGLastRefresh = 0;
const CAL_G_REFRESH_GAP_MS = 10_000;
let calModalEl = null, calLastFocus = null, calSubHandled = null, calLoadErr = false;

// ---------- 시간 변환 (순수 함수) ----------
function calPad(n) { return String(n).padStart(2, '0'); }
/** UTC epoch ms → KST 벽시계 'YYYY-MM-DDTHH:MM:SS' */
function calMsToWall(ms) { return new Date(ms + CAL_KST_MS).toISOString().slice(0, 19); }
/** UTC ISO('...Z') → KST 벽시계 */
function calUtcToWall(iso) { return calMsToWall(Date.parse(iso)); }
/** KST 날짜('YYYY-MM-DD') + 시각('HH:MM') → UTC ISO 'YYYY-MM-DDTHH:MM:SSZ' */
function calWallToUtc(date, time) {
  const ms = Date.parse(date + 'T' + (time || '00:00') + ':00Z');
  if (Number.isNaN(ms)) return null;
  return new Date(ms - CAL_KST_MS).toISOString().slice(0, 19) + 'Z';
}
/** FullCalendar가 돌려준 Date(timeZone:'UTC' → KST 벽시계를 UTC 필드에 담은 값) → 실제 UTC ISO */
function calFcDateToUtc(d) { return new Date(d.getTime() - CAL_KST_MS).toISOString().slice(0, 19) + 'Z'; }
function calAddDays(date, n) { return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10); }
function calTodayKst() { return calMsToWall(Date.now()).slice(0, 10); }
function calWeekday(date) { return CAL_WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()]; }
function calKorDate(date) { const [y, m, d] = date.split('-').map(Number); return `${y}년 ${m}월 ${d}일 (${calWeekday(date)})`; }
/** 서버 일정 → 사람이 읽는 KST 범위 문자열 */
function calFmtRange(ev) {
  if (ev.all_day) {
    const last = calAddDays(ev.end_date, -1);
    return last <= ev.start_date ? calKorDate(ev.start_date) + ' · 종일' : `${calKorDate(ev.start_date)} ~ ${calKorDate(last)} · 종일`;
  }
  const s = calUtcToWall(ev.start_at), e = calUtcToWall(ev.end_at);
  const sd = s.slice(0, 10), ed = e.slice(0, 10);
  return sd === ed
    ? `${calKorDate(sd)} ${s.slice(11, 16)} ~ ${e.slice(11, 16)}`
    : `${calKorDate(sd)} ${s.slice(11, 16)} ~ ${calKorDate(ed)} ${e.slice(11, 16)}`;
}
/** 서버 일정 → FullCalendar 이벤트 (KST 벽시계 값) */
function calToFcEvent(ev) {
  const base = { id: ev.id, title: ev.title, extendedProps: { raw: ev } };
  return ev.all_day
    ? Object.assign(base, { allDay: true, start: ev.start_date, end: ev.end_date })
    : Object.assign(base, { allDay: false, start: calUtcToWall(ev.start_at), end: calUtcToWall(ev.end_at) });
}
/** 할 일 이벤트 색: 보통 = 연한 노랑·주황 테두리·어두운 글자, 기한 지남 = 연한 빨강·빨강 테두리·빨강 글자. */
function calTaskColors(over) {
  return over
    ? { backgroundColor: '#fdecea', borderColor: '#b3261e', textColor: '#b3261e' }
    : { backgroundColor: '#fff4d6', borderColor: '#d97706', textColor: '#14233a' };
}
/** 할 일 → FullCalendar 이벤트. due_date·due_time은 이미 KST 벽시계 값이다. 시간이 있으면 30분짜리, 없으면 종일. */
function calTaskToFc(t, today, nowHm) {
  const over = t.due_date < today || (t.due_date === today && !!t.due_time && t.due_time < nowHm);
  const raw = { source: 'task', id: t.id, title: t.title, sub: !!t.parent_id, overdue: over };
  // 색은 FullCalendar 이벤트 속성으로 준다 (인라인 스타일이라 테마 기본 파랑·흰 글자를 이긴다). CSS 클래스는 점선·범례·목록 보기용.
  const base = Object.assign({ id: 'task:' + t.id, title: t.title, extendedProps: { raw }, editable: false, startEditable: false, durationEditable: false }, calTaskColors(over));
  if (!t.due_time) return Object.assign(base, { allDay: true, start: t.due_date });
  const start = t.due_date + 'T' + t.due_time + ':00';
  const end = new Date(Date.parse(start + 'Z') + 30 * 60_000).toISOString().slice(0, 19);
  return Object.assign(base, { allDay: false, start, end });
}
/** 달력에 올릴 할 일: 미완료 + 날짜 있음 + 보이는 기간(from 이상, to 미만 — 둘 다 'YYYY-MM-DD'). 하위 작업도 포함. */
function calTasksToFc(tasks, from, to, today, nowHm) {
  return (tasks || [])
    .filter((t) => !t.done && /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') && t.due_date >= from && t.due_date < to)
    .map((t) => calTaskToFc(/^\d{2}:\d{2}$/.test(t.due_time || '') ? t : Object.assign({}, t, { due_time: null }), today, nowHm));
}
function calEventClasses(ev) {
  if (ev.source === 'google') return ['cal-ev', 'cal-ev-google'];
  if (ev.source === 'task') return ev.overdue ? ['cal-ev', 'cal-ev-task', 'cal-ev-task-over'] : ['cal-ev', 'cal-ev-task'];
  const c = ['cal-ev', ev.visibility === 'team' ? 'cal-ev-team' : 'cal-ev-private'];
  if (ev.category === 'coaching') c.push('cal-ev-coaching');
  return c;
}
function calTitleOf(view) {
  const s = view.currentStart, e = new Date(view.currentEnd.getTime() - 86400_000);
  const y = s.getUTCFullYear(), m = s.getUTCMonth() + 1;
  if (view.type === 'dayGridMonth') return `${y}년 ${m}월`;
  const em = e.getUTCMonth() + 1;
  if (s.getUTCFullYear() !== e.getUTCFullYear()) return `${y}년 ${m}월 ${s.getUTCDate()}일 ~ ${e.getUTCFullYear()}년 ${em}월 ${e.getUTCDate()}일`;
  return m === em ? `${y}년 ${m}월 ${s.getUTCDate()}일 ~ ${e.getUTCDate()}일` : `${y}년 ${m}월 ${s.getUTCDate()}일 ~ ${em}월 ${e.getUTCDate()}일`;
}

// ---------- FullCalendar 지연 로딩 ----------
function calLoadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error('불러오지 못했습니다: ' + src));
    document.head.appendChild(s);
  });
}
function calLoadLib() {
  if (window.FullCalendar && window.FullCalendar.Calendar) return Promise.resolve();
  if (!calLibPromise) {
    calLibPromise = calLoadScript(CAL_LIB).then(() => calLoadScript(CAL_LIB_KO)).catch((e) => { calLibPromise = null; throw e; });
  }
  return calLibPromise;
}

// ---------- 탭 진입·이탈 ----------
function calNarrow() { return !!(window.matchMedia && window.matchMedia('(max-width: 720px)').matches); }
function calViewName() { return calMode === 'month' ? 'dayGridMonth' : (calNarrow() ? 'listWeek' : 'timeGridWeek'); }

async function calendarOpen(sub) {
  const root = $('calendarMount');
  if (!root) return;
  if (!root.dataset.ready) {
    root.innerHTML =
      '<div class="card cal-card">' +
      '<div class="cal-toolbar" role="toolbar" aria-label="캘린더 도구">' +
      '<div class="cal-nav"><button type="button" class="secondary" id="calToday">오늘</button>' +
      '<button type="button" class="secondary cal-arrow" id="calPrev" aria-label="이전">‹</button>' +
      '<button type="button" class="secondary cal-arrow" id="calNext" aria-label="다음">›</button>' +
      '<h2 class="cal-title" id="calTitle" aria-live="polite"></h2></div>' +
      '<div class="cal-right"><div class="cal-seg" role="group" aria-label="보기">' +
      '<button type="button" id="calViewMonth" aria-pressed="true">월</button>' +
      '<button type="button" id="calViewWeek" aria-pressed="false">주</button></div>' +
      '<span id="calGChip" class="cal-gchip-wrap"></span>' +
      '<button type="button" class="primary cal-add" id="calAdd">+ 일정 추가</button></div></div>' +
      '<div class="cal-filters"><label><input type="checkbox" id="calFMine" checked /> 내 일정</label>' +
      '<label><input type="checkbox" id="calFTeam" checked /> 팀 일정</label>' +
      '<label><input type="checkbox" id="calFTasks" checked /> 할 일</label>' +
      '<label><input type="checkbox" id="calFGoogle" checked /> 구글</label>' +
      '<button type="button" class="secondary" id="calGRefresh">구글 새로고침</button>' +
      '<span class="cal-legend small"><i class="cal-dot cal-dot-private"></i>내 일정 <i class="cal-dot cal-dot-team"></i>팀 공유(<b>팀</b> 배지) <i class="cal-dot cal-dot-coaching"></i>코칭(보라 띠) <i class="cal-dot cal-dot-task"></i>할 일(체크 표시·점선, 누르면 할 일 탭) <i class="cal-dot cal-dot-google"></i>구글(<b>G</b> 배지, <span id="calLegendGoogle">읽기 전용</span>)</span></div>' +
      '<div class="cal-msg" id="calMsg" role="status"></div>' +
      '<div class="cal-msg" id="calGMsg" role="status"></div>' +
      '<div id="calGrid" class="cal-grid"></div></div>';
    root.dataset.ready = '1';
    $('calToday').onclick = () => calObj && calObj.today();
    $('calPrev').onclick = () => calObj && calObj.prev();
    $('calNext').onclick = () => calObj && calObj.next();
    $('calViewMonth').onclick = () => calSetMode('month');
    $('calViewWeek').onclick = () => calSetMode('week');
    $('calAdd').onclick = () => calShowForm(null, { date: calTodayKst(), time: '09:00' });
    $('calFMine').onchange = (e) => { calFilter.mine = e.target.checked; calRefetch(); };
    $('calFTeam').onchange = (e) => { calFilter.team = e.target.checked; calRefetch(); };
    $('calFTasks').onchange = (e) => { calFilter.tasks = e.target.checked; calRefetch(); };
    $('calFGoogle').onchange = (e) => { calFilter.google = e.target.checked; calRefetch(); };
    $('calGRefresh').onclick = calGoogleManualRefresh;
  }
  const seq = ++calSeq;
  calGForce = true; // 탭을 열 때는 구글을 새로 읽는다
  calGoogleRefresh(); // 구글 연결 상태 칩 (C3) — 달력 로딩과 독립
  if (!calObj) {
    calMsg('달력을 불러오는 중…');
    try { await calLoadLib(); } catch (e) { if (seq === calSeq) calMsg('달력 구성요소를 불러오지 못했습니다. 새로고침 후 다시 시도하세요.', true); return; }
    if (seq !== calSeq) return; // 그 사이 탭을 떠났거나 다시 열었다
    calMsg('');
    calInit();
  } else {
    calObj.updateSize();
    calRefetch();
  }
  if (sub) { if (calSubHandled !== sub || !calModalEl) { calSubHandled = sub; calOpenById(sub); } } else calSubHandled = null;
}

function calendarLeave() {
  calSeq++; // 늦게 도착한 로딩·응답이 화면을 건드리지 않게
  calCloseModal(true);
}

function calMsg(text, isErr) {
  const el = $('calMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'cal-msg' + (isErr ? ' err' : '');
}

// ---------- FullCalendar 생성 ----------
function calInit() {
  const timeFmt = { hour: '2-digit', minute: '2-digit', hour12: false };
  calObj = new FullCalendar.Calendar($('calGrid'), {
    initialView: calViewName(),
    locale: 'ko',
    timeZone: 'UTC', // 값 자체가 KST 벽시계다 (calToFcEvent). 브라우저 시간대의 영향을 받지 않는다.
    now: () => new Date(Date.now() + CAL_KST_MS), // "오늘"·현재 시각선도 KST 기준
    headerToolbar: false,
    height: 'auto',
    firstDay: 0,
    fixedWeekCount: false,
    dayMaxEvents: 3,
    eventDisplay: 'block',
    nowIndicator: true,
    allDayText: '종일',
    slotMinTime: '00:00:00', slotMaxTime: '24:00:00', scrollTime: '07:00:00', slotDuration: '00:30:00',
    slotLabelFormat: timeFmt, eventTimeFormat: timeFmt,
    dayCellContent: (a) => a.dayNumberText.replace('일', ''),
    moreLinkContent: (a) => '+' + a.num + '개',
    noEventsContent: () => '이 기간에 일정이 없습니다',
    // 세 개의 독립된 소스: 자체 일정이 먼저 그려지고, 할 일·구글이 느리거나 실패해도 자체 일정은 그대로 보인다.
    eventSources: [
      { events: (info, ok, fail) => calFetchRange(info).then(ok, fail) },
      { events: (info, ok) => calFetchTasks(info).then(ok, () => ok([])) },
      { events: (info, ok) => calFetchGoogle(info).then(ok, () => ok([])) },
    ],
    eventClassNames: (a) => calEventClasses(a.event.extendedProps.raw),
    eventContent: calEventContent,
    eventClick: (a) => {
      a.jsEvent.preventDefault();
      const raw = a.event.extendedProps.raw;
      if (raw.source === 'task') { if (window.openTaskDetail) window.openTaskDetail(raw.id); } // 할 일 탭으로 가서 펼친다
      else if (raw.source === 'google') calShowGoogleDetail(raw); else calShowDetail(raw);
    },
    dateClick: (a) => calShowForm(null, a.allDay ? { date: a.dateStr.slice(0, 10), allDay: true } : { date: a.dateStr.slice(0, 10), time: a.dateStr.slice(11, 16) }),
    datesSet: (a) => { $('calTitle').textContent = calTitleOf(a.view); },
  });
  calObj.render();
  calApplyHeight();
  if (window.matchMedia && !calMq) {
    calMq = window.matchMedia('(max-width: 720px)');
    const onChange = () => { if (calObj && calMode === 'week') calObj.changeView(calViewName()); calApplyHeight(); };
    if (calMq.addEventListener) calMq.addEventListener('change', onChange); else if (calMq.addListener) calMq.addListener(onChange);
  }
}

/** 주 보기(시간 격자)는 07:00~21:00이 한눈에 보이는 고정 높이, 나머지는 내용 높이. */
function calApplyHeight() {
  if (!calObj) return;
  calObj.setOption('height', calObj.view.type === 'timeGridWeek' ? 760 : 'auto');
}

function calSetMode(mode) {
  calMode = mode === 'week' ? 'week' : 'month';
  $('calViewMonth').setAttribute('aria-pressed', calMode === 'month' ? 'true' : 'false');
  $('calViewWeek').setAttribute('aria-pressed', calMode === 'week' ? 'true' : 'false');
  if (calObj) { calObj.changeView(calViewName()); calApplyHeight(); }
}

function calRefetch() { if (calObj) calObj.refetchEvents(); }

async function calFetchRange(info) {
  const q = `from=${encodeURIComponent(calFcDateToUtc(info.start))}&to=${encodeURIComponent(calFcDateToUtc(info.end))}`;
  let j;
  try { j = await api('/api/calendar/events?' + q); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { calLoadErr = true; calMsg('일정을 불러오지 못했습니다. ' + (j.error || ''), true); throw new Error(j.error || 'load failed'); }
  if (calLoadErr) { calLoadErr = false; calMsg(''); } // 저장·삭제·충돌 안내는 남기고 "불러오기 실패"만 지운다
  const uid = currentUser && currentUser.id;
  return (j.events || [])
    .filter((e) => (e.visibility === 'team' ? calFilter.team : (e.owner_id === uid ? calFilter.mine : false)))
    .map(calToFcEvent);
}

// ---------- 할 일 소스 (2026-11-23) ----------
// 할 일 탭과 같은 범위를 그대로 쓴다: GET /api/tasks (본인 + 미지정, 관리자는 할 일 탭의 사용자 필터 기준).
// 할 일 수가 적어 캐시 없이 기간이 바뀔 때마다 다시 읽는다. 실패하면 빈 배열 (자체 일정에는 영향 없음).
async function calFetchTasks(info) {
  if (!calFilter.tasks) return [];
  const sel = currentUser && currentUser.role === 'hr_admin' ? $('taskOwnerFilter') : null;
  const owner = sel ? sel.value : '';
  let j;
  try { j = await api('/api/tasks' + (owner ? '?owner=' + encodeURIComponent(owner) : '')); } catch { j = { ok: false }; }
  if (!j || !j.ok) return [];
  const now = calMsToWall(Date.now());
  return calTasksToFc(j.tasks, info.start.toISOString().slice(0, 10), info.end.toISOString().slice(0, 10), j.today || now.slice(0, 10), now.slice(11, 16));
}

// ---------- 구글 일정 소스 (C4) ----------
function calGMsg(text, isErr) {
  const el = $('calGMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'cal-msg' + (isErr ? ' err' : '');
}

/** 구글 일정 → FullCalendar 이벤트. 종일은 날짜 그대로(끝 날짜 미포함), 그 밖은 UTC → KST 벽시계. */
function calGoogleToFc(g) {
  const base = { id: g.id, title: g.title, extendedProps: { raw: g }, editable: false, startEditable: false, durationEditable: false };
  return g.allDay
    ? Object.assign(base, { allDay: true, start: g.start, end: g.end })
    : Object.assign(base, { allDay: false, start: calUtcToWall(g.start), end: calUtcToWall(g.end) });
}

/** 구글 호출 결과를 안내 문구로. 자체 일정 표시에는 영향을 주지 않는다. */
function calGoogleNotice(status, extra) {
  if (status === 'needs_reconnect') calGMsg('구글 권한이 만료됐거나 회수됐습니다 — 툴바의 "다시 연결"로 구글을 다시 연결해 주세요. 내 일정과 팀 일정은 정상입니다.', true);
  else if (status === 'not_connected') calGMsg('구글 캘린더가 연결되어 있지 않습니다. 툴바의 "구글 캘린더 연결"을 눌러 내 구글 일정을 함께 볼 수 있습니다.');
  else if (status === 'error') calGMsg('구글 일정을 불러오지 못했습니다 — 잠시 후 "구글 새로고침"을 누르거나 다시 연결해 주세요. 내 일정과 팀 일정은 정상입니다.', true);
  else if (status === 'connected' && extra && extra.truncated) calGMsg('구글 일정이 너무 많아 일부만 표시합니다. 기간을 좁혀 보세요.');
  else calGMsg('');
}

async function calFetchGoogle(info) {
  if (!calFilter.google) return [];
  const from = calFcDateToUtc(info.start), to = calFcDateToUtc(info.end);
  const key = from + '|' + to;
  if (calGCache && calGCache.key === key && !calGForce) return calGCache.events;
  calGForce = false;
  const seq = calSeq;
  let r, j;
  try {
    r = await fetch('/api/calendar/google/events?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to), { cache: 'no-store' });
    j = await r.json().catch(() => ({ ok: false }));
  } catch { r = null; j = { ok: false }; }
  if (seq !== calSeq) return [];
  let status, events = [];
  if (r && r.status === 503) status = 'unconfigured';
  else if (r && r.status === 409) status = 'not_connected';
  else if (j && j.ok) { status = j.status === 'needs_reconnect' ? 'needs_reconnect' : 'connected'; events = (j.events || []).map(calGoogleToFc); }
  else status = 'error';
  calGCache = { key, events, status };
  calGoogleNotice(status, j);
  // 칩이 실제 상태와 다르면 상태를 다시 읽는다 (예: 갱신 실패로 NEEDS_RECONNECT가 된 직후)
  const chip = calGStatus && calGStatus.status;
  if ((status === 'needs_reconnect' && chip !== 'needs_reconnect') || (status === 'not_connected' && chip !== 'not_connected')) calGoogleRefresh();
  return events;
}

/** 새로고침 버튼: 구글만 다시 읽는다. 10초에 한 번까지. */
function calGoogleManualRefresh() {
  const now = Date.now();
  if (now - calGLastRefresh < CAL_G_REFRESH_GAP_MS) { calGMsg('구글 새로고침은 10초에 한 번만 할 수 있습니다.'); return; }
  calGLastRefresh = now;
  calGForce = true;
  calGoogleRefresh();
  calRefetch();
}

/** 구글 일정 상세: 읽기 전용 (수정·삭제 버튼 없음). */
function calShowGoogleDetail(g) {
  const row = (k, v) => (v ? `<div class="cal-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');
  let when;
  if (g.allDay) {
    const last = calAddDays(g.end, -1);
    when = last <= g.start ? calKorDate(g.start) + ' · 종일' : `${calKorDate(g.start)} ~ ${calKorDate(last)} · 종일`;
  } else {
    when = calFmtRange({ all_day: false, start_at: g.start, end_at: g.end });
  }
  const link = typeof g.htmlLink === 'string' && g.htmlLink.startsWith('https://')
    ? `<a href="${escAttr(g.htmlLink)}" target="_blank" rel="noopener noreferrer">구글 캘린더에서 열기</a>` : '';
  const html =
    `<h2 id="calDetailTitle" class="cal-detail-title"><span class="cal-badge cal-badge-google">G</span> ${esc(g.title)}</h2>` +
    '<dl class="cal-dl">' +
    row('일시', esc(when) + (g.allDay ? '' : ' <span class="small muted">(한국 시간)</span>')) +
    row('장소', g.location ? esc(g.location) : '') +
    row('출처', '구글 캘린더 (읽기 전용)') +
    '</dl>' +
    '<div class="cal-modal-btns"><button type="button" class="secondary" data-act="close">닫기</button></div>' +
    `<p class="small muted">구글 일정은 여기서 수정·삭제할 수 없습니다. ${link}</p>`;
  const m = calOpenModal(html, 'calDetailTitle');
  m.querySelector('[data-act=close]').onclick = () => calCloseModal();
}

/** 이벤트 모양: 팀 배지 + 시각 + 제목. 제목은 textContent로만 넣는다 (스크립트 주입 방지). */
function calEventContent(arg) {
  const ev = arg.event.extendedProps.raw;
  const wrap = document.createElement('div');
  wrap.className = 'cal-ev-inner';
  if (ev.source === 'google') {
    const b = document.createElement('span');
    b.className = 'cal-badge cal-badge-google'; b.textContent = 'G'; b.title = '구글 캘린더 (읽기 전용)';
    wrap.appendChild(b);
  } else if (ev.source === 'task') {
    // Lucide circle-check (선 아이콘). 고정 문자열이라 innerHTML로 넣어도 된다 — 제목은 아래에서 textContent로.
    const b = document.createElement('span');
    b.className = 'cal-task-ico'; b.title = ev.overdue ? '할 일 (기한 지남)' : '할 일';
    b.style.color = calTaskColors(ev.overdue).borderColor; // 아이콘 색 = 테두리 색 (주황 / 빨강)
    b.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
    wrap.appendChild(b);
  } else if (ev.visibility === 'team') {
    const b = document.createElement('span');
    b.className = 'cal-badge'; b.textContent = '팀';
    wrap.appendChild(b);
  }
  // 시간 격자(주·일 보기)의 할 일은 30분 칸이라 "14:00 - 14:30"을 붙이면 제목이 한 글자만 남는다. 시각은 격자 눈금이 보여 준다.
  const taskInGrid = ev.source === 'task' && String(arg.view.type).startsWith('timeGrid');
  if (arg.timeText && !arg.event.allDay && !String(arg.view.type).startsWith('list') && !taskInGrid) {
    const t = document.createElement('span');
    t.className = 'cal-ev-time'; t.textContent = arg.timeText;
    wrap.appendChild(t);
  }
  const title = document.createElement('span');
  title.className = 'cal-ev-title'; title.textContent = ev.title;
  wrap.appendChild(title);
  return { domNodes: [wrap] };
}

// ---------- 모달 ----------
function calOpenModal(html, labelId) {
  calCloseModal(true);
  calLastFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'cal-modal-back';
  wrap.innerHTML = `<div class="cal-modal" role="dialog" aria-modal="true" aria-labelledby="${labelId}">${html}</div>`;
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) calCloseModal(); });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); calCloseModal(); } });
  $('calendarMount').appendChild(wrap);
  calModalEl = wrap;
  const first = wrap.querySelector('input:not([type=hidden]),select,textarea,button');
  if (first) first.focus();
  return wrap;
}
function calCloseModal(silent) {
  if (calModalEl) { calModalEl.remove(); calModalEl = null; }
  if (!silent && calLastFocus && calLastFocus.focus) { try { calLastFocus.focus(); } catch { /* 사라진 요소 */ } }
}
function calRemindLabel(ev) {
  if (ev.remind_minutes === null || ev.remind_minutes === undefined) return '없음';
  const list = ev.all_day ? CAL_REMIND_ALLDAY : CAL_REMIND_TIMED;
  const hit = list.find((r) => r[0] === ev.remind_minutes);
  return hit ? hit[1] : ev.remind_minutes + '분 전';
}

/** C6: "구글에도 저장" 상태 문구 (소유자에게만 값이 온다). 저장 안 하는 일정은 빈 문자열 → 줄을 그리지 않는다. */
function calGoogleSyncLabel(ev) {
  if (!ev.google_sync) return '';
  if (ev.google_status === 'synced') return '내 구글 캘린더에도 저장됨';
  if (ev.google_status === 'failed') {
    const why = ev.google_error === 'needs_reconnect' || ev.google_error === 'not_connected' ? '구글을 다시 연결해 주세요'
      : ev.google_error === 'no_write_scope' ? '구글 쓰기 권한 동의가 필요합니다' : '자동으로 다시 시도합니다';
    return `<span class="cal-warn-inline">구글 반영 실패</span> <span class="small muted">(${esc(why)})</span>`;
  }
  return '구글에 반영하는 중…';
}
/** C6: 지금 "구글에도 저장"을 켤 수 있는가 (연결됨 + 쓰기 권한 동의). */
function calGoogleCanWrite() { return !!(calGStatus && calGStatus.status === 'connected' && calGStatus.can_write); }

// ---------- 상세 ----------
function calShowDetail(ev) {
  const isMine = currentUser && ev.owner_id === currentUser.id;
  const team = ev.visibility === 'team';
  const row = (k, v) => (v ? `<div class="cal-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>` : '');
  const html =
    `<h2 id="calDetailTitle" class="cal-detail-title">${team ? '<span class="cal-badge">팀</span> ' : ''}${esc(ev.title)}</h2>` +
    '<dl class="cal-dl">' +
    row('일시', esc(calFmtRange(ev)) + ' <span class="small muted">(한국 시간)</span>') +
    row('공개 범위', team ? '팀 공유 (전원이 봅니다)' : '나만 보기') +
    row('분류', esc(CAL_CATS[ev.category] || ev.category)) +
    row('장소', ev.location ? esc(ev.location) : '') +
    row('메모', ev.description ? `<div class="cal-pre">${esc(ev.description)}</div>` : '') +
    row('알림', esc(calRemindLabel(ev))) +
    row('구글 캘린더', calGoogleSyncLabel(ev)) +
    (team && !isMine ? row('작성자', esc(ev.owner_name || '알 수 없음')) : '') +
    '</dl>' +
    '<div class="cal-modal-btns">' +
    (ev.editable ? '<button type="button" class="primary" data-act="edit">수정</button><button type="button" class="secondary cal-danger" data-act="delete">삭제</button>' : '') +
    '<button type="button" class="secondary" data-act="close">닫기</button></div>' +
    (!ev.editable && team ? '<p class="small muted">다른 사람이 만든 팀 일정은 수정할 수 없습니다.</p>' : '');
  const m = calOpenModal(html, 'calDetailTitle');
  m.querySelector('[data-act=close]').onclick = () => calCloseModal();
  const ed = m.querySelector('[data-act=edit]');
  if (ed) ed.onclick = () => calShowForm(ev);
  const del = m.querySelector('[data-act=delete]');
  if (del) del.onclick = () => calDelete(ev);
}

async function calOpenById(id) {
  const seq = calSeq;
  let j;
  try { j = await api('/api/calendar/events/' + encodeURIComponent(id)); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (seq !== calSeq) return;
  if (!j.ok) { calMsg('일정을 열지 못했습니다. ' + (j.error || ''), true); return; }
  const ev = j.event;
  if (calObj) calObj.gotoDate(ev.all_day ? ev.start_date : calUtcToWall(ev.start_at).slice(0, 10));
  calShowDetail(ev);
}

// ---------- 추가·수정 폼 ----------
function calTimeOpts(sel) {
  let h = '';
  // 15분 단위가 아닌 시각(워크플로우 "일정 만들기" 노드 등으로 만든 일정)은 목록에 없어 00:00으로 바뀌어 저장됐다 —
  // 현재 값을 선택된 항목으로 먼저 넣는다.
  if (/^\d{2}:\d{2}$/.test(sel || '') && Number(sel.slice(3)) % 15 !== 0) h += `<option value="${sel}" selected>${sel}</option>`;
  for (let m = 0; m < 1440; m += 15) {
    const v = calPad(Math.floor(m / 60)) + ':' + calPad(m % 60);
    h += `<option value="${v}"${v === sel ? ' selected' : ''}>${v}</option>`;
  }
  return h;
}
function calRemindOpts(allDay, sel) {
  return (allDay ? CAL_REMIND_ALLDAY : CAL_REMIND_TIMED).map((r) =>
    `<option value="${r[0] === null ? '' : r[0]}"${r[0] === sel ? ' selected' : ''}>${esc(r[1])}</option>`).join('');
}
/** 'HH:MM'에 분을 더한 (날짜, 시각). 15분 단위로 맞춘다. */
function calShift(date, time, addMin) {
  const ms = Date.parse(date + 'T' + time + ':00Z') + addMin * 60_000;
  const w = new Date(ms).toISOString();
  return { date: w.slice(0, 10), time: w.slice(11, 16) };
}

/** ev가 있으면 수정, 없으면 pre({date, time?, allDay?})로 새 일정. */
function calShowForm(ev, pre) {
  const isNew = !ev;
  const own = isNew || (currentUser && ev.owner_id === currentUser.id);
  let v;
  if (ev) {
    const s = ev.all_day ? { date: ev.start_date, time: '09:00' } : { date: calUtcToWall(ev.start_at).slice(0, 10), time: calUtcToWall(ev.start_at).slice(11, 16) };
    const e = ev.all_day ? { date: calAddDays(ev.end_date, -1), time: '10:00' } : { date: calUtcToWall(ev.end_at).slice(0, 10), time: calUtcToWall(ev.end_at).slice(11, 16) };
    v = { title: ev.title, all_day: ev.all_day, sd: s.date, st: s.time, ed: e.date, et: e.time, visibility: ev.visibility, category: ev.category, location: ev.location || '', description: ev.description || '', remind: ev.remind_minutes };
  } else {
    const st = pre.time || '09:00';
    const e = calShift(pre.date, st, 60);
    v = { title: '', all_day: !!pre.allDay, sd: pre.date, st, ed: pre.allDay ? pre.date : e.date, et: e.time, visibility: 'private', category: 'general', location: '', description: '', remind: null };
  }
  v.gsync = !!(ev && ev.google_sync);
  // 구글 저장 칸: 내 일정이고, 구글이 연결돼 있거나(동의 안내 포함) 이미 저장 중일 때 보인다.
  const gShow = own && (v.gsync || !!(calGStatus && calGStatus.status === 'connected'));
  const html =
    `<h2 id="calFormTitle" class="cal-detail-title">${isNew ? '일정 추가' : '일정 수정'}</h2>` +
    '<form id="calForm" class="cal-form" novalidate>' +
    `<label>제목<input id="calFTitle" type="text" maxlength="200" required value="${escAttr(v.title)}" /></label>` +
    `<label class="cal-check"><input id="calFAllDay" type="checkbox"${v.all_day ? ' checked' : ''} /> 종일</label>` +
    '<div class="cal-when">' +
    `<label>시작<span class="cal-pair"><input id="calFSD" type="date" required value="${escAttr(v.sd)}" /><select id="calFST" aria-label="시작 시각">${calTimeOpts(v.st)}</select></span></label>` +
    `<label>종료<span class="cal-pair"><input id="calFED" type="date" required value="${escAttr(v.ed)}" /><select id="calFET" aria-label="종료 시각">${calTimeOpts(v.et)}</select></span></label>` +
    '</div><p class="small muted cal-tz">한국 시간(KST) 기준입니다.</p>' +
    `<label>공개 범위<select id="calFVis"${own ? '' : ' disabled'}>` +
    `<option value="private"${v.visibility === 'private' ? ' selected' : ''}>나만 보기</option>` +
    `<option value="team"${v.visibility === 'team' ? ' selected' : ''}>팀 공유 (전원이 봅니다)</option></select></label>` +
    '<p class="cal-warn" id="calFTeamNote" hidden>팀 공유 일정은 모든 사용자의 달력에 표시됩니다. 개인 정보나 민감한 내용은 넣지 마세요.</p>' +
    `<label>분류<select id="calFCat">${Object.keys(CAL_CATS).map((k) => `<option value="${k}"${k === v.category ? ' selected' : ''}>${esc(CAL_CATS[k])}</option>`).join('')}</select></label>` +
    `<label>장소 (선택)<input id="calFLoc" type="text" maxlength="200" value="${escAttr(v.location)}" /></label>` +
    `<label>메모 (선택)<textarea id="calFDesc" rows="3" maxlength="2000">${esc(v.description)}</textarea></label>` +
    `<label>알림<select id="calFRemind">${calRemindOpts(v.all_day, v.remind)}</select></label>` +
    '<p class="small muted cal-tz">알림은 15분 간격으로 확인해 보냅니다 (종 아이콘 + 개인 일정은 메일).</p>' +
    // C6: 구글 연결이 있을 때만 보인다. 개인 일정 + 쓰기 권한 동의가 있어야 켤 수 있다.
    (gShow ? `<label class="cal-check"><input id="calFGSync" type="checkbox"${v.gsync ? ' checked' : ''} /> 구글 캘린더에도 저장</label>` +
      '<p class="small muted cal-tz" id="calFGNote"></p>' : '') +
    '<div class="cal-msg err" id="calFErr" role="alert" hidden></div>' +
    '<div class="cal-modal-btns"><button type="submit" class="primary" id="calFSave">저장</button>' +
    '<button type="button" class="secondary" data-act="cancel">취소</button>' +
    (isNew ? '' : '<button type="button" class="secondary cal-danger" data-act="delete">삭제</button>') + '</div></form>';
  const m = calOpenModal(html, 'calFormTitle');
  const g = (id) => m.querySelector('#' + id);
  const syncAllDay = () => {
    const ad = g('calFAllDay').checked;
    g('calFST').hidden = ad; g('calFET').hidden = ad;
    const cur = g('calFRemind').value;
    g('calFRemind').innerHTML = calRemindOpts(ad, cur === '' ? null : Number(cur));
  };
  const syncTeam = () => {
    const team = g('calFVis').value === 'team';
    g('calFTeamNote').hidden = !team;
    const gs = g('calFGSync');
    if (!gs) return;
    // 팀 일정은 구글에 쓰지 않는다. 쓰기 권한 동의가 없으면 새로 켤 수 없다 (이미 켜진 것을 끄는 것은 된다).
    const can = calGoogleCanWrite();
    if (team) gs.checked = false;
    gs.disabled = team || (!can && !v.gsync);
    g('calFGNote').textContent = team ? '팀 공유 일정은 구글 캘린더에 저장하지 않습니다.'
      : !can ? '구글에 저장하려면 쓰기 권한 동의가 필요합니다 — 툴바의 구글 칩 → "구글에 저장 허용".'
        : '켜면 내 구글 기본 캘린더에 같은 일정을 만들고, 수정·삭제도 따라갑니다. 구글에서 고치면 구글 내용이 우선합니다.';
  };
  // 시작을 바꾸면 종료도 같은 간격으로 따라간다.
  let prevStart = Date.parse(g('calFSD').value + 'T' + g('calFST').value + ':00Z');
  const onStart = () => {
    const cur = Date.parse(g('calFSD').value + 'T' + g('calFST').value + ':00Z');
    if (Number.isNaN(cur) || Number.isNaN(prevStart)) { prevStart = cur; return; }
    const ee = Date.parse(g('calFED').value + 'T' + g('calFET').value + ':00Z');
    if (!Number.isNaN(ee)) {
      const t = new Date(ee + (cur - prevStart)).toISOString();
      g('calFED').value = t.slice(0, 10);
      g('calFET').value = t.slice(11, 16);
    }
    prevStart = cur;
  };
  g('calFAllDay').onchange = syncAllDay;
  g('calFVis').onchange = syncTeam;
  g('calFSD').onchange = onStart; g('calFST').onchange = onStart;
  syncAllDay(); syncTeam();
  g('calFRemind').value = v.remind === null || v.remind === undefined ? '' : String(v.remind);
  m.querySelector('[data-act=cancel]').onclick = () => calCloseModal();
  const del = m.querySelector('[data-act=delete]');
  if (del) del.onclick = () => calDelete(ev);
  g('calForm').addEventListener('submit', (e) => { e.preventDefault(); calSubmit(ev, own, m); });
}

/** 폼 값 → API 본문. 검증 실패면 { error }. */
function calBuildPayload(f) {
  const title = f.title.trim();
  if (!title) return { error: '제목을 입력하세요.' };
  if (title.length > 200) return { error: '제목은 200자 이하여야 합니다.' };
  if (!f.sd || !f.ed) return { error: '시작과 종료 날짜를 입력하세요.' };
  let start_at, end_at;
  if (f.all_day) {
    if (f.ed < f.sd) return { error: '종료일은 시작일보다 빠를 수 없습니다.' };
    start_at = calWallToUtc(f.sd, '00:00');
    end_at = calWallToUtc(calAddDays(f.ed, 1), '00:00'); // 서버는 종일의 끝을 "다음 날 00:00"으로 둔다
  } else {
    start_at = calWallToUtc(f.sd, f.st);
    end_at = calWallToUtc(f.ed, f.et);
  }
  if (!start_at || !end_at) return { error: '날짜 형식이 올바르지 않습니다.' };
  if (end_at <= start_at) return { error: '종료는 시작보다 뒤여야 합니다.' };
  if (Date.parse(end_at) - Date.parse(start_at) > 31 * 86400_000) return { error: '일정은 최대 31일까지입니다.' };
  return {
    body: {
      title, all_day: !!f.all_day, start_at, end_at, category: f.category,
      location: f.location.trim() || null, description: f.description.trim() || null,
      remind_minutes: f.remind === '' || f.remind === null ? null : Number(f.remind),
    },
  };
}

async function calSubmit(ev, own, m) {
  const g = (id) => m.querySelector('#' + id);
  const errBox = g('calFErr');
  const showErr = (t) => { errBox.textContent = t; errBox.hidden = false; };
  errBox.hidden = true;
  const r = calBuildPayload({
    title: g('calFTitle').value, all_day: g('calFAllDay').checked, sd: g('calFSD').value, st: g('calFST').value,
    ed: g('calFED').value, et: g('calFET').value, category: g('calFCat').value, location: g('calFLoc').value,
    description: g('calFDesc').value, remind: g('calFRemind').value,
  });
  if (r.error) { showErr(r.error); return; }
  const body = r.body;
  if (own) body.visibility = g('calFVis').value; // 남의 팀 일정을 고치는 hr_admin은 공개 범위를 못 바꾼다 (서버도 403)
  // C6: 구글 저장 칸이 보일 때만 값을 보낸다 (안 보이면 서버가 지금 상태를 유지한다).
  const gs = g('calFGSync');
  if (own && gs && (gs.checked !== !!(ev && ev.google_sync) || (!ev && gs.checked))) body.google_sync = gs.checked;
  if (body.visibility === 'team' && (!ev || ev.visibility !== 'team')) {
    if (!(await uiConfirm('이 일정은 모든 사용자의 달력에 표시됩니다. 저장할까요?', { title: '팀 일정 저장', okText: '저장' }))) return;
  }
  const save = g('calFSave');
  save.disabled = true;
  let j;
  try {
    j = ev
      ? await api('/api/calendar/events/' + encodeURIComponent(ev.id), { method: 'PATCH', body: JSON.stringify(Object.assign({ version: ev.version }, body)) })
      : await api('/api/calendar/events', { method: 'POST', body: JSON.stringify(body) });
  } catch { j = { ok: false, error: '네트워크 오류' }; }
  save.disabled = false;
  if (!j.ok) {
    if (j.error && /다른 곳에서 먼저 수정/.test(j.error)) {
      calCloseModal(true); calMsg('다른 곳에서 먼저 수정됐습니다. 새로 불러옵니다.', true); calRefetch(); return;
    }
    showErr(j.error || '저장하지 못했습니다.');
    return;
  }
  calCloseModal();
  calMsg(ev ? '일정을 저장했습니다.' : '일정을 추가했습니다.');
  calRefetch();
  // C6: 구글 반영은 응답 뒤에 끝난다 — 잠시 뒤 한 번 더 읽어 "반영하는 중"을 "저장됨"으로 바꾼다.
  if (j.event && j.event.google_status === 'pending') { const seq = calSeq; setTimeout(() => { if (seq === calSeq) calRefetch(); }, 4000); }
}

// ---------- 구글 연결 상태 칩 (C3, calendar-plan.md 5.5) ----------
// 상태는 /api/calendar/google/status. 토큰은 서버 밖으로 나오지 않는다 — 화면은 상태·마스킹 이메일만 본다.
let calGStatus = null; // 마지막 상태 응답 (패널 표시용)
const CAL_G_AUTH_PREFIX = 'https://accounts.google.com/';

async function calGoogleRefresh() {
  const el = $('calGChip');
  if (!el) return;
  const seq = calSeq;
  let r, j;
  try {
    r = await fetch('/api/calendar/google/status', { headers: { 'content-type': 'application/json' }, cache: 'no-store' });
    j = await r.json().catch(() => ({ ok: false }));
  } catch { r = null; j = { ok: false }; }
  if (seq !== calSeq) return;
  if (r && r.status === 503) j = { ok: true, status: 'unconfigured' };
  else if (!j.ok) j = { ok: true, status: 'error' };
  calGStatus = j;
  calGoogleRender();
  calGoogleSyncLinks();
}

// C6: 구글에 저장한 내 일정을 구글과 맞춘다 (구글에서 고쳤거나 지운 것을 가져온다). 쓰기 권한이 있고 저장한 일정이 있을 때만,
// 탭을 열 때·새로고침 버튼에서 한 번. 바뀐 것이 있으면 달력을 다시 읽는다.
let calGSyncBusy = false;
async function calGoogleSyncLinks() {
  if (calGSyncBusy || !calGoogleCanWrite() || !calGStatus.linked_count) return;
  calGSyncBusy = true;
  const seq = calSeq;
  let j;
  try { j = await api('/api/calendar/google/sync', { method: 'POST', body: '{}' }); } catch { j = { ok: false }; }
  calGSyncBusy = false;
  if (seq !== calSeq || !j || !j.ok || !j.changed) return;
  calMsg('구글 캘린더에서 바뀐 내용을 반영했습니다.');
  calRefetch();
}

function calGoogleRender() {
  const el = $('calGChip');
  if (!el) return;
  const s = calGStatus ? calGStatus.status : null;
  const isAdmin = currentUser && currentUser.role === 'hr_admin';
  let html = '';
  if (s === 'unconfigured') {
    html = isAdmin ? '<button type="button" class="secondary cal-gchip cal-gchip-off" data-g="info">구글 연동 미설정</button>' : '';
  } else if (s === 'not_connected') {
    html = '<button type="button" class="secondary cal-gchip" data-g="info">구글 캘린더 연결</button>';
  } else if (s === 'connected') {
    html = calGStatus.degraded
      ? '<button type="button" class="secondary cal-gchip cal-gchip-err" data-g="info"><span aria-hidden="true">●</span> 구글 응답 없음</button>'
      : '<button type="button" class="secondary cal-gchip cal-gchip-ok" data-g="info"><span aria-hidden="true">●</span> 구글 연결됨</button>';
  } else if (s === 'needs_reconnect') {
    html = '<button type="button" class="secondary cal-gchip cal-gchip-warn" data-g="info"><span aria-hidden="true">▲</span> 다시 연결</button>';
  } else if (s === 'error') {
    html = '<button type="button" class="secondary cal-gchip cal-gchip-err" data-g="info"><span aria-hidden="true">●</span> 구글 상태 확인 실패</button>';
  }
  el.innerHTML = html;
  const b = el.querySelector('[data-g=info]');
  if (b) b.onclick = calGooglePanel;
  // 범례의 구글 권한 표시도 연결 상태에 맞춘다 (쓰기 동의 전에는 "읽기 전용", 후에는 "읽기 + 구글에 저장").
  const lg = $('calLegendGoogle');
  if (lg) lg.textContent = calGoogleCanWrite() ? '읽기 + 구글에 저장' : '읽기 전용';
}

function calGooglePanel() {
  const j = calGStatus || {};
  const s = j.status;
  let body = '', btns = '';
  if (s === 'unconfigured') {
    body = '<p>관리자가 Google OAuth 설정을 마쳐야 합니다. (Worker 시크릿 GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET · GCAL_TOKEN_KEY)</p>';
  } else if (s === 'not_connected') {
    body = '<p>구글 <b>기본 캘린더의 일정을 읽기만</b> 합니다. 구글 일정 내용은 People OS에 저장하지 않습니다.</p>' +
      '<p class="small muted">People OS 개인 일정을 구글에도 저장하려면 "읽기 + 구글에 저장 허용"으로 연결하세요 (일정마다 직접 켠 것만 구글에 씁니다).</p>' +
      '<p class="small muted">구글 화면에서 계정을 고르고 권한에 동의하면 이 화면으로 돌아옵니다.</p>';
    btns = '<button type="button" class="primary" data-g="connect">구글 캘린더 연결 (읽기)</button>' +
      '<button type="button" class="secondary" data-g="connect-write">읽기 + 구글에 저장 허용</button>';
  } else if (s === 'connected') {
    body = `<dl class="cal-dl"><div class="cal-row"><dt>계정</dt><dd>${esc(j.email || '(이메일 정보 없음)')}</dd></div>` +
      `<div class="cal-row"><dt>권한</dt><dd>${j.can_write ? '일정 읽기 + People OS 개인 일정을 구글에 저장' : '캘린더 일정 읽기 전용'}</dd></div>` +
      (j.linked_count ? `<div class="cal-row"><dt>구글에 저장 중</dt><dd>${Number(j.linked_count)}건${j.failed_count ? ` · <span class="cal-warn-inline">반영 실패 ${Number(j.failed_count)}건</span>` : ''}</dd></div>` : '') +
      '</dl>' +
      (j.can_write ? '' : '<p class="small muted">People OS 개인 일정을 구글 캘린더에도 저장하려면 구글에서 <b>쓰기 권한에 한 번 더 동의</b>해야 합니다. 동의해도 일정마다 "구글 캘린더에도 저장"을 켠 것만 구글에 씁니다.</p>') +
      (j.degraded ? '<p class="cal-warn">구글 일정을 불러오지 못했습니다. 내 일정과 팀 일정은 정상입니다.</p>' : '');
    btns = (j.degraded ? '<button type="button" class="primary" data-g="retry">다시 시도</button>' : '') +
      (j.can_write ? '' : '<button type="button" class="primary" data-g="connect-write">구글에 저장 허용 (다시 동의)</button>') +
      '<button type="button" class="secondary cal-danger" data-g="disconnect">연결 해제</button>';
  } else if (s === 'needs_reconnect') {
    body = `<p class="cal-warn">구글 권한이 만료됐거나 회수됐습니다. 다시 연결해 주세요.</p>` +
      (j.email ? `<p class="small muted">이전 계정: ${esc(j.email)}</p>` : '') +
      (j.linked_count ? '<p class="small muted">구글에 저장하던 일정이 있습니다 — "읽기 + 구글에 저장 허용"으로 다시 연결해야 계속 반영됩니다.</p>' : '');
    btns = '<button type="button" class="primary" data-g="connect">다시 연결 (읽기)</button>' +
      '<button type="button" class="secondary" data-g="connect-write">읽기 + 구글에 저장 허용</button>' +
      '<button type="button" class="secondary cal-danger" data-g="disconnect">연결 해제</button>';
  } else {
    body = '<p>구글 연결 상태를 확인하지 못했습니다. 내 일정과 팀 일정은 정상입니다.</p>';
    btns = '<button type="button" class="primary" data-g="retry">다시 시도</button>';
  }
  const m = calOpenModal(
    '<h2 id="calGTitle" class="cal-detail-title">구글 캘린더 연동</h2>' + body +
    '<div class="cal-msg err" id="calGErr" role="alert" hidden></div>' +
    `<div class="cal-modal-btns">${btns}<button type="button" class="secondary" data-g="close">닫기</button></div>`,
    'calGTitle');
  const on = (k, fn) => { const x = m.querySelector(`[data-g=${k}]`); if (x) x.onclick = fn; };
  const err = (t) => { const e = m.querySelector('#calGErr'); e.textContent = t; e.hidden = false; };
  on('close', () => calCloseModal());
  on('retry', () => { calCloseModal(); calGoogleRefresh(); });
  const connect = (write) => async (e) => {
    e.target.disabled = true;
    let r;
    try { r = await api('/api/calendar/google/connect', { method: 'POST', body: JSON.stringify({ write }) }); } catch { r = { ok: false, error: '네트워크 오류' }; }
    if (!r.ok || typeof r.url !== 'string' || !r.url.startsWith(CAL_G_AUTH_PREFIX)) {
      e.target.disabled = false; err('연결을 시작하지 못했습니다. ' + (r.error || '')); return;
    }
    location.assign(r.url); // 구글 동의 화면 → /api/calendar/google/callback → /#calendar
  };
  // 이미 쓰기 권한이 있는 연결을 "다시 연결"하면 쓰기 권한을 유지한 채로 요청한다.
  on('connect', connect(!!j.can_write));
  on('connect-write', connect(true));
  on('disconnect', async (e) => {
    if (!(await uiConfirm('구글 캘린더 연결을 해제할까요? People OS의 일정은 그대로 남습니다. 구글에 이미 저장된 일정은 구글에 남습니다.', { title: '구글 캘린더 연결 해제', okText: '연결 해제', danger: true }))) return;
    e.target.disabled = true;
    let r;
    try { r = await api('/api/calendar/google/disconnect', { method: 'POST', body: '{}' }); } catch { r = { ok: false, error: '네트워크 오류' }; }
    if (!r.ok) { e.target.disabled = false; err('연결을 해제하지 못했습니다. ' + (r.error || '')); return; }
    calCloseModal();
    calMsg('구글 캘린더 연결을 해제했습니다.');
    calGoogleRefresh();
  });
}

async function calDelete(ev) {
  const ok = await uiConfirm(ev.visibility === 'team' ? `"${ev.title}" 팀 일정을 삭제할까요? 전원의 달력에서 사라집니다.` : `"${ev.title}" 일정을 삭제할까요?`, { title: '일정 삭제', okText: '삭제', danger: true });
  if (!ok) return;
  let j;
  try { j = await api('/api/calendar/events/' + encodeURIComponent(ev.id), { method: 'DELETE' }); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { calMsg('삭제하지 못했습니다. ' + (j.error || ''), true); calCloseModal(true); calRefetch(); return; }
  calCloseModal();
  calMsg('일정을 삭제했습니다.');
  calRefetch();
}
