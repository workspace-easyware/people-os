/* WF-11 — 관측 · 워크플로우 run 화면 (public/obs/workflows.js). common.js 다음에 로드한다. 스타일: obs.css.
 *
 *   PeopleOSObs.workflows.mount(el, { route })     route: 'workflows' (목록) | 'workflow-run/<runId>' (단계 타임라인)
 *
 * API (src/obs/routes-workflows.ts, hr_admin 전용·읽기 전용):
 *   GET /api/obs/workflow-runs?limit=50&status=   → {runs:[{id,workflow_name,owner_email,owner_name,status,started_at,finished_at,duration_ms,step_count,llm_calls,error}]}
 *   GET /api/obs/workflow-runs/:runId             → {run:{...}, steps:[{step_index,node_type,node_name,status,started_at,finished_at,duration_ms,llm_calls,error}]}
 * 소요 시간이 없으면(아직 안 돈 단계 등) "—". 서버 데이터는 전부 esc()를 거쳐 넣는다.
 */
(function (global) {
  'use strict';
  var O = global.PeopleOSObs;
  if (!O || !O.obsFetch) { console.error('[obs] common.js must load before workflows.js'); return; }
  var esc = O.esc, escAttr = O.escAttr;

  var RUN_KO = { queued: ['대기', ''], running: ['실행 중', 'info'], waiting_approval: ['승인 대기', 'warn'], succeeded: ['성공', 'ok'], failed: ['실패', 'err'], cancelled: ['취소됨', 'err'] };
  var STEP_KO = { pending: ['대기', ''], running: ['실행 중', 'info'], succeeded: ['성공', 'ok'], failed: ['실패', 'err'], skipped: ['건너뜀', ''] };
  var FILTERS = [['', '전체'], ['succeeded', '성공'], ['failed', '실패'], ['waiting_approval', '승인 대기'], ['running', '실행 중'], ['queued', '대기'], ['cancelled', '취소됨']];

  function sBadge(map, s) { var x = map[s] || [s || '—', '']; return O.badge(x[0], x[1], s); }
  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 1000);
    return s < 60 ? s + '초' : Math.floor(s / 60) + '분 ' + (s % 60) + '초';
  }
  function owner(r) { return (r.owner_name ? r.owner_name + ' ' : '') + (r.owner_email ? '(' + r.owner_email + ')' : ''); }

  function renderList(el, state) {
    el.innerHTML = '<div class="obs-toolbar"><label>상태<select data-f="status">' +
      FILTERS.map(function (f) { return '<option value="' + escAttr(f[0]) + '"' + (state.status === f[0] ? ' selected' : '') + '>' + esc(f[1]) + '</option>'; }).join('') +
      '</select></label></div><div data-body><p class="obs-muted">불러오는 중…</p></div>';
    var body = el.querySelector('[data-body]');
    el.querySelector('[data-f="status"]').onchange = function (ev) { state.status = ev.target.value; renderList(el, state); };
    O.obsFetch('/api/obs/workflow-runs?limit=50' + (state.status ? '&status=' + encodeURIComponent(state.status) : '')).then(function (j) {
      var runs = j.runs || [];
      if (!runs.length) { body.innerHTML = '<p class="obs-empty">워크플로우 실행 기록이 없습니다.</p>'; return; }
      body.innerHTML = '<div class="obs-table-wrap"><table class="obs-table"><thead><tr><th>워크플로우</th><th>소유자</th><th>상태</th><th>시작</th><th>소요</th><th>단계</th><th>LLM 호출</th><th>오류</th></tr></thead><tbody>' +
        runs.map(function (r) {
          return '<tr class="obs-row-link" tabindex="0" role="link" data-run="' + escAttr(r.id) + '" style="cursor:pointer"><td>' + esc(r.workflow_name) + '</td><td>' + esc(owner(r)) + '</td><td>' + sBadge(RUN_KO, r.status) +
            '</td><td>' + esc(O.kst(r.started_at)) + '</td><td>' + esc(fmtDur(r.duration_ms)) + '</td><td>' + esc(r.step_count) + '</td><td>' + esc(r.llm_calls) +
            '</td><td class="obs-muted">' + esc(r.error ? String(r.error).slice(0, 60) : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      Array.prototype.forEach.call(body.querySelectorAll('tr[data-run]'), function (tr) {
        var go = function () { global.location.hash = 'obs/workflow-run/' + tr.getAttribute('data-run'); };
        tr.onclick = go;
        tr.onkeydown = function (ev) { if (ev.key === 'Enter') go(); };
      });
    }).catch(function (e) { body.innerHTML = '<div class="obs-error" role="alert">' + esc(e.message) + '</div>'; });
  }

  function renderDetail(el, runId) {
    el.innerHTML = '<p><a href="#obs/workflows">← 목록</a></p><div data-body><p class="obs-muted">불러오는 중…</p></div>';
    var body = el.querySelector('[data-body]');
    O.obsFetch('/api/obs/workflow-runs/' + encodeURIComponent(runId)).then(function (j) {
      var r = j.run, steps = j.steps || [];
      var max = 0;
      steps.forEach(function (s) { if (typeof s.duration_ms === 'number' && s.duration_ms > max) max = s.duration_ms; });
      var html = '<h3>' + esc(r.workflow_name) + ' ' + sBadge(RUN_KO, r.status) + '</h3>' +
        '<p class="obs-muted">' + esc(owner(r)) + ' · 시작 ' + esc(O.kst(r.started_at)) + (r.finished_at ? ' · 종료 ' + esc(O.kst(r.finished_at)) : '') +
        ' · 소요 ' + esc(fmtDur(r.duration_ms)) + ' · 단계 ' + esc(r.step_count) + ' · LLM 호출 ' + esc(r.llm_calls) + '</p>';
      if (r.error) html += '<div class="obs-error" role="alert">' + esc(r.error) + '</div>';
      if (!steps.length) html += '<p class="obs-empty">기록된 단계가 없습니다.</p>';
      else {
        html += '<div class="obs-table-wrap"><table class="obs-table"><thead><tr><th>#</th><th>단계</th><th>종류</th><th>상태</th><th>소요</th><th style="width:30%">타임라인</th><th>LLM</th><th>오류</th></tr></thead><tbody>' +
          steps.map(function (s) {
            var d = s.duration_ms, pct = max > 0 && typeof d === 'number' ? Math.max(2, Math.round(d / max * 100)) : 0;
            var longest = max > 0 && d === max;
            var bar = typeof d === 'number'
              ? '<div style="background:var(--obs-surface-soft,#eee);border-radius:3px;height:10px"><div data-bar style="height:10px;border-radius:3px;width:' + pct + '%;background:' + (longest ? 'var(--obs-warn,#d97706)' : 'var(--obs-info,#3b82f6)') + '"></div></div>'
              : '<span class="obs-muted">—</span>';
            return '<tr><td>' + esc(s.step_index + 1) + '</td><td>' + esc(s.node_name) + '</td><td><code>' + esc(s.node_type) + '</code></td><td>' + sBadge(STEP_KO, s.status) +
              '</td><td>' + esc(fmtDur(d)) + (longest && steps.length > 1 ? ' ' + O.badge('가장 김', 'warn') : '') + '</td><td>' + bar + '</td><td>' + esc(s.llm_calls || 0) +
              '</td><td class="obs-muted">' + esc(s.error ? String(s.error).slice(0, 120) : '') + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      body.innerHTML = html;
    }).catch(function (e) { body.innerHTML = '<div class="obs-error" role="alert">' + esc(e.message) + '</div>'; });
  }

  function mount(el, opts) {
    var route = (opts && opts.route) || 'workflows';
    var m = /^workflow-run\/(.+)$/.exec(route);
    if (m) renderDetail(el, m[1]); else renderList(el, { status: '' });
    return { unmount: function () { el.innerHTML = ''; } };
  }

  O.workflows = { mount: mount, version: 'obs-workflows-1' };
})(typeof window !== 'undefined' ? window : globalThis);
