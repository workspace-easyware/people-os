// 채팅 UI DO-1b + DO-1d (2026-11-18) — 1:1 채팅 + 그룹채팅 + 방 목록. 마운트 지점: #chatMount. 빌드 없음, 바닐라 JS.
// 플로팅 웹챗 (2026-11-18): #chatMount는 우하단 FAB가 여는 오버레이 패널(#chatPanel) 안에 있다 — 파일 끝 "플로팅 웹챗 위젯" 참고.
// index.html 인라인 스크립트의 전역(currentUser)을 쓴다. 보안: 서버·사용자 데이터는 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// API(1:1): GET /api/chat/rooms · GET|POST /api/chat/dm/:userId/messages · WS /api/chat/dm/:userId/ws · 사용자 검색 GET /api/approval/users?q=
// API(그룹, DO-1c): POST /groups · GET|POST /groups/:id/members · DELETE /groups/:id/members/:userId · GET|POST /groups/:id/messages · WS /groups/:id/ws · POST /rooms/:id/read
// 대화창은 DM과 그룹이 같은 컴포넌트다 — 다른 것은 API 경로(convBase)와 그룹 전용 멤버 패널·읽음 확인뿐이다.
(function () {
  'use strict';
  var MAX_BODY = 4000;
  var MAX_NAME = 100;
  var PAGE = 50;
  var RECONNECT_MS = 3000;
  var READ_DEBOUNCE_MS = 2000;
  var MSG_MANAGER_ONLY = '방 생성자 또는 관리자만 할 수 있습니다.';
  // presence·읽음·반응 (2026-11-18): 반응 이모지 6개 (서버 REACTION_EMOJIS와 같은 순서)
  var EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  var EMOJI_LABEL = { '👍': '좋아요', '❤️': '하트', '😂': '웃음', '😮': '놀람', '😢': '슬픔', '🙏': '감사' };

  var S = null; // 화면 상태 (chatOpen이 만든다)
  // 접속 중인 사용자 (로비 WebSocket이 채운다 — 파일 끝 "로비" 참고). 패널을 닫아도 유지된다.
  var P = { online: {} };
  function isOnline(id) { return !!(id && P.online[id]); }
  function presenceDot(id, label) {
    var on = isOnline(id);
    var d = h('span', { cls: 'chat-dot', title: '접속 중', 'aria-label': (label ? label + ' ' : '') + '접속 중' });
    d.hidden = !on;
    return d;
  }

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'text') e.textContent = props[k];
      else if (k === 'cls') e.className = props[k];
      else if (k.slice(0, 2) === 'on') e[k] = props[k];
      else e.setAttribute(k, props[k]);
    }
    for (var i = 2; i < arguments.length; i++) { var kid = arguments[i]; if (kid != null) e.append(kid); }
    return e;
  }
  function clear(e) { e.textContent = ''; }
  function meId() { return typeof currentUser !== 'undefined' && currentUser ? currentUser.id : ''; }
  function isAdmin() { return typeof currentUser !== 'undefined' && !!currentUser && currentUser.role === 'hr_admin'; }
  function ask(msg) { return typeof confirm === 'function' ? confirm(msg) : true; }

  async function getJson(path, opts) {
    var r = await fetch(path, opts);
    var j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, ok: r.ok, body: j };
  }
  function jsonOpts(method, obj) { return { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}) }; }
  function errText(r, fallback) {
    if (r && r.status === 403) return MSG_MANAGER_ONLY;
    return (r && r.body && typeof r.body.error === 'string' && r.body.error) || fallback;
  }

  // ---------- 시각 ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(iso) { // 메시지 시각: 오늘이면 HH:mm, 아니면 M/D HH:mm
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var n = new Date();
    return d.toDateString() === n.toDateString() ? t : (d.getMonth() + 1) + '/' + d.getDate() + ' ' + t;
  }
  function fmtRoomTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var n = new Date();
    return d.toDateString() === n.toDateString() ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : (d.getMonth() + 1) + '/' + d.getDate();
  }
  function roleLabel(r) { return r === 'coach' ? '코치' : '코칭 대상'; }

  // ---------- 현재 방 (DM 또는 그룹) ----------
  function cur() { return S.peer || S.group; }
  function convBase() {
    return S.group ? '/api/chat/groups/' + encodeURIComponent(S.group.id) : '/api/chat/dm/' + encodeURIComponent(S.peer.id);
  }
  function dmRoomId(peerId) { var a = meId(), b = peerId; return 'chat:dm:' + (a < b ? a + ':' + b : b + ':' + a); }
  function curRoomId() { return S.group ? S.group.id : dmRoomId(S.peer.id); }

  // ---------- 알림 문구 ----------
  function note(text, kind, retryFn) {
    if (!S) return;
    clear(S.note);
    S.note.className = 'chat-note' + (kind ? ' ' + kind : '');
    S.note.hidden = !text;
    if (!text) return;
    S.note.append(h('span', { text: text }));
    if (retryFn) S.note.append(h('button', { type: 'button', cls: 'secondary chat-retry', id: 'chatRetryBtn', text: '다시 시도', onclick: retryFn }));
  }
  function setNote(el, text, kind) { // 패널용 간단 문구 (재시도 버튼 없음)
    clear(el);
    el.className = 'chat-note' + (kind ? ' ' + kind : '');
    el.hidden = !text;
    if (text) el.append(h('span', { text: text }));
  }

  // ---------- 방 목록 ----------
  async function loadRooms() {
    var s = S;
    try {
      var r = await getJson('/api/chat/rooms');
      if (S !== s) return;
      if (!r.ok || !r.body || !Array.isArray(r.body.rooms)) throw new Error('rooms');
      s.rooms = r.body.rooms;
      s.roomsFailed = false;
    } catch (e) {
      if (S !== s) return;
      s.roomsFailed = true;
    }
    renderRooms();
  }

  function renderRooms() {
    var list = S.list;
    clear(list);
    if (!S.roomsFailed) paintFab(sumUnread(S.rooms)); // 플로팅 버튼 배지도 같은 방 목록 값으로 맞춘다
    if (S.roomsFailed) { list.append(h('p', { cls: 'chat-empty err', text: '대화 목록을 불러오지 못했습니다.' })); return; }
    if (!S.rooms.length) { list.append(h('p', { cls: 'chat-empty', text: '아직 대화가 없습니다. "새 대화"로 시작하거나 "그룹 만들기"를 눌러 보세요.' })); return; }
    S.rooms.forEach(function (room) {
      var isDm = room.type === 'dm' && room.peer;
      var title = isDm ? (room.peer.name || room.peer.email || '(이름 없음)') : (room.name || '(이름 없는 그룹)');
      var selected = isDm ? !!(S.peer && S.peer.id === room.peer.id) : !!(S.group && S.group.id === room.id);
      var badge;
      var unread = Number(room.unread) || 0; // 2026-11-18부터 DM도 센다
      var openNow = selected && S.viewing; // 지금 보고 있는 방은 배지를 안 띄운다
      if (unread > 0 && !openNow) badge = h('span', { cls: 'chat-badge', 'aria-label': '안 읽은 메시지 ' + unread + '개', text: unread > 99 ? '99+' : String(unread) });
      else badge = h('span', { cls: 'chat-badge', hidden: 'hidden', text: '' });
      var btn = h('button', { type: 'button', cls: 'chat-room' + (selected ? ' sel' : '') + (isDm ? '' : ' group') },
        h('span', { cls: 'chat-room-top' },
          h('span', { cls: 'chat-room-name' }, isDm ? presenceDot(room.peer.id, title) : null, h('span', { text: title })),
          h('span', { cls: 'chat-room-time', text: room.updated_at ? fmtRoomTime(room.updated_at) : '대화 시작 전' })),
        h('span', { cls: 'chat-room-sub' },
          h('span', { cls: 'chat-room-role', text: isDm ? roleLabel(room.peer.coaching_role) : '그룹' }),
          badge));
      if (isDm) btn.onclick = function () { openPeer({ id: room.peer.id, name: title, coaching_role: room.peer.coaching_role }); };
      else btn.onclick = function () { openGroup({ id: room.id, name: room.name || '(이름 없는 그룹)' }); };
      list.append(h('div', { cls: 'chat-room-row' }, btn));
    });
  }

  function findRoom(id) {
    for (var i = 0; i < S.rooms.length; i++) if (S.rooms[i].id === id) return S.rooms[i];
    return null;
  }
  // 그룹에 새 메시지가 왔을 때 목록에서만 맨 위로 올린다 (서버 재조회 없이). 목록에 없으면 재조회.
  function touchGroupRoom(id, whenIso, bumpUnread) {
    var row = findRoom(id);
    if (!row) { loadRooms(); return; }
    if (whenIso) row.updated_at = whenIso;
    if (bumpUnread) row.unread = (Number(row.unread) || 0) + 1;
    S.rooms.splice(S.rooms.indexOf(row), 1);
    S.rooms.unshift(row);
    renderRooms();
  }

  // ---------- 사용자 검색 (새 대화·그룹 만들기·멤버 추가 공용) ----------
  function toggleSearch(show) {
    S.search.hidden = !show;
    if (show) { S.groupForm.hidden = true; S.searchInput.value = ''; runSearch(''); }
  }
  async function userSearch(q, box, seqKey, onPick, excluded) {
    var s = S;
    var seq = ++s[seqKey];
    try {
      var r = await getJson('/api/approval/users?q=' + encodeURIComponent(q));
      if (S !== s || seq !== s[seqKey]) return;
      if (!r.ok || !r.body || !Array.isArray(r.body.users)) throw new Error('users');
      clear(box);
      var me = meId();
      var skip = excluded ? excluded() : [];
      var users = r.body.users.filter(function (u) { return u.id !== me && skip.indexOf(u.id) < 0; });
      if (!users.length) { box.append(h('p', { cls: 'chat-empty', text: '검색 결과가 없습니다.' })); return; }
      users.forEach(function (u) {
        var name = u.name || u.email;
        box.append(h('button', { type: 'button', cls: 'chat-user', onclick: function () { onPick(u, name); } },
          h('span', { cls: 'chat-user-name', text: name }),
          h('span', { cls: 'chat-user-role', text: roleLabel(u.coaching_role) }),
          h('span', { cls: 'chat-user-sub', text: [u.email, u.department_name].filter(Boolean).join(' · ') })));
      });
    } catch (e) {
      if (S !== s || seq !== s[seqKey]) return;
      clear(box);
      box.append(h('p', { cls: 'chat-empty err', text: '사용자를 검색하지 못했습니다.' }));
    }
  }
  function runSearch(q) {
    var s = S;
    return userSearch(q, s.searchResults, 'searchSeq', function (u, name) { s.search.hidden = true; openPeer({ id: u.id, name: name, coaching_role: u.coaching_role }); });
  }

  // ---------- 그룹 만들기 ----------
  function toggleGroupForm(show) {
    S.groupForm.hidden = !show;
    if (show) {
      S.search.hidden = true;
      S.gName.value = ''; S.gSel = []; setNote(S.gNote, '');
      renderGroupSel(); S.gSearchInput.value = ''; runGroupSearch('');
      if (S.gName.focus) S.gName.focus();
    }
  }
  function runGroupSearch(q) {
    var s = S;
    return userSearch(q, s.gResults, 'gSearchSeq', function (u, name) {
      s.gSel.push({ id: u.id, name: name, email: u.email, coaching_role: u.coaching_role });
      renderGroupSel(); runGroupSearch(s.gSearchInput.value.trim());
    }, function () { return s.gSel.map(function (x) { return x.id; }); });
  }
  function renderGroupSel() {
    var box = S.gSelBox, s = S;
    clear(box);
    box.append(h('div', { cls: 'chat-gsel-item me', text: '나 (자동 포함)' }));
    s.gSel.forEach(function (u) {
      box.append(h('div', { cls: 'chat-gsel-item' },
        h('span', { text: u.name }),
        h('button', { type: 'button', cls: 'secondary chat-gsel-x', 'aria-label': u.name + ' 빼기', text: '×', onclick: function () {
          s.gSel = s.gSel.filter(function (x) { return x.id !== u.id; });
          renderGroupSel(); runGroupSearch(s.gSearchInput.value.trim());
        } })));
    });
  }
  async function createGroup() {
    var s = S;
    if (s.gBusy) return;
    var name = s.gName.value.trim(); // 비면 서버가 멤버 이름으로 자동 지정한다
    if (name.length > MAX_NAME) { setNote(s.gNote, '그룹 이름은 ' + MAX_NAME + '자까지 입니다 (현재 ' + name.length + '자).', 'warn'); return; }
    if (!s.gSel.length) { setNote(s.gNote, '멤버를 1명 이상 선택해 주세요.', 'warn'); return; }
    s.gBusy = true; s.gCreateBtn.disabled = true;
    setNote(s.gNote, '');
    try {
      var r = await getJson('/api/chat/groups', jsonOpts('POST', name ? { name: name, member_ids: s.gSel.map(function (u) { return u.id; }) } : { member_ids: s.gSel.map(function (u) { return u.id; }) }));
      if (!r.ok || !r.body || !r.body.room || !r.body.room.id) { if (S === s) setNote(s.gNote, errText(r, '그룹을 만들지 못했습니다. 다시 시도해 주세요.'), 'err'); return; }
      if (S !== s) return;
      var room = r.body.room;
      s.rooms = s.rooms.filter(function (x) { return x.id !== room.id; });
      s.rooms.unshift({ id: room.id, type: 'group', name: room.name, updated_at: room.updated_at, unread: 0 });
      s.roomsFailed = false;
      s.groupForm.hidden = true;
      openGroup({ id: room.id, name: room.name }, { members: room.members, creator_id: room.creator_id });
    } catch (e) {
      if (S === s) setNote(s.gNote, '그룹을 만들지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.', 'err');
    } finally {
      s.gBusy = false; s.gCreateBtn.disabled = false;
    }
  }

  // ---------- 대화창 (DM · 그룹 공용) ----------
  function resetConv() {
    closeWs();
    S.msgs = [];
    S.hasMore = false;
    S.loadingMore = false;
    S.retried = false;
    S.wsOpened = false;
    S.token++;
    S.viewing = true;
    S.readGen++; S.readPending = false; S.readInflight = null;
    S.reads = {}; S.pickerSeq = null; S.reactBusy = {};
    S.members = []; S.creatorId = null; S.membersOpen = false; S.addOpen = false; S.transfer = null;
    S.mpanel.hidden = true;
    S.root.className = 'chat-root show-pane';
    S.empty.hidden = true;
    S.conv.hidden = false;
    S.input.value = '';
    note('');
  }

  // ---------- 그룹 이름 변경 (머리글 인라인 편집) ----------
  function pencilIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    ['width', '16', 'height', '16', 'viewBox', '0 0 24 24', 'fill', 'none', 'stroke', 'currentColor', 'stroke-width', '2', 'stroke-linecap', 'round', 'stroke-linejoin', 'round', 'aria-hidden', 'true']
      .forEach(function (v, i, a) { if (i % 2 === 0) svg.setAttribute(v, a[i + 1]); });
    var p1 = document.createElementNS(NS, 'path');
    p1.setAttribute('d', 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z');
    var p2 = document.createElementNS(NS, 'path');
    p2.setAttribute('d', 'm15 5 4 4');
    svg.append(p1, p2);
    return svg;
  }
  function startRename() {
    if (!S || !S.group || S.renaming) return;
    S.renaming = true;
    S.renameInput.value = S.group.name || '';
    S.peerName.hidden = true; S.renameBtn.hidden = true; S.renameForm.hidden = false;
    if (S.renameInput.focus) S.renameInput.focus();
  }
  function cancelRename() {
    if (!S) return;
    S.renaming = false;
    S.renameForm.hidden = true; S.peerName.hidden = false;
    if (S.group) S.renameBtn.hidden = false;
  }
  async function saveRename() {
    var s = S;
    if (!s || !s.group || s.renameBusy) return;
    var name = s.renameInput.value.trim();
    if (!name) { note('그룹 이름을 입력해 주세요.', 'warn'); return; }
    if (name.length > MAX_NAME) { note('그룹 이름은 ' + MAX_NAME + '자까지 입니다 (현재 ' + name.length + '자).', 'warn'); return; }
    if (name === s.group.name) { cancelRename(); return; }
    var gid = s.group.id;
    s.renameBusy = true; s.renameSave.disabled = true;
    try {
      var r = await getJson('/api/chat/groups/' + encodeURIComponent(gid), jsonOpts('PATCH', { name: name }));
      if (S !== s) return;
      if (!r.ok || !r.body || !r.body.room) { note(errText(r, '이름을 바꾸지 못했습니다. 다시 시도해 주세요.'), 'err'); return; }
      var nn = r.body.room.name;
      s.rooms.forEach(function (x) { if (x.id === gid) { x.name = nn; if (r.body.room.updated_at) x.updated_at = r.body.room.updated_at; } });
      if (s.group && s.group.id === gid) { s.group.name = nn; s.peerName.textContent = nn; cancelRename(); }
      note('');
      renderRooms();
    } catch (e) {
      if (S === s) note('이름을 바꾸지 못했습니다. 네트워크를 확인하고 다시 시도해 주세요.', 'err');
    } finally {
      s.renameBusy = false; s.renameSave.disabled = false;
    }
  }

  function openPeer(peer) {
    resetConv();
    S.peer = peer;
    S.group = null;
    S.peerName.textContent = peer.name;
    cancelRename();
    S.renameBtn.hidden = true;
    S.peerRole.textContent = peer.coaching_role ? roleLabel(peer.coaching_role) : '';
    S.membersBtn.hidden = true;
    paintHeadPresence();
    renderMsgs();
    renderRooms();
    loadHistory();
    connectWs();
    if (S.input.focus) S.input.focus();
  }

  function openGroup(g, known) {
    resetConv();
    S.group = { id: g.id, name: g.name };
    S.peer = null;
    S.peerName.textContent = g.name;
    cancelRename();
    S.renameBtn.hidden = false;
    S.peerRole.textContent = '';
    S.membersBtn.hidden = false;
    S.membersBtn.textContent = '멤버';
    S.members = []; // 아래 loadMembers가 채운다
    if (known && Array.isArray(known.members)) applyMembers(known.members, known.creator_id);
    S.toggleGroupFormHide();
    paintHeadPresence();
    renderMsgs();
    renderRooms();
    loadHistory();
    connectWs();
    if (!known) loadMembers();
    if (S.input.focus) S.input.focus();
  }

  // ---------- 접속 표시 (머리글) ----------
  // DM: 상대 이름 옆 녹색 점. 그룹: 이름 옆 "N명 접속 중" (나 제외). 멤버별 점은 멤버 패널에 있다.
  function paintHeadPresence() {
    if (!S || !S.peerDot) return;
    if (S.peer) {
      S.peerDot.hidden = !isOnline(S.peer.id);
      S.onlineCount.hidden = true;
    } else if (S.group) {
      S.peerDot.hidden = true;
      var me = meId(), n = 0;
      S.members.forEach(function (m) { if (m.id !== me && isOnline(m.id)) n++; });
      S.onlineCount.textContent = n > 0 ? n + '명 접속 중' : '';
      S.onlineCount.hidden = !(n > 0);
    } else { S.peerDot.hidden = true; S.onlineCount.hidden = true; }
  }

  // ---------- 읽음 표시 ----------
  // 내 메시지 옆 숫자 = 이 메시지를 아직 안 읽은 사람 수 (나 제외). 1:1이면 "1" → 상대가 읽으면 사라진다.
  // 읽은 위치는 메시지 조회 응답의 reads + 방 WebSocket {type:'read'} 이벤트로 갱신한다.
  function readers() {
    var me = meId();
    if (S.peer) return [S.peer.id];
    var ids = S.members.length ? S.members.map(function (m) { return m.id; }) : Object.keys(S.reads);
    return ids.filter(function (id) { return id !== me; });
  }
  function unreadBy(seq) {
    var n = 0;
    readers().forEach(function (id) { if ((S.reads[id] || 0) < seq) n++; });
    return n;
  }
  function applyReads(list) {
    if (!Array.isArray(list)) return;
    list.forEach(function (r) {
      if (!r || typeof r.user_id !== 'string') return;
      var v = Number(r.last_read_seq) || 0;
      if (v > (S.reads[r.user_id] || 0)) S.reads[r.user_id] = v;
    });
  }

  // ---------- 반응 ----------
  function smileIcon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    ['width', '14', 'height', '14', 'viewBox', '0 0 24 24', 'fill', 'none', 'stroke', 'currentColor', 'stroke-width', '2', 'stroke-linecap', 'round', 'stroke-linejoin', 'round', 'aria-hidden', 'true']
      .forEach(function (v, i, a) { if (i % 2 === 0) svg.setAttribute(v, a[i + 1]); });
    var c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '10');
    var p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M8 14s1.5 2 4 2 4-2 4-2');
    var l1 = document.createElementNS(NS, 'line'); l1.setAttribute('x1', '9'); l1.setAttribute('y1', '9'); l1.setAttribute('x2', '9.01'); l1.setAttribute('y2', '9');
    var l2 = document.createElementNS(NS, 'line'); l2.setAttribute('x1', '15'); l2.setAttribute('y1', '9'); l2.setAttribute('x2', '15.01'); l2.setAttribute('y2', '9');
    svg.append(c, p, l1, l2);
    return svg;
  }
  function nameOf(id) {
    if (id === meId()) return '나';
    if (S.peer && S.peer.id === id) return S.peer.name;
    for (var i = 0; i < S.members.length; i++) if (S.members[i].id === id) return S.members[i].name || S.members[i].email || '';
    return '';
  }
  function setReactions(seq, list) {
    for (var i = 0; i < S.msgs.length; i++) if (S.msgs[i].seq === seq) { S.msgs[i].reactions = Array.isArray(list) ? list : []; return true; }
    return false;
  }
  async function toggleReaction(seq, emoji) {
    var s = S, tok = s.token, key = seq + emoji;
    if (!cur() || s.reactBusy[key]) return;
    s.reactBusy[key] = true;
    s.pickerSeq = null;
    try {
      var r = await getJson('/api/chat/rooms/' + encodeURIComponent(curRoomId()) + '/messages/' + seq + '/reactions', jsonOpts('POST', { emoji: emoji }));
      if (S !== s || s.token !== tok) return;
      if (!r.ok || !r.body || !Array.isArray(r.body.reactions)) { note(errText(r, '반응을 남기지 못했습니다. 다시 시도해 주세요.'), 'err'); renderMsgs('stay'); return; }
      setReactions(seq, r.body.reactions);
      renderMsgs('stay');
    } catch (e) {
      if (S === s && s.token === tok) note('반응을 남기지 못했습니다. 네트워크를 확인해 주세요.', 'err');
    } finally {
      s.reactBusy[key] = false;
    }
  }
  function renderReactions(m, mine) {
    var me = meId();
    var bar = h('div', { cls: 'chat-reacts' + (mine ? ' mine' : '') });
    (m.reactions || []).forEach(function (rx) {
      if (!rx || !rx.count) return;
      var ids = Array.isArray(rx.user_ids) ? rx.user_ids : [];
      var minePressed = ids.indexOf(me) >= 0;
      var who = ids.map(nameOf).filter(Boolean).join(', ');
      bar.append(h('button', {
        type: 'button', cls: 'chat-react-pill' + (minePressed ? ' on' : ''), 'aria-pressed': minePressed ? 'true' : 'false',
        'aria-label': (EMOJI_LABEL[rx.emoji] || rx.emoji) + ' ' + rx.count + '명' + (minePressed ? ' (내 반응, 누르면 취소)' : ''),
        title: who, onclick: function () { toggleReaction(m.seq, rx.emoji); },
      }, h('span', { cls: 'chat-react-emoji', text: rx.emoji }), h('span', { cls: 'chat-react-count', text: String(rx.count) })));
    });
    bar.hidden = !bar.childNodes.length;
    return bar;
  }
  function renderPicker(m) {
    var box = h('div', { cls: 'chat-react-picker', role: 'menu', 'aria-label': '반응 고르기' });
    EMOJIS.forEach(function (e) {
      box.append(h('button', { type: 'button', role: 'menuitem', cls: 'chat-react-opt', 'aria-label': EMOJI_LABEL[e], title: EMOJI_LABEL[e], text: e, onclick: function () { toggleReaction(m.seq, e); } }));
    });
    return box;
  }

  // mode: true = 위쪽에 이전 메시지를 붙였다(아래 기준 위치 유지), 'stay' = 스크롤 위치 그대로(읽음·반응 갱신), 그 외 = 맨 아래로
  function renderMsgs(mode) {
    var box = S.msgBox;
    var prevH = box.scrollHeight || 0, prevTop = box.scrollTop || 0;
    var atBottom = prevH - prevTop - (box.clientHeight || 0) < 40;
    clear(box);
    if (S.hasMore) box.append(h('p', { cls: 'chat-more', text: '위로 스크롤하면 이전 메시지를 더 불러옵니다.' }));
    if (!S.msgs.length) box.append(h('p', { cls: 'chat-empty', id: 'chatNoMsgs', text: '메시지가 없습니다. 첫 메시지를 보내 보세요.' }));
    var me = meId();
    S.msgs.forEach(function (m) {
      var mine = m.sender_id === me;
      var bubble = h('div', { cls: 'chat-msg ' + (mine ? 'mine' : 'theirs'), 'data-seq': String(m.seq) },
        h('div', { cls: 'chat-msg-meta' }, h('b', { text: m.sender_name || '' }), h('span', { text: ' ' + fmtTime(m.created_at) })),
        h('div', { cls: 'chat-msg-body', text: m.body }));
      var addBtn = h('button', { type: 'button', cls: 'chat-react-add' + (S.pickerSeq === m.seq ? ' on' : ''), 'aria-label': '반응 남기기', title: '반응 남기기', 'aria-expanded': S.pickerSeq === m.seq ? 'true' : 'false',
        onclick: function () { S.pickerSeq = S.pickerSeq === m.seq ? null : m.seq; renderMsgs('stay'); } }, smileIcon());
      var line = h('div', { cls: 'chat-line' });
      if (mine) {
        var n = unreadBy(m.seq);
        var rd = h('span', { cls: 'chat-read', 'aria-label': n > 0 ? '안 읽은 사람 ' + n + '명' : '', text: n > 0 ? String(n) : '' });
        rd.hidden = !(n > 0);
        line.append(addBtn, rd, bubble);
      } else line.append(bubble, addBtn);
      box.append(h('div', { cls: 'chat-item ' + (mine ? 'mine' : 'theirs') },
        line,
        S.pickerSeq === m.seq ? renderPicker(m) : null,
        renderReactions(m, mine)));
    });
    if (mode === true) box.scrollTop = (box.scrollHeight || 0) - prevH;
    else if (mode === 'stay' && !atBottom) box.scrollTop = prevTop;
    else box.scrollTop = box.scrollHeight || 0;
  }

  function addMsg(m) { // seq 중복 없이 시간순으로 추가
    if (!m || typeof m.seq !== 'number') return false;
    if (S.msgs.some(function (x) { return x.seq === m.seq; })) return false;
    S.msgs.push(m);
    S.msgs.sort(function (a, b) { return a.seq - b.seq; });
    return true;
  }

  async function loadHistory(merge) {
    var s = S, tok = s.token, base = convBase();
    try {
      var r = await getJson(base + '/messages?limit=' + PAGE);
      if (S !== s || s.token !== tok) return;
      if (!r.ok || !r.body || !Array.isArray(r.body.messages)) throw new Error('history');
      var before = s.msgs.length;
      r.body.messages.forEach(function (m) { if (!addMsg(m) && Array.isArray(m.reactions)) setReactions(m.seq, m.reactions); });
      applyReads(r.body.reads);
      if (!merge) s.hasMore = r.body.messages.length >= PAGE;
      renderMsgs(merge && s.msgs.length === before ? 'stay' : undefined);
      if (!merge) markRead(); // 방을 열었다 = 최신까지 읽음 (seq 없이)
    } catch (e) {
      if (S !== s || s.token !== tok) return;
      note('대화 내용을 불러오지 못했습니다.', 'err', function () { note(''); loadHistory(merge); });
    }
  }

  async function loadMore() {
    var s = S, tok = s.token;
    if (s.loadingMore || !s.hasMore || !s.msgs.length) return;
    s.loadingMore = true;
    try {
      var r = await getJson(convBase() + '/messages?limit=' + PAGE + '&before=' + s.msgs[0].seq);
      if (S !== s || s.token !== tok) return;
      if (!r.ok || !r.body || !Array.isArray(r.body.messages)) throw new Error('more');
      r.body.messages.forEach(addMsg);
      applyReads(r.body.reads);
      s.hasMore = r.body.messages.length >= PAGE;
      renderMsgs(true);
    } catch (e) {
      if (S === s && s.token === tok) note('이전 메시지를 불러오지 못했습니다.', 'err');
    } finally {
      s.loadingMore = false;
    }
  }

  // ---------- 읽음 확인 ----------
  // 실패해도 대화는 계속된다 (console.error만). DM 방은 첫 메시지 전에는 D1 행이 없어 404 — 정상이라 조용히 넘긴다.
  function markRead() {
    var s = S;
    if (!s || !cur()) return Promise.resolve();
    var id = curRoomId(), isGroup = !!s.group;
    s.readPending = false;
    var p = (async function () {
      try {
        var r = await getJson('/api/chat/rooms/' + encodeURIComponent(id) + '/read', jsonOpts('POST', {}));
        if (!r.ok) { if (!(r.status === 404 && !isGroup)) console.error('chat read failed', r.status); return; }
        if (S !== s) return;
        var row = findRoom(id);
        if (row && row.unread) { row.unread = 0; renderRooms(); }
      } catch (e) { console.error('chat read failed', e); }
    })();
    s.readInflight = p;
    return p;
  }
  // 방(DM·그룹)을 보는 동안 메시지가 오면: 2초 안에 여러 번 와도 마지막 한 번만 읽음 확인 (디바운스).
  // 브라우저 탭이 가려져 있으면 읽은 게 아니므로 보류하고, 다시 보일 때(visibilitychange) 확인한다.
  function pageHidden() { return typeof document !== 'undefined' && !!document.hidden; }
  function scheduleRead() {
    var s = S, gen = ++s.readGen, tok = s.token;
    s.readPending = true;
    setTimeout(function () { if (S === s && s.token === tok && s.readGen === gen && s.readPending && cur() && !pageHidden()) markRead(); }, READ_DEBOUNCE_MS);
  }
  async function flushRead() {
    if (S.readPending) { S.readGen++; await markRead(); }
    else if (S.readInflight) await S.readInflight;
  }

  // ---------- WebSocket ----------
  function closeWs() {
    if (!S) return;
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
    var ws = S.ws;
    S.ws = null;
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null; try { ws.close(1000, 'bye'); } catch (e) { /* 이미 닫힘 */ } }
  }

  function connectWs() {
    var s = S, tok = s.token, base = convBase(), groupId = s.group ? s.group.id : null;
    if (typeof WebSocket === 'undefined') { note('실시간 연결을 쓸 수 없습니다. 보내기는 되지만 새 메시지는 새로고침해야 보입니다.', 'warn'); return; }
    var ws;
    try {
      var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + base + '/ws');
    } catch (e) { onDrop(); return; }
    s.ws = ws;
    ws.onopen = function () {
      if (S !== s || s.token !== tok) return;
      var wasRetry = s.retried;
      s.wsOpened = true; s.retried = false;
      note('');
      if (wasRetry) loadHistory(true); // 끊긴 사이 온 메시지를 REST로 보충
    };
    ws.onmessage = function (ev) {
      if (S !== s || s.token !== tok) return;
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m) return;
      if (m.type === 'read') { // 다른 멤버가 읽음 → 내 메시지 옆 숫자 갱신
        if (typeof m.user_id === 'string' && m.user_id !== meId()) { applyReads([m]); renderMsgs('stay'); }
        return;
      }
      if (m.type === 'reaction') {
        if (typeof m.seq === 'number' && setReactions(m.seq, m.reactions)) renderMsgs('stay');
        return;
      }
      if (m.type !== 'message') return;
      if (m.sender_id === meId()) return; // 내가 보낸 것은 REST 응답으로 이미 넣었다 (에코 중복 방지)
      if (addMsg({ seq: m.seq, sender_id: m.sender_id, sender_name: m.sender_name, body: m.body, created_at: m.created_at, reactions: [] })) {
        // 보낸 사람은 자기 메시지까지 읽은 것 (서버 규칙과 같다) — 그 사람의 이전 메시지 숫자가 바로 맞는다
        applyReads([{ user_id: m.sender_id, last_read_seq: m.seq }]);
        renderMsgs();
        if (s.viewing) scheduleRead(); // DM·그룹 모두: 보고 있으면 읽음 확인 → 상대 화면의 "1"이 사라진다
        if (groupId) touchGroupRoom(groupId, m.created_at, !s.viewing); // 보고 있지 않은 방: 화면에서만 배지 +1 (다음 목록 로딩 때 서버 값으로 맞춘다)
        else loadRooms(); // 상대가 처음 보낸 방이면 목록에 생긴다
      }
    };
    ws.onerror = function () { /* onclose가 이어서 온다 */ };
    ws.onclose = function () {
      if (S !== s || s.token !== tok || s.ws !== ws) return;
      s.ws = null;
      onDrop();
    };
    function onDrop() {
      if (S !== s || s.token !== tok) return;
      if (!s.retried) {
        s.retried = true;
        s.reconnectTimer = setTimeout(function () { s.reconnectTimer = null; if (S === s && s.token === tok) connectWs(); }, RECONNECT_MS);
      } else {
        note(s.wsOpened ? '연결이 끊겼습니다. 새로고침해 주세요.' : '실시간 연결이 안 됩니다. 메시지는 보낼 수 있지만 상대의 새 메시지는 새로고침해야 보입니다.', 'warn');
      }
    }
  }

  // ---------- 보내기 ----------
  async function send(textOverride) {
    var s = S;
    if (!cur() || s.sending) return;
    var text = typeof textOverride === 'string' ? textOverride : s.input.value;
    if (!text.trim()) { note('메시지를 입력해 주세요.', 'warn'); return; }
    if (text.length > MAX_BODY) { note('메시지는 ' + MAX_BODY + '자까지 보낼 수 있습니다 (현재 ' + text.length + '자).', 'warn'); return; }
    s.sending = true;
    s.sendBtn.disabled = true;
    var tok = s.token;
    try {
      var r = await getJson(convBase() + '/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text }),
      });
      if (!r.ok || !r.body || !r.body.message) throw new Error('send ' + r.status);
      if (S === s && s.token === tok) {
        if (s.input.value === text || typeof textOverride === 'string') s.input.value = '';
        note('');
        var sent = r.body.message;
        if (!Array.isArray(sent.reactions)) sent.reactions = [];
        if (addMsg(sent)) renderMsgs();
        if (s.viewing) scheduleRead(); // 내가 보낸 것 포함 — 보고 있는 동안은 읽음 확인 (디바운스)
      }
      loadRooms(); // 첫 메시지면 목록에 방이 생기고, 아니면 순서·시각이 갱신된다
    } catch (e) {
      if (S === s && s.token === tok) note('보내지 못했습니다. 다시 시도해 주세요.', 'err', function () { send(text); });
    } finally {
      s.sending = false;
      s.sendBtn.disabled = false;
    }
  }

  // ---------- 그룹 멤버 패널 ----------
  function canManage() { return isAdmin() || (!!S.creatorId && S.creatorId === meId()); }
  function applyMembers(members, creatorId) {
    S.members = members.slice();
    S.creatorId = creatorId || (members.filter(function (m) { return m.is_creator; })[0] || {}).id || null;
    S.membersBtn.textContent = '멤버 ' + S.members.length + '명';
    paintHeadPresence();
    if (S.membersOpen) renderMembers();
    if (S.msgs.length) renderMsgs('stay'); // 읽음 숫자는 멤버 수 기준이라 다시 그린다
  }
  async function loadMembers() {
    var s = S, tok = s.token, g = s.group;
    if (!g) return;
    try {
      var r = await getJson('/api/chat/groups/' + encodeURIComponent(g.id) + '/members');
      if (S !== s || s.token !== tok) return;
      if (!r.ok || !r.body || !Array.isArray(r.body.members)) throw new Error('members');
      applyMembers(r.body.members, r.body.creator_id);
    } catch (e) {
      if (S !== s || s.token !== tok) return;
      setNote(s.mNote, '멤버 목록을 불러오지 못했습니다.', 'err');
    }
  }
  function toggleMembers() {
    S.membersOpen = !S.membersOpen;
    S.mpanel.hidden = !S.membersOpen;
    if (S.membersOpen) { S.addOpen = false; S.transfer = null; setNote(S.mNote, ''); renderMembers(); loadMembers(); }
  }
  function renderMembers() {
    var s = S, box = s.mList, me = meId(), manage = canManage();
    clear(box);
    s.mTitle.textContent = '멤버 ' + s.members.length + '명';
    s.mAddBtn.hidden = !manage;
    s.mAdd.hidden = !manage || !s.addOpen;
    s.members.forEach(function (m) {
      var isMe = m.id === me;
      var actions = null;
      if (isMe) actions = h('button', { type: 'button', cls: 'secondary chat-member-leave', text: '나가기', onclick: function () { memberAction(m); } });
      else if (manage) actions = h('button', { type: 'button', cls: 'secondary chat-member-remove', text: '제거', onclick: function () { memberAction(m); } });
      box.append(h('div', { cls: 'chat-member' },
        h('span', { cls: 'chat-member-main' },
          isMe ? null : presenceDot(m.id, m.name || m.email),
          h('span', { cls: 'chat-member-name', text: (m.name || m.email || '(이름 없음)') + (isMe ? ' (나)' : '') }),
          m.is_creator ? h('span', { cls: 'chat-member-tag', text: '생성자' }) : null,
          h('span', { cls: 'chat-member-role', text: roleLabel(m.coaching_role) })),
        h('span', { cls: 'chat-member-email', text: m.email || '' }),
        actions));
    });
    if (s.members.length === 1 && s.members[0].is_creator && s.members[0].id === me) {
      box.append(h('p', { cls: 'chat-empty', text: '멤버가 본인뿐입니다. 나가면 이 방은 삭제됩니다.' }));
    }
    renderTransfer();
  }

  // 생성자를 내보낼 때(나가기 포함) 새 생성자를 먼저 고르게 한다 (transfer_to)
  function renderTransfer() {
    var s = S, box = s.mTransfer;
    clear(box);
    box.hidden = !s.transfer;
    if (!s.transfer) return;
    var t = s.transfer;
    var sel = h('select', { id: 'chatTransferSelect', 'aria-label': '새 방 생성자' });
    sel.append(h('option', { value: '', text: '새 생성자를 선택하세요' }));
    s.members.filter(function (m) { return m.id !== t.member.id; }).forEach(function (m) {
      sel.append(h('option', { value: m.id, text: (m.name || m.email) + (m.email ? ' (' + m.email + ')' : '') }));
    });
    box.append(
      h('p', { text: t.isMe ? '생성자는 나가기 전에 방을 맡을 멤버를 정해야 합니다.' : '이 멤버는 방 생성자입니다. 내보내기 전에 새 생성자를 정해야 합니다.' }),
      sel,
      h('button', { type: 'button', cls: 'primary', id: 'chatTransferConfirm', text: t.isMe ? '넘기고 나가기' : '넘기고 제거', onclick: function () {
        var to = sel.value;
        if (!to) { setNote(s.mNote, '넘길 멤버를 선택해 주세요.', 'warn'); return; }
        var target = s.members.filter(function (m) { return m.id === to; })[0];
        var who = target ? (target.name || target.email) : '선택한 멤버';
        var msg = t.isMe ? '방 생성자를 ' + who + '님에게 넘기고 이 그룹에서 나갈까요?' : (t.member.name || t.member.email) + '님을 제거하고 방 생성자를 ' + who + '님에게 넘길까요?';
        if (!ask(msg)) return;
        removeMember(t.member, to);
      } }),
      h('button', { type: 'button', cls: 'secondary', id: 'chatTransferCancel', text: '취소', onclick: function () { s.transfer = null; setNote(s.mNote, ''); renderTransfer(); } }));
  }

  function memberAction(m) {
    var s = S, isMe = m.id === meId();
    setNote(s.mNote, '');
    var others = s.members.filter(function (x) { return x.id !== m.id; });
    if (m.is_creator && others.length) { s.transfer = { member: m, isMe: isMe }; renderTransfer(); return; }
    var msg;
    if (isMe) msg = m.is_creator ? '이 방에는 다른 멤버가 없습니다. 나가면 방이 삭제됩니다. 나갈까요?' : '"' + s.group.name + '" 그룹에서 나갈까요?';
    else msg = (m.name || m.email) + '님을 이 그룹에서 제거할까요?';
    if (!ask(msg)) return;
    removeMember(m, null);
  }

  async function removeMember(m, transferTo) {
    var s = S, tok = s.token, g = s.group, isMe = m.id === meId();
    if (!g || s.mBusy) return;
    s.mBusy = true;
    try {
      var r = await getJson('/api/chat/groups/' + encodeURIComponent(g.id) + '/members/' + encodeURIComponent(m.id), jsonOpts('DELETE', transferTo ? { transfer_to: transferTo } : {}));
      if (S !== s || s.token !== tok) return;
      if (!r.ok) { setNote(s.mNote, errText(r, '처리하지 못했습니다. 다시 시도해 주세요.'), 'err'); return; }
      s.transfer = null;
      if (isMe || (r.body && r.body.room_deleted)) { leaveGroupView(g.id); return; }
      setNote(s.mNote, (m.name || m.email) + '님을 제거했습니다.', '');
      s.members = s.members.filter(function (x) { return x.id !== m.id; });
      if (r.body && r.body.creator_id) {
        s.creatorId = r.body.creator_id;
        s.members.forEach(function (x) { x.is_creator = x.id === s.creatorId; });
      }
      applyMembers(s.members, s.creatorId);
      renderMembers();
      loadMembers(); // 서버 기준으로 다시 맞춘다
    } catch (e) {
      if (S === s && s.token === tok) setNote(s.mNote, '처리하지 못했습니다. 네트워크를 확인해 주세요.', 'err');
    } finally {
      s.mBusy = false;
    }
  }

  // 방에서 나갔거나 방이 삭제됨 — 대화창을 닫고 목록을 다시 불러온다
  function leaveGroupView(roomId) {
    var s = S;
    closeWs();
    s.token++;
    s.group = null; s.peer = null; s.msgs = [];
    s.membersOpen = false; s.mpanel.hidden = true;
    s.rooms = s.rooms.filter(function (x) { return x.id !== roomId; });
    s.conv.hidden = true; s.empty.hidden = false;
    s.root.className = 'chat-root';
    renderRooms();
    loadRooms();
  }

  async function addMember(u, name) {
    var s = S, tok = s.token, g = s.group;
    if (!g || s.mBusy) return;
    s.mBusy = true;
    try {
      var r = await getJson('/api/chat/groups/' + encodeURIComponent(g.id) + '/members', jsonOpts('POST', { user_id: u.id }));
      if (S !== s || s.token !== tok) return;
      if (!r.ok) { setNote(s.mNote, errText(r, '멤버를 추가하지 못했습니다. 다시 시도해 주세요.'), 'err'); return; }
      if (r.body && r.body.already_member) setNote(s.mNote, name + '님은 이미 멤버입니다.', 'warn');
      else {
        setNote(s.mNote, name + '님을 추가했습니다.', '');
        if (r.body && r.body.member && !s.members.some(function (x) { return x.id === u.id; })) { s.members.push(r.body.member); applyMembers(s.members, s.creatorId); }
        loadMembers();
      }
      s.mSearchInput.value = '';
      renderMembers();
      runMemberSearch('');
    } catch (e) {
      if (S === s && s.token === tok) setNote(s.mNote, '멤버를 추가하지 못했습니다. 네트워크를 확인해 주세요.', 'err');
    } finally {
      s.mBusy = false;
    }
  }
  function runMemberSearch(q) {
    var s = S;
    return userSearch(q, s.mResults, 'mSearchSeq', addMember, function () { return s.members.map(function (x) { return x.id; }); });
  }

  // ---------- 마운트 ----------
  function chatOpen(mount) {
    if (!mount) return;
    chatLeave();
    clear(mount);
    var st = {
      token: 0, rooms: [], roomsFailed: false, peer: null, group: null, msgs: [], hasMore: false, loadingMore: false,
      ws: null, retried: false, wsOpened: false, reconnectTimer: null, sending: false, searchSeq: 0, searchTimer: null,
      viewing: false, readGen: 0, readPending: false, readInflight: null,
      members: [], creatorId: null, membersOpen: false, addOpen: false, transfer: null, mBusy: false, mSearchSeq: 0, mSearchTimer: null,
      gSel: [], gBusy: false, gSearchSeq: 0, gSearchTimer: null,
    };
    // -- 새 대화 검색
    var searchInput = h('input', { type: 'text', id: 'chatSearchInput', placeholder: '이름 또는 이메일로 검색', autocomplete: 'off' });
    searchInput.oninput = function () {
      if (st.searchTimer) clearTimeout(st.searchTimer);
      st.searchTimer = setTimeout(function () { runSearch(searchInput.value.trim()); }, 250);
    };
    var searchResults = h('div', { cls: 'chat-user-list', id: 'chatSearchResults' });
    var search = h('div', { cls: 'chat-search', id: 'chatSearch', hidden: 'hidden' },
      searchInput, searchResults);
    search.hidden = true;
    var newBtn = h('button', { type: 'button', cls: 'primary', id: 'chatNewBtn', text: '새 대화', onclick: function () { toggleSearch(search.hidden); } });
    var groupBtn = h('button', { type: 'button', cls: 'secondary', id: 'chatGroupBtn', text: '그룹 만들기', onclick: function () { toggleGroupForm(groupForm.hidden); } });

    // -- 그룹 만들기 폼
    var gName = h('input', { type: 'text', id: 'chatGroupName', placeholder: '비워두면 멤버 이름으로 자동 지정됩니다', maxlength: String(MAX_NAME), autocomplete: 'off', 'aria-label': '그룹 이름 (선택)' });
    var gSearchInput = h('input', { type: 'text', id: 'chatGroupSearchInput', placeholder: '멤버 검색 (이름 또는 이메일)', autocomplete: 'off', 'aria-label': '멤버 검색' });
    gSearchInput.oninput = function () {
      if (st.gSearchTimer) clearTimeout(st.gSearchTimer);
      st.gSearchTimer = setTimeout(function () { if (S === st) runGroupSearch(gSearchInput.value.trim()); }, 250);
    };
    var gResults = h('div', { cls: 'chat-user-list', id: 'chatGroupSearchResults' });
    var gSelBox = h('div', { cls: 'chat-gsel', id: 'chatGroupSelected' });
    var gNote = h('div', { cls: 'chat-note', id: 'chatGroupNote', hidden: 'hidden' });
    gNote.hidden = true;
    var gCreateBtn = h('button', { type: 'button', cls: 'primary', id: 'chatGroupCreate', text: '만들기', onclick: function () { createGroup(); } });
    var gCancelBtn = h('button', { type: 'button', cls: 'secondary', id: 'chatGroupCancel', text: '취소', onclick: function () { groupForm.hidden = true; } });
    var groupForm = h('div', { cls: 'chat-group-form', id: 'chatGroupForm', hidden: 'hidden' },
      gName, gSelBox, gSearchInput, gResults, gNote, h('div', { cls: 'chat-group-actions' }, gCreateBtn, gCancelBtn));
    groupForm.hidden = true;

    var list = h('div', { cls: 'chat-rooms', id: 'chatRoomList' });
    var side = h('div', { cls: 'chat-side' }, h('div', { cls: 'chat-side-head' }, h('b', { text: '대화 목록' }), h('span', { cls: 'chat-side-btns' }, groupBtn, newBtn)), search, groupForm, list);

    // -- 대화창
    var peerName = h('b', { id: 'chatPeerName', text: '' });
    var renameBtn = h('button', { type: 'button', cls: 'secondary chat-rename-btn', id: 'chatRenameBtn', 'aria-label': '그룹 이름 변경', title: '그룹 이름 변경', hidden: 'hidden', onclick: function () { startRename(); } }, pencilIcon());
    renameBtn.hidden = true;
    var renameInput = h('input', { type: 'text', cls: 'chat-rename-input', id: 'chatRenameInput', maxlength: String(MAX_NAME), autocomplete: 'off', 'aria-label': '새 그룹 이름' });
    renameInput.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); saveRename(); } else if (ev.key === 'Escape') cancelRename(); };
    var renameSave = h('button', { type: 'button', cls: 'primary', id: 'chatRenameSave', text: '저장', onclick: function () { saveRename(); } });
    var renameCancel = h('button', { type: 'button', cls: 'secondary', id: 'chatRenameCancel', text: '취소', onclick: function () { cancelRename(); } });
    var renameForm = h('span', { cls: 'chat-rename-form', hidden: 'hidden' }, renameInput, renameSave, renameCancel);
    renameForm.hidden = true;
    var peerRole = h('span', { cls: 'chat-peer-role', id: 'chatPeerRole', text: '' });
    var peerDot = h('span', { cls: 'chat-dot', id: 'chatPeerDot', title: '접속 중', 'aria-label': '접속 중' });
    peerDot.hidden = true;
    var onlineCount = h('span', { cls: 'chat-online-count', id: 'chatOnlineCount', text: '' });
    onlineCount.hidden = true;
    var membersBtn = h('button', { type: 'button', cls: 'secondary chat-members-btn', id: 'chatMembersBtn', text: '멤버', hidden: 'hidden', onclick: function () { toggleMembers(); } });
    membersBtn.hidden = true;
    var backBtn = h('button', { type: 'button', cls: 'secondary chat-back', id: 'chatBackBtn', text: '← 목록', onclick: async function () {
      st.root.className = 'chat-root';
      st.viewing = false;
      await flushRead(); // 읽음 확인이 끝난 뒤 목록을 다시 불러와야 배지가 서버 값으로 맞는다
      if (S === st) loadRooms();
    } });
    // -- 멤버 패널 (그룹 전용)
    var mTitle = h('b', { id: 'chatMembersTitle', text: '멤버' });
    var mClose = h('button', { type: 'button', cls: 'secondary', id: 'chatMembersClose', text: '닫기', onclick: function () { toggleMembers(); } });
    var mAddBtn = h('button', { type: 'button', cls: 'secondary', id: 'chatMemberAddBtn', text: '멤버 추가', hidden: 'hidden', onclick: function () {
      st.addOpen = !st.addOpen; mAdd.hidden = !st.addOpen;
      if (st.addOpen) { mSearchInput.value = ''; runMemberSearch(''); }
    } });
    mAddBtn.hidden = true;
    var mSearchInput = h('input', { type: 'text', id: 'chatMemberSearchInput', placeholder: '추가할 사용자 검색 (이름 또는 이메일)', autocomplete: 'off', 'aria-label': '추가할 사용자 검색' });
    mSearchInput.oninput = function () {
      if (st.mSearchTimer) clearTimeout(st.mSearchTimer);
      st.mSearchTimer = setTimeout(function () { if (S === st) runMemberSearch(mSearchInput.value.trim()); }, 250);
    };
    var mResults = h('div', { cls: 'chat-user-list', id: 'chatMemberSearchResults' });
    var mAdd = h('div', { cls: 'chat-member-add', id: 'chatMemberAdd', hidden: 'hidden' }, mSearchInput, mResults);
    mAdd.hidden = true;
    var mNote = h('div', { cls: 'chat-note', id: 'chatMembersNote', hidden: 'hidden' });
    mNote.hidden = true;
    var mList = h('div', { cls: 'chat-members-list', id: 'chatMembersList' });
    var mTransfer = h('div', { cls: 'chat-transfer', id: 'chatTransfer', hidden: 'hidden' });
    mTransfer.hidden = true;
    var mpanel = h('div', { cls: 'chat-members', id: 'chatMembersPanel', hidden: 'hidden' },
      h('div', { cls: 'chat-members-head' }, mTitle, h('span', { cls: 'chat-side-btns' }, mAddBtn, mClose)),
      mAdd, mNote, mList, mTransfer);
    mpanel.hidden = true;

    var msgBox = h('div', { cls: 'chat-msgs', id: 'chatMsgs' });
    msgBox.onscroll = function () { if (msgBox.scrollTop <= 0 && S === st) loadMore(); };
    var noteEl = h('div', { cls: 'chat-note', id: 'chatNote', hidden: 'hidden' });
    noteEl.hidden = true;
    var input = h('textarea', { id: 'chatInput', rows: '2', placeholder: 'Enter로 보내기, Shift+Enter로 줄바꿈', 'aria-label': '메시지 입력' });
    input.onkeydown = function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { if (e.preventDefault) e.preventDefault(); send(); }
    };
    var sendBtn = h('button', { type: 'button', cls: 'primary', id: 'chatSendBtn', text: '보내기', onclick: function () { send(); } });
    var conv = h('div', { cls: 'chat-conv', id: 'chatConv', hidden: 'hidden' },
      h('div', { cls: 'chat-conv-head' }, backBtn, peerDot, peerName, renameBtn, renameForm, peerRole, onlineCount, membersBtn),
      mpanel, msgBox, noteEl,
      h('div', { cls: 'chat-compose' }, input, sendBtn));
    conv.hidden = true;
    var empty = h('div', { cls: 'chat-pane-empty', id: 'chatPaneEmpty', text: '왼쪽에서 대화를 고르거나 "새 대화"·"그룹 만들기"로 시작하세요.' });
    var main = h('div', { cls: 'chat-main' }, empty, conv);
    var root = h('div', { cls: 'chat-root', id: 'chatRoot' }, side, main);

    st.root = root; st.list = list; st.search = search; st.searchInput = searchInput; st.searchResults = searchResults;
    st.groupForm = groupForm; st.gName = gName; st.gSearchInput = gSearchInput; st.gResults = gResults; st.gSelBox = gSelBox; st.gNote = gNote; st.gCreateBtn = gCreateBtn;
    st.empty = empty; st.conv = conv; st.peerName = peerName; st.renameBtn = renameBtn; st.renameForm = renameForm; st.renameInput = renameInput; st.renameSave = renameSave; st.renaming = false; st.renameBusy = false; st.peerRole = peerRole; st.msgBox = msgBox; st.note = noteEl;
    st.input = input; st.sendBtn = sendBtn; st.peerDot = peerDot; st.onlineCount = onlineCount;
    st.reads = {}; st.pickerSeq = null; st.reactBusy = {};
    st.membersBtn = membersBtn; st.mpanel = mpanel; st.mTitle = mTitle; st.mList = mList; st.mNote = mNote; st.mAdd = mAdd; st.mAddBtn = mAddBtn;
    st.mSearchInput = mSearchInput; st.mResults = mResults; st.mTransfer = mTransfer;
    st.toggleGroupFormHide = function () { groupForm.hidden = true; search.hidden = true; };
    S = st;
    mount.append(root);
    renderRooms();
    loadRooms();
  }

  function chatLeave() {
    if (!S) return;
    closeWs();
    if (S.searchTimer) clearTimeout(S.searchTimer);
    if (S.gSearchTimer) clearTimeout(S.gSearchTimer);
    if (S.mSearchTimer) clearTimeout(S.mSearchTimer);
    S = null;
  }

  // ---------- 플로팅 웹챗 위젯 (2026-11-18) ----------
  // 사이드바 "채팅" 탭 대신 우하단 FAB + 오버레이 패널. 패널 안 UI는 위 chatOpen 그대로 (좁은 폭이라 CSS로 목록↔대화 1단 전환).
  // 미읽음 배지 = /api/chat/rooms unread 합계 — 그룹 + 1:1 (2026-11-18부터 서버가 DM 미읽음도 센다. 방 목록 배지와 같은 값).
  // 패널이 닫혀 있으면 POLL_MS마다 방 목록만 조회해 배지를 맞춘다. 패널 열림 상태는 새로고침 시 유지하지 않는다 (기본 닫힘).
  // 그 외에 로비 WebSocket(/api/chat/lobby/ws)이 새 메시지 알림(chat_msg)을 받으면 즉시 다시 조회한다 (패널이 닫혀 있어도).
  var POLL_MS = 30000;
  var W = { user: '', open: false, timer: null, seq: 0, bound: false, soon: null };
  function wEl(id) { return document.getElementById(id); }

  function viewingRoomId() {
    if (!W.open || !S || !S.viewing || !cur()) return '';
    return curRoomId();
  }
  function sumUnread(rooms) {
    var n = 0, viewing = viewingRoomId();
    (rooms || []).forEach(function (room) {
      if (!room) return;
      if (viewing && room.id === viewing) return; // 지금 보고 있는 방은 안 센다 (목록 배지와 같은 규칙)
      n += Number(room.unread) || 0;
    });
    return n;
  }
  // 짧은 시간에 알림이 몰려도 방 목록 조회는 한 번만
  function pollUnreadSoon() {
    if (W.soon) return;
    W.soon = setTimeout(function () { W.soon = null; pollUnread(); }, 400);
  }

  // ---------- 로비 WebSocket: 접속 표시(presence) + 새 메시지 알림 ----------
  // 로그인해 있는 동안 소켓 1개를 유지한다 (패널을 닫아도). 서버→클라이언트:
  //   {type:'presence_snapshot', online:[ids]} (hello에 대한 답) · {type:'presence', user_id, online} · {type:'chat_msg', room_id, seq}
  // 25초마다 "ping" (DO가 깨지 않고 pong), 60초마다 hello로 접속자 목록을 다시 맞춘다. 끊기면 3초→최대 60초 간격으로 재연결.
  var L = { ws: null, user: '', tries: 0, timer: null, ping: null, hello: null };
  function lobbyStop() {
    if (L.timer) { clearTimeout(L.timer); L.timer = null; }
    if (L.ping) { clearInterval(L.ping); L.ping = null; }
    if (L.hello) { clearInterval(L.hello); L.hello = null; }
    var ws = L.ws; L.ws = null; L.user = ''; L.tries = 0;
    if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null; try { ws.close(1000, 'bye'); } catch (e) { /* 이미 닫힘 */ } }
    P.online = {};
    repaintPresence();
  }
  function lobbySchedule() {
    if (!W.user || L.timer) return;
    var wait = Math.min(60000, 3000 * Math.pow(2, Math.min(L.tries, 5)));
    L.tries++;
    L.timer = setTimeout(function () { L.timer = null; lobbyStart(); }, wait);
  }
  function lobbyStart() {
    if (!W.user || typeof WebSocket === 'undefined') return;
    if (L.ws || L.timer) return;
    var user = W.user, ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/api/chat/lobby/ws'); }
    catch (e) { lobbySchedule(); return; }
    L.ws = ws; L.user = user;
    function sendHello() { try { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'hello' })); } catch (e) { /* 무시 */ } }
    ws.onopen = function () {
      if (L.ws !== ws) return;
      L.tries = 0;
      sendHello();
      if (L.ping) clearInterval(L.ping);
      if (L.hello) clearInterval(L.hello);
      L.ping = setInterval(function () { try { if (ws.readyState === 1) ws.send('ping'); } catch (e) { /* 무시 */ } }, 25000);
      L.hello = setInterval(sendHello, 60000);
      pollUnreadSoon(); // 끊긴 사이 놓친 알림 보충
    };
    ws.onmessage = function (ev) {
      if (L.ws !== ws || W.user !== user) return;
      if (ev.data === 'pong') return;
      var m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m) return;
      if (m.type === 'presence_snapshot' && Array.isArray(m.online)) {
        var o = {};
        m.online.forEach(function (id) { if (typeof id === 'string' && id !== user) o[id] = true; });
        P.online = o;
        repaintPresence();
      } else if (m.type === 'presence' && typeof m.user_id === 'string' && m.user_id !== user) {
        if (m.online) P.online[m.user_id] = true; else delete P.online[m.user_id];
        repaintPresence();
      } else if (m.type === 'chat_msg') {
        onChatMsg(m);
      }
    };
    ws.onerror = function () { /* onclose가 이어서 온다 */ };
    ws.onclose = function () {
      if (L.ws !== ws) return;
      L.ws = null;
      if (L.ping) { clearInterval(L.ping); L.ping = null; }
      if (L.hello) { clearInterval(L.hello); L.hello = null; }
      P.online = {}; // 연결이 없으면 접속 정보를 믿을 수 없다 — 점을 숨긴다
      repaintPresence();
      lobbySchedule();
    };
  }
  function repaintPresence() {
    if (!S) return;
    renderRooms();
    paintHeadPresence();
    if (S.membersOpen) renderMembers();
  }
  // 새 메시지 알림: 지금 보고 있는 방이면 방 WebSocket이 처리한다. 그 외(패널 닫힘·다른 방·목록 화면)는 미읽음을 다시 센다.
  function onChatMsg(m) {
    if (typeof m.room_id !== 'string') return;
    if (m.room_id === viewingRoomId()) return;
    pollUnreadSoon();
  }
  function paintFab(n) {
    var badge = wEl('chatFabBadge'), fab = wEl('chatFab');
    if (!badge || !fab) return;
    badge.hidden = !(n > 0);
    badge.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
    var base = W.open ? '채팅 닫기' : '채팅 열기';
    fab.setAttribute('aria-label', n > 0 ? base + ' (안 읽은 메시지 ' + n + '개)' : base);
  }

  async function pollUnread() {
    if (!W.user || (typeof document !== 'undefined' && document.hidden)) return;
    if (S) { loadRooms(); return; } // 패널이 열려 있으면 목록 재조회가 배지까지 맞춘다
    var seq = ++W.seq, user = W.user;
    try {
      var r = await getJson('/api/chat/rooms');
      if (seq !== W.seq || user !== W.user || S) return;
      if (r.ok && r.body && Array.isArray(r.body.rooms)) paintFab(sumUnread(r.body.rooms));
    } catch (e) { /* 다음 주기에 다시 */ }
  }

  function showPanel(open) {
    var panel = wEl('chatPanel'), fab = wEl('chatFab');
    if (panel) panel.hidden = !open;
    if (fab) { fab.setAttribute('aria-expanded', open ? 'true' : 'false'); fab.classList.toggle('open', open); }
    if (document.body) document.body.classList.toggle('chat-panel-open', open);
  }

  function widgetOpen() {
    if (!W.user || W.open) return;
    W.open = true;
    showPanel(true);
    chatOpen(wEl('chatMount'));
    var close = wEl('chatPanelClose');
    if (close && close.focus) close.focus();
  }

  async function widgetClose(keepFocus) {
    if (!W.open) return;
    W.open = false;
    showPanel(false);
    var s = S;
    if (s) {
      s.viewing = false;
      try { await flushRead(); } catch (e) { /* 읽음 확인 실패는 대화에 영향 없음 */ }
      if (S === s && !W.open) chatLeave(); // 소켓·타이머 정리 (다시 열면 목록부터 새로 그린다)
    }
    pollUnread(); // 읽음 반영된 서버 값으로 배지를 맞춘다
    if (!keepFocus) { var fab = wEl('chatFab'); if (fab && fab.focus) fab.focus(); }
  }

  function bindWidget() {
    if (W.bound) return;
    var fab = wEl('chatFab'), close = wEl('chatPanelClose');
    if (!fab) return;
    W.bound = true;
    fab.onclick = function () { if (W.open) widgetClose(); else widgetOpen(); };
    if (close) close.onclick = function () { widgetClose(); };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && W.open && !e.isComposing) widgetClose();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      pollUnread();
      if (W.user && !L.ws) { if (L.timer) { clearTimeout(L.timer); L.timer = null; } lobbyStart(); }
      if (S && S.viewing && cur() && W.open && S.readPending) { S.readGen++; markRead(); } // 가려진 동안 보류한 읽음 확인
    });
  }

  // index.html applyRole()이 로그인·로그아웃마다 부른다. 로그인 사용자만 FAB가 보인다.
  function chatWidgetSetUser(user) {
    bindWidget();
    var id = user && user.id ? String(user.id) : '';
    var root = wEl('chatWidget');
    if (id === W.user) { if (root) root.hidden = !id; return; }
    // 로그아웃 또는 다른 사용자로 로그인: 패널을 닫고 이전 사용자의 상태를 버린다
    if (W.open) { W.open = false; showPanel(false); }
    if (S) chatLeave();
    if (W.timer) { clearInterval(W.timer); W.timer = null; }
    lobbyStop();
    W.user = id;
    W.seq++;
    paintFab(0);
    if (root) root.hidden = !id;
    if (id) { W.timer = setInterval(pollUnread, POLL_MS); pollUnread(); lobbyStart(); }
  }

  window.chatOpen = chatOpen;
  window.chatLeave = chatLeave;
  window.chatWidgetSetUser = chatWidgetSetUser;
  window.chatWidgetOpen = widgetOpen;
  window.chatWidgetClose = widgetClose;
})();
