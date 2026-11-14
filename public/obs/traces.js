/* S4 M2 — 트레이스 화면 (public/obs/traces.js). common.js 다음에 로드한다.
 *
 *   PeopleOSObs.traces.mount(el, { route, navigate? })
 *     route: 'traces' (목록) | 'trace/<eventId>' (상세)   — 해시 #obs/<route>의 뒷부분
 *     navigate(route): 기본은 location.hash = '#obs/' + route
 *   반환: { unmount() }
 *
 * API: GET /api/obs/traces, GET /api/obs/traces/:id (routes-traces.ts). 서버가 마스킹해서 준다.
 */
(function (global) {
  'use strict';
  var O = global.PeopleOSObs;
  if (!O || !O.obsFetch) { console.error('[obs] common.js must load before traces.js'); return; }
  var esc = O.esc, escAttr = O.escAttr;

  var OUTCOME = {
    kept: ['채택', 'ok'], below_floor: ['하한 미달', ''], keyword_gate: ['키워드 게이트 탈락', 'warn'],
    dedup: ['중복(같은 문서)', ''], over_max: ['상한 초과', ''], unresolved: ['원문 없음', 'err']
  };
  function outcomeBadge(o) { var s = OUTCOME[o] || [o, '']; return O.badge(s[0], s[1], o); }

  function nav(opts, route) {
    if (opts && typeof opts.navigate === 'function') opts.navigate(route);
    else global.location.hash = '#obs/' + route;
  }

  // ---- 목록 ------------------------------------------------------------------
  function renderList(el, opts) {
    var state = { origin: 'user', status: '', feedback: '', risk: false, q: '', cursor: null, rows: [], next: null, loading: false };
    el.innerHTML =
      '<div class="obs-root">' +
      '<div class="obs-kpis" data-kpis></div>' +
      '<form class="obs-toolbar" data-filters>' +
      '<label>출처<select name="origin"><option value="user">user</option><option value="eval">eval</option><option value="all">전체</option></select></label>' +
      '<label>상태<select name="status"><option value="">전체</option><option value="grounded">근거 있음</option><option value="no_evidence">근거 없음</option><option value="error">오류</option></select></label>' +
      '<label>피드백<select name="feedback"><option value="">전체</option><option value="down">👎만</option><option value="up">👍만</option><option value="none">없음</option></select></label>' +
      '<label class="obs-check"><input type="checkbox" name="risk"> 판정 위험(환각 의심)</label>' +
      '<label>질문 검색<input type="search" name="q" placeholder="질문에 포함된 말"></label>' +
      '<button type="submit" class="secondary">적용</button>' +
      '</form>' +
      '<p class="obs-notice">질문·답의 개인정보(주민번호·전화·이메일·계좌·키)는 마스킹되어 표시됩니다. 시각은 KST.</p>' +
      '<div data-body><div class="obs-empty loading">불러오는 중…</div></div>' +
      '<div class="obs-pager" data-pager></div>' +
      '</div>';
    var form = el.querySelector('[data-filters]');
    var body = el.querySelector('[data-body]');
    var pager = el.querySelector('[data-pager]');

    function qs() {
      var p = new URLSearchParams();
      p.set('origin', state.origin);
      if (state.status) p.set('status', state.status);
      if (state.feedback) p.set('feedback', state.feedback);
      if (state.risk) p.set('risk', '1');
      if (state.q) p.set('q', state.q);
      if (state.cursor) p.set('cursor', state.cursor);
      return p.toString();
    }

    function rowHtml(t) {
      var src = t.sources || {};
      var srcTxt = src.count ? src.count + (src.topScore != null ? ' · ' + O.fmtScore(src.topScore) : '') : '0';
      var gap = t.gapId ? ' ' + O.badge('공백 큐 등록', 'warn', t.gapId) : '';
      var fb = t.feedback === 'up' ? '👍' : t.feedback === 'down' ? '👎' : '—';
      return '<tr class="obs-row-link" tabindex="0" data-id="' + escAttr(t.id) + '">' +
        '<td class="obs-num">' + esc(O.kst(t.createdAt)) + '</td>' +
        '<td class="obs-q" title="' + escAttr(t.question) + '">' + esc(t.question) + '</td>' +
        '<td>' + O.statusBadge(t.status) + gap + '</td>' +
        '<td class="obs-num">' + esc(O.fmtMs(t.latencyMs)) + '</td>' +
        '<td class="obs-num">' + esc(O.fmtTokens(t.tokens)) + '</td>' +
        '<td class="obs-num" title="채택 근거 수 · 1위 점수(' + escAttr(src.topScoreKind || '') + ')">' + esc(srcTxt) + '</td>' +
        '<td class="obs-engv" title="엔진 / 검색 · 판정"><div class="obs-mono obs-engv-eng">' + esc(t.engine || '—') + ' / ' + esc(t.searchEngine || '—') + '</div><div>' + O.verdictBadge(t.verdict) + '</div></td>' +
        '<td>' + fb + '</td>' +
        '<td class="obs-col-origin">' + O.badge(t.origin, t.origin === 'eval' ? 'info' : '') + '</td>' +
        '</tr>';
    }

    function draw() {
      if (!state.rows.length) { body.innerHTML = '<div class="obs-empty">조건에 맞는 트레이스가 없습니다.</div>'; pager.innerHTML = ''; return; }
      body.innerHTML = '<div class="obs-table-wrap"><table class="obs-table obs-traces-table"><thead><tr>' +
        '<th>시각</th><th>질문</th><th>상태</th><th>지연</th><th>토큰</th><th>근거</th><th>엔진 · 판정</th><th>피드백</th><th class="obs-col-origin">출처</th>' +
        '</tr></thead><tbody>' + state.rows.map(rowHtml).join('') + '</tbody></table></div>';
      pager.innerHTML = state.next ? '<button type="button" class="secondary" data-more>더 보기</button>' : '';
    }

    function load(reset) {
      if (state.loading) return;
      state.loading = true;
      if (reset) { state.cursor = null; state.rows = []; body.innerHTML = '<div class="obs-empty loading">불러오는 중…</div>'; }
      O.obsFetch('/api/obs/traces?' + qs()).then(function (res) {
        state.rows = state.rows.concat(res.traces || []);
        state.next = res.nextCursor || null;
        draw();
      }).catch(function (e) {
        body.innerHTML = '<div class="obs-error">' + esc(e.message) + '</div>';
      }).then(function () { state.loading = false; });
    }

    function loadKpis() {
      var box = el.querySelector('[data-kpis]');
      O.obsFetch('/api/obs/summary?window=24h').then(function (s) {
        var cost = s.cost || {};
        var k = [
          ['질문 수 (24h)', String(s.questions)],
          ['근거 있음', O.fmtPct(s.groundedRate)],
          ['지연 p50 / p95', O.fmtMs(s.latency && s.latency.p50) + ' / ' + O.fmtMs(s.latency && s.latency.p95)],
          ['토큰', O.fmtTokens(s.tokens)],
          ['비용', O.fmtUsd(cost.usd, cost.estimated)],
          ['👍 / 👎', (s.feedback ? s.feedback.up + ' / ' + s.feedback.down : '—')]
        ];
        box.innerHTML = k.map(function (x) { return '<div class="obs-kpi"><div class="obs-kpi-label">' + esc(x[0]) + '</div><div class="obs-kpi-value">' + esc(x[1]) + '</div></div>'; }).join('');
      }).catch(function () { box.innerHTML = ''; });
    }

    function onSubmit(ev) {
      ev.preventDefault();
      state.origin = form.origin.value; state.status = form.status.value; state.feedback = form.feedback.value;
      state.risk = form.risk.checked; state.q = form.q.value.trim();
      load(true);
    }
    function onClick(ev) {
      if (ev.target.closest('[data-more]')) { state.cursor = state.next; load(false); return; }
      var tr = ev.target.closest('tr[data-id]');
      if (tr) nav(opts, 'trace/' + tr.getAttribute('data-id'));
    }
    function onKey(ev) {
      var tr = ev.target.closest && ev.target.closest('tr[data-id]');
      if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); nav(opts, 'trace/' + tr.getAttribute('data-id')); }
    }
    form.addEventListener('submit', onSubmit);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    loadKpis();
    load(true);
    return function () { el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); };
  }

  // ---- 상세 ------------------------------------------------------------------
  function waterfall(t) {
    var spans = (t.spans || []).slice().sort(function (a, b) { return a.startMs - b.startMs; });
    if (!spans.length) return '<div class="obs-empty">단계 기록이 없습니다 (S4 이전 트레이스이거나 기록 실패).</div>';
    var end = Math.max.apply(null, spans.map(function (s) { return s.startMs + s.durationMs; }).concat([t.latencyMs || 0, 1]));
    var rows = spans.map(function (s) {
      var left = (s.startMs / end) * 100, width = Math.max((s.durationMs / end) * 100, 0.4);
      var attrs = s.attrs && Object.keys(s.attrs).length ? JSON.stringify(s.attrs) : '';
      return '<div class="obs-wf-row">' +
        '<div class="obs-wf-label"><span class="obs-wf-name">' + esc(s.name) + '</span>' + O.productBadge(s.product) + (s.ok ? '' : ' ' + O.badge('실패', 'err')) + '</div>' +
        '<div class="obs-wf-track" title="' + escAttr(s.name + ' · 시작 +' + s.startMs + 'ms · ' + s.durationMs + 'ms') + '">' +
        '<div class="obs-wf-bar' + (s.ok ? '' : ' fail') + '" data-prod="' + escAttr(s.product || '') + '" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%"></div></div>' +
        '<div class="obs-wf-ms">' + esc(O.fmtMs(s.durationMs)) + '</div>' +
        (attrs ? '<div class="obs-wf-attrs">' + esc(attrs) + '</div>' : '') +
        '</div>';
    }).join('');
    return '<div class="obs-wf" role="list" aria-label="단계 타임라인">' + rows +
      '<div class="obs-wf-axis"><span></span><span><span>0</span><span>' + esc(O.fmtMs(end / 2)) + '</span><span>' + esc(O.fmtMs(end)) + '</span></span><span></span></div></div>';
  }

  function scoreCell(v, floor) {
    if (v == null) return '<span class="obs-muted">—</span>';
    var pct = Math.max(0, Math.min(1, v)) * 100;
    return '<div class="obs-score"><div class="obs-score-track"><div class="obs-score-fill' + (v < floor ? ' low' : '') + '" style="width:' + pct.toFixed(1) + '%"></div>' +
      '<div class="obs-score-floor" style="left:' + (floor * 100).toFixed(1) + '%" title="하한 ' + floor + '"></div></div>' +
      '<span class="obs-num">' + esc(O.fmtScore(v)) + '</span></div>';
  }

  function retrievalTables(t) {
    var th = t.thresholds || { scoreFloor: 0.55, keywordGateMin: 2 };
    var all = t.retrievals || [];
    var vec = all.filter(function (r) { return r.stage === 'vectorize'; });
    var d1 = all.filter(function (r) { return r.stage !== 'vectorize'; });
    function row(r, withVec) {
      var dropped = r.outcome !== 'kept';
      var name = (r.title || r.chunkId) + (r.article ? ' › ' + r.article : '');
      return '<tr' + (dropped ? ' class="obs-row-dropped"' : '') + '>' +
        '<td class="obs-num">' + esc(r.rank) + '</td>' +
        '<td title="' + escAttr(r.chunkId) + '">' + esc(name) + '</td>' +
        (withVec ? '<td>' + scoreCell(r.vectorScore, th.scoreFloor) + '</td>' : '') +
        '<td class="obs-num">' + esc(O.fmtScore(r.keywordScore)) + '</td>' +
        '<td>' + outcomeBadge(r.outcome) + '</td></tr>';
    }
    var html = '';
    html += '<div class="obs-floor-legend"><i></i> Vectorize 코사인 하한 <b>' + esc(th.scoreFloor) + '</b> (SCORE_FLOOR) · 키워드 게이트 ≥ <b>' + esc(th.keywordGateMin) + '</b> (KEYWORD_GATE_MIN) · 흐린 행 = 탈락 후보</div>';
    if (vec.length) {
      html += '<div class="obs-table-wrap"><table class="obs-table"><thead><tr><th>순위</th><th>Vectorize 후보 (제목 › 조문)</th><th>벡터 점수</th><th>키워드</th><th>결과</th></tr></thead><tbody>' +
        vec.map(function (r) { return row(r, true); }).join('') + '</tbody></table></div>';
    } else {
      html += '<p class="small obs-muted">Vectorize 후보 없음 (임베딩·Vectorize 실패 시 D1 텍스트 폴백).</p>';
    }
    if (t.unresolvedCount) html += '<p class="small">' + O.badge('원문 없음 ' + t.unresolvedCount + '건', 'err') + ' D1·메타데이터에서 찾지 못한 Vectorize 매치 (gate span attrs.unresolved — chunk id는 기록되지 않음).</p>';
    if (d1.length) {
      html += '<div class="obs-table-wrap" style="margin-top:8px"><table class="obs-table"><thead><tr><th>순위</th><th>D1 키워드 후보 (제목 › 조문)</th><th>키워드 점수</th><th>결과</th></tr></thead><tbody>' +
        d1.map(function (r) { return row(r, false); }).join('') + '</tbody></table></div>';
    }
    return html;
  }

  function promptBlock(t) {
    var p = t.prompt || {};
    if (!p.available) return '<p class="small obs-muted">원문 없음 (' + esc(p.reason || '기록 안 됨') + ').</p>';
    if (p.restricted) return '<p class="small obs-muted">프롬프트·응답 원문은 관리자만 볼 수 있습니다 (공개 범위 O5 권장안).</p>';
    var msgs = (p.messages || []).map(function (m) {
      return '<div class="obs-msg"><div class="obs-msg-role">' + esc(m.role) + '</div><pre class="obs-pre">' + esc(m.content) + '</pre></div>';
    }).join('');
    var raw = p.rawResponse == null ? '' : '<div class="obs-msg"><div class="obs-msg-role">raw response</div><pre class="obs-pre">' + esc(JSON.stringify(p.rawResponse, null, 2)) + '</pre></div>';
    return '<details class="obs-details"><summary>프롬프트 / 응답 원문' + (p.masked ? ' (마스킹됨)' : '') + '</summary>' + (msgs || '<div class="obs-msg obs-muted">messages 없음 (근거 없음 — LLM 미호출)</div>') + raw + '</details>';
  }

  function scoresTable(t) {
    var s = t.scores || [];
    if (!s.length) return '<p class="small obs-muted">점수 없음.</p>';
    return '<div class="obs-table-wrap"><table class="obs-table"><thead><tr><th>이름</th><th>값</th><th>라벨</th><th>출처</th><th>코멘트</th><th>시각</th></tr></thead><tbody>' +
      s.map(function (x) {
        return '<tr><td class="obs-mono">' + esc(x.name) + '</td><td class="obs-num">' + esc(O.fmtScore(x.value)) + '</td><td>' + (x.name === 'verdict' ? O.verdictBadge(x.label) : esc(x.label || '—')) + '</td><td>' + esc(x.source) + '</td><td>' + esc(x.comment || '') + '</td><td class="obs-num">' + esc(O.kst(x.created_at)) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function renderDetail(el, opts, id) {
    el.innerHTML = '<div class="obs-root"><button type="button" class="obs-back" data-back>← 트레이스 목록</button><div data-body><div class="obs-empty loading">불러오는 중…</div></div></div>';
    var body = el.querySelector('[data-body]');
    function onClick(ev) { if (ev.target.closest('[data-back]')) nav(opts, 'traces'); }
    el.addEventListener('click', onClick);
    O.obsFetch('/api/obs/traces/' + encodeURIComponent(id)).then(function (res) {
      var t = res.trace;
      var tk = t.tokens || {};
      var cost = t.cost || {};
      var costTxt = cost.usd == null ? '—' : O.fmtUsd(cost.usd, false);
      var meta = [
        ['상태', O.statusBadge(t.status) + (t.gapId ? ' ' + O.badge('공백 큐 등록', 'warn', t.gapId) : '')],
        ['시각 (KST)', esc(O.kst(t.createdAt, true))],
        ['출처', O.badge(t.origin, t.origin === 'eval' ? 'info' : '') + (t.evalRunId ? ' <span class="obs-mono">' + esc(t.evalRunId) + '</span>' : '')],
        ['세션', '<span class="obs-mono">' + esc(t.sessionId || '—') + '</span>'],
        ['엔진 / 검색', '<span class="obs-mono">' + esc(t.engine || '—') + ' / ' + esc(t.searchEngine || '—') + '</span>'],
        ['모델', '<span class="obs-mono">' + esc(t.model || '—') + '</span>'],
        ['prompt 버전', '<span class="obs-mono">' + esc(t.promptVersion || '—') + '</span>'],
        ['지식 epoch', esc(t.knowledgeEpoch == null ? '—' : t.knowledgeEpoch)],
        ['지연', esc(O.fmtMs(t.latencyMs))],
        ['토큰 (입력 / 출력)', esc(O.fmtTokens(tk.prompt)) + ' / ' + esc(O.fmtTokens(tk.completion))],
        ['비용', esc(costTxt) + (cost.usd != null && cost.estimated ? ' ' + O.badge('추정', 'est', cost.source === 'pricing' ? '토큰 × 단가표(pricing.ts) 추정' : '게이트웨이 로그에 cost가 없어 추정') : '')],
        ['피드백', t.feedback ? (t.feedback.rating === 'up' ? '👍' : '👎') + (t.feedback.comment ? ' ' + esc(t.feedback.comment) : '') : '—']
      ];
      body.innerHTML =
        '<div class="obs-section obs-head">' +
        '<div class="obs-question">' + esc(t.question) + '</div>' +
        '<div class="obs-answer">' + esc(t.answer) + '</div>' +
        '<dl class="obs-meta">' + meta.map(function (m) { return '<div><dt>' + esc(m[0]) + '</dt><dd>' + m[1] + '</dd></div>'; }).join('') + '</dl>' +
        (res.masked ? '<p class="obs-notice">개인정보는 마스킹되어 표시됩니다.</p>' : '') +
        '</div>' +
        '<div class="obs-section"><h3>단계 타임라인 <span class="small">' + esc((t.spans || []).length) + '단계 · 합계 ' + esc(O.fmtMs(t.latencyMs)) + '</span></h3>' + waterfall(t) + '</div>' +
        '<div class="obs-section"><h3>근거 후보 <span class="small">탈락 후보 포함</span></h3>' + retrievalTables(t) + '</div>' +
        '<div class="obs-section"><h3>프롬프트 / 응답</h3>' + promptBlock(t) + '</div>' +
        '<div class="obs-section"><h3>점수</h3>' + scoresTable(t) + '</div>';
    }).catch(function (e) {
      body.innerHTML = '<div class="obs-error">' + esc(e.message) + '</div>';
    });
    return function () { el.removeEventListener('click', onClick); };
  }

  function mount(el, opts) {
    opts = opts || {};
    var route = String(opts.route || 'traces').replace(/^#?obs\//, '');
    var cleanup;
    var m = /^trace\/(.+)$/.exec(route);
    if (m) cleanup = renderDetail(el, opts, decodeURIComponent(m[1]));
    else cleanup = renderList(el, opts);
    return { unmount: function () { if (cleanup) cleanup(); el.innerHTML = ''; } };
  }

  O.traces = { mount: mount, version: 'obs-traces-1' };
})(typeof window !== 'undefined' ? window : globalThis);
