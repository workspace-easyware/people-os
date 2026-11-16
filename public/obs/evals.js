/* S4 M5 — 평가 화면: 실행 목록 · 실행 상세 · 추이 · 실행 대화상자 (public/obs/evals.js).
 * common.js 다음에 로드한다. 스타일: obs.css + evals.css.
 *
 *   PeopleOSObs.evals.mount(el, { route, navigate? })
 *     route: 'evals' (목록 + 추이) | 'run/<runId>' (실행 상세)   — 해시 #obs/<route>의 뒷부분
 *   반환: { unmount() }
 *
 * API (routes-evals.ts · routes-datasets.ts 계약 그대로):
 *   GET  /api/obs/datasets                → {datasets:[{id,name,version,itemCount,activeCount}]}
 *   GET  /api/obs/evals/guards            → {enabled, manualRunsPerDay, manualRunsUsedToday, maxItemsPerRun, lock:{runId,expiresAt}|null, ...}
 *   GET  /api/obs/evals/runs?datasetId    → {runs:[EvalRun], nextCursor}
 *   GET  /api/obs/evals/runs/:id          → {run, baseRunId, items:[...]}
 *   POST /api/obs/evals/runs {datasetId, limit} → 202 {runId, status, itemsTotal, truncated}
 *   POST /api/obs/evals/runs/:id/abort    (관리자)
 *   GET  /api/obs/evals/trend?datasetId   → {datasetId, points:[{runId,createdAt,passRate,avgJudge,retrievalHitRate,noEvidenceAccuracy,changes,judgeDisagreement,...}]}
 */
(function (global) {
  'use strict';
  var O = global.PeopleOSObs;
  if (!O || !O.obsFetch) { console.error('[obs] common.js must load before evals.js'); return; }
  var esc = O.esc, escAttr = O.escAttr;

  var POLL_MS = 3000;
  var ACTIVE = { queued: 1, running: 1 };

  var STATUS = {
    queued: ['대기', 'info'], running: ['실행 중', 'info'], done: ['완료', 'ok'], partial: ['일부 오류', 'warn'],
    failed: ['실패', 'err'], aborted: ['중단됨', ''], skipped: ['건너뜀', '']
  };
  var TRIGGER = { manual: '수동', cron: '정기(cron)', regression: '회귀' };
  var COMPARISON = {
    new_fail: ['새로 실패', 'err'], new_pass: ['새로 통과', 'ok'], same: ['동일', ''], 'new': ['신규', 'info'], error: ['오류', 'err']
  };

  function nav(opts, route) {
    if (opts && typeof opts.navigate === 'function') opts.navigate(route);
    else global.location.hash = '#obs/' + route;
  }
  function statusBadge(s) { var x = STATUS[s] || [s || '—', '']; return O.badge(x[0], x[1], s); }
  function cfgOf(run) { return (run && run.config) || {}; }
  function active(run) { return !!(run && ACTIVE[run.status]); }
  function cost(run) {
    return run.costEstimateUsd == null ? '—' : O.fmtUsd(run.costEstimateUsd, false) + ' ' + O.badge('추정', 'est', '토큰 × 단가표 추정. 게이트웨이 비용 로그 동기화 전까지 실제 청구액이 아닙니다.');
  }
  function engineBadge(cfg) {
    var e = cfg.verdict_engine;
    if (!e) return '<span class="obs-muted">—</span>';
    return e === 'clef'
      ? O.badge('clef', 'ok', 'verdict 엔진: Cloudflare Clef')
      : O.badge(e, 'warn', 'Clef 미확인 시의 대체 엔진(LLM 분류). ' + (cfg.verdict_engine_reason || ''));
  }
  function progressCell(run) {
    var total = run.itemsTotal || 0, done = run.itemsDone || 0;
    var pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    return '<div class="obs-progress"><progress max="100" value="' + pct + '" aria-label="진행률"></progress>' +
      '<span class="obs-num">' + esc(done + '/' + total) + (run.itemsError ? ' · 오류 ' + esc(run.itemsError) : '') + '</span></div>';
  }
  function metricCells(run) {
    return '<td class="obs-num">' + esc(O.fmtPct(run.passRate)) + '</td>' +
      '<td class="obs-num">' + esc(O.fmtScore(run.avgJudge)) + '</td>' +
      '<td class="obs-num">' + esc(O.fmtPct(run.retrievalHitRate)) + '</td>' +
      '<td class="obs-num">' + esc(O.fmtPct(run.noEvidenceAccuracy)) + '</td>';
  }

  /** 모달 대화상자 (<dialog>): 닫으면 DOM에서 제거, 포커스는 브라우저가 원래 요소로 돌려준다. */
  function openDialog(title, bodyHtml, onSubmit) {
    var dlg = global.document.createElement('dialog');
    dlg.className = 'obs-dialog';
    dlg.innerHTML = '<form method="dialog" class="obs-dialog-form"><h3>' + esc(title) + '</h3>' + bodyHtml +
      '<div class="obs-dialog-error obs-error" hidden data-err role="alert"></div>' +
      '<div class="btnrow obs-dialog-actions"><button type="button" class="secondary" data-cancel>취소</button><button type="submit" class="primary" data-ok>확인</button></div></form>';
    global.document.body.appendChild(dlg);
    var form = dlg.querySelector('form'), err = dlg.querySelector('[data-err]'), ok = dlg.querySelector('[data-ok]');
    dlg.querySelector('[data-cancel]').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('close', function () { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.hidden = true; ok.disabled = true;
      Promise.resolve().then(function () { return onSubmit(form, dlg); }).then(function (keepOpen) {
        if (!keepOpen) dlg.close();
      }).catch(function (e) {
        err.textContent = e && e.message ? e.message : String(e); err.hidden = false;
      }).then(function () { ok.disabled = false; });
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    var first = form.querySelector('input,select,textarea'); if (first) first.focus();
    return dlg;
  }

  // ---- 목록 + 추이 ------------------------------------------------------------
  function renderList(el, opts) {
    var st = { datasets: [], datasetId: '', loaded: false, runs: [], hadActive: false, timer: null, dead: false, guards: null };
    el.innerHTML =
      '<div class="obs-root">' +
      '<p class="obs-notice obs-fixed-notice" data-notice>평가 점수는 Workers AI judge의 추정치로, 추이와 회귀 감지용입니다. 절대적인 정답 판정이 아닙니다.</p>' +
      '<div class="obs-toolbar">' +
      '<label>데이터셋<select data-dataset aria-label="데이터셋"></select></label>' +
      '<button type="button" class="primary" data-run>평가 실행</button>' +
      '<span class="small obs-muted" data-guards></span>' +
      '</div>' +
      '<div class="obs-section"><h3>추이 <span class="small">실행 순서 · 점선 = 설정이 바뀐 실행</span></h3><div data-trend><div class="obs-empty loading">불러오는 중…</div></div></div>' +
      '<div class="obs-section"><h3>실행 목록</h3><div data-runs><div class="obs-empty loading">불러오는 중…</div></div></div>' +
      '</div>';
    var selDs = el.querySelector('[data-dataset]');
    var trendBox = el.querySelector('[data-trend]');
    var runsBox = el.querySelector('[data-runs]');
    var guardsBox = el.querySelector('[data-guards]');

    function drawDatasets() {
      var list = st.datasets;
      if (!list.length) {
        selDs.innerHTML = '<option value="">' + (st.loaded ? '데이터셋 없음' : '불러오는 중…') + '</option>';
        selDs.disabled = true;
        el.querySelector('[data-run]').disabled = st.loaded;
        return;
      }
      selDs.disabled = false;
      selDs.innerHTML = list.map(function (d) {
        return '<option value="' + escAttr(d.id) + '"' + (d.id === st.datasetId ? ' selected' : '') + '>' + esc(d.name || d.id) + (d.version != null ? ' (v' + esc(d.version) + ')' : '') + '</option>';
      }).join('');
    }

    function drawGuards() {
      var g = st.guards;
      if (!g) { guardsBox.textContent = ''; return; }
      var parts = [];
      if (g.enabled === false) parts.push('평가 실행이 꺼져 있습니다 (eval_enabled=0)');
      parts.push('오늘 수동 실행 ' + (g.manualRunsUsedToday == null ? '—' : g.manualRunsUsedToday) + '/' + (g.manualRunsPerDay == null ? '—' : g.manualRunsPerDay));
      if (g.lock && g.lock.runId) parts.push('실행 중: ' + g.lock.runId);
      guardsBox.textContent = parts.join(' · ');
      el.querySelector('[data-run]').disabled = g.enabled === false || (st.loaded && !st.datasetId);
    }

    function drawRuns() {
      if (!st.runs.length) { runsBox.innerHTML = '<div class="obs-empty">아직 평가 실행이 없습니다. "평가 실행"으로 골든 데이터셋을 돌려 보세요.</div>'; return; }
      runsBox.innerHTML = '<div class="obs-table-wrap"><table class="obs-table"><thead><tr>' +
        '<th>시각 (KST)</th><th>트리거</th><th>데이터셋 v</th><th>LLM 모델</th><th>judge 모델</th><th>verdict 엔진</th><th>prompt</th><th>지식 epoch</th>' +
        '<th>진행</th><th>통과율</th><th>judge 평균</th><th>근거 적중률</th><th>근거 없음 정확도</th><th>비용</th><th>상태</th></tr></thead><tbody>' +
        st.runs.map(function (r) {
          var c = cfgOf(r);
          return '<tr class="obs-row-link" tabindex="0" data-run-id="' + escAttr(r.id) + '">' +
            '<td class="obs-num">' + esc(O.kst(r.createdAt)) + '</td>' +
            '<td>' + esc(TRIGGER[r.trigger] || r.trigger) + '</td>' +
            '<td class="obs-num">' + esc(r.datasetVersion) + '</td>' +
            '<td class="obs-mono">' + esc(c.llm_model || '—') + '</td>' +
            '<td class="obs-mono">' + esc(c.judge_model || '—') + '</td>' +
            '<td>' + engineBadge(c) + '</td>' +
            '<td class="obs-mono">' + esc(c.prompt_version_id || '—') + '</td>' +
            '<td class="obs-num">' + esc(c.knowledge_epoch == null ? '—' : c.knowledge_epoch) + '</td>' +
            '<td>' + progressCell(r) + '</td>' + metricCells(r) +
            '<td>' + cost(r) + '</td>' +
            '<td>' + statusBadge(r.status) + (r.error ? ' <span class="small obs-muted" title="' + escAttr(r.error) + '">!</span>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function drawTrend(points) {
      if (!points.length) { trendBox.innerHTML = '<div class="obs-empty">완료된 실행이 없어 추이를 그릴 수 없습니다.</div>'; return; }
      var series = [
        { name: '통과율', values: points.map(function (p) { return p.passRate; }), className: 'obs-s1' },
        { name: 'judge 평균', values: points.map(function (p) { return p.avgJudge; }), className: 'obs-s2' },
        { name: '근거 적중률', values: points.map(function (p) { return p.retrievalHitRate; }), className: 'obs-s3' },
        { name: '근거 없음 판정 정확도', values: points.map(function (p) { return p.noEvidenceAccuracy; }), className: 'obs-s4' }
      ];
      var marks = [];
      points.forEach(function (p, i) {
        if (p.changes && p.changes.length) {
          marks.push({
            index: i,
            label: '#' + (i + 1) + ' 설정 변경: ' + p.changes.map(function (c) { return c.label + ' ' + fmtVal(c.from) + ' → ' + fmtVal(c.to); }).join(' · ')
          });
        }
      });
      var labels = points.map(function (p) { return O.kst(p.createdAt).slice(5, 10); });
      var legend = series.map(function (s) { return '<span class="obs-legend-item"><i class="' + s.className + '"></i>' + esc(s.name) + '</span>'; }).join('');
      var disagree = points.map(function (p, i) { return p.judgeDisagreement ? '#' + (i + 1) : null; }).filter(Boolean);
      var changes = marks.map(function (m) { return '<li>' + esc(m.label) + '</li>'; }).join('');
      trendBox.innerHTML = '<div class="obs-legend">' + legend + '</div>' +
        O.lineChart(series, { width: 720, height: 220, yMin: 0, yMax: 1, marks: marks, labels: labels, title: '평가 추이 — 통과율, judge 평균, 근거 적중률, 근거 없음 판정 정확도' }) +
        (points.length === 1 ? '<p class="small obs-muted">실행이 1개뿐이라 점으로 표시됩니다. 2개 이상이 쌓이면 선이 됩니다.</p>' : '') +
        (changes ? '<ul class="small obs-trend-changes">' + changes + '</ul>' : '') +
        (disagree.length ? '<p class="obs-notice">judge 불일치: ' + esc(disagree.join(', ')) + ' — 결정적 지표(근거 적중률)와 judge 평균이 반대 방향으로 움직였습니다. judge 점수만으로 판단하지 마세요.</p>' : '');
    }
    function fmtVal(v) { return v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); }

    function loadTrend() {
      return O.obsFetch('/api/obs/evals/trend?datasetId=' + encodeURIComponent(st.datasetId)).then(function (res) {
        if (!st.dead) drawTrend(res.points || []);
      }).catch(function (e) { if (!st.dead) trendBox.innerHTML = '<div class="obs-error">' + esc(e.message) + '</div>'; });
    }

    function loadRuns(first) {
      return O.obsFetch('/api/obs/evals/runs?datasetId=' + encodeURIComponent(st.datasetId)).then(function (res) {
        if (st.dead) return;
        st.runs = res.runs || [];
        drawRuns();
        var nowActive = st.runs.some(active);
        if (st.hadActive && !nowActive) { loadTrend(); loadGuards(); }
        st.hadActive = nowActive;
        clearTimeout(st.timer);
        if (nowActive) st.timer = setTimeout(function () { loadRuns(false); }, POLL_MS);
      }).catch(function (e) {
        if (!st.dead) runsBox.innerHTML = '<div class="obs-error">' + esc(e.message) + '</div>';
      });
    }

    function loadGuards() {
      return O.obsFetch('/api/obs/evals/guards').then(function (g) { st.guards = g; if (!st.dead) drawGuards(); }).catch(function () { st.guards = null; });
    }

    function startDialog() {
      var g = st.guards || {};
      var maxItems = g.maxItemsPerRun || 30;
      var dsOpts = (st.datasets.length ? st.datasets : []).map(function (d) {
        var cnt = d.activeCount != null ? ' · 활성 ' + d.activeCount + '개' : '';
        return '<option value="' + escAttr(d.id) + '"' + (d.id === st.datasetId ? ' selected' : '') + '>' + esc((d.name || d.id) + cnt) + '</option>';
      }).join('');
      openDialog('평가 실행',
        '<p class="small obs-muted">골든 항목을 실제 /api/ask 경로로 돌리고 judge가 채점합니다. 사용자 질문 목록·공백 큐에는 기록되지 않습니다. 동시에 하나만 실행됩니다.</p>' +
        '<label class="obs-field">데이터셋<select name="datasetId">' + dsOpts + '</select></label>' +
        '<label class="obs-field">최대 항목 수<input type="number" name="limit" min="1" max="' + escAttr(maxItems) + '" value="' + escAttr(Math.min(30, maxItems)) + '"></label>' +
        '<p class="small obs-muted">서버 상한 ' + esc(maxItems) + '개를 넘으면 잘립니다. 비용은 추정치로만 표시됩니다.</p>',
        function (form) {
          var limit = parseInt(form.limit.value, 10);
          var body = { datasetId: form.datasetId.value };
          if (isFinite(limit) && limit > 0) body.limit = limit;
          return O.obsFetch('/api/obs/evals/runs', { method: 'POST', body: body }).then(function (res) {
            st.datasetId = body.datasetId; drawDatasets();
            st.hadActive = true;
            loadRuns(true); loadTrend(); loadGuards();
            if (res.truncated) global.console.info('[obs] run truncated to ' + res.itemsTotal + ' items');
          }).catch(function (e) {
            var b = e.body || {};
            if (e.status === 409) throw new Error('이미 실행 중인 평가가 있습니다' + (b.runId ? ' (' + b.runId + ')' : '') + '. 끝난 뒤 다시 시도하세요.');
            if (e.status === 429) throw new Error('오늘 수동 실행 한도를 넘었습니다' + (b.retryAfter ? ' — ' + b.retryAfter + '초 뒤 재시도 가능' : '') + '.');
            if (e.status === 403) throw new Error('평가 실행이 꺼져 있습니다 (' + e.message + ').');
            throw e;
          });
        });
    }

    function onClick(ev) {
      if (ev.target.closest('[data-run]')) { if (st.datasetId) startDialog(); return; } // 데이터셋이 없으면 실행할 대상도 없다
      var tr = ev.target.closest('tr[data-run-id]');
      if (tr) nav(opts, 'run/' + tr.getAttribute('data-run-id'));
    }
    function onKey(ev) {
      var tr = ev.target.closest && ev.target.closest('tr[data-run-id]');
      if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); nav(opts, 'run/' + tr.getAttribute('data-run-id')); }
    }
    function onChange(ev) {
      if (ev.target === selDs) { st.datasetId = selDs.value; st.hadActive = false; loadRuns(true); loadTrend(); }
    }
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('change', onChange);

    drawDatasets();
    loadGuards();
    O.obsFetch('/api/obs/datasets').then(function (res) {
      st.datasets = res.datasets || [];
      if (st.datasets.length && !st.datasets.some(function (d) { return d.id === st.datasetId; })) st.datasetId = st.datasets[0].id;
    }).catch(function () { st.datasets = []; /* 목록 실패 → 임의 id를 지어내지 않고 빈 상태로 둔다 */ }).then(function () {
      if (st.dead) return;
      st.loaded = true;
      drawDatasets();
      if (!st.datasetId) {
        runsBox.innerHTML = '<div class="obs-empty">데이터셋이 없습니다. 골든 데이터셋을 먼저 만들어 주세요.</div>';
        trendBox.innerHTML = '<div class="obs-empty">데이터셋이 없어 추이를 그릴 수 없습니다.</div>';
        return;
      }
      loadRuns(true); loadTrend();
    });

    return function () {
      st.dead = true; clearTimeout(st.timer);
      el.removeEventListener('click', onClick); el.removeEventListener('keydown', onKey); el.removeEventListener('change', onChange);
    };
  }

  // ---- 실행 상세 ----------------------------------------------------------------
  var CMP_ORDER = { new_fail: 0, error: 1, new_pass: 2, 'new': 3, same: 4 };

  function resultBadge(r) {
    return r.result === 'pass' ? O.badge('통과', 'ok') : r.result === 'fail' ? O.badge('실패', 'err') : O.badge('오류', 'err', r.error || '');
  }
  function hitCell(v) { return v === true ? O.badge('적중', 'ok') : v === false ? O.badge('빗나감', 'warn') : '<span class="obs-muted">—</span>'; }
  var SKIPPED = { rule: '규칙 판정 (judge 생략)', no_evidence: '근거 없음 (judge 생략, 0점)' };

  function dimsHtml(dims) {
    if (!dims) return '<p class="small obs-muted">차원별 채점 없음.</p>';
    var rows = [['diagnosis', '진단'], ['evidence', '근거'], ['fix', '조치']].map(function (k) {
      var d = dims[k[0]];
      if (!d) return '';
      return '<tr><td>' + esc(k[1]) + '</td><td class="obs-num">' + esc(O.fmtScore(d.level)) + '</td><td>' + esc(d.reason || '') + '</td></tr>';
    }).join('');
    return '<table class="obs-table obs-dims"><thead><tr><th>차원</th><th>단계</th><th>사유</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function itemRows(items, idx) {
    var it = items[idx];
    var cmp = COMPARISON[it.comparison] || [it.comparison, ''];
    var judge = it.judgeScore != null ? O.fmtScore(it.judgeScore) + (it.judgeSnapped ? ' *' : '') : '—';
    var skipped = it.judgeSkipped ? '<div class="small obs-muted">' + esc(SKIPPED[it.judgeSkipped] || it.judgeSkipped) + '</div>' : '';
    var link = it.eventId ? '<a href="#obs/trace/' + escAttr(encodeURIComponent(it.eventId)) + '">트레이스</a>' : '<span class="obs-muted">—</span>';
    var main = '<tr data-i="' + idx + '" class="obs-item-row ' + (it.comparison === 'new_fail' ? 'obs-regress' : '') + '">' +
      '<td>' + O.badge(cmp[0], cmp[1], it.prevPassed == null ? '직전 실행 기록 없음' : '직전: ' + (it.prevPassed ? '통과' : '실패')) + '</td>' +
      '<td class="obs-q" title="' + escAttr(it.question) + '">' + esc(it.question || it.itemId) + '</td>' +
      '<td>' + resultBadge(it) + '</td>' +
      '<td class="obs-num">' + esc(judge) + skipped + '</td>' +
      '<td>' + O.verdictBadge(it.verdict) + (it.expectedVerdict ? '<div class="small obs-muted">기대 ' + esc(it.expectedVerdict) + '</div>' : '') + '</td>' +
      '<td>' + hitCell(it.retrievalHit) + '</td>' +
      '<td class="obs-num">' + esc(O.fmtMs(it.latencyMs)) + '</td>' +
      '<td>' + link + '</td>' +
      '<td><button type="button" class="secondary small" data-toggle="' + idx + '" aria-expanded="false" aria-controls="obs-det-' + idx + '">사유</button></td></tr>';
    var detail = '<tr class="obs-item-detail" id="obs-det-' + idx + '" hidden><td colspan="9">' +
      (it.error ? '<div class="obs-error">' + esc(it.error) + '</div>' : '') +
      '<div class="obs-detail-grid">' +
      '<div><div class="obs-detail-h">답</div><pre class="obs-pre">' + esc(it.answer || '(답 없음)') + '</pre></div>' +
      '<div><div class="obs-detail-h">기대 답 (사람이 작성)</div><pre class="obs-pre">' + esc(it.expectedAnswer || '(없음)') + '</pre></div>' +
      '</div>' +
      '<div class="obs-detail-h">judge 사유' + (it.judgeSnapped ? ' <span class="small obs-muted">(* 점수를 아래 단계로 내려 맞춤)</span>' : '') + '</div>' +
      '<p>' + esc(it.judgeReason || '—') + '</p>' + dimsHtml(it.judgeDims) +
      '<div class="obs-detail-h">개선 코멘트 (재귀적 자기개선 근거)</div>' +
      (it.judgeComment ? '<p class="obs-judge-comment">' + esc(it.judgeComment) + '</p>'
        : '<p class="small obs-muted">이 실행에는 개선 코멘트가 없습니다 (judge-v2 이전 실행).</p>') +
      '<p class="small obs-muted">verdict 엔진: ' + esc(it.verdictEngine || '—') + ' · 검색된 근거 ' + esc((it.retrievedIds || []).length) + '건</p>' +
      '</td></tr>';
    return main + detail;
  }

  function renderDetail(el, opts, runId) {
    var st = { run: null, base: null, items: [], sort: 'cmp', timer: null, dead: false };
    el.innerHTML = '<div class="obs-root"><button type="button" class="obs-back" data-back>← 평가 목록</button>' +
      '<p class="obs-notice obs-fixed-notice">평가 점수는 Workers AI judge의 추정치로, 추이와 회귀 감지용입니다. 절대적인 정답 판정이 아닙니다.</p>' +
      '<div data-body><div class="obs-empty loading">불러오는 중…</div></div></div>';
    var body = el.querySelector('[data-body]');

    function sorted() {
      var a = st.items.slice();
      if (st.sort === 'judge') a.sort(function (x, y) { return (x.judgeScore == null ? 2 : x.judgeScore) - (y.judgeScore == null ? 2 : y.judgeScore); });
      else a.sort(function (x, y) { return (CMP_ORDER[x.comparison] == null ? 9 : CMP_ORDER[x.comparison]) - (CMP_ORDER[y.comparison] == null ? 9 : CMP_ORDER[y.comparison]); });
      return a;
    }

    function draw(res) {
      var r = res.run, c = cfgOf(r);
      st.run = r; st.items = res.items || []; st.base = res.baseRunId || null;
      var openIdx = {};
      Array.prototype.forEach.call(el.querySelectorAll('.obs-item-detail:not([hidden])'), function (n) { openIdx[n.id] = 1; });
      var order = sorted();
      var meta = [
        ['상태', statusBadge(r.status) + (r.error ? ' <span class="small">' + esc(r.error) + '</span>' : '')],
        ['트리거', esc(TRIGGER[r.trigger] || r.trigger)],
        ['시작 (KST)', esc(O.kst(r.startedAt || r.createdAt, true))],
        ['데이터셋', '<span class="obs-mono">' + esc(r.datasetId) + ' v' + esc(r.datasetVersion) + '</span>'],
        ['LLM 모델', '<span class="obs-mono">' + esc(c.llm_model || '—') + '</span>'],
        ['judge 모델', '<span class="obs-mono">' + esc(c.judge_model || '—') + '</span>'],
        ['verdict 엔진', engineBadge(c)],
        ['prompt 버전', '<span class="obs-mono">' + esc(c.prompt_version_id || '—') + '</span>'],
        ['지식 epoch', esc(c.knowledge_epoch == null ? '—' : c.knowledge_epoch)],
        ['통과 기준', esc(c.pass_threshold == null ? '—' : c.pass_threshold)],
        ['직전 실행', res.baseRunId ? '<a href="#obs/run/' + escAttr(encodeURIComponent(res.baseRunId)) + '">' + esc(res.baseRunId) + '</a>' : '—'],
        ['비용', cost(r)]
      ];
      var kpis = [
        ['통과율', O.fmtPct(r.passRate)], ['judge 평균', O.fmtScore(r.avgJudge)], ['근거 적중률', O.fmtPct(r.retrievalHitRate)],
        ['근거 없음 판정 정확도', O.fmtPct(r.noEvidenceAccuracy)], ['진행', (r.itemsDone || 0) + '/' + (r.itemsTotal || 0) + (r.itemsError ? ' (오류 ' + r.itemsError + ')' : '')]
      ];
      var failNew = st.items.filter(function (x) { return x.comparison === 'new_fail'; }).length;
      var passNew = st.items.filter(function (x) { return x.comparison === 'new_pass'; }).length;
      body.innerHTML =
        '<div class="obs-section"><h2 class="obs-h2">실행 <span class="obs-mono">' + esc(r.id) + '</span></h2>' +
        (active(r) ? '<div class="obs-progress-big">' + progressCell(r) + '<span class="small obs-muted">3초마다 갱신 중…</span>' +
          (O.config && O.config.adminSecret ? ' <button type="button" class="secondary small" data-abort>중단 (관리자)</button>' : '') + '</div>' : '') +
        '<div class="obs-kpis">' + kpis.map(function (k) { return '<div class="obs-kpi"><div class="obs-kpi-label">' + esc(k[0]) + '</div><div class="obs-kpi-value">' + esc(k[1]) + '</div></div>'; }).join('') + '</div>' +
        '<dl class="obs-meta">' + meta.map(function (m) { return '<div><dt>' + esc(m[0]) + '</dt><dd>' + m[1] + '</dd></div>'; }).join('') + '</dl></div>' +
        '<div class="obs-section"><h3>항목별 결과 <span class="small">' +
        (failNew ? O.badge('새로 실패 ' + failNew, 'err') + ' ' : '') + (passNew ? O.badge('새로 통과 ' + passNew, 'ok') : '') + '</span>' +
        '<label class="obs-sort small">정렬 <select data-sort><option value="cmp"' + (st.sort === 'cmp' ? ' selected' : '') + '>새로 실패 먼저</option><option value="judge"' + (st.sort === 'judge' ? ' selected' : '') + '>judge 낮은 순</option></select></label></h3>' +
        (order.length
          ? '<div class="obs-table-wrap"><table class="obs-table"><thead><tr><th>직전 대비</th><th>질문</th><th>결과</th><th>judge</th><th>verdict</th><th>근거 적중</th><th>지연</th><th>트레이스</th><th></th></tr></thead><tbody>' +
            order.map(function (it, i) { return itemRows(order, i); }).join('') + '</tbody></table></div>'
          : '<div class="obs-empty">' + (active(r) ? '아직 결과가 없습니다. 항목이 끝나는 대로 채워집니다.' : '이 실행에는 항목 결과가 없습니다.') + '</div>') + '</div>';
      Array.prototype.forEach.call(body.querySelectorAll('.obs-item-detail'), function (n) {
        if (openIdx[n.id]) { n.hidden = false; var b = body.querySelector('[aria-controls="' + n.id + '"]'); if (b) b.setAttribute('aria-expanded', 'true'); }
      });
      clearTimeout(st.timer);
      if (active(r) && !st.dead) st.timer = setTimeout(load, POLL_MS);
    }

    function load() {
      O.obsFetch('/api/obs/evals/runs/' + encodeURIComponent(runId)).then(function (res) { if (!st.dead) draw(res); })
        .catch(function (e) { if (!st.dead) body.innerHTML = '<div class="obs-error">' + esc(e.message) + '</div>'; });
    }

    function onClick(ev) {
      if (ev.target.closest('[data-back]')) { nav(opts, 'evals'); return; }
      var t = ev.target.closest('[data-toggle]');
      if (t) {
        var d = el.querySelector('#obs-det-' + t.getAttribute('data-toggle'));
        if (d) { d.hidden = !d.hidden; t.setAttribute('aria-expanded', d.hidden ? 'false' : 'true'); }
        return;
      }
      if (ev.target.closest('[data-abort]')) {
        O.obsFetch('/api/obs/evals/runs/' + encodeURIComponent(runId) + '/abort', { method: 'POST', body: {} }).then(load)
          .catch(function (e) { body.insertAdjacentHTML('afterbegin', '<div class="obs-error">' + esc(e.message) + '</div>'); });
      }
    }
    function onChange(ev) {
      if (ev.target.matches && ev.target.matches('[data-sort]')) { st.sort = ev.target.value; draw({ run: st.run, baseRunId: st.base, items: st.items }); }
    }
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    load();
    return function () { st.dead = true; clearTimeout(st.timer); el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); };
  }

  function mount(el, opts) {
    opts = opts || {};
    var route = String(opts.route || 'evals').replace(/^#?obs\//, '');
    var cleanup;
    var m = /^run\/(.+)$/.exec(route);
    if (m) cleanup = renderDetail(el, opts, decodeURIComponent(m[1]));
    else cleanup = renderList(el, opts);
    return { unmount: function () { if (cleanup) cleanup(); el.innerHTML = ''; } };
  }

  O.evals = { mount: mount, openDialog: openDialog, version: 'obs-evals-1' };
})(typeof window !== 'undefined' ? window : globalThis);
