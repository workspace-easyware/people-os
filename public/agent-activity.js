// 에이전트 활동 타임라인 홈 카드 (A1, 2026-11-17, presentation-plan.md 6.2 계약).
//   agentActivityCard(el) — el 안에 "에이전트가 최근에 한 일" 목록을 그린다.
//   익명(401)이거나 API가 404/503이면 el의 부모 카드를 숨긴다.
// index.html의 전역($, api, esc)에 기대지 않는다. switchTab이 있으면 항목을 눌러 해당 탭으로 간다.
// 스타일은 styles.css의 기존 클래스(.taskrow, .badge, .empty, .small)만 쓴다.
(function () {
  const SOURCE_LABEL = {
    recording: '녹음', ask: '질문', email_draft: '메일 초안',
    knowledge_gap: '지식 공백', digest: '다이제스트', eval: '자기 평가',
  };
  const HIDE_ON = [401, 403, 404, 503];

  function h(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff >= 0 && diff < 60) return '방금';
    if (diff >= 0 && diff < 3600) return Math.floor(diff / 60) + '분 전';
    if (diff >= 0 && diff < 86400) return Math.floor(diff / 3600) + '시간 전';
    try {
      return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso.slice(0, 16).replace('T', ' '); }
  }
  function statusBadge(it) {
    if (it.needsReview) return '<span class="badge warn" title="' + h(it.reviewHint || '') + '">확인 필요</span>';
    if (it.status === 'running') return '<span class="badge">진행 중</span>';
    if (it.status === 'error') return '<span class="badge warn">실패</span>';
    return '<span class="badge ok">완료</span>';
  }
  function hideCard(el) {
    const card = el && el.parentElement;
    if (card) card.style.display = 'none';
  }

  async function agentActivityCard(el, opts) {
    if (!el) return;
    const limit = (opts && opts.limit) || 8;
    el.innerHTML = '<p class="small">불러오는 중…</p>';
    let res, j;
    try {
      res = await fetch('/api/agent/activity?limit=' + encodeURIComponent(limit), { credentials: 'same-origin' });
    } catch {
      el.innerHTML = '<p class="empty">에이전트 활동을 불러오지 못했습니다.</p>';
      return;
    }
    if (HIDE_ON.includes(res.status)) { hideCard(el); return; }
    try { j = await res.json(); } catch { j = null; }
    if (!res.ok || !j || !j.ok) {
      el.innerHTML = '<p class="empty">에이전트 활동을 불러오지 못했습니다.</p>';
      return;
    }
    const card = el.parentElement;
    if (card) card.style.display = '';
    const items = Array.isArray(j.items) ? j.items : [];
    if (!items.length) {
      el.innerHTML = '<p class="empty">아직 에이전트가 한 일이 없습니다. 녹음을 올리거나 질문하면 여기에 쌓입니다.</p>';
      return;
    }
    const canGo = typeof window.switchTab === 'function';
    const head = '<p class="small">' + (j.scope === 'all' ? '전체 사용자 + 시스템 작업' : '내 요청으로 에이전트가 한 일') +
      (j.needsReview ? ' · <b>사람 확인 필요 ' + h(j.needsReview) + '건</b>' : '') + '</p>';
    el.innerHTML = head + items.map(function (it) {
      const owner = it.owner ? '<span class="badge" title="소유자">' + h(it.owner.name) + '</span>'
        : (j.scope === 'all' && it.system ? '<span class="badge" title="시스템 작업">시스템</span>' : '');
      const go = canGo && it.tab ? ' style="cursor:pointer" data-agent-tab="' + h(it.tab) + '" role="button" tabindex="0"' : '';
      return '<div class="taskrow"' + go + '>' +
        '<span class="badge">' + h(SOURCE_LABEL[it.source] || it.source) + '</span>' +
        '<span class="t-title">' + h(it.what) + '<br><span class="small">' + h(it.result) +
        (it.needsReview && it.reviewHint ? ' — ' + h(it.reviewHint) : '') + '</span></span>' +
        '<span class="t-meta">' +
        // 모바일 메타 한 줄용 출처 라벨 사본 (데스크톱은 .m-only가 숨기고, 원래 앞쪽 배지는 모바일에서 숨긴다)
        '<span class="m-only badge">' + h(SOURCE_LABEL[it.source] || it.source) + '</span>' +
        owner + statusBadge(it) +
        '<span class="t-src">' + h(when(it.at)) + '</span></span></div>';
    }).join('');
    if (canGo) {
      el.querySelectorAll('[data-agent-tab]').forEach(function (row) {
        const go = function () { window.switchTab(row.getAttribute('data-agent-tab')); };
        row.addEventListener('click', go);
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      });
    }
  }

  window.agentActivityCard = agentActivityCard;
})();
