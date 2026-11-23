/* 할 일 탭 — 목록 > 할 일 > 하위 작업 (Google Tasks 패리티, 2026-11-23, migration 0046).
 *
 * index.html 본문 스크립트보다 먼저 불러온다 (본문이 loadTasks·addTask를 버튼에 건다). 본문의 $, api, esc, escAttr, isAdminUser,
 * getPerspectiveUsers, userOptions, taskSrcHtml, taskSrcResolve, loadHome 과 ui-dialog.js 의 uiConfirm·uiToast 는 실행 시점에만 쓴다.
 *
 * 저장 버튼이 없다 — 고치면 바로 반영한다 (제목·메모는 칸을 벗어날 때, 나머지는 고르는 즉시).
 * 화면 글자는 전부 esc()/textContent 로 넣는다 (할 일 제목·메모·목록 이름은 사용자 입력이다).
 *
 * 낙관적 업데이트 (2026-11-23): 바꾼 값은 S.tasks 에 먼저 반영해 바로 그리고, 서버 요청은 send() 줄(한 번에 하나, 누른 순서대로)로 보낸다.
 * 응답이 오면 서버 값으로 확정하고, 실패하면 바꾸기 전 값으로 되돌린 뒤 알리고 다시 읽는다.
 * 보내는 중인 변경이 있으면 목록 새로고침은 미루고(S.dirty), 변경과 겹친 새로고침 응답은 버린다(S.mut) — 늦게 온 옛 목록이 방금 바꾼 값을 덮지 않는다.
 * 그린 결과가 직전과 같으면 DOM 을 건드리지 않는다(S.html) — 확인용 새로고침이 줄을 흔들거나 입력 중인 칸을 지우지 않는다.
 */
(function (g) {
  'use strict';

  var S = {
    pend: 0,          // 아직 응답을 못 받은 변경 수 (줄 서 있는 것 포함)
    mut: 0,           // 변경이 시작·종료될 때마다 오른다 (겹친 새로고침 응답을 가려낸다)
    dirty: false,     // 변경이 다 끝나면 목록을 다시 읽는다
    busy: {},         // 할 일 id → 그 할 일에 걸린 변경 수 (마지막 응답만 서버 값으로 확정한다)
    ids: {},          // 임시 id → 서버 id (새 할 일)
    chain: Promise.resolve(),
    html: {},         // 컨테이너 id → 마지막으로 그린 HTML
    tmpN: 0,
    lockT: 0,
    rendering: false,
    lists: [],        // GET /api/task-lists
    mode: 'all',      // 'all' | 'starred' | 'list'
    listId: '',       // mode === 'list' 일 때
    sort: 'myorder',  // myorder | date | deadline | starred | title
    tasks: [],        // GET /api/tasks (진행 중 → 완료 순)
    today: '',        // 서버가 준 오늘 (KST)
    open: null,       // 상세를 펼친 할 일 id
    subFor: null,     // 하위 작업 입력 칸을 연 할 일 id
    doneOpen: false,  // "완료됨" 섹션을 펼쳤는가
    focus: null,      // 다음 loadTasks 뒤에 스크롤해 보여 줄 할 일 id (openTaskDetail)
    seq: 0,
    bound: false,
  };

  // Lucide 선 아이콘 (16px, stroke 2 — styles.css 가 button svg 크기를 맞춘다)
  var ICON = {
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    up: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
    down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    outdent: '<polyline points="7 8 3 12 7 16"/><line x1="21" x2="11" y1="12" y2="12"/><line x1="21" x2="11" y1="6" y2="6"/><line x1="21" x2="11" y1="18" y2="18"/>',
    calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  };
  function ico(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + '</svg>';
  }

  // ---- 날짜 (전부 "YYYY-MM-DD" 문자열, KST 달력 날짜) ----
  var WD = ['일', '월', '화', '수', '목', '금', '토'];
  var NTH = { 1: '첫째', 2: '둘째', 3: '셋째', 4: '넷째', last: '마지막' };
  function kstNow() { return new Date(Date.now() + 9 * 3600000).toISOString(); }
  function today() { return S.today || kstNow().slice(0, 10); }
  function toUtc(s) { var p = s.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { return new Date(toUtc(s) + n * 86400000).toISOString().slice(0, 10); }
  function dowOf(s) { return new Date(toUtc(s)).getUTCDay(); }
  function domOf(s) { return +s.split('-')[2]; }
  function dateLabel(s) {
    var t = today();
    if (s === t) return '오늘';
    if (s === addDays(t, 1)) return '내일';
    if (s === addDays(t, -1)) return '어제';
    var p = s.split('-');
    return (p[0] !== t.slice(0, 4) ? p[0] + '년 ' : '') + (+p[1]) + '월 ' + (+p[2]) + '일 (' + WD[dowOf(s)] + ')';
  }
  function timeLabel(hm) {
    var h = +hm.slice(0, 2), m = hm.slice(3, 5);
    return (h < 12 ? '오전 ' : '오후 ') + (h % 12 === 0 ? 12 : h % 12) + ':' + m;
  }
  function isOverdue(t) {
    if (t.done || !t.due_date) return false;
    var td = today();
    if (t.due_date < td) return true;
    return t.due_date === td && !!t.due_time && t.due_time < kstNow().slice(11, 16);
  }
  // done_at(UTC ISO) → KST 날짜
  function doneLabel(iso) {
    var ms = Date.parse(iso || '');
    if (isNaN(ms)) return '';
    return dateLabel(new Date(ms + 9 * 3600000).toISOString().slice(0, 10));
  }
  function repeatLabel(r) {
    if (!r) return '';
    var unit = { day: '일', week: '주', month: '개월', year: '년' }[r.unit];
    var s = r.every === 1 ? { day: '매일', week: '매주', month: '매월', year: '매년' }[r.unit] : r.every + unit + '마다';
    if (r.unit === 'week' && r.weekdays && r.weekdays.length) s += ' ' + r.weekdays.map(function (d) { return WD[d]; }).join('·');
    if (r.unit === 'month') {
      if (r.nth !== undefined && r.nth !== null) s += ' ' + NTH[r.nth] + ' ' + WD[r.weekday] + '요일';
      else if (r.day === 'last') s += ' 마지막 날';
      else if (r.day) s += ' ' + r.day + '일';
    }
    if (r.ends === 'on' && r.until) s += ', ' + r.until + '까지';
    if (r.ends === 'after' && r.occurrences) s += ', ' + r.occurrences + '회';
    return s;
  }
  function timeOptions(cur, emptyLabel) {
    var html = '<option value="">' + esc(emptyLabel) + '</option>', seen = false;
    for (var i = 0; i < 48; i++) {
      var hm = String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00');
      if (hm === cur) seen = true;
      html += '<option value="' + hm + '"' + (hm === cur ? ' selected' : '') + '>' + timeLabel(hm) + '</option>';
    }
    if (cur && !seen) html += '<option value="' + escAttr(cur) + '" selected>' + timeLabel(cur) + '</option>'; // 30분 단위가 아닌 기존 값
    return html;
  }

  // ---- 불러오기 ----
  function ownerFilter() { return isAdminUser() ? $('taskOwnerFilter').value : ''; }
  function curList() { return S.mode === 'list' ? S.lists.find(function (l) { return l.id === S.listId; }) || null : null; }
  function taskById(id) { return S.tasks.find(function (t) { return t.id === id; }) || null; }

  function tasksUrl() {
    var f = ownerFilter(), q = [];
    if (f) q.push('owner=' + encodeURIComponent(f));
    if (S.mode === 'list') q.push('list=' + encodeURIComponent(S.listId));
    if (S.mode === 'starred') q.push('filter=starred');
    if (S.sort !== 'myorder') q.push('sort=' + S.sort);
    return '/api/tasks' + (q.length ? '?' + q.join('&') : '');
  }

  // ---- 화면 순서 (서버 src/tasks.ts 의 arrangeTasks 와 같은 규칙 — 낙관적 변경을 서버가 줄 순서대로 놓는다) ----
  function cmpStr(a, b) {
    if (a == null) a = null;
    if (b == null) b = null;
    if (a === b) return 0;
    if (a === null) return 1; // 값 없음은 뒤로
    if (b === null) return -1;
    return a < b ? -1 : 1;
  }
  function comparator(sort) {
    var byPos = function (a, b) { return (a.position - b.position) || cmpStr(b.created_at, a.created_at); };
    if (sort === 'date') return function (a, b) { return cmpStr(a.due_date, b.due_date) || byPos(a, b); };
    if (sort === 'deadline') {
      var key = function (t) { return t.due_date ? t.due_date + ' ' + (t.due_time || '24:00') : null; };
      return function (a, b) { return cmpStr(key(a), key(b)) || byPos(a, b); };
    }
    if (sort === 'starred') return function (a, b) { return ((b.starred ? 1 : 0) - (a.starred ? 1 : 0)) || cmpStr(b.starred_at, a.starred_at) || byPos(a, b); };
    if (sort === 'title') return function (a, b) { return String(a.title).localeCompare(String(b.title), 'ko') || byPos(a, b); };
    return byPos;
  }
  function arrange(rows) {
    var active = rows.filter(function (r) { return !r.done; });
    var ids = {}, kids = {}, tops = [], out = [];
    active.forEach(function (r) { ids[r.id] = true; });
    active.forEach(function (r) {
      if (r.parent_id && ids[r.parent_id]) (kids[r.parent_id] = kids[r.parent_id] || []).push(r);
      else tops.push(r);
    });
    tops.sort(comparator(S.sort));
    tops.forEach(function (t) {
      t.indent = 0; out.push(t);
      (kids[t.id] || []).sort(comparator('myorder')).forEach(function (c) { c.indent = 1; out.push(c); });
    });
    rows.filter(function (r) { return r.done; })
      .sort(function (a, b) { return cmpStr(b.done_at, a.done_at) || (a.position - b.position); })
      .forEach(function (d) { d.indent = 0; out.push(d); });
    return out;
  }
  // 지금 보기(별표·목록)에 남는 할 일만 두고 순서를 다시 잡는다.
  function inView(t) {
    if (S.mode === 'starred') return !!t.starred;
    if (S.mode === 'list') return t.list_id === S.listId;
    return true;
  }
  function reflow() {
    S.tasks = arrange(S.tasks.filter(inView));
    if (S.open && !taskById(S.open)) S.open = null;
  }

  // 변경과 겹친 새로고침은 버리고, 변경이 다 끝난 뒤 다시 읽는다.
  function reloadLater() { if (S.pend) S.dirty = true; else loadTasks(); }

  async function loadTasks() {
    bind();
    if (S.pend) { S.dirty = true; return; } // 보내는 중인 변경이 있다 — 끝나면 send()가 다시 부른다
    var seq = ++S.seq, mut = S.mut;
    var admin = isAdminUser();
    $('taskAdminBar').style.display = admin ? '' : 'none';
    if (admin) {
      // 사용자 필터·담당자 드롭다운 (관리자 본인을 기본값으로 두지 않는다).
      var users = await getPerspectiveUsers();
      var keepF = $('taskOwnerFilter').value, keepO = $('newTaskOwner').value;
      $('taskOwnerFilter').innerHTML = '<option value="">전체 사용자</option><option value="unassigned">미지정</option>' + users.map(function (u) { return '<option value="' + esc(u.id) + '">' + esc(u.name || u.email) + ' (' + esc(u.email) + ')</option>'; }).join('');
      $('newTaskOwner').innerHTML = userOptions(users, '— 사용자를 선택하세요 —');
      if (keepF === 'unassigned' || users.some(function (u) { return u.id === keepF; })) $('taskOwnerFilter').value = keepF;
      if (users.some(function (u) { return u.id === keepO; })) $('newTaskOwner').value = keepO;
    }
    if (seq !== S.seq) return;
    if (S.mut !== mut) { reloadLater(); return; }
    var f = ownerFilter();
    // 목록과 할 일을 함께 부른다 (차례로 부르면 왕복이 두 번이다).
    var pl = api('/api/task-lists' + (f ? '?owner=' + encodeURIComponent(f) : ''));
    var pt = api(tasksUrl());
    pt.catch(function () { /* 아래 await 에서 다룬다 */ });
    var lj = await pl;
    if (seq !== S.seq) return;
    if (S.mut !== mut) { reloadLater(); return; }
    if (lj.ok) S.lists = lj.lists || [];
    if (S.mode === 'list' && !curList()) { S.mode = 'all'; S.listId = ''; pt = api(tasksUrl()); } // 지워졌거나 사용자 필터 밖의 목록 — 전체 보기로 다시 부른다
    var j = await pt;
    if (seq !== S.seq) return;
    if (S.mut !== mut) { reloadLater(); return; } // 응답을 기다리는 사이 화면에서 바꾼 것이 있다 — 이 응답은 옛 목록일 수 있다
    if (!j.ok) { setHtml('taskList', '<p class="empty">할 일을 불러오지 못했습니다. 새로고침해 주세요.</p>'); return; }
    S.tasks = j.tasks || [];
    S.today = j.today || '';
    if (S.open && !taskById(S.open)) S.open = null;
    render(true);
    if (S.focus) { var fid = S.focus; S.focus = null; focusRow(fid); }
  }

  // 캘린더의 할 일을 눌렀을 때: 할 일 탭으로 와서 전체 보기에서 그 할 일을 펼치고 그 줄로 스크롤한다.
  // 전체 보기에서는 하위 작업이 부모 바로 아래에 있으므로 가운데로 스크롤하면 부모도 함께 보인다.
  // 탭을 바꾸기 전에 화면을 먼저 맞춘다: loadTasks는 비동기라, 그대로 두면 응답이 올 때까지 이전에 펼쳐 둔 상세가 보인다.
  function openTaskDetail(id) {
    S.mode = 'all'; S.listId = ''; S.open = id; S.subFor = null; S.focus = id;
    bind();
    var known = taskById(id);
    if (known && !known.done) render(); // 이미 가진 목록으로 맞는 상세를 바로 그린다 (뒤이은 loadTasks가 새로 고친다)
    else {
      setHtml('taskList', '<p class="empty">불러오는 중…</p>');
      $('taskDoneBox').hidden = true;
    }
    if (typeof g.switchTab === 'function') g.switchTab('tasks'); // 탭 전환이 loadTasks를 부른다
    else loadTasks();
  }
  function focusRow(id) {
    var t = taskById(id);
    if (!t || t.done) { uiToast('이미 완료했거나 삭제된 할 일입니다.'); return; }
    var row = document.querySelector('#tab-tasks .tk-row[data-id="' + CSS.escape(id) + '"]');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    var btn = row.querySelector('.tk-main');
    if (btn && btn.focus) btn.focus({ preventScroll: true });
  }

  // ---- 그리기 ----
  // 직전에 그린 것과 같으면 DOM 을 건드리지 않는다 (줄이 흔들리지 않고, 입력 중인 칸·펼친 드롭다운이 그대로 남는다).
  function setHtml(id, html) {
    if (S.html[id] === html) return false;
    S.html[id] = html;
    $(id).innerHTML = html;
    return true;
  }

  // 다시 그려도 포커스(와 아직 저장 전인 글자)를 지킨다.
  function keepFocus() {
    var a = document.activeElement;
    var host = a && a.closest ? a.closest('#taskList [data-id], #taskDoneList [data-id]') : null;
    if (!host || !a.dataset) return null;
    var f = a.dataset.f, act = a.dataset.act;
    if (!f && !act) return null;
    return {
      id: host.dataset.id, cls: host.classList.contains('tk-detail') ? '.tk-detail' : '.tk-row',
      sel: f ? '[data-f="' + f + '"]' : '[data-act="' + act + '"]',
      text: f === 'title' || f === 'details' || f === 'newsub', v: a.value, s: a.selectionStart, e: a.selectionEnd,
    };
  }
  function restoreFocus(k) {
    var el = document.querySelector('#tab-tasks ' + k.cls + '[data-id="' + CSS.escape(S.ids[k.id] || k.id) + '"] ' + k.sel);
    if (!el || !el.focus) return;
    if (k.text) el.value = k.v;
    el.focus({ preventScroll: true });
    if (k.text) { try { el.setSelectionRange(k.s, k.e); } catch (x) { /* 무시 */ } }
  }

  // 클릭 잠금: 서버 응답으로 줄이 바뀌는 순간, 움직인 줄에 클릭이 잘못 닿지 않게 잠깐 막는다 (저장이 끝날 때까지 잡지 않는다).
  var LOCK_MS = 300;
  function setLock(on) {
    ['taskList', 'taskDoneBox'].forEach(function (id) {
      var c = $(id).classList;
      if (c) c[on ? 'add' : 'remove']('tk-lock');
    });
  }
  function lock() {
    setLock(true);
    clearTimeout(S.lockT);
    S.lockT = setTimeout(function () { setLock(false); }, LOCK_MS);
  }

  // fromServer: 서버 응답으로 그리는 경우 (사용자가 누른 것이 아닌데 줄이 바뀐다 → 클릭 잠금).
  function render(fromServer) {
    S.rendering = true;
    try {
      renderLists();
      renderTools();
      var active = S.tasks.filter(function (t) { return !t.done; });
      var done = S.tasks.filter(function (t) { return t.done; });
      var keep = keepFocus();
      var a = setHtml('taskList', active.length
        ? active.map(rowHtml).join('')
        : '<p class="empty">' + (S.mode === 'starred' ? '별표 한 할 일이 없습니다.' : '아직 할 일이 없습니다.') + '</p>');
      var box = $('taskDoneBox');
      box.hidden = !done.length;
      box.open = S.doneOpen;
      $('taskDoneSum').textContent = '완료됨 (' + done.length + ')';
      var b = setHtml('taskDoneList', done.map(rowHtml).join(''));
      $('newTaskTitle').placeholder = S.mode === 'starred' ? '별표 할 일을 입력하세요' : '할 일을 입력하세요';
      if (a) taskSrcResolve($('taskList'));
      if (b) taskSrcResolve($('taskDoneList'));
      if ((a || b) && keep) restoreFocus(keep);
      if ((a || b) && fromServer) lock();
    } finally { S.rendering = false; }
  }

  function listLabel(l) {
    // 관리자는 여러 사용자의 "내 할 일 목록"을 함께 보므로 소유자 이름을 붙인다.
    return l.title + (isAdminUser() && l.owner_id ? ' · ' + (l.owner_name || '') : '');
  }

  function renderLists() {
    var html = '<button type="button" class="tk-chip' + (S.mode === 'all' ? ' on' : '') + '" data-act="mode-all" role="tab" aria-selected="' + (S.mode === 'all') + '"><span>전체 할 일</span></button>' +
      '<button type="button" class="tk-chip' + (S.mode === 'starred' ? ' on' : '') + '" data-act="mode-starred" role="tab" aria-selected="' + (S.mode === 'starred') + '">' + ico('star') + '<span>별표</span></button>' +
      '<span class="tk-sep" aria-hidden="true"></span>';
    html += S.lists.map(function (l) {
      var on = S.mode === 'list' && S.listId === l.id;
      return '<button type="button" class="tk-chip' + (on ? ' on' : '') + '" data-act="mode-list" data-list="' + escAttr(l.id) + '" role="tab" aria-selected="' + on + '" title="' + escAttr(listLabel(l)) + '"><span>' + esc(listLabel(l)) + '</span><span class="tk-n">' + (l.open_count || 0) + '</span></button>';
    }).join('');
    html += '<button type="button" class="tk-chip tk-new" data-act="list-new">' + ico('plus') + '<span>새 목록</span></button>';
    setHtml('taskLists', html);
  }

  function renderTools() {
    var l = curList();
    var left = '<span>' + esc(S.mode === 'starred' ? '별표' : l ? listLabel(l) : '전체 할 일') + '</span>';
    if (l) {
      left += (l.is_default ? ' <span class="badge">기본 목록</span>' : '') +
        '<button type="button" class="tk-ib" data-act="list-rename" title="목록 이름 변경" aria-label="목록 이름 변경">' + ico('pencil') + '</button>' +
        (l.is_default
          ? '<button type="button" class="tk-ib" disabled title="기본 목록은 삭제할 수 없습니다" aria-label="목록 삭제 (기본 목록은 삭제할 수 없습니다)">' + ico('trash') + '</button>'
          : '<button type="button" class="tk-ib tk-del" data-act="list-delete" title="목록 삭제" aria-label="목록 삭제">' + ico('trash') + '</button>');
    }
    var sorts = [['myorder', '내 순서'], ['date', '날짜'], ['deadline', '기한'], ['starred', '최근 별표'], ['title', '제목']];
    setHtml('taskTools', '<div class="tk-cur">' + left + '</div>' +
      '<div class="tk-sort"><label for="taskSort">정렬</label><select id="taskSort" class="tk-in">' +
      sorts.map(function (s) { return '<option value="' + s[0] + '"' + (S.sort === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') +
      '</select></div>');
  }

  function rowHtml(t) {
    var sub = t.indent === 1, open = S.open === t.id && !t.done;
    var meta = [];
    if (t.done) {
      var dl = doneLabel(t.done_at);
      if (dl) meta.push('<span>완료: ' + esc(dl) + '</span>');
    } else {
      if (t.details && !open) meta.push('<span class="tk-note">' + esc(String(t.details).split('\n')[0].slice(0, 120)) + '</span>');
      if (t.due_date) meta.push('<span class="tk-due' + (isOverdue(t) ? ' tk-over' : '') + '"' + (isOverdue(t) ? ' title="기한 지남"' : '') + '>' + ico('calendar') + esc(dateLabel(t.due_date) + (t.due_time ? ' ' + timeLabel(t.due_time) : '')) + (isOverdue(t) ? ' · 기한 지남' : '') + '</span>');
      if (t.repeat_rule) meta.push('<span class="tk-due">' + ico('repeat') + esc(repeatLabel(t.repeat_rule)) + '</span>');
    }
    // 담당자 표시: 관리자 화면과 미지정 할 일에만 (일반 사용자는 전부 본인 것이라 생략).
    var owner = isAdminUser() || !t.owner_id ? '<span class="badge' + (t.owner_id ? '' : ' warn') + '" title="담당자">' + esc(t.owner_name || '미지정') + '</span>' : '';
    var id = escAttr(t.id);
    var tail = t.done
      ? '<button type="button" class="tk-ib tk-del" data-act="delete" title="삭제" aria-label="삭제">' + ico('trash') + '</button>'
      : '<button type="button" class="tk-ib tk-star' + (t.starred ? ' on' : '') + '" data-act="star" title="' + (t.starred ? '별표 해제' : '별표') + '" aria-label="' + (t.starred ? '별표 해제' : '별표') + '" aria-pressed="' + !!t.starred + '">' + ico('star') + '</button>';
    var main = '<span class="t-title">' + esc(t.title) + '</span>' + (meta.length ? '<span class="tk-meta">' + meta.join('') + '</span>' : '');
    return '<div class="taskrow tk-row' + (sub ? ' tk-sub' : '') + (t.done ? ' done' : '') + (open ? ' tk-open' : '') + '" data-id="' + id + '">' +
      '<input type="checkbox" data-act="toggle" aria-label="' + (t.done ? '완료 취소' : '완료') + '"' + (t.done ? ' checked' : '') + ' />' +
      (t.done ? '<div class="tk-main">' + main + '</div>' : '<button type="button" class="tk-main" data-act="open" aria-expanded="' + open + '">' + main + '</button>') +
      owner + taskSrcHtml(t.source) + tail + '</div>' + (open ? detailHtml(t) : '');
  }

  function detailHtml(t) {
    var sub = !!t.parent_id;
    var id = escAttr(t.id);
    var lists = S.lists.filter(function (l) { return (l.owner_id || null) === (t.owner_id || null); });
    var movable = S.sort === 'myorder';
    var h = '<div class="tk-detail' + (t.indent === 1 ? ' tk-sub' : '') + '" data-id="' + id + '">' +
      '<input type="text" data-f="title" maxlength="200" value="' + escAttr(t.title) + '" aria-label="제목" />' +
      '<textarea data-f="details" maxlength="2000" placeholder="세부정보 추가" aria-label="세부정보">' + esc(t.details || '') + '</textarea>' +
      '<div class="tk-line">' +
        '<button type="button" class="secondary" data-act="due-today">오늘</button>' +
        '<button type="button" class="secondary" data-act="due-tomorrow">내일</button>' +
        '<input type="date" class="tk-in" data-f="due_date" value="' + escAttr(t.due_date || '') + '" aria-label="날짜" />' +
        '<select class="tk-in" data-f="due_time" aria-label="시간"' + (t.due_date ? '' : ' disabled title="날짜를 먼저 정하세요"') + '>' + timeOptions(t.due_time || '', '시간 없음') + '</select>' +
        (t.due_date ? '<button type="button" class="tk-ib" data-act="due-clear" title="날짜 지우기" aria-label="날짜 지우기">' + ico('x') + '</button>' : '') +
        (sub ? '' : '<button type="button" class="secondary" data-act="repeat">' + ico('repeat') + esc(t.repeat_rule ? repeatLabel(t.repeat_rule) : '반복') + '</button>') +
      '</div>' +
      '<div class="tk-line">' +
        (sub
          ? '<button type="button" class="secondary" data-act="unindent" title="하위 작업을 최상위 할 일로 되돌립니다">' + ico('outdent') + '최상위 할 일로</button>'
          : '<button type="button" class="secondary" data-act="sub-open">' + ico('plus') + '하위 작업 추가</button>') +
        (lists.length > 1 ? '<label>목록 <select class="tk-in" data-f="list_id" aria-label="목록 이동">' + lists.map(function (l) { return '<option value="' + escAttr(l.id) + '"' + (l.id === t.list_id ? ' selected' : '') + '>' + esc(l.title) + '</option>'; }).join('') + '</select></label>' : '') +
        '<span class="tk-grow"></span>' +
        (movable ? '<button type="button" class="tk-ib" data-act="move-up" title="위로" aria-label="위로">' + ico('up') + '</button><button type="button" class="tk-ib" data-act="move-down" title="아래로" aria-label="아래로">' + ico('down') + '</button>' : '') +
        '<button type="button" class="tk-ib tk-del" data-act="delete" title="삭제" aria-label="삭제">' + ico('trash') + '</button>' +
      '</div>';
    if (!sub && S.subFor === t.id) {
      h += '<div class="tk-line"><input type="text" class="tk-grow" data-f="newsub" maxlength="200" placeholder="하위 작업을 입력하세요" aria-label="하위 작업 제목" />' +
        '<button type="button" class="secondary" data-act="sub-save">추가</button></div>';
    }
    return h + '</div>';
  }

  // ---- 저장 ----
  function isTmp(id) { return typeof id === 'string' && id.indexOf('tmp_') === 0; }
  function realId(id) { return S.ids[id] || id; }

  // 서버 요청 줄. 화면은 이미 바뀌어 있으므로 요청은 누른 순서대로 하나씩 보낸다 (같은 칸을 연달아 바꿔도 마지막 값이 남고,
  // 방금 만든 임시 줄을 고쳐도 만들기가 끝난 뒤 서버 id로 나간다).
  // done(j, rid, last): 응답 처리. last = 이 할 일에 걸린 변경 중 마지막 응답인가. true를 돌려주면 변경이 다 끝난 뒤 목록을 다시 읽는다.
  // 항상 응답 객체로 끝난다 (실패도 { ok: false, error }).
  function send(id, method, body, done) {
    S.pend++; S.mut++;
    if (id) S.busy[id] = (S.busy[id] || 0) + 1;
    var p = S.chain.then(async function () {
      var rid = id ? realId(id) : null, j = null;
      if (body && body.parent_id && S.ids[body.parent_id]) body = Object.assign({}, body, { parent_id: S.ids[body.parent_id] });
      var orphan = isTmp(rid) || !!(body && isTmp(body.parent_id)); // 만들기가 실패한 임시 줄에 걸린 변경 — 보낼 곳이 없다
      if (orphan) j = { ok: false, error: '저장되지 않은 할 일입니다' };
      else {
        try { j = await api('/api/tasks' + (rid ? '/' + encodeURIComponent(rid) : ''), body === undefined ? { method: method } : { method: method, body: JSON.stringify(body) }); }
        catch (e) { j = null; }
        if (!j || typeof j !== 'object') j = { ok: false, error: '서버에 연결하지 못했습니다' };
      }
      var last = true;
      if (id) { S.busy[id]--; last = !S.busy[id]; if (last) delete S.busy[id]; }
      var again = true;
      if (!orphan || !id) { try { again = done ? !!done(j, rid, last) : false; } catch (e) { again = true; } }
      S.pend--; S.mut++;
      if (again) S.dirty = true;
      if (!S.pend && S.dirty) { S.dirty = false; loadTasks(); }
      return j;
    });
    S.chain = p;
    return p;
  }

  // 서버 PATCH 와 같은 규칙으로 화면 값을 먼저 만든다 (날짜를 지우면 시간·반복도 지워진다 등).
  function applyLocal(t, b) {
    var n = Object.assign({}, t), now = Date.now();
    if (b.title !== undefined) n.title = b.title;
    if (b.details !== undefined) n.details = b.details || null;
    if (b.starred !== undefined && !!b.starred !== !!t.starred) { n.starred = b.starred ? 1 : 0; n.starred_at = b.starred ? new Date(now).toISOString() : null; }
    if (b.due_date !== undefined) n.due_date = b.due_date || null;
    if (b.due_time !== undefined) n.due_time = b.due_time || null;
    if (b.repeat_rule !== undefined) n.repeat_rule = b.repeat_rule;
    if (!n.due_date) { n.due_time = null; n.repeat_rule = null; }
    if (b.parent_id === null && t.parent_id) { n.parent_id = null; n.position = -now; } // 최상위 맨 위로
    if (b.list_id !== undefined && b.list_id !== n.list_id) {
      n.list_id = b.list_id;
      if (n.parent_id) { n.parent_id = null; n.position = -now; } // 하위 작업을 다른 목록으로 옮기면 그 목록의 최상위 할 일이 된다
    }
    if (b.position !== undefined && n.position === t.position) n.position = b.position;
    return n;
  }

  // 되돌리기: 바꾸기 전 객체를 id 기준으로 다시 넣는다 (그 사이 다른 변경이 건드린 줄은 그대로 둔다).
  function restore(prev) {
    prev.forEach(function (p) {
      var id = realId(p.id), pid = p.parent_id ? realId(p.parent_id) : p.parent_id;
      if (id !== p.id || pid !== p.parent_id) p = Object.assign({}, p, { id: id, parent_id: pid });
      var i = S.tasks.findIndex(function (x) { return x.id === p.id; });
      if (i >= 0) S.tasks[i] = p; else S.tasks.push(p);
    });
    reflow();
  }
  // 서버가 돌려준 할 일로 확정한다.
  function put(task) {
    var i = S.tasks.findIndex(function (x) { return x.id === task.id; });
    if (i >= 0) S.tasks[i] = Object.assign({}, task);
  }
  // 제목·메모: 상세 칸을 다시 그리지 않고(다음에 누른 칸의 포커스를 지킨다) 행만 갱신한다.
  function softRow(id) {
    S.html.taskList = null; // 행만 바꿨으므로 다음 render 는 무조건 다시 그린다
    var t = taskById(id);
    var row = document.querySelector('#tab-tasks .tk-row[data-id="' + CSS.escape(id) + '"]');
    if (!t || !row) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = rowHtml(t);
    row.replaceWith(tmp.firstChild);
  }
  function show(id, soft, fromServer) {
    reflow();
    if (soft && taskById(id)) softRow(id); else render(fromServer);
  }

  // 필드 변경: 화면에 먼저 반영하고 PATCH 는 뒤에서 보낸다. 실패하면 되돌리고 알린 뒤 다시 읽는다.
  function patch(id, body, soft) {
    var t = taskById(id);
    if (!t) return Promise.resolve(null);
    var n = applyLocal(t, body), prev = [t];
    var moved = n.list_id !== t.list_id && !t.parent_id; // 부모를 다른 목록으로 옮기면 하위 작업도 따라간다
    S.tasks = S.tasks.map(function (x) {
      if (x.id === id) return n;
      if (moved && x.parent_id === id) { prev.push(x); return Object.assign({}, x, { list_id: n.list_id }); }
      return x;
    });
    show(id, soft);
    return send(id, 'PATCH', body, function (j, rid, last) {
      if (!j.ok) {
        restore(prev); render();
        uiToast('저장하지 못했습니다: ' + (j.error || ''), true);
        return true;
      }
      if (j.task && last && taskById(rid)) { put(j.task); show(rid, soft, true); }
      return !soft; // 제목·메모는 다시 읽지 않는다 (입력 중인 칸을 건드리지 않는다)
    }).then(function (j) { return j.ok ? j : null; });
  }

  // 완료 토글: 체크 즉시 옮긴다. 부모를 완료하면 하위 작업도 함께, 취소는 그 할 일만 (서버와 같은 비대칭).
  // 반복 할 일의 다음 회차는 서버가 만든다 — 응답 뒤 다시 읽어 넣는다.
  function toggle(id) {
    var t = taskById(id);
    if (!t) return;
    var done = !t.done, nowIso = new Date().toISOString(), prev = [];
    S.tasks = S.tasks.map(function (x) {
      if (x.id === id || (done && !t.parent_id && x.parent_id === id && !x.done)) {
        prev.push(x);
        if (S.open === x.id) S.open = null;
        return Object.assign({}, x, { done: done ? 1 : 0, done_at: done ? nowIso : null });
      }
      return x;
    });
    reflow(); render();
    send(id, 'PATCH', { done: done }, function (j) {
      if (!j.ok) {
        restore(prev); render();
        uiToast('완료 처리를 하지 못했습니다: ' + (j.error || ''), true);
        return true;
      }
      if (j.done) {
        if (j.completed > 1) uiToast('할 일 ' + j.completed + '개를 완료했습니다.');
        if (j.next) uiToast('반복 할 일의 다음 회차를 만들었습니다.');
      }
      loadHome();
      return true;
    });
  }

  async function remove(id) {
    var kids = S.tasks.filter(function (t) { return t.parent_id === id; }).length;
    if (kids && !(await uiConfirm('하위 작업 ' + kids + '개도 함께 삭제됩니다.', { title: '할 일을 삭제할까요?', okText: '삭제', danger: true }))) return;
    id = realId(id); // 확인을 기다리는 사이 임시 줄이 서버 id로 바뀌었을 수 있다
    var prev = [];
    S.tasks = S.tasks.filter(function (x) {
      if (x.id !== id && x.parent_id !== id) return true;
      prev.push(x);
      return false;
    });
    if (!prev.length) return;
    reflow(); render();
    send(id, 'DELETE', undefined, function (j) {
      if (!j.ok) {
        restore(prev); render();
        uiToast('삭제하지 못했습니다: ' + (j.error || ''), true);
        return true;
      }
      loadHome();
      return true;
    });
  }

  // 위·아래로 옮기기 (내 순서): 같은 단계의 이웃 바로 앞·뒤 값을 준다. 순서 값은 ms 단위 시각이라 사이가 비어 있다.
  function move(id, dir) {
    var t = taskById(id);
    if (!t) return;
    var sib = S.tasks.filter(function (x) { return !x.done && x.indent === t.indent && (t.indent === 0 || x.parent_id === t.parent_id); });
    var i = sib.findIndex(function (x) { return x.id === id; });
    var nb = sib[i + dir];
    if (!nb) return;
    patch(id, { position: nb.position + dir });
  }

  function addTask() {
    var inp = $('newTaskTitle');
    var title = inp.value.trim();
    if (!title) return;
    var body = { title: title };
    var l = curList();
    if (S.mode === 'starred') body.starred = true;
    if (isAdminUser()) {
      // 관리자는 담당자를 직접 골라 그 사용자의 할 일로 만든다 (본인 계정에 쌓지 않는다). 목록을 골라 둔 상태면 그 목록의 소유자가 담당자다.
      if (l && l.owner_id) { body.ownerId = l.owner_id; body.list_id = l.id; }
      else {
        var owner = $('newTaskOwner').value;
        if (!owner) { alert('새 할 일 담당자를 선택하세요.'); return; }
        body.ownerId = owner;
      }
    } else if (l && l.owner_id) body.list_id = l.id; // "미지정 할 일" 목록을 보고 있을 때는 내 기본 목록에 만든다
    // 서버를 기다리지 않고 임시 줄을 바로 보여 준다 (새 할 일은 "내 순서"의 맨 위다). 담당자·목록은 서버가 정할 값을 미리 맞춘다.
    var mine = S.lists.find(function (x) { return x.is_default && x.owner_id && (!body.ownerId || x.owner_id === body.ownerId); }) || null;
    var ownerId = body.ownerId || (mine ? mine.owner_id : myId());
    var named = S.lists.find(function (x) { return x.owner_id === ownerId; });
    var tmp = tempTask({
      title: title.slice(0, 200), owner_id: ownerId, owner_name: named ? named.owner_name : '…',
      list_id: body.list_id || (mine ? mine.id : null), starred: body.starred ? 1 : 0, position: -Date.now(),
    });
    S.tasks.unshift(tmp);
    reflow(); render();
    clearInput(inp, title);
    create(tmp, body, function (j) {
      uiToast('할 일을 만들지 못했습니다: ' + (j.error || ''), true);
      if (!inp.value) inp.value = title; // 쓴 글자를 잃지 않게 돌려놓는다
    });
  }

  function myId() {
    try { return currentUser ? currentUser.id : null; } catch (e) { return null; } // index.html 본문의 로그인 사용자
  }
  function tempTask(o) {
    var now = new Date().toISOString();
    return Object.assign({
      id: 'tmp_' + Date.now().toString(36) + '_' + (++S.tmpN), title: '', source: null, done: 0, created_at: now, done_at: null,
      owner_id: null, owner_name: '', list_id: null, details: null, due_date: null, due_time: null,
      starred: 0, starred_at: o.starred ? now : null, repeat_rule: null, repeat_group: null, parent_id: null, position: 0, indent: 0,
    }, o);
  }
  // 입력칸 비우기. 한글 조합 중에 Enter 를 누르면 브라우저가 조합을 끝내며 마지막 글자를 다시 넣으므로, 조합이 끝난 뒤 한 번 더 비운다.
  function clearInput(inp, title) {
    var ev = g.event;
    if (ev && ev.isComposing && inp.addEventListener) {
      inp.addEventListener('compositionend', function () {
        setTimeout(function () {
          var v = inp.value.trim();
          if (v && title.slice(-v.length) === v) inp.value = '';
        }, 0);
      }, { once: true });
    }
    inp.value = '';
  }
  // 만들기: POST 가 끝나면 임시 줄의 id 를 서버 id 로 바꾼다. 실패하면 임시 줄을 뺀다.
  function create(tmp, body, onFail) {
    send(null, 'POST', body, function (j) {
      if (!j.ok || !j.id) {
        S.tasks = S.tasks.filter(function (x) { return x.id !== tmp.id && x.parent_id !== tmp.id; });
        reflow(); render();
        onFail(j);
        return true;
      }
      S.ids[tmp.id] = j.id;
      var waiting = !!S.busy[tmp.id]; // 임시 줄을 이미 고쳤다 — 그 값은 뒤따르는 요청이 확정한다
      S.tasks = S.tasks.map(function (x) {
        if (x.id === tmp.id) {
          var real = waiting ? Object.assign({}, x, { id: j.id }) : Object.assign({}, x, j);
          delete real.ok;
          return real;
        }
        return x.parent_id === tmp.id ? Object.assign({}, x, { parent_id: j.id }) : x;
      });
      if (S.open === tmp.id) S.open = j.id;
      if (S.subFor === tmp.id) S.subFor = j.id;
      if (S.focus === tmp.id) S.focus = j.id;
      reflow(); render(); // 줄은 제자리다 (id 만 바뀐다) — 클릭 잠금 없이 그린다
      loadHome();
      return true;
    });
  }

  function addSub(parentId, input) {
    var title = (input && input.value || '').trim();
    if (!title) { S.subFor = null; render(); return; } // 빈 초안은 버린다
    var p = taskById(parentId);
    if (!p) return;
    var tmp = tempTask({ title: title.slice(0, 200), owner_id: p.owner_id, owner_name: p.owner_name, list_id: p.list_id, parent_id: parentId, position: Date.now(), indent: 1 });
    S.tasks.push(tmp); // 하위 작업 맨 아래
    input.value = '';
    reflow(); render();
    var next = document.querySelector('#tab-tasks .tk-detail [data-f="newsub"]'); // 이어서 입력
    if (next) { next.value = ''; next.focus(); }
    create(tmp, { title: title, parent_id: parentId }, function (j) {
      uiToast('하위 작업을 만들지 못했습니다: ' + (j.error || ''), true);
    });
  }

  // ---- 대화상자 (ui-dialog.js 의 .ui-dlg 모양을 쓴다) ----
  // opts: { title, body(html), okText, extra: { text, onClick }, onOpen(box), onOk(box) → true(닫기) | 오류 문자열 }
  function modal(opts) {
    var back = document.createElement('div');
    back.className = 'ui-dlg-back';
    var box = document.createElement('div');
    box.className = 'ui-dlg';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', opts.title);
    box.innerHTML = '<h3 class="ui-dlg-title"></h3><div class="tk-dlg">' + opts.body + '<div class="tk-err" role="alert"></div></div>' +
      '<div class="ui-dlg-btns">' + (opts.extra ? '<button type="button" class="secondary tk-left" data-m="extra"></button>' : '') +
      '<button type="button" class="secondary" data-m="cancel">취소</button><button type="button" class="primary" data-m="ok"></button></div>';
    box.querySelector('.ui-dlg-title').textContent = opts.title;
    box.querySelector('[data-m="ok"]').textContent = opts.okText || '완료';
    if (opts.extra) box.querySelector('[data-m="extra"]').textContent = opts.extra.text;
    back.appendChild(box);
    var prev = document.activeElement;
    function close() {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      try { if (prev && prev.focus) prev.focus(); } catch (x) { /* 무시 */ }
    }
    async function ok() {
      var r = await opts.onOk(box);
      if (r === true) close();
      else box.querySelector('.tk-err').textContent = r || '';
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'Enter' && ev.target && ev.target.tagName === 'INPUT' && ev.target.type === 'text') { ev.preventDefault(); ok(); }
    }
    box.querySelector('[data-m="cancel"]').onclick = close;
    box.querySelector('[data-m="ok"]').onclick = ok;
    if (opts.extra) box.querySelector('[data-m="extra"]').onclick = async function () { if ((await opts.extra.onClick(box)) !== false) close(); };
    back.addEventListener('mousedown', function (ev) { if (ev.target === back) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    if (opts.onOpen) opts.onOpen(box);
    var first = box.querySelector('input,select');
    if (first) { first.focus(); if (first.select) first.select(); }
  }

  function listDialog(existing) {
    modal({
      title: existing ? '목록 이름 변경' : '새 목록 만들기',
      okText: existing ? '저장' : '만들기',
      body: '<div class="tk-line"><input type="text" id="tkListTitle" maxlength="100" placeholder="목록 이름" aria-label="목록 이름" value="' + escAttr(existing ? existing.title : '') + '" /></div>',
      onOk: async function (box) {
        var title = box.querySelector('#tkListTitle').value.trim();
        if (!title) return '목록 이름을 입력하세요.';
        var j;
        if (existing) j = await api('/api/task-lists/' + encodeURIComponent(existing.id), { method: 'PATCH', body: JSON.stringify({ title: title }) });
        else {
          var body = { title: title };
          if (isAdminUser()) {
            // 관리자는 누구의 목록인지 정해야 한다: 사용자 필터에서 고른 사용자, 없으면 새 할 일 담당자.
            var f = $('taskOwnerFilter').value;
            var owner = f && f !== 'unassigned' ? f : $('newTaskOwner').value;
            if (!owner) return '사용자 필터나 새 할 일 담당자에서 목록을 가질 사용자를 먼저 선택하세요.';
            body.ownerId = owner;
          }
          j = await api('/api/task-lists', { method: 'POST', body: JSON.stringify(body) });
        }
        if (!j.ok) return j.error || '저장하지 못했습니다.';
        if (!existing) { S.mode = 'list'; S.listId = j.id; }
        loadTasks();
        return true;
      },
    });
  }

  async function deleteList(l) {
    var ok = await uiConfirm('"' + l.title + '" 목록을 삭제합니다. 이 목록의 할 일은 기본 목록으로 옮겨집니다.', { title: '목록을 삭제할까요?', okText: '삭제', danger: true });
    if (!ok) return;
    var j = await api('/api/task-lists/' + encodeURIComponent(l.id), { method: 'DELETE' });
    if (!j.ok) { uiToast('목록을 삭제하지 못했습니다: ' + (j.error || ''), true); return; }
    S.mode = 'all'; S.listId = '';
    if (j.moved) uiToast('할 일 ' + j.moved + '개를 기본 목록으로 옮겼습니다.');
    loadTasks();
  }

  // 반복 설정 (Google Tasks의 사용자 지정 반복과 같은 항목)
  function repeatDialog(t) {
    var r = t.repeat_rule || null;
    var start = t.due_date || today();
    var dom = domOf(start), dow = dowOf(start);
    var st = {
      weekdays: r && r.weekdays ? r.weekdays.slice() : [dow],
      monthMode: r && r.nth !== undefined && r.nth !== null ? 'nth' : 'day',
    };
    var unit = r ? r.unit : 'week';
    var day = r && r.day ? r.day : dom;
    var nth = r && r.nth ? r.nth : (Math.ceil(dom / 7) > 4 ? 'last' : Math.ceil(dom / 7));
    var weekday = r && typeof r.weekday === 'number' ? r.weekday : dow;
    var ends = r ? r.ends : 'never';
    var opt = function (v, label, cur) { return '<option value="' + v + '"' + (String(v) === String(cur) ? ' selected' : '') + '>' + label + '</option>'; };
    var dayOpts = '';
    for (var d = 1; d <= 31; d++) dayOpts += opt(d, d + '일', day);
    dayOpts += opt('last', '마지막 날', day);
    var body =
      '<div class="tk-line"><span class="tk-lbl">반복 주기</span><input type="number" class="tk-in" id="tkREvery" min="1" max="100" value="' + (r ? r.every : 1) + '" aria-label="반복 간격" />' +
        '<select class="tk-in" id="tkRUnit" aria-label="반복 단위">' + opt('day', '일', unit) + opt('week', '주', unit) + opt('month', '개월', unit) + opt('year', '년', unit) + '</select><span>마다</span></div>' +
      '<div class="tk-line" id="tkRWeek"><span class="tk-lbl">요일</span><div class="tk-wd" role="group" aria-label="반복 요일">' +
        WD.map(function (w, i) { return '<button type="button" data-wd="' + i + '" aria-pressed="false">' + w + '</button>'; }).join('') + '</div></div>' +
      '<div class="tk-opts" id="tkRMonth">' +
        '<div class="tk-line"><span class="tk-lbl"></span><label class="tk-radio"><input type="radio" name="tkRMonthMode" value="day" /> 매월</label><select class="tk-in" id="tkRDay" aria-label="날짜">' + dayOpts + '</select></div>' +
        '<div class="tk-line"><span class="tk-lbl"></span><label class="tk-radio"><input type="radio" name="tkRMonthMode" value="nth" /> 매월</label><select class="tk-in" id="tkRNth" aria-label="몇째 주">' +
          [1, 2, 3, 4, 'last'].map(function (n) { return opt(n, NTH[n], nth); }).join('') + '</select><select class="tk-in" id="tkRWeekday" aria-label="요일">' +
          WD.map(function (w, i) { return opt(i, w + '요일', weekday); }).join('') + '</select></div>' +
      '</div>' +
      '<div class="tk-line"><span class="tk-lbl">시작</span><input type="date" class="tk-in" id="tkRStart" value="' + escAttr(start) + '" aria-label="시작 날짜" />' +
        '<select class="tk-in" id="tkRTime" aria-label="시간">' + timeOptions(t.due_time || '', '시간 없음') + '</select></div>' +
      '<div class="tk-opts">' +
        '<div class="tk-line"><span class="tk-lbl">종료</span><label class="tk-radio"><input type="radio" name="tkREnds" value="never" /> 없음</label></div>' +
        '<div class="tk-line"><span class="tk-lbl"></span><label class="tk-radio"><input type="radio" name="tkREnds" value="on" /> 날짜</label><input type="date" class="tk-in" id="tkRUntil" value="' + escAttr(r && r.until ? r.until : addDays(start, 30)) + '" aria-label="종료 날짜" /></div>' +
        '<div class="tk-line"><span class="tk-lbl"></span><label class="tk-radio"><input type="radio" name="tkREnds" value="after" /></label><input type="number" class="tk-in" id="tkRCount" min="1" max="1000" value="' + (r && r.occurrences ? r.occurrences : 30) + '" aria-label="반복 횟수" /><span>회 반복 후</span></div>' +
      '</div>';
    modal({
      title: '반복',
      body: body,
      extra: r ? { text: '반복 안 함', onClick: async function () { await patch(t.id, { repeat_rule: null }); } } : null,
      onOpen: function (box) {
        var sync = function () {
          var u = box.querySelector('#tkRUnit').value;
          box.querySelector('#tkRWeek').style.display = u === 'week' ? '' : 'none';
          box.querySelector('#tkRMonth').style.display = u === 'month' ? '' : 'none';
          box.querySelectorAll('[data-wd]').forEach(function (b) {
            var on = st.weekdays.indexOf(+b.dataset.wd) >= 0;
            b.classList.toggle('on', on);
            b.setAttribute('aria-pressed', String(on));
          });
        };
        box.querySelector('#tkRUnit').onchange = sync;
        box.querySelectorAll('[data-wd]').forEach(function (b) {
          b.onclick = function () {
            var n = +b.dataset.wd, i = st.weekdays.indexOf(n);
            if (i >= 0) { if (st.weekdays.length > 1) st.weekdays.splice(i, 1); } // 요일은 하나 이상
            else st.weekdays.push(n);
            sync();
          };
        });
        box.querySelector('input[name="tkRMonthMode"][value="' + st.monthMode + '"]').checked = true;
        box.querySelector('input[name="tkREnds"][value="' + ends + '"]').checked = true;
        box.querySelector('#tkRUntil').onfocus = function () { box.querySelector('input[name="tkREnds"][value="on"]').checked = true; };
        box.querySelector('#tkRCount').onfocus = function () { box.querySelector('input[name="tkREnds"][value="after"]').checked = true; };
        sync();
      },
      onOk: async function (box) {
        var val = function (sel) { return box.querySelector(sel).value; };
        var every = Number(val('#tkREvery'));
        if (!Number.isInteger(every) || every < 1 || every > 100) return '반복 간격은 1~100 사이여야 합니다.';
        var s = val('#tkRStart');
        if (!s) return '시작 날짜를 정하세요.';
        var u = val('#tkRUnit');
        var rule = { every: every, unit: u };
        if (u === 'week') rule.weekdays = st.weekdays.slice().sort();
        if (u === 'month') {
          if (box.querySelector('input[name="tkRMonthMode"]:checked').value === 'nth') {
            rule.nth = val('#tkRNth') === 'last' ? 'last' : Number(val('#tkRNth'));
            rule.weekday = Number(val('#tkRWeekday'));
          } else rule.day = val('#tkRDay') === 'last' ? 'last' : Number(val('#tkRDay'));
        }
        rule.ends = box.querySelector('input[name="tkREnds"]:checked').value;
        if (rule.ends === 'on') {
          rule.until = val('#tkRUntil');
          if (!rule.until) return '종료 날짜를 정하세요.';
          if (rule.until < s) return '종료 날짜는 시작 날짜보다 빠를 수 없습니다.';
        }
        if (rule.ends === 'after') {
          rule.occurrences = Number(val('#tkRCount'));
          if (!Number.isInteger(rule.occurrences) || rule.occurrences < 1 || rule.occurrences > 1000) return '반복 횟수는 1~1000 사이여야 합니다.';
        }
        // 서버가 규칙을 검증하므로 대화상자는 응답을 기다린다 (틀리면 여기에 오류를 보여 준다). 요청은 다른 변경과 같은 줄로 보낸다.
        var j = await send(t.id, 'PATCH', { due_date: s, due_time: val('#tkRTime') || null, repeat_rule: rule }, function (j, rid, last) {
          if (j.ok && j.task && last && taskById(rid)) { put(j.task); reflow(); render(true); }
          return j.ok;
        });
        if (!j.ok) return j.error || '저장하지 못했습니다.';
        return true;
      },
    });
  }

  // 보기 전환. 전체 보기에서 목록·별표로 갈 때는 가진 할 일에서 먼저 걸러 바로 보여 주고, 뒤에서 다시 읽는다.
  function setMode(mode, listId) {
    var full = S.mode === 'all';
    S.mode = mode; S.listId = listId; S.open = null;
    if (full && mode !== 'all') { reflow(); render(); }
    loadTasks();
  }

  // ---- 이벤트 (위임) ----
  function onClick(ev) {
    var el = ev.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return; // 체크박스는 change에서
    var act = el.dataset.act;
    var host = el.closest('[data-id]');
    var id = host ? host.dataset.id : null;
    var t = id ? taskById(id) : null;
    if (act === 'mode-all') setMode('all', '');
    else if (act === 'mode-starred') setMode('starred', '');
    else if (act === 'mode-list') setMode('list', el.dataset.list);
    else if (act === 'list-new') listDialog(null);
    else if (act === 'list-rename') { if (curList()) listDialog(curList()); }
    else if (act === 'list-delete') { if (curList()) deleteList(curList()); }
    else if (!t) return;
    else if (act === 'open') { S.open = S.open === id ? null : id; S.subFor = null; render(); }
    else if (act === 'star') patch(id, { starred: !t.starred });
    else if (act === 'delete') remove(id);
    else if (act === 'due-today') patch(id, { due_date: today() });
    else if (act === 'due-tomorrow') patch(id, { due_date: addDays(today(), 1) });
    else if (act === 'due-clear') patch(id, { due_date: null });
    else if (act === 'repeat') repeatDialog(t);
    else if (act === 'unindent') patch(id, { parent_id: null });
    else if (act === 'move-up') move(id, -1);
    else if (act === 'move-down') move(id, 1);
    else if (act === 'sub-open') {
      S.subFor = id; render();
      var inp = document.querySelector('#tab-tasks .tk-detail [data-f="newsub"]');
      if (inp) inp.focus();
    }
    else if (act === 'sub-save') addSub(id, host.querySelector('[data-f="newsub"]'));
  }

  function onChange(ev) {
    var el = ev.target;
    var host = el.closest('[data-id]');
    if (!host) return;
    var id = host.dataset.id, t = taskById(id);
    if (!t) return;
    if (el.dataset.act === 'toggle') { toggle(id); return; }
    var f = el.dataset.f;
    if (f === 'title') {
      var v = el.value.trim();
      if (!v) { el.value = t.title; return; } // 빈 제목은 받지 않는다 — 원래 제목으로 되돌린다
      if (v !== t.title) patch(id, { title: v }, true);
    }
    else if (f === 'details') { if ((el.value || '') !== (t.details || '')) patch(id, { details: el.value }, true); }
    else if (f === 'due_date') patch(id, { due_date: el.value || null });
    else if (f === 'due_time') patch(id, { due_time: el.value || null });
    else if (f === 'list_id') patch(id, { list_id: el.value });
  }

  function onKey(ev) {
    if (ev.key !== 'Enter' || ev.isComposing) return; // 한글 조합 중 Enter는 넘긴다
    var el = ev.target;
    if (el.dataset && el.dataset.f === 'title') { ev.preventDefault(); el.blur(); }
    else if (el.dataset && el.dataset.f === 'newsub') { ev.preventDefault(); addSub(el.closest('[data-id]').dataset.id, el); }
  }

  function bind() {
    if (S.bound) return;
    S.bound = true;
    var tab = $('tab-tasks');
    tab.addEventListener('click', onClick);
    tab.addEventListener('change', function (ev) {
      if (ev.target.id === 'taskSort') { S.sort = ev.target.value; reflow(); render(); loadTasks(); return; } // 가진 목록으로 먼저 정렬해 보여 준다
      onChange(ev);
    });
    // 다시 그리며 되살린 칸은 change 가 오지 않을 수 있다 — 칸을 벗어날 때도 저장한다 (값이 같으면 아무 일도 없다).
    tab.addEventListener('focusout', function (ev) {
      if (S.rendering) return;
      var f = ev.target && ev.target.dataset ? ev.target.dataset.f : '';
      if (f === 'title' || f === 'details') onChange(ev);
    });
    tab.addEventListener('keydown', onKey);
    $('taskDoneBox').addEventListener('toggle', function () { S.doneOpen = $('taskDoneBox').open; });
  }

  g.loadTasks = loadTasks;
  g.addTask = addTask;
  g.openTaskDetail = openTaskDetail;
})(typeof window !== 'undefined' ? window : globalThis);
