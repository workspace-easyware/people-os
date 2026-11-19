/* 일잇 People OS — 발표자료 로더·내비게이션 (public/pitch.js) · O-A 2026-11-17
 *
 * 두 환경에서 같은 조각(/pitch-content.html)을 그린다.
 *   - 앱 안:  index.html의 switchTab이 pitchOpen($('pitchMount'), sub)을 부른다.
 *             칩은 location.hash = 'pitch/<키>'만 바꾼다 (hashchange → switchTab → pitchOpen).
 *   - 독립:   /pitch.html의 #pitchStandalone 마운트를 이 파일이 스스로 연다.
 *             주소는 #<키> (#pt-<키>, #pitch/<키>도 받는다).
 * index.html의 전역($, api, esc)에 기대지 않는다. 조각 계약은 pitch.css 맨 위 주석.
 *
 * 전역: pitchOpen(mountEl, sectionKey), pitchLeave()
 * 테스트 훅: window.PITCH_CONFIG = { contentUrl, healthUrl } (스크립트보다 먼저), window.__pitchTest
 */
(function () {
  'use strict';

  var CFG = { contentUrl: '/pitch-content.html', healthUrl: '/api/health', healthTimeoutMs: 6000 };
  if (window.PITCH_CONFIG) for (var k in window.PITCH_CONFIG) CFG[k] = window.PITCH_CONFIG[k];

  var GROUP_LABEL = { biz: '비즈니스', tech: '기술', end: '마무리' };
  var BINDING_LABEL = { d1: 'D1', kv: 'KV', r2: 'R2', vectorize: 'Vectorize', ai: 'Workers AI', durable_objects: 'Durable Objects' };
  var KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

  var st = {
    mount: null, mode: 'app', loading: null, ready: false,
    nav: null, track: null, bar: null, items: [], chips: {}, active: '',
    listening: false, raf: 0, pendingKey: null, userMoved: false, liveDone: false
  };

  /* ---------- 순수 함수 (node로 단위 검증: files/pitch-verify/unit.cjs) ---------- */

  // 해시 → 섹션 키. 앱 모드에서 발표자료 해시가 아니면 null.
  function parseHash(hash, mode) {
    var h = String(hash || '').replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch (e) { /* 그대로 */ }
    if (mode === 'app') {
      if (h === 'pitch') return '';
      if (h.indexOf('pitch/') !== 0) return null;
      h = h.slice(6);
    } else if (h.indexOf('pitch/') === 0) h = h.slice(6);
    else if (h === 'pitch') h = '';
    if (h.indexOf('pt-') === 0) h = h.slice(3);
    h = h.toLowerCase();
    return KEY_RE.test(h) ? h : '';
  }

  // 키 → 이 환경의 href
  function hrefFor(key, mode) {
    if (mode === 'app') return key ? '#pitch/' + key : '#pitch';
    return key ? '#' + key : '#';
  }

  // 앱 탭 링크 → 이 환경의 href
  function tabHref(tab, mode) { return mode === 'app' ? '#' + tab : '/#' + tab; }

  // tops: 각 섹션 위쪽의 화면 좌표(px). line보다 위에 있는 마지막 섹션이 현재.
  function pickActive(tops, line, atBottom) {
    if (!tops.length) return -1;
    if (atBottom) return tops.length - 1;
    var idx = 0;
    for (var i = 0; i < tops.length; i++) if (tops[i] <= line) idx = i;
    return idx;
  }

  // 조각 정리: <script>·<section>(경고)·인라인 이벤트·javascript: 링크 제거
  function sanitize(root) {
    var bad = root.querySelectorAll('script,iframe,object,embed');
    for (var i = 0; i < bad.length; i++) bad[i].parentNode.removeChild(bad[i]);
    var all = root.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      for (var a = el.attributes.length - 1; a >= 0; a--) {
        var n = el.attributes[a].name.toLowerCase();
        var v = String(el.attributes[a].value || '').trim().toLowerCase();
        if (n.indexOf('on') === 0) el.removeAttribute(el.attributes[a].name);
        else if ((n === 'href' || n === 'src') && v.indexOf('javascript:') === 0) el.removeAttribute(el.attributes[a].name);
      }
    }
    if (root.querySelector('section') && window.console) console.warn('[pitch] 조각에 <section>이 있습니다. 앱 안에서 보이지 않습니다 — <article>을 쓰세요.');
  }

  /* ---------- 조각 불러오기 ---------- */

  function setState(mount, cls, text, retry) {
    mount.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'pt-state' + (cls ? ' ' + cls : '');
    p.textContent = text;
    if (retry) {
      var a = document.createElement('a');
      a.href = '#'; a.textContent = ' 다시 시도';
      a.addEventListener('click', function (e) { e.preventDefault(); pitchOpen(mount, st.pendingKey || ''); });
      p.appendChild(a);
    }
    mount.appendChild(p);
  }

  function load(mount) {
    if (st.mount === mount && (st.ready || st.loading)) return st.loading || Promise.resolve();
    st.mount = mount; st.ready = false; st.liveDone = false;
    mount.classList.add('pt-root');
    mount.setAttribute('data-mode', st.mode);
    setState(mount, '', '발표자료를 불러오는 중…');
    st.loading = fetch(CFG.contentUrl, { credentials: 'same-origin', cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (html) {
        var tpl = document.createElement('template');
        tpl.innerHTML = html;
        sanitize(tpl.content);
        mount.innerHTML = '';
        mount.appendChild(tpl.content);
        decorate(mount);
        buildNav(mount);
        st.ready = true; st.loading = null;
        live(mount);
      })
      .catch(function (err) {
        st.loading = null; st.ready = false;
        setState(mount, 'err', '발표자료를 불러오지 못했습니다 (' + (err && err.message || err) + ').', true);
        throw err;
      });
    return st.loading;
  }

  // 링크·배지 등 환경별 손질
  function decorate(mount) {
    var mode = st.mode;
    var links = mount.querySelectorAll('a[href^="#pt-"]');
    for (var i = 0; i < links.length; i++) {
      var key = parseHash(links[i].getAttribute('href'), 'standalone');
      links[i].setAttribute('href', hrefFor(key, mode));
      links[i].setAttribute('data-pt-goto', key);
    }
    var tabs = mount.querySelectorAll('a[data-tab]');
    for (var t = 0; t < tabs.length; t++) {
      var tab = tabs[t].getAttribute('data-tab');
      if (/^[a-z][a-z0-9/-]*$/.test(tab)) tabs[t].setAttribute('href', tabHref(tab, mode));
    }
    var keys = mount.querySelectorAll('.pt-key[data-keyno] > .pt-sec-head');
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].querySelector('.pt-keybadge')) continue;
      var b = document.createElement('span');
      b.className = 'pt-keybadge';
      b.textContent = '핵심 ' + keys[k].parentNode.getAttribute('data-keyno');
      keys[k].insertBefore(b, keys[k].firstChild);
    }
    var ext = mount.querySelectorAll('a[href^="http"]');
    for (var x = 0; x < ext.length; x++) { ext[x].setAttribute('target', '_blank'); ext[x].setAttribute('rel', 'noopener'); }
    var figs = mount.querySelectorAll('.pt-figure a');
    for (var f = 0; f < figs.length; f++) { figs[f].setAttribute('target', '_blank'); figs[f].setAttribute('rel', 'noopener'); }
    // 그림이 늦게 뜨면 위치가 밀린다 → 사용자가 움직이기 전이면 다시 맞춘다
    var imgs = mount.querySelectorAll('img');
    for (var m = 0; m < imgs.length; m++) imgs[m].addEventListener('load', function () {
      if (st.pendingKey !== null && !st.userMoved) scrollToKey(st.pendingKey, false);
    });
  }

  /* ---------- 내비게이션 ---------- */

  function buildNav(mount) {
    var nodes = mount.querySelectorAll('[data-key][data-nav]');
    st.items = []; st.chips = {};
    var nav = document.createElement('nav');
    nav.className = 'pt-nav';
    nav.setAttribute('aria-label', '발표자료 섹션');
    var track = document.createElement('div');
    track.className = 'pt-nav-track';
    var lastGroup = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = String(el.getAttribute('data-key') || '').toLowerCase();
      if (!KEY_RE.test(key) || st.chips[key]) continue;
      if (!el.id) el.id = 'pt-' + key;
      var group = el.getAttribute('data-group') || '';
      if (group && group !== lastGroup) {
        if (lastGroup !== null) { var sep = document.createElement('span'); sep.className = 'pt-nav-sep'; sep.setAttribute('aria-hidden', 'true'); track.appendChild(sep); }
        if (GROUP_LABEL[group]) { var gl = document.createElement('span'); gl.className = 'pt-nav-group'; gl.textContent = GROUP_LABEL[group]; gl.setAttribute('aria-hidden', 'true'); track.appendChild(gl); }
      }
      lastGroup = group || lastGroup || '';
      var a = document.createElement('a');
      a.className = 'pt-chip';
      a.href = hrefFor(key === 'top' ? '' : key, st.mode);
      a.setAttribute('data-pt-goto', key);
      var kn = el.getAttribute('data-keyno');
      if (kn) { var s = document.createElement('span'); s.className = 'pt-chip-key'; s.textContent = '핵심' + kn; a.appendChild(s); }
      a.appendChild(document.createTextNode(el.getAttribute('data-nav')));
      track.appendChild(a);
      st.items.push({ key: key, el: el });
      st.chips[key] = a;
    }
    var prog = document.createElement('div');
    prog.className = 'pt-progress'; prog.setAttribute('aria-hidden', 'true');
    var bar = document.createElement('i');
    prog.appendChild(bar);
    nav.appendChild(track); nav.appendChild(prog);
    var first = mount.querySelector('.pt-sec');
    if (first) first.parentNode.insertBefore(nav, first); else mount.insertBefore(nav, mount.firstChild);
    st.nav = nav; st.track = track; st.bar = bar;
    mount.addEventListener('click', onClick);
  }

  function onClick(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[data-pt-goto]') : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var key = a.getAttribute('data-pt-goto');
    if (key === 'top') key = '';
    var want = hrefFor(key, st.mode);
    // 같은 해시면 hashchange가 안 나므로 직접 스크롤
    if (location.hash === want || (want === '#' && !location.hash)) {
      e.preventDefault();
      scrollToKey(key, true);
    }
    // 아니면 기본 동작(해시 변경) → 앱: switchTab → pitchOpen / 독립: onHash
  }

  function itemFor(key) {
    for (var i = 0; i < st.items.length; i++) if (st.items[i].key === key) return st.items[i];
    return null;
  }

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function scrollToKey(key, smooth) {
    var it = key ? itemFor(key) : null;
    var y;
    if (!it || key === 'top') {
      y = 0; // 맨 위 (앱 안에서는 공통 .hero까지 보인다)
    } else {
      var navH = st.nav ? st.nav.offsetHeight : 0;
      y = it.el.getBoundingClientRect().top + window.pageYOffset - navH - 8;
    }
    var behavior = smooth && !reducedMotion() ? 'smooth' : 'auto';
    try { window.scrollTo({ top: Math.max(0, y), behavior: behavior }); } catch (e) { window.scrollTo(0, Math.max(0, y)); }
    if (key) setActive(key);
    else if (st.items.length) setActive(st.items[0].key);
  }

  function setActive(key) {
    if (st.active === key) return;
    var prev = st.chips[st.active];
    if (prev) prev.removeAttribute('aria-current');
    st.active = key;
    var cur = st.chips[key];
    if (!cur) return;
    cur.setAttribute('aria-current', 'true');
    // 현재 칩이 가로 스크롤 영역 안에 들어오게 (window는 움직이지 않는다)
    var tr = st.track;
    var left = cur.offsetLeft - tr.offsetLeft, right = left + cur.offsetWidth;
    if (left < tr.scrollLeft + 8 || right > tr.scrollLeft + tr.clientWidth - 8) {
      var to = left - (tr.clientWidth - cur.offsetWidth) / 2;
      try { tr.scrollTo({ left: to, behavior: reducedMotion() ? 'auto' : 'smooth' }); } catch (e) { tr.scrollLeft = to; }
    }
  }

  function measure() {
    st.raf = 0;
    var m = st.mount;
    if (!st.ready || !m || m.offsetParent === null) return; // 숨은 탭 (display:none)
    var line = (st.nav ? st.nav.getBoundingClientRect().bottom : 0) + 24;
    var tops = [];
    for (var i = 0; i < st.items.length; i++) tops.push(st.items[i].el.getBoundingClientRect().top);
    var doc = document.documentElement;
    var atBottom = window.pageYOffset + window.innerHeight >= doc.scrollHeight - 4 && window.pageYOffset > 0;
    var idx = pickActive(tops, line, atBottom);
    if (idx >= 0) setActive(st.items[idx].key);
    if (st.bar) {
      var r = m.getBoundingClientRect();
      var span = r.height - window.innerHeight;
      var p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 1;
      st.bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
    }
  }

  function onScroll() { if (!st.raf) st.raf = requestAnimationFrame(measure); }
  function onUserMove() { st.userMoved = true; }

  function listen() {
    if (st.listening) return;
    st.listening = true;
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    window.addEventListener('wheel', onUserMove, { passive: true });
    window.addEventListener('touchstart', onUserMove, { passive: true });
    window.addEventListener('keydown', onUserMove);
  }

  /* ---------- 라이브 상태 띠 (GET /api/health) ---------- */

  function live(mount) {
    var strip = mount.querySelector('.pt-live[data-live="health"]');
    if (!strip || st.liveDone) return;
    st.liveDone = true;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, CFG.healthTimeoutMs) : 0;
    fetch(CFG.healthUrl, { credentials: 'same-origin', cache: 'no-store', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || j.ok !== true || !j.bindings || typeof j.bindings !== 'object') throw new Error('bad payload');
        var box = strip.querySelector('.pt-live-badges');
        if (!box) { box = document.createElement('span'); box.className = 'pt-live-badges'; strip.appendChild(box); }
        box.innerHTML = '';
        var n = 0;
        for (var key in BINDING_LABEL) {
          if (!(key in j.bindings)) continue;
          var b = document.createElement('span');
          var on = j.bindings[key] === true;
          b.className = 'badge ' + (on ? 'ok' : 'warn');
          b.textContent = BINDING_LABEL[key] + (on ? '' : ' 없음');
          box.appendChild(b); n++;
        }
        if (!n) throw new Error('no bindings');
        strip.classList.add('is-ready');
        strip.setAttribute('role', 'status');
      })
      .catch(function () { strip.classList.remove('is-ready'); strip.setAttribute('hidden', ''); })
      .then(function () { if (timer) clearTimeout(timer); onScroll(); });
  }

  /* ---------- 공개 함수 ---------- */

  function pitchOpen(mountEl, sectionKey, opts) {
    if (!mountEl) return Promise.resolve();
    st.mode = (opts && opts.mode) || (mountEl.hasAttribute('data-pitch-standalone') ? 'standalone' : 'app');
    var key = parseHash(sectionKey || '', 'standalone') || '';
    var first = !(st.mount === mountEl && st.ready);
    st.pendingKey = key; st.userMoved = false;
    listen();
    return load(mountEl).then(function () {
      if (key && !itemFor(key)) key = '';
      // 레이아웃(탭 표시) 뒤에 스크롤. 첫 진입은 즉시, 이후(칩·뒤로 가기)는 부드럽게.
      requestAnimationFrame(function () {
        scrollToKey(key, !first);
        measure();
      });
    }, function () { /* 상태 문구는 setState가 그렸다 */ });
  }

  function pitchLeave() {
    if (!st.listening) return;
    st.listening = false;
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('wheel', onUserMove);
    window.removeEventListener('touchstart', onUserMove);
    window.removeEventListener('keydown', onUserMove);
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    st.pendingKey = null;
  }

  window.pitchOpen = pitchOpen;
  window.pitchLeave = pitchLeave;
  window.__pitchTest = { parseHash: parseHash, hrefFor: hrefFor, tabHref: tabHref, pickActive: pickActive, state: st };

  /* ---------- 독립 페이지 자동 시작 ---------- */

  function boot() {
    var el = document.getElementById('pitchStandalone');
    if (!el) return;
    el.setAttribute('data-pitch-standalone', '');
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    pitchOpen(el, parseHash(location.hash, 'standalone'), { mode: 'standalone' });
    window.addEventListener('hashchange', function () {
      pitchOpen(el, parseHash(location.hash, 'standalone'), { mode: 'standalone' });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
