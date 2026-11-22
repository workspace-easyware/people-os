/* Think T3 — 관측 · 어시스턴트 턴 화면 (public/obs/assistant.js). common.js 다음에 로드한다. 스타일: obs.css.
 *
 *   PeopleOSObs.assistant.mount(el, { route })     route: 'assistant'
 *
 * API (src/obs/routes-workflows.ts, hr_admin 전용·읽기 전용):
 *   GET /api/obs/assistant-turns?limit=50&owner=   → {turns:[{user_id,owner_email,owner_name,turn_no,status,stopped_reason,steps,llm_calls,tool_calls,tools,research_runs,recoveries,duration_ms,started_at,ended_at}]}
 * 대화 내용은 오지 않는다 (상태·숫자·도구 이름만). 서버 데이터는 전부 esc()를 거쳐 넣는다.
 */
(function (global) {
  'use strict';
  var O = global.PeopleOSObs;
  if (!O || !O.obsFetch) { console.error('[obs] common.js must load before assistant.js'); return; }
  var esc = O.esc, escAttr = O.escAttr;

  var ST_KO = { completed: ['완료', 'ok'], aborted: ['중단', 'err'], skipped: ['건너뜀', ''], error: ['오류', 'err'] };
  var STOP_KO = { max_steps: '단계 상한', llm_cap: 'LLM 상한', timeout: '시간 상한', repeat_tool: '같은 도구 반복', tool_selection_failed: '도구 선택 실패' };
  function sBadge(s) { var x = ST_KO[s] || [s || '—', '']; return O.badge(x[0], x[1], s); }
  function fmtDur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return '—';
    if (ms < 1000) return ms + 'ms';
    var s = Math.round(ms / 1000);
    return s < 60 ? s + '초' : Math.floor(s / 60) + '분 ' + (s % 60) + '초';
  }

  function render(el, state) {
    el.innerHTML = '<p class="obs-muted">어시스턴트(에이전트 메뉴) 턴 요약입니다. 턴이 끝날 때 한 줄씩 남습니다. LLM 호출 = 모델 스텝 + LLM 도구 + 조사 하위 에이전트 사용분.</p>' +
      '<div class="obs-toolbar"><label>사용자<input data-f="owner" placeholder="이메일 또는 id" value="' + escAttr(state.owner) + '"></label>' +
      '<button type="button" data-f="go">조회</button></div><div data-body><p class="obs-muted">불러오는 중…</p></div>';
    var body = el.querySelector('[data-body]');
    var inp = el.querySelector('[data-f="owner"]');
    el.querySelector('[data-f="go"]').onclick = function () { state.owner = inp.value.trim(); render(el, state); };
    inp.onkeydown = function (ev) { if (ev.key === 'Enter') { state.owner = inp.value.trim(); render(el, state); } };
    O.obsFetch('/api/obs/assistant-turns?limit=100' + (state.owner ? '&owner=' + encodeURIComponent(state.owner) : '')).then(function (j) {
      var turns = j.turns || [];
      if (j.schemaMissing) { body.innerHTML = '<p class="obs-empty">assistant_turns 표가 아직 없습니다 (마이그레이션 0041).</p>'; return; }
      if (!turns.length) { body.innerHTML = '<p class="obs-empty">어시스턴트 턴 기록이 없습니다.</p>'; return; }
      var llm = 0, done = 0;
      turns.forEach(function (t) { llm += t.llm_calls || 0; if (t.status === 'completed' && !t.stopped_reason) done++; });
      body.innerHTML = '<p class="obs-muted">' + esc(turns.length) + '턴 · 멈춤 없이 완료 ' + esc(done) + ' · LLM 호출 합계 ' + esc(llm) + '</p>' +
        '<div class="obs-table-wrap"><table class="obs-table"><thead><tr><th>끝난 시각</th><th>사용자</th><th>턴</th><th>상태</th><th>멈춤 사유</th><th>스텝</th><th>LLM 호출</th><th>도구 호출</th><th>도구</th><th>조사 위임</th><th>복구</th><th>소요</th></tr></thead><tbody>' +
        turns.map(function (t) {
          var who = (t.owner_name ? t.owner_name + ' ' : '') + (t.owner_email ? '(' + t.owner_email + ')' : t.user_id);
          return '<tr><td>' + esc(O.kst(t.ended_at)) + '</td><td>' + esc(who) + '</td><td>' + esc(t.turn_no) + '</td><td>' + sBadge(t.status) +
            '</td><td>' + (t.stopped_reason ? O.badge(STOP_KO[t.stopped_reason] || t.stopped_reason, 'warn') : '') + '</td><td>' + esc(t.steps) +
            '</td><td>' + esc(t.llm_calls) + '</td><td>' + esc(t.tool_calls) + '</td><td>' + (t.tools || []).map(function (x) { return '<code>' + esc(x) + '</code>'; }).join(' ') +
            '</td><td>' + esc(t.research_runs || 0) + '</td><td>' + esc(t.recoveries || 0) + '</td><td>' + esc(fmtDur(t.duration_ms)) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }).catch(function (e) { body.innerHTML = '<div class="obs-error" role="alert">' + esc(e.message) + '</div>'; });
  }

  function mount(el) {
    render(el, { owner: '' });
    return { unmount: function () { el.innerHTML = ''; } };
  }

  O.assistant = { mount: mount, version: 'obs-assistant-1' };
})(typeof window !== 'undefined' ? window : globalThis);
