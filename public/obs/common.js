/* S4 관측 · 평가 공용 프론트 헬퍼 (public/obs/common.js) — M2 작성, M5 공유.
 *
 * 빌드 없는 단일 HTML 원칙: <script src="/obs/common.js"></script> 한 줄로 읽는다.
 * 모든 것은 전역 window.PeopleOSObs 아래에 붙는다. 다른 파일(traces.js, M5의
 * evals.js·gaps.js)은 이 파일 뒤에 로드되어 PeopleOSObs.<모듈> = {mount(el, opts)}를 붙인다.
 * 이 파일은 기존 PeopleOSObs 객체를 덮어쓰지 않고 빠진 키만 채운다 (로드 순서에 관대).
 *
 * 공개 API (M5 계약 — 이름·인자를 바꾸지 않는다, 추가만):
 *   obsFetch(path, init?)           → Promise<body>  (ok:false 또는 HTTP 오류면 Error(.status,.body) throw)
 *   esc(s) / escAttr(s)             HTML 이스케이프
 *   badge(text, kind?, title?)      kind: ok|warn|err|info|est|'' → HTML 문자열
 *   statusBadge(status)             grounded|no_evidence|error
 *   verdictBadge(verdict)           grounded|partial|ungrounded|off_topic
 *   productBadge(product)           kv|durable-objects|workers-ai|vectorize|d1
 *   kst(isoOrSqlTime, withSeconds?) KST 표시 (D1 datetime('now')는 UTC 'YYYY-MM-DD HH:MM:SS')
 *   fmtMs(n) / fmtTokens(n) / fmtUsd(n, estimated?) / fmtScore(n) / fmtPct(n)   (null → '—', 0으로 채우지 않음)
 *   sparkline(values, {width,height,title}?)                         → SVG 문자열
 *   lineChart(series, {width,height,yMin,yMax,marks,labels,title}?)  → SVG 문자열
 *   config: { base: '', fixtures: null | (path)=>body|undefined, adminSecret: null }
 */
(function (global) {
  'use strict';
  var NS = global.PeopleOSObs = global.PeopleOSObs || {};

  function fill(key, value) { if (!(key in NS)) NS[key] = value; }

  fill('config', { base: '', fixtures: null, adminSecret: null });

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

  /** fetch + JSON + {ok:false} 처리. config.fixtures가 함수면 먼저 묻는다 (dev 페이지용). */
  function obsFetch(path, init) {
    var cfg = NS.config || {};
    if (typeof cfg.fixtures === 'function') {
      var fx = cfg.fixtures(path, init || {});
      if (fx !== undefined) {
        return Promise.resolve(fx).then(function (body) {
          if (body && body.ok === false) { var e = new Error(body.error || 'error'); e.status = body.__status || 400; e.body = body; throw e; }
          return body;
        });
      }
    }
    var opts = Object.assign({ headers: {} }, init || {});
    opts.headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); opts.headers['Content-Type'] = 'application/json'; }
    if (cfg.adminSecret) opts.headers['X-Admin-Secret'] = cfg.adminSecret;
    return fetch((cfg.base || '') + path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok || !body || body.ok === false) {
          var msg = (body && body.error) || ('HTTP ' + res.status);
          if (res.status === 503 && body && /not migrated/.test(body.error || '')) msg = '관측 스키마가 아직 적용되지 않았습니다 (마이그레이션 0013/0014). ' + msg;
          var err = new Error(msg); err.status = res.status; err.body = body; throw err;
        }
        return body;
      });
    });
  }

  function badge(text, kind, title) {
    return '<span class="obs-badge' + (kind ? ' ' + escAttr(kind) : '') + '"' + (title ? ' title="' + escAttr(title) + '"' : '') + '>' + esc(text) + '</span>';
  }
  var STATUS = { grounded: ['근거 있음', 'ok'], no_evidence: ['근거 없음', 'warn'], off_topic: ['업무 외', 'warn'], error: ['오류', 'err'] };
  function statusBadge(status) {
    var s = STATUS[status] || [status || '—', ''];
    return badge(s[0], s[1], status);
  }
  var VERDICT = { grounded: ['grounded', 'ok'], partial: ['partial', 'info'], ungrounded: ['ungrounded', 'err'], off_topic: ['off_topic', 'err'] };
  function verdictBadge(v) {
    if (!v) return '<span class="obs-muted">—</span>';
    var s = VERDICT[v] || [v, ''];
    return badge(s[0], s[1], '판정(verdict)');
  }
  var PRODUCT = { kv: 'KV', 'durable-objects': 'Durable Objects', 'workers-ai': 'Workers AI', vectorize: 'Vectorize', d1: 'D1' };
  function productBadge(p) {
    if (!p) return '';
    return '<span class="obs-prod" data-prod="' + escAttr(p) + '">' + esc(PRODUCT[p] || p) + '</span>';
  }

  /** D1 'YYYY-MM-DD HH:MM:SS'(UTC) 또는 ISO → 'MM-DD HH:mm' KST */
  function kst(t, withSeconds) {
    if (!t) return '—';
    var s = String(t);
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s = s.replace(' ', 'T') + 'Z';
    var d = new Date(s);
    if (isNaN(d.getTime())) return esc(t);
    var k = new Date(d.getTime() + 9 * 3600 * 1000).toISOString();
    return k.slice(0, 10) + ' ' + k.slice(11, withSeconds ? 19 : 16);
  }

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function fmtMs(n) { return isNum(n) ? (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 's' : Math.round(n) + 'ms') : '—'; }
  function fmtTokens(n) { return isNum(n) ? n.toLocaleString('ko-KR') : '—'; }
  function fmtUsd(n, estimated) {
    if (!isNum(n)) return '—';
    var v = n === 0 ? '$0' : n < 0.0001 ? '$' + n.toExponential(1) : '$' + n.toFixed(n < 0.01 ? 5 : 4);
    return estimated ? v + ' (추정)' : v;
  }
  function fmtScore(n) { return isNum(n) ? (Math.abs(n) >= 10 ? String(Math.round(n)) : n.toFixed(n % 1 === 0 && n >= 1 ? 0 : 2)) : '—'; }
  function fmtPct(n) { return isNum(n) ? Math.round(n * 1000) / 10 + '%' : '—'; }

  /** 값 배열 → 작은 꺾은선 SVG. null 값은 끊긴다. */
  function sparkline(values, o) {
    o = o || {};
    var w = o.width || 120, h = o.height || 28, pad = 2;
    var nums = (values || []).filter(isNum);
    if (!nums.length) return '<svg class="obs-chart" width="' + w + '" height="' + h + '" role="img" aria-label="데이터 없음"></svg>';
    var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    if (min === max) { min -= 1; max += 1; }
    var n = values.length, d = '', pen = false;
    values.forEach(function (v, i) {
      if (!isNum(v)) { pen = false; return; }
      var x = pad + (n === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (n - 1));
      var y = h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
      d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
      pen = true;
    });
    return '<svg class="obs-chart" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + escAttr(o.title || '추이') + '"><path class="obs-chart-line" d="' + d + '"/></svg>';
  }

  /**
   * 꺾은선 차트. series: [{name, values:[number|null], className?}]
   * marks: [{index, label}] — 설정 변경 표식(세로 점선 + title 툴팁). labels: x축 라벨 배열.
   */
  function lineChart(series, o) {
    o = o || {};
    var w = o.width || 560, h = o.height || 180, pl = 36, pr = 8, pt = 8, pb = 22;
    var all = [];
    (series || []).forEach(function (s) { (s.values || []).forEach(function (v) { if (isNum(v)) all.push(v); }); });
    var yMin = isNum(o.yMin) ? o.yMin : (all.length ? Math.min.apply(null, all) : 0);
    var yMax = isNum(o.yMax) ? o.yMax : (all.length ? Math.max.apply(null, all) : 1);
    if (yMin === yMax) { yMax = yMin + 1; }
    var n = Math.max.apply(null, [1].concat((series || []).map(function (s) { return (s.values || []).length; })));
    function X(i) { return pl + (n === 1 ? (w - pl - pr) / 2 : (i * (w - pl - pr)) / (n - 1)); }
    function Y(v) { return pt + (1 - (v - yMin) / (yMax - yMin)) * (h - pt - pb); }
    var out = '<svg class="obs-chart" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + escAttr(o.title || '추이 차트') + '">';
    [0, 0.5, 1].forEach(function (f) {
      var v = yMin + f * (yMax - yMin), y = Y(v);
      out += '<line class="obs-chart-grid" x1="' + pl + '" x2="' + (w - pr) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>';
      out += '<text x="' + (pl - 4) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end">' + esc(fmtScore(v)) + '</text>';
    });
    (o.marks || []).forEach(function (m) {
      var x = X(m.index);
      out += '<line class="obs-chart-mark" x1="' + x.toFixed(1) + '" x2="' + x.toFixed(1) + '" y1="' + pt + '" y2="' + (h - pb) + '"><title>' + esc(m.label || '설정 변경') + '</title></line>';
    });
    (series || []).forEach(function (s) {
      var d = '', pen = false;
      (s.values || []).forEach(function (v, i) {
        if (!isNum(v)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true;
      });
      out += '<path class="obs-chart-line' + (s.className ? ' ' + escAttr(s.className) : '') + '" d="' + d + '"><title>' + esc(s.name || '') + '</title></path>';
      (s.values || []).forEach(function (v, i) {
        if (isNum(v)) out += '<circle class="obs-chart-dot" cx="' + X(i).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="2.5"><title>' + esc((s.name ? s.name + ': ' : '') + fmtScore(v)) + '</title></circle>';
      });
    });
    (o.labels || []).forEach(function (l, i) {
      if (n > 12 && i % Math.ceil(n / 12)) return;
      out += '<text x="' + X(i).toFixed(1) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(l) + '</text>';
    });
    return out + '</svg>';
  }

  fill('esc', esc);
  fill('escAttr', escAttr);
  fill('obsFetch', obsFetch);
  fill('badge', badge);
  fill('statusBadge', statusBadge);
  fill('verdictBadge', verdictBadge);
  fill('productBadge', productBadge);
  fill('kst', kst);
  fill('fmtMs', fmtMs);
  fill('fmtTokens', fmtTokens);
  fill('fmtUsd', fmtUsd);
  fill('fmtScore', fmtScore);
  fill('fmtPct', fmtPct);
  fill('sparkline', sparkline);
  fill('lineChart', lineChart);
  fill('version', 'obs-common-1');
})(typeof window !== 'undefined' ? window : globalThis);
