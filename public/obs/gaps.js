/* S4 M5 — 개선 루프(공백) 화면 (public/obs/gaps.js). common.js 다음에 로드한다. 스타일: obs.css + evals.css.
 *
 *   PeopleOSObs.gaps.mount(el, { route, navigate? })     route: 'gaps' (단일 화면)
 *   PeopleOSObs.gaps.openCount() → Promise<number>        하위 탭 라벨의 "열린 공백 N"
 *
 * API (routes-evals.ts · gaps.ts 계약 그대로):
 *   GET  /api/obs/gaps                  → {gaps:[{key,kind,question,status,count,gapId?,eventId?,resultId?,itemId?,docId?,lastSeenAt?,actions?[],judgeScore?,judgeReason?,baseRunId?}]}
 *   GET  /api/obs/gaps/count            → {open}
 *   POST /api/obs/gaps/:key/actions     {action: publish_tacit|fix_document|adjust_prompt|promote|dismiss, note?, docId?, promptVersionId?, itemId?,
 *                                         datasetId?, expectedAnswer?, expectedSources?, expectedVerdict?}
 *                                       → {action, itemId?, gapId?, existingItem?}   (409 'promote_required' = 연결 골든 항목 없음)
 *   POST /api/gaps/:gapId/publish       (기존 API) {answer, author} → {docId, docTitle, status, verification:{resolved, sources}}
 *   GET/POST /api/obs/prompts           → {prompts:[{id,name,version,body,status,note,created_at}], activeId} / {prompt}
 *   POST /api/obs/prompts/:id/activate  (관리자)
 *   POST /api/obs/evals/runs            {trigger:'regression'} 또는 {promptVersionId}
 */
(function (global) {
  'use strict';
  var O = global.PeopleOSObs;
  if (!O || !O.obsFetch) { console.error('[obs] common.js must load before gaps.js'); return; }
  var esc = O.esc, escAttr = O.escAttr;
  var DEFAULT_DATASET = 'ds_core_v1';

  var KIND = {
    no_evidence: ['근거 없음', 'warn'], downvote: ['아쉬움 피드백', 'warn'], low_score: ['낮은 점수', 'info'],
    hallucination_risk: ['환각 의심', 'err'], regression: ['회귀', 'err']
  };
  var STATUS = { open: ['열림', 'warn'], applied: ['적용함', 'info'], verified: ['검증됨', 'ok'], regressed: ['재발', 'err'], dismissed: ['무시', ''] };
  var ACTION_LABEL = { publish_tacit: '암묵지 게시', fix_document: '문서 수정', adjust_prompt: '프롬프트 조정', promote: '골든셋에 추가', dismiss: '무시' };

  function kindBadge(k) { var x = KIND[k] || [k, '']; return O.badge(x[0], x[1], k); }
  function statusBadge(s) { var x = STATUS[s] || [s || '—', '']; return O.badge(x[0], x[1], s); }

  /** 열린 공백 수 (M6이 하위 탭 라벨에 쓴다). 실패하면 0을 돌려주되 콘솔에 남긴다. */
  function openCount() {
    return O.obsFetch('/api/obs/gaps/count').then(function (r) { return typeof r.open === 'number' ? r.open : 0; })
      .catch(function (e) { global.console.warn('[obs] gaps count failed: ' + e.message); return 0; });
  }

  function openDialog(title, bodyHtml, okLabel, onSubmit) {
    var dlg = global.document.createElement('dialog');
    dlg.className = 'obs-dialog';
    dlg.innerHTML = '<form method="dialog" class="obs-dialog-form"><h3>' + esc(title) + '</h3>' + bodyHtml +
      '<div class="obs-dialog-error obs-error" hidden data-err role="alert"></div>' +
      '<div class="btnrow obs-dialog-actions"><button type="button" class="secondary" data-cancel>취소</button><button type="submit" class="primary" data-ok>' + esc(okLabel || '확인') + '</button></div></form>';
    global.document.body.appendChild(dlg);
    var form = dlg.querySelector('form'), err = dlg.querySelector('[data-err]'), ok = dlg.querySelector('[data-ok]');
    dlg.querySelector('[data-cancel]').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('close', function () { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.hidden = true; ok.disabled = true;
      Promise.resolve().then(function () { return onSubmit(form, dlg); }).then(function () { dlg.close(); })
        .catch(function (e) { err.textContent = e && e.message ? e.message : String(e); err.hidden = false; })
        .then(function () { ok.disabled = false; });
    });
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    var first = form.querySelector('input,select,textarea'); if (first) first.focus();
    return dlg;
  }

  function actionUrl(gap) { return '/api/obs/gaps/' + encodeURIComponent(gap.key) + '/actions'; }
  function postAction(gap, payload) { return O.obsFetch(actionUrl(gap), { method: 'POST', body: payload }); }

  /** 연결 골든 항목이 없을 때 대화상자에 붙이는 기대 답 입력 블록 (§4 규칙 1). */
  function itemBlock(gap) {
    if (gap.itemId) return '<p class="small obs-muted">연결된 골든 항목: <span class="obs-mono">' + esc(gap.itemId) + '</span></p>';
    return '<fieldset class="obs-fieldset"><legend>골든 항목으로 등록 (필수 — 고친 공백은 반드시 골든 항목이 됩니다)</legend>' +
      '<label class="obs-field">기대 답 (사람이 작성)<textarea name="expectedAnswer" rows="3" placeholder="이 질문에 대한 올바른 답을 직접 적어 주세요"></textarea></label>' +
      '<label class="obs-field">기대 판정<select name="expectedVerdict"><option value="grounded">grounded — 근거로 답해야 함</option><option value="ungrounded">ungrounded — 근거 없음이 정답</option></select></label>' +
      '</fieldset>';
  }

  /** gap에 연결 항목이 없으면 promote 동작으로 만들고 itemId를 돌려준다. */
  function ensureItem(gap, form, fallbackAnswer) {
    if (gap.itemId) return Promise.resolve(gap.itemId);
    var expectedAnswer = (form.expectedAnswer && form.expectedAnswer.value.trim()) || fallbackAnswer || '';
    var expectedVerdict = form.expectedVerdict ? form.expectedVerdict.value : 'grounded';
    return postAction(gap, { action: 'promote', datasetId: DEFAULT_DATASET, expectedAnswer: expectedAnswer, expectedVerdict: expectedVerdict })
      .then(function (r) { return r.itemId; });
  }

  // ---- 화면 -----------------------------------------------------------------------
  function renderGaps(el, opts) {
    var st = { gaps: [], kind: '', status: '', dead: false };
    el.innerHTML =
      '<div class="obs-root">' +
      '<p class="obs-notice obs-fixed-notice">평가 점수는 Workers AI judge의 추정치로, 추이와 회귀 감지용입니다. 절대적인 정답 판정이 아닙니다.</p>' +
      '<div data-regress-bar></div>' +
      '<div class="obs-flash" data-flash role="status" aria-live="polite"></div>' +
      '<form class="obs-toolbar" data-filters>' +
      '<label>종류<select name="kind"><option value="">전체</option>' +
      Object.keys(KIND).map(function (k) { return '<option value="' + k + '">' + esc(KIND[k][0]) + '</option>'; }).join('') + '</select></label>' +
      '<label>상태<select name="status"><option value="">전체</option><option value="open">열림 (재발 포함)</option><option value="applied">적용함</option><option value="verified">검증됨</option><option value="dismissed">무시</option></select></label>' +
      '</form>' +
      '<div data-body><div class="obs-empty loading">불러오는 중…</div></div></div>';
    var body = el.querySelector('[data-body]');
    var flash = el.querySelector('[data-flash]');
    var bar = el.querySelector('[data-regress-bar]');
    var form = el.querySelector('[data-filters]');

    function say(html, kind) { flash.innerHTML = html ? '<div class="obs-flash-box ' + (kind || '') + '">' + html + '</div>' : ''; }

    function visible() {
      return st.gaps.filter(function (g) {
        if (st.kind && g.kind !== st.kind) return false;
        if (st.status === 'open') return g.status === 'open' || g.status === 'regressed';
        if (st.status && g.status !== st.status) return false;
        return true;
      });
    }

    function drawBar() {
      var applied = st.gaps.filter(function (g) { return g.status === 'applied'; }).length;
      var openN = st.gaps.filter(function (g) { return g.status === 'open' || g.status === 'regressed'; }).length;
      bar.innerHTML = '<div class="obs-regress-bar' + (applied ? ' emph' : '') + '"><div><b>열린 공백 ' + esc(openN) + '</b> · 적용함(검증 대기) ' + esc(applied) + '</div>' +
        (applied
          ? '<div><span class="small">적용한 개선이 다른 질문을 깨뜨리지 않았는지 확인하세요.</span> <button type="button" class="primary" data-regress>회귀 실행</button></div>'
          : '<div class="small obs-muted">적용(applied)된 공백이 생기면 여기에 회귀 실행 버튼이 강조됩니다.</div>') + '</div>';
    }

    // 개선 코멘트 (재귀적 자기개선 근거): 평가 결과에서 온 공백에만 있다.
    // 평가 결과가 아닌 공백(no_evidence/downvote/사용자 low_score)은 빈칸.
    function improveBlock(g) {
      if (!g.resultId) return '';
      if (g.judgeComment) return '<div class="obs-improve"><b>개선 코멘트:</b> ' + esc(g.judgeComment) + '</div>';
      return '<div class="obs-improve obs-muted">이 실행에는 개선 코멘트가 없습니다 (judge-v2 이전 실행).</div>';
    }

    function actionsCell(g) {
      if (g.status === 'dismissed' || g.status === 'verified') return '<span class="obs-muted small">—</span>';
      return '<div class="obs-actions">' + ['publish_tacit', 'fix_document', 'adjust_prompt', 'promote', 'dismiss'].map(function (a) {
        return '<button type="button" class="secondary small" data-act="' + a + '" data-key="' + escAttr(g.key) + '">' + esc(ACTION_LABEL[a]) + '</button>';
      }).join('') + '</div>';
    }

    function historyRows(g) {
      if (!g.actions || !g.actions.length) return '';
      var list = g.actions.map(function (a) {
        return '<li>' + esc(O.kst(a.createdAt)) + ' · ' + esc(ACTION_LABEL[a.action] || a.action) + ' ' + statusBadge(a.status) +
          (a.note ? ' — ' + esc(a.note) : '') + (a.itemId ? ' · 항목 <span class="obs-mono">' + esc(a.itemId) + '</span>' : '') +
          (a.verifiedRunId ? ' · 검증 실행 <a href="#obs/run/' + escAttr(encodeURIComponent(a.verifiedRunId)) + '">' + esc(a.verifiedRunId) + '</a>' : '') + '</li>';
      }).join('');
      return '<details class="obs-history"><summary class="small">동작 이력 ' + esc(g.actions.length) + '건</summary><ul class="small">' + list + '</ul></details>';
    }

    function draw() {
      drawBar();
      var rows = visible();
      if (!rows.length) {
        body.innerHTML = '<div class="obs-empty">' + (st.gaps.length ? '조건에 맞는 공백이 없습니다.' : '열린 공백이 없습니다. 근거 없는 질문·아쉬움 피드백·낮은 judge 점수·회귀가 생기면 여기에 모입니다.') + '</div>';
        return;
      }
      body.innerHTML = '<div class="obs-table-wrap"><table class="obs-table obs-gaps-table"><thead><tr>' +
        '<th>질문</th><th>종류</th><th>횟수</th><th class="obs-th-date">최근 발생 (KST)</th><th>관련 문서·트레이스</th><th>judge 사유</th><th>상태</th><th>골든 항목</th><th class="obs-th-act">동작</th></tr></thead><tbody>' +
        rows.map(function (g) {
          var links = [];
          if (g.docId) links.push('<span class="obs-mono obs-ellip" title="문서 id: ' + escAttr(g.docId) + '">' + esc(g.docId) + '</span>');
          if (g.eventId) links.push('<a href="#obs/trace/' + escAttr(encodeURIComponent(g.eventId)) + '">트레이스</a>');
          var judge = g.judgeScore != null || g.judgeReason
            ? (g.judgeScore != null ? '<b>' + esc(O.fmtScore(g.judgeScore)) + '</b> ' : '') + '<span>' + esc(g.judgeReason || '') + '</span>' + improveBlock(g)
            : '<span class="obs-muted">—</span>';
          return '<tr class="obs-gap-row"><td class="obs-q" title="' + escAttr(g.question) + '">' + esc(g.question) + historyRows(g) + '</td>' +
            '<td>' + kindBadge(g.kind) + '<div class="small">질문자: <b>' + esc(g.askerName || '익명') + '</b></div></td><td class="obs-num">' + esc(g.count) + '</td>' +
            '<td class="obs-num obs-date">' + esc(O.kst(g.lastSeenAt)) + '</td>' +
            '<td class="obs-docs">' + (links.join(' ') || '<span class="obs-muted">—</span>') + '</td>' +
            '<td class="obs-judge-cell">' + judge + '</td>' +
            '<td>' + statusBadge(g.status) + '</td>' +
            '<td class="obs-mono obs-gid"' + (g.itemId ? ' title="' + escAttr(g.itemId) + '"' : '') + '>' + (g.itemId ? esc(g.itemId) : '<span class="obs-muted">—</span>') + '</td>' +
            '<td>' + actionsCell(g) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    function load() {
      return O.obsFetch('/api/obs/gaps').then(function (res) {
        if (st.dead) return;
        st.gaps = res.gaps || [];
        draw();
      }).catch(function (e) { if (!st.dead) { bar.innerHTML = ''; body.innerHTML = '<div class="obs-error">' + esc(e.message) + '</div>'; } });
    }
    function find(key) { return st.gaps.filter(function (g) { return g.key === key; })[0]; }
    function done(msg, kind) { say(msg, kind); return load(); }

    // ---- 동작 대화상자 ----
    function dlgPublish(g) {
      openDialog('암묵지 게시 — ' + g.question,
        '<p class="small obs-muted">답을 작성해 게시하면 암묵지 문서로 색인되고, 같은 질문을 다시 실행해 근거로 잡히는지 확인합니다.</p>' +
        '<label class="obs-field">답 (필수)<textarea name="answer" rows="5" required minlength="3"></textarea></label>' +
        '<label class="obs-field">작성자<input name="author" value="인사팀" maxlength="40"></label>' + itemBlock(g) +
        '<label class="obs-field">메모<input name="note" maxlength="300"></label>', '게시',
        function (f) {
          var answer = f.answer.value.trim(), author = f.author.value.trim() || '인사팀', note = f.note.value.trim();
          if (answer.length < 3) throw new Error('답을 3자 이상 적어 주세요.');
          return ensureItem(g, f, answer).then(function (itemId) {
            function publish(gapId) {
              return O.obsFetch('/api/gaps/' + encodeURIComponent(gapId) + '/publish', { method: 'POST', body: { answer: answer, author: author } });
            }
            // 공백 행이 이미 있으면 게시 성공 뒤에 동작을 기록하고, 없으면(낮은 점수·회귀 등) 동작이 공백 행을 먼저 만든다.
            var chain = g.gapId
              ? publish(g.gapId).then(function (pub) { return postAction(g, { action: 'publish_tacit', itemId: itemId, note: note || undefined }).then(function () { return pub; }); })
              : postAction(g, { action: 'publish_tacit', itemId: itemId, note: note || undefined }).then(function (ar) {
                if (!ar.gapId) throw new Error('공백 행 id를 받지 못했습니다.');
                return publish(ar.gapId);
              });
            return chain.then(function (pub) {
              var v = pub.verification || {};
              var n = Array.isArray(v.sources) ? v.sources.length : null;
              if (v.resolved) done('암묵지 「' + esc(pub.docTitle || '') + '」을 게시했고 검증을 통과했습니다 — 같은 질문이 이제 근거로 잡힙니다' + (n != null ? ' (근거 ' + n + '건)' : '') + '. 다음 평가에서 통과하면 "검증됨"이 됩니다.', 'ok');
              else done('게시는 됐지만 같은 질문을 다시 실행했을 때 근거로 잡히지 않았습니다 (verification.resolved = false, 상태 ' + esc(pub.status || '—') + '). 답이나 문서를 다시 확인하세요.', 'warn');
            });
          });
        });
    }

    function dlgFix(g) {
      openDialog('문서 수정 — ' + g.question,
        '<p class="small obs-muted">라이브러리/업로드 탭에서 관련 문서를 수정하거나 다시 업로드한 뒤, 여기서 "적용함"을 누르세요. 문서 id는 기록용입니다.</p>' +
        '<label class="obs-field">문서 id<input name="docId" value="' + escAttr(g.docId || '') + '" placeholder="예: doc_… (선택)"></label>' + itemBlock(g) +
        '<label class="obs-field">메모<input name="note" maxlength="300" placeholder="무엇을 고쳤는지"></label>', '적용함',
        function (f) {
          return ensureItem(g, f, '').then(function (itemId) {
            return postAction(g, { action: 'fix_document', itemId: itemId, docId: f.docId.value.trim() || undefined, note: f.note.value.trim() || undefined });
          }).then(function () { done('문서 수정을 "적용함"으로 기록했습니다. 회귀 실행으로 확인하세요.', 'ok'); });
        });
    }

    function dlgPrompt(g) {
      O.obsFetch('/api/obs/prompts?name=ask-system').then(function (res) {
        var prompts = res.prompts || [];
        var act = prompts.filter(function (p) { return p.id === res.activeId; })[0];
        var drafts = prompts.filter(function (p) { return p.status === 'draft'; });
        var isAdmin = !!(O.config && O.config.adminSecret);
        openDialog('프롬프트 조정 — ' + g.question,
          '<p class="small obs-muted">새 prompt 초안을 저장하고, 필요하면 초안으로 평가를 먼저 돌립니다 (라이브에는 반영되지 않습니다).</p>' +
          '<label class="obs-field">기준 버전<select name="pick"><option value="__new">새 초안 작성</option>' +
          drafts.map(function (p) { return '<option value="' + escAttr(p.id) + '">초안 v' + esc(p.version) + (p.note ? ' — ' + esc(p.note) : '') + '</option>'; }).join('') + '</select></label>' +
          '<label class="obs-field">prompt 본문 (새 초안일 때)<textarea name="body" rows="6">' + esc(act ? act.body : '') + '</textarea></label>' +
          '<label class="obs-field">초안 메모<input name="note" maxlength="300"></label>' + itemBlock(g) +
          '<label class="obs-check"><input type="checkbox" name="runEval" checked> 저장 후 이 초안으로 평가 먼저 실행</label>' +
          (isAdmin ? '<label class="obs-check"><input type="checkbox" name="activate"> 활성화 (관리자 — 평가 통과 확인 뒤에만)</label>' : ''), '저장·적용함',
          function (f) {
            return ensureItem(g, f, '').then(function (itemId) {
              var pick = f.pick.value;
              var pv = pick === '__new'
                ? O.obsFetch('/api/obs/prompts', { method: 'POST', body: { name: 'ask-system', body: f.body.value, note: f.note.value.trim() || undefined } }).then(function (r) { return r.prompt.id; })
                : Promise.resolve(pick);
              return pv.then(function (pvId) {
                return postAction(g, { action: 'adjust_prompt', itemId: itemId, promptVersionId: pvId, note: f.note.value.trim() || undefined }).then(function () {
                  var msg = 'prompt 초안 <span class="obs-mono">' + esc(pvId) + '</span>을 "적용함"으로 기록했습니다.';
                  var run = f.runEval.checked
                    ? O.obsFetch('/api/obs/evals/runs', { method: 'POST', body: { datasetId: DEFAULT_DATASET, promptVersionId: pvId } }).then(function (r) { msg += ' 평가를 시작했습니다 — <a href="#obs/run/' + escAttr(encodeURIComponent(r.runId)) + '">실행 ' + esc(r.runId) + ' 보기</a>.'; })
                    : Promise.resolve();
                  return run.then(function () {
                    if (f.activate && f.activate.checked) return O.obsFetch('/api/obs/prompts/' + encodeURIComponent(pvId) + '/activate', { method: 'POST', body: {} }).then(function () { msg += ' 활성화했습니다.'; });
                  }).then(function () { done(msg, 'ok'); });
                });
              });
            });
          });
      }).catch(function (e) { say(esc(e.message), 'err'); });
    }

    function dlgPromote(g) {
      openDialog('골든셋에 추가 — ' + g.question,
        '<p class="small obs-muted">이 질문을 골든 항목으로 만듭니다. 기대 답은 사람이 직접 적습니다 (모델이 정답을 만들지 않습니다). 같은 질문의 활성 항목이 있으면 그 항목에 연결됩니다.</p>' +
        '<label class="obs-field">데이터셋 id<input name="datasetId" value="' + escAttr(DEFAULT_DATASET) + '"></label>' +
        '<label class="obs-field">기대 답<textarea name="expectedAnswer" rows="4"></textarea></label>' +
        '<label class="obs-field">기대 판정<select name="expectedVerdict"><option value="grounded">grounded</option><option value="ungrounded">ungrounded (근거 없음이 정답)</option></select></label>', '추가',
        function (f) {
          return postAction(g, { action: 'promote', datasetId: f.datasetId.value.trim() || undefined, expectedAnswer: f.expectedAnswer.value.trim() || undefined, expectedVerdict: f.expectedVerdict.value })
            .then(function (r) {
              done(r.existingItem ? '같은 질문의 활성 항목 <span class="obs-mono">' + esc(r.itemId) + '</span>에 연결했습니다.' : '골든 항목 <span class="obs-mono">' + esc(r.itemId) + '</span>을 만들었습니다 (데이터셋 버전 +1).', 'ok');
            });
        });
    }

    function dlgDismiss(g) {
      openDialog('무시 — ' + g.question,
        '<label class="obs-field">사유 (필수)<textarea name="note" rows="3" required maxlength="1000"></textarea></label>', '무시',
        function (f) {
          var note = f.note.value.trim();
          if (!note) throw new Error('무시하는 사유를 적어 주세요.');
          return postAction(g, { action: 'dismiss', note: note }).then(function () { done('공백을 무시 처리했습니다.', 'ok'); });
        });
    }

    function regress(btn) {
      btn.disabled = true;
      O.obsFetch('/api/obs/evals/runs', { method: 'POST', body: { trigger: 'regression' } }).then(function (r) {
        say('회귀 실행을 시작했습니다 (항목 ' + esc(r.itemsTotal) + '개) — <a href="#obs/run/' + escAttr(encodeURIComponent(r.runId)) + '">실행 ' + esc(r.runId) + ' 보기</a>. 끝나면 적용한 공백이 검증됨/재발로 바뀝니다.', 'ok');
      }).catch(function (e) {
        var b = e.body || {};
        say(esc(e.status === 409 ? '이미 실행 중인 평가가 있습니다' + (b.runId ? ' (' + b.runId + ')' : '') : e.status === 429 ? '오늘 수동 실행 한도를 넘었습니다' : e.message), 'err');
      }).then(function () { btn.disabled = false; });
    }

    var DLG = { publish_tacit: dlgPublish, fix_document: dlgFix, adjust_prompt: dlgPrompt, promote: dlgPromote, dismiss: dlgDismiss };
    function onClick(ev) {
      var r = ev.target.closest('[data-regress]');
      if (r) { regress(r); return; }
      var b = ev.target.closest('[data-act]');
      if (!b) return;
      var g = find(b.getAttribute('data-key'));
      if (g && DLG[b.getAttribute('data-act')]) DLG[b.getAttribute('data-act')](g);
    }
    function onChange(ev) {
      if (ev.target.form === form) { st.kind = form.kind.value; st.status = form.status.value; draw(); }
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); });
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    load();
    return function () { st.dead = true; el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); };
  }

  function mount(el, opts) {
    opts = opts || {};
    var cleanup = renderGaps(el, opts);
    return { unmount: function () { if (cleanup) cleanup(); el.innerHTML = ''; } };
  }

  O.gaps = { mount: mount, openCount: openCount, version: 'obs-gaps-1' };
})(typeof window !== 'undefined' ? window : globalThis);
