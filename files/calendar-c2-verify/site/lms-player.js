// 강의실 플레이어 (2026-11-17, LMS O1). lms-plan.md 6.2 계약 — S2(lms.js)는 아래 두 함수만 부른다.
//
//   lmsPlayerMount(containerEl, lesson, { onComplete, onPosition })
//     lesson: GET /api/lms/courses/:id 의 lessons[] 항목 {id, source, youtube_id, start_sec, end_sec, title, completed, position_sec}
//     onComplete(lesson)          자동 완료 때 한 번 호출 (R2: <video> ended / 유튜브: IFrame API ENDED 또는 구간 끝 도달).
//                                 플레이어는 완료를 직접 POST하지 않는다 — 호출자가 {completed:true}를 보내고 화면을 갱신한다.
//     onPosition(lesson, sec)     위치 저장 시점(15초마다 재생 중, 일시정지, 언마운트, 페이지 이탈)에 호출.
//                                 생략하면 플레이어가 직접 POST /api/lms/lessons/:id/progress {position_sec} (keepalive)를 보낸다.
//                                 null을 주면 위치 저장을 끈다.
//   lmsPlayerUnmount()            재생 중지 + 마지막 위치 저장 + DOM 제거 + 리스너·타이머 정리.
//                                 강의 전환·탭 이탈(lmsLeave)·과정 목록 복귀 때 부른다. 여러 번 불러도 안전하다.
//
// 이어보기: lesson.position_sec가 의미 있는 위치(처음/끝 5초 밖)면 그 위치부터 시작한다. 자동 재생은 하지 않는다.
// 유튜브: youtube-nocookie iframe. IFrame Player API(외부 스크립트)는 자동 완료·위치 저장에만 쓰고, 불러오지 못해도 재생은 된다.
// 보안: iframe src는 검증된 11자 id + 정수 초로만 조립한다. <video>에 crossorigin을 넣지 않는다(같은 출처 세션 쿠키).
(function () {
  'use strict';

  var YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var SAVE_EVERY_MS = 15000;   // 재생 중 위치 저장 주기
  var MIN_DELTA_SEC = 5;       // 이 이상 움직였을 때만 저장
  var EDGE_SEC = 5;            // 처음/끝 5초 안의 위치는 이어보기에서 무시
  var YT_POLL_MS = 1000;       // 유튜브 구간 끝 감시 주기

  /** 현재 마운트 상태. 한 번에 하나만 재생한다. */
  var cur = null;
  var mountSeq = 0;

  function intOrNull(v) {
    var n = Number(v);
    return v === null || v === undefined || v === '' || !Number.isFinite(n) || n < 0 ? null : Math.floor(n);
  }

  function defaultSavePosition(lesson, sec) {
    try {
      fetch('/api/lms/lessons/' + encodeURIComponent(lesson.id) + '/progress', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true, // 탭 닫기·이탈 중에도 전송되게
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ position_sec: Math.max(0, Math.floor(sec)) }),
      }).catch(function () {});
    } catch (e) { /* 무시 — 위치 저장은 최선 노력 */ }
  }

  function msg(text) {
    var p = document.createElement('div');
    p.className = 'lms-player-msg empty';
    p.textContent = text;
    return p;
  }

  /** 공통 상태 객체. 정리 함수(cleanups)를 모아 두고 언마운트에서 역순으로 실행한다. */
  function newState(container, lesson, opts) {
    var onPos = opts && Object.prototype.hasOwnProperty.call(opts, 'onPosition') ? opts.onPosition : defaultSavePosition;
    var st = {
      id: ++mountSeq,
      container: container,
      lesson: lesson,
      root: document.createElement('div'),
      cleanups: [],
      completed: false,
      lastSaved: intOrNull(lesson.position_sec),
      getPos: function () { return null; },   // 미디어별로 덮어쓴다
      stop: function () {},                   // 미디어별로 덮어쓴다
      onComplete: opts && typeof opts.onComplete === 'function' ? opts.onComplete : null,
      onPosition: typeof onPos === 'function' ? onPos : null,
    };
    st.root.className = 'lms-player';
    st.root.setAttribute('data-lesson-id', String(lesson.id));
    return st;
  }

  function alive(st) { return cur === st; }

  function on(st, target, type, fn, o) {
    target.addEventListener(type, fn, o);
    st.cleanups.push(function () { target.removeEventListener(type, fn, o); });
  }

  function every(st, ms, fn) {
    var t = setInterval(fn, ms);
    st.cleanups.push(function () { clearInterval(t); });
  }

  function fireComplete(st) {
    if (st.completed || !alive(st)) return;
    st.completed = true;
    if (st.onComplete) {
      try { st.onComplete(st.lesson); } catch (e) { console.error('lms onComplete', e); }
    }
  }

  /** 위치 저장. force면 변화량과 무관하게 저장한다(언마운트·이탈). */
  function savePos(st, force, explicitSec) {
    if (!st.onPosition) return;
    var sec = explicitSec !== undefined ? explicitSec : st.getPos();
    if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return;
    sec = Math.floor(sec);
    if (!force && st.lastSaved !== null && Math.abs(sec - st.lastSaved) < MIN_DELTA_SEC) return;
    if (force && st.lastSaved === sec) return;
    st.lastSaved = sec;
    try { st.onPosition(st.lesson, sec); } catch (e) { console.error('lms onPosition', e); }
  }

  /** 페이지 이탈(탭 닫기·새로고침·백그라운드)에서 위치 저장. pagehide에서는 재생도 멈춘다. */
  function wirePageLifecycle(st) {
    on(st, document, 'visibilitychange', function () {
      if (document.visibilityState === 'hidden') savePos(st, true);
    });
    on(st, window, 'pagehide', function () { savePos(st, true); });
  }

  // ---------------- R2 <video> ----------------

  function mountVideo(st) {
    var lesson = st.lesson;
    var v = document.createElement('video');
    v.className = 'lms-video';
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('controlsList', 'nodownload');
    v.setAttribute('aria-label', lesson.title || '강의 영상');
    v.src = '/api/lms/lessons/' + encodeURIComponent(lesson.id) + '/video';
    st.root.appendChild(v);

    st.getPos = function () { return v.currentTime; };
    st.stop = function () {
      try { v.pause(); } catch (e) {}
      // src를 비우고 load()해야 진행 중인 Range 요청과 디코더가 풀린다 (pause만으로는 버퍼링이 계속된다).
      v.removeAttribute('src');
      try { v.load(); } catch (e) {}
    };

    var resume = intOrNull(lesson.position_sec);
    on(st, v, 'loadedmetadata', function () {
      var d = v.duration;
      if (resume !== null && resume > EDGE_SEC && (!Number.isFinite(d) || resume < d - EDGE_SEC)) {
        try { v.currentTime = resume; } catch (e) {}
      }
    }, { once: true });
    on(st, v, 'pause', function () { if (!v.ended) savePos(st, false); });
    on(st, v, 'ended', function () {
      savePos(st, true, 0); // 다 본 강의는 다음에 처음부터
      fireComplete(st);
    });
    on(st, v, 'error', function () {
      if (!alive(st) || !v.getAttribute('src')) return; // 언마운트 중 src 제거로 난 오류는 무시
      var code = v.error ? v.error.code : 0;
      var text = code === 4
        ? '영상을 불러올 수 없습니다. 로그인 상태를 확인하거나 잠시 후 다시 시도해 주세요.'
        : '영상 재생 중 오류가 발생했습니다.';
      if (!st.root.querySelector('.lms-player-msg')) st.root.appendChild(msg(text));
    });
    every(st, SAVE_EVERY_MS, function () { if (!v.paused && !v.ended) savePos(st, false); });
  }

  // ---------------- 유튜브 iframe ----------------

  var ytApiPromise = null;
  /** IFrame Player API를 한 번만 불러온다. 실패하면 null로 해결된다(재생은 iframe만으로 된다). */
  function loadYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (!done) { done = true; resolve(v); } };
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (e) {} }
        finish(window.YT || null);
      };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = function () { ytApiPromise = null; finish(null); };
      document.head.appendChild(s);
      setTimeout(function () { finish(window.YT && window.YT.Player ? window.YT : null); }, 10000);
    });
    return ytApiPromise;
  }

  function mountYoutube(st) {
    var lesson = st.lesson;
    var id = String(lesson.youtube_id || '');
    if (!YT_ID_RE.test(id)) { st.root.appendChild(msg('유튜브 영상 정보를 확인할 수 없습니다.')); return; }
    var start = intOrNull(lesson.start_sec);
    var end = intOrNull(lesson.end_sec);
    if (end !== null && start !== null && end <= start) end = null;

    // 이어보기: 구간 안의 의미 있는 위치면 거기서 시작 (위치는 영상 전체 기준 초).
    var from = start;
    var resume = intOrNull(lesson.position_sec);
    if (resume !== null && resume > (start || 0) + EDGE_SEC && (end === null || resume < end - EDGE_SEC)) from = resume;

    var q = ['rel=0', 'playsinline=1', 'enablejsapi=1', 'origin=' + encodeURIComponent(location.origin)];
    if (from !== null && from > 0) q.push('start=' + from);
    if (end !== null) q.push('end=' + end);

    var f = document.createElement('iframe');
    f.className = 'lms-frame';
    f.id = 'lms-yt-' + st.id;
    f.src = 'https://www.youtube-nocookie.com/embed/' + id + '?' + q.join('&');
    f.title = lesson.title || '강의 영상';
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    st.root.appendChild(f);

    var yt = null;
    st.getPos = function () {
      try { return yt && typeof yt.getCurrentTime === 'function' ? yt.getCurrentTime() : null; } catch (e) { return null; }
    };
    st.stop = function () {
      try { if (yt && typeof yt.stopVideo === 'function') yt.stopVideo(); } catch (e) {}
      try { if (yt && typeof yt.destroy === 'function') yt.destroy(); } catch (e) {}
      yt = null;
      // destroy가 iframe을 지우지 못한 경우를 대비해 src를 비운다 (소리가 남지 않게).
      try { f.src = 'about:blank'; } catch (e) {}
      if (f.parentNode) f.parentNode.removeChild(f);
    };

    // 2순위: API로 종료 감지·위치 저장. API가 없으면 "수강 완료" 버튼만으로 완료한다.
    loadYtApi().then(function (YT) {
      if (!YT || !alive(st) || !f.isConnected) return;
      var ended = (YT.PlayerState && YT.PlayerState.ENDED) || 0;
      var playing = (YT.PlayerState && YT.PlayerState.PLAYING) || 1;
      var paused = (YT.PlayerState && YT.PlayerState.PAUSED) || 2;
      var p;
      try {
        p = new YT.Player(f.id, {
          events: {
            onReady: function () { if (alive(st)) yt = p; else { try { p.destroy(); } catch (e) {} } },
            onStateChange: function (ev) {
              if (!alive(st)) return;
              if (ev.data === ended) {
                savePos(st, true, start || 0); // 다 본 구간은 다음에 구간 처음부터
                fireComplete(st);
              } else if (ev.data === paused) {
                savePos(st, false);
              }
            },
          },
        });
      } catch (e) { return; }
      // 구간 끝(end=) 도달 감시: 일부 환경에서 end 도달 시 ENDED 대신 PAUSED가 온다.
      every(st, YT_POLL_MS, function () {
        if (!yt || st.completed) return;
        var t = st.getPos();
        var state = -1;
        try { state = yt.getPlayerState(); } catch (e) {}
        if (end !== null && t !== null && t >= end - 1 && state !== playing) {
          savePos(st, true, start || 0);
          fireComplete(st);
        }
      });
      every(st, SAVE_EVERY_MS, function () {
        if (!yt) return;
        var state = -1;
        try { state = yt.getPlayerState(); } catch (e) {}
        if (state === playing) savePos(st, false);
      });
    });
  }

  // ---------------- 공개 API ----------------

  function lmsPlayerUnmount() {
    var st = cur;
    if (!st) return;
    try { savePos(st, true); } catch (e) {}
    cur = null; // 이후 도착하는 비동기 콜백(유튜브 API 준비 등)을 무효화한다
    try { st.stop(); } catch (e) {}
    for (var i = st.cleanups.length - 1; i >= 0; i--) {
      try { st.cleanups[i](); } catch (e) {}
    }
    st.cleanups = [];
    if (st.root.parentNode) st.root.parentNode.removeChild(st.root);
  }

  function lmsPlayerMount(containerEl, lesson, opts) {
    lmsPlayerUnmount();
    if (!containerEl || !lesson || !lesson.id) return;
    var st = newState(containerEl, lesson, opts || {});
    cur = st;
    containerEl.appendChild(st.root);
    if (lesson.source === 'r2') mountVideo(st);
    else if (lesson.source === 'youtube') mountYoutube(st);
    else st.root.appendChild(msg('지원하지 않는 영상 형식입니다.'));
    wirePageLifecycle(st);
  }

  window.lmsPlayerMount = lmsPlayerMount;
  window.lmsPlayerUnmount = lmsPlayerUnmount;
})();
