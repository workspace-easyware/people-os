// 메일함 (2026-11-17) — /api/email/* 화면. index.html 인라인 스크립트의 전역($, api, esc, currentUser)을 쓴다.
// HTML 본문은 sandbox iframe(스크립트·같은 출처 불가) + CSP(외부 이미지·추적 픽셀 차단)로만 보여준다.
let emailFolder = 'in', emailPage = 1, emailQuery = '', emailCurrent = null;

function emailFmt(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(s).slice(0, 16); }
}
function emailName(addr) {
  const s = String(addr || '');
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>/);
  return (m && m[1].trim()) || s.replace(/[<>]/g, '');
}
function emailSize(n) {
  n = Number(n) || 0;
  return n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(1) + 'KB' : (n / 1048576).toFixed(1) + 'MB';
}
function emailShow(which) {
  $('emailListCard').style.display = which === 'list' ? '' : 'none';
  $('emailDetailCard').style.display = which === 'detail' ? '' : 'none';
  $('emailComposeCard').style.display = which === 'compose' ? '' : 'none';
}
function emailOpen() {
  const admin = !!(currentUser && currentUser.role === 'hr_admin');
  $('emailScope').style.display = admin ? '' : 'none';
  emailShow('list');
  emailLoad(1);
}
function emailSetFolder(f) {
  emailFolder = f; emailQuery = ''; $('emailSearch').value = '';
  ['in', 'starred', 'out'].forEach(x => $('emailFolder-' + x).setAttribute('aria-selected', x === f ? 'true' : 'false'));
  emailShow('list');
  emailLoad(1);
}
function emailDoSearch() {
  emailQuery = $('emailSearch').value.trim();
  emailShow('list');
  emailLoad(1);
}
async function emailLoad(page) {
  emailPage = page || 1;
  const scope = $('emailScope').style.display === 'none' ? '' : '&scope=' + encodeURIComponent($('emailScope').value);
  const url = emailQuery
    ? `/api/email/search?q=${encodeURIComponent(emailQuery)}&page=${emailPage}${scope}`
    : `/api/email/inbox?folder=${emailFolder}&page=${emailPage}${scope}`;
  $('emailList').innerHTML = '<p class="loading">불러오는 중…</p>';
  let j;
  try { j = await api(url); } catch { j = { ok: false, error: '네트워크 오류' }; }
  if (!j.ok) { $('emailList').innerHTML = `<p class="small">${esc(j.error || '불러오지 못했습니다.')}</p>`; $('emailPager').innerHTML = ''; return; }
  $('emailMyAddr').textContent = j.address || '—';
  $('emailFromAddr').textContent = j.address || '—';
  emailBadge(j.unread);
  const head = emailQuery ? `<p class="small">“${esc(emailQuery)}” 검색 결과</p>` : '';
  if (!j.emails.length) {
    $('emailList').innerHTML = head + `<p class="small">${emailQuery ? '검색 결과가 없습니다.' : emailFolder === 'out' ? '보낸 메일이 없습니다.' : '메일이 없습니다. ' + esc(j.address || '') + '로 받은 메일이 여기에 쌓입니다.'}</p>`;
  } else {
    $('emailList').innerHTML = head + '<div class="email-list">' + j.emails.map(m => {
      const who = m.direction === 'out' ? '받는 사람: ' + emailName(m.to_addr) : emailName(m.from_addr);
      const unread = m.direction === 'in' && !m.is_read;
      return `<div class="email-row${unread ? ' unread' : ''}" onclick="emailView('${escAttr(m.id)}')">
        <button type="button" class="email-star${m.is_starred ? ' on' : ''}" title="별표" aria-label="별표" aria-pressed="${m.is_starred ? 'true' : 'false'}" onclick="event.stopPropagation();emailStar('${escAttr(m.id)}', this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></button>
        <div class="email-from">${unread ? '<span class="email-dot" aria-label="안 읽음"></span>' : ''}${esc(who)}</div>
        <div class="email-subj"><b>${esc(m.subject || '(제목 없음)')}</b> <span class="small">${esc(m.snippet || '')}</span></div>
        <div class="email-meta">${m.attachments ? '<svg class="email-clip" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="첨부 있음"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' : ''}${m.owner !== undefined ? `<span class="badge">${esc(m.owner || '공용·미지정')}</span> ` : ''}${esc(emailFmt(m.received_at))}</div>
      </div>`;
    }).join('') + '</div>';
  }
  $('emailPager').innerHTML =
    (emailPage > 1 ? `<button class="secondary" type="button" onclick="emailLoad(${emailPage - 1})">← 이전</button>` : '') +
    (j.hasMore ? `<button class="secondary" type="button" onclick="emailLoad(${emailPage + 1})">다음 →</button>` : '');
}
function emailBadge(n) {
  const b = $('emailUnreadBadge');
  if (!b) return;
  b.textContent = n > 99 ? '99+' : String(n || '');
  b.style.display = n ? '' : 'none';
}
async function emailStar(id, btn) {
  const j = await api(`/api/email/${encodeURIComponent(id)}/star`, { method: 'POST', body: '{}' });
  if (!j.ok) return alert(j.error || '실패');
  if (btn) { btn.classList.toggle('on', j.is_starred); btn.setAttribute('aria-pressed', j.is_starred ? 'true' : 'false'); }
  if (emailCurrent && emailCurrent.id === id) emailCurrent.is_starred = j.is_starred;
}
async function emailView(id) {
  emailShow('detail');
  const card = $('emailDetailCard');
  card.innerHTML = '<p class="loading">불러오는 중…</p>';
  const j = await api(`/api/email/${encodeURIComponent(id)}`);
  if (!j.ok) { card.innerHTML = `<p class="small">${esc(j.error || '불러오지 못했습니다.')}</p><button class="secondary" onclick="emailShow('list')">← 목록</button>`; return; }
  const m = j.email;
  emailCurrent = m;
  if (m.direction === 'in' && !m.is_read) api(`/api/email/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' }).catch(() => {});
  const atts = (j.attachments || []).map(a =>
    `<li><a href="/api/email/${encodeURIComponent(id)}/attachment/${encodeURIComponent(a.id)}">${esc(a.filename)}</a> <span class="small">${esc(a.content_type || '')} · ${emailSize(a.size)}</span></li>`).join('');
  const thread = (j.thread || []).length > 1 ? `<h3>스레드 (${j.thread.length})</h3><ul class="email-thread">` + j.thread.map(t =>
    `<li${t.id === id ? ' class="cur"' : ''}><a href="#" onclick="event.preventDefault();emailView('${escAttr(t.id)}')">${esc(t.direction === 'out' ? '나 → ' : emailName(t.from_addr) + ' · ')}${esc(t.subject || '(제목 없음)')}</a> <span class="small">${esc(emailFmt(t.received_at))}</span></li>`).join('') + '</ul>' : '';
  card.innerHTML = `
    <div class="btnrow"><button class="secondary" type="button" onclick="emailShow('list');emailLoad(emailPage)">← 목록</button>
      ${m.direction === 'in' ? `<button class="secondary" type="button" onclick="emailReply()">답장</button>
      <button class="secondary" type="button" id="emailDraftBtn" onclick="emailDraft()">AI 답장 초안</button>` : ''}
      ${m.has_owner ? `<button class="secondary" type="button" id="emailIndexBtn" onclick="emailIndex()"${m.indexed_doc_id ? ' disabled' : ''}>${m.indexed_doc_id ? '개인 업무 검색에 색인됨' : '개인 업무 검색에 넣기'}</button>` : ''}
    </div>
    <h2>${esc(m.subject || '(제목 없음)')}</h2>
    <dl class="email-hdr">
      <dt>보낸 사람</dt><dd>${esc(m.from_addr)}</dd>
      <dt>받는 사람</dt><dd>${esc(m.to_addr)}</dd>
      ${m.cc ? `<dt>참조</dt><dd>${esc(m.cc)}</dd>` : ''}
      <dt>날짜</dt><dd>${esc(emailFmt(m.received_at))}</dd>
      ${m.owner !== undefined ? `<dt>소유자</dt><dd>${esc(m.owner || '공용·미지정 (HR 관리자만 봄)')}</dd>` : ''}
    </dl>
    ${m.parse_error ? `<p><span class="badge warn">파싱 경고</span> <span class="small">${esc(m.parse_error)} — 원문은 보관돼 있습니다.</span></p>` : ''}
    <div id="emailBodyBox"></div>
    ${atts ? `<h3>첨부 (${j.attachments.length})</h3><ul>${atts}</ul>` : ''}
    ${thread}
    <div id="emailDraftBox">${m.ai_draft ? emailDraftHtml(m.ai_draft, m.ai_draft_at) : ''}</div>`;
  emailRenderBody($('emailBodyBox'), m);
}
function emailRenderBody(box, m) {
  if (m.body_html) {
    const f = document.createElement('iframe');
    f.className = 'email-html';
    // 스크립트·폼·같은 출처 모두 금지. 링크만 새 탭으로 열 수 있게 popups 허용.
    f.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('referrerpolicy', 'no-referrer');
    f.title = '메일 본문';
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
    // 보안점검(2026-11-22) Low: 보낸 쪽이 넣은 <meta http-equiv>(refresh로 프레임을 바깥 사이트로 보냄 — 열람 확인·IP 노출)와 <base>를 뺀다.
    // 스크립트는 sandbox·CSP가 이미 막는다. 이 치환은 그 위에 얹는 보조 방어다.
    const bodyHtml = String(m.body_html).replace(/<meta\b[^>]*>/gi, '').replace(/<base\b[^>]*>/gi, '');
    f.srcdoc = csp + '<base target="_blank">' + bodyHtml;
    f.onload = () => { try { f.style.height = Math.min(1600, Math.max(200, f.contentDocument ? f.contentDocument.body.scrollHeight + 24 : 480)) + 'px'; } catch { f.style.height = '480px'; } };
    box.appendChild(f);
    const note = document.createElement('p');
    note.className = 'small';
    note.textContent = '보안을 위해 외부 이미지·스크립트는 차단됩니다.';
    box.appendChild(note);
  } else {
    const pre = document.createElement('pre');
    pre.className = 'email-text';
    pre.textContent = m.body_text || '(본문 없음)';
    box.appendChild(pre);
  }
}
function emailDraftHtml(text, at) {
  return `<div class="email-draft"><h3>AI 답장 초안 <span class="small">${esc(emailFmt(at))} · 자동 발송되지 않습니다</span></h3>
    <pre class="email-text">${esc(text)}</pre>
    <div class="btnrow"><button class="primary" type="button" onclick="emailReply(true)">초안으로 답장 작성</button></div></div>`;
}
async function emailDraft() {
  if (!emailCurrent) return;
  const btn = $('emailDraftBtn');
  btn.disabled = true; btn.textContent = '초안 생성 중…';
  const j = await api(`/api/email/${encodeURIComponent(emailCurrent.id)}/draft`, { method: 'POST', body: '{}' }).catch(() => ({ ok: false, error: '네트워크 오류' }));
  btn.disabled = false; btn.textContent = 'AI 답장 초안';
  if (!j.ok) return alert(j.error || '초안 생성 실패');
  emailCurrent.ai_draft = j.draft; emailCurrent.ai_draft_at = j.at;
  $('emailDraftBox').innerHTML = emailDraftHtml(j.draft, j.at);
}
async function emailIndex() {
  if (!emailCurrent) return;
  const btn = $('emailIndexBtn');
  btn.disabled = true; btn.textContent = '색인 중…';
  const j = await api(`/api/email/${encodeURIComponent(emailCurrent.id)}/index`, { method: 'POST', body: '{}' }).catch(() => ({ ok: false, error: '네트워크 오류' }));
  if (!j.ok) { btn.disabled = false; btn.textContent = '개인 업무 검색에 넣기'; return alert(j.error || '색인 실패'); }
  btn.textContent = j.indexError ? '색인 일부 실패 (문서는 저장됨)' : '개인 업무 검색에 색인됨';
}
function emailCompose() {
  $('emailComposeTitle').textContent = '새 메일';
  $('emailTo').value = ''; $('emailCc').value = ''; $('emailSubject').value = ''; $('emailBody').value = '';
  $('emailReplyToId').value = ''; $('emailSendResult').innerHTML = '';
  if ($('emailFromAddr').textContent === '—') api('/api/email/inbox?limit=1').then(j => { if (j.ok) $('emailFromAddr').textContent = j.address; }).catch(() => {});
  emailShow('compose');
}
function emailReply(useDraft) {
  const m = emailCurrent;
  if (!m) return;
  emailCompose();
  $('emailComposeTitle').textContent = '답장';
  const addr = (String(m.from_addr).match(/<([^>]+)>/) || [null, m.from_addr])[1];
  $('emailTo').value = addr || '';
  $('emailSubject').value = /^\s*(re|회신|답장)\s*:/i.test(m.subject || '') ? m.subject : 'Re: ' + (m.subject || '');
  const quoted = (m.body_text || '').split('\n').slice(0, 40).map(l => '> ' + l).join('\n');
  $('emailBody').value = (useDraft && m.ai_draft ? m.ai_draft : '') + `\n\n${emailFmt(m.received_at)}, ${m.from_addr} 작성:\n${quoted}`;
  $('emailReplyToId').value = m.id;
}
function emailCloseCompose() {
  if (emailCurrent && $('emailReplyToId').value) emailShow('detail'); else emailShow('list');
}
async function emailSend() {
  const body = {
    to: $('emailTo').value, cc: $('emailCc').value, subject: $('emailSubject').value.trim(), text: $('emailBody').value,
  };
  if ($('emailReplyToId').value) body.replyToId = $('emailReplyToId').value;
  if (!body.to.trim() || !body.subject || !body.text.trim()) { $('emailSendResult').innerHTML = '<p class="small">받는 사람·제목·본문을 입력하세요.</p>'; return; }
  const btn = $('emailSendBtn');
  btn.disabled = true; btn.textContent = '발송 중…';
  const j = await api('/api/email/send', { method: 'POST', body: JSON.stringify(body) }).catch(() => ({ ok: false, error: '네트워크 오류' }));
  btn.disabled = false; btn.textContent = '발송';
  if (!j.ok) { $('emailSendResult').innerHTML = `<p><span class="badge warn">발송 실패</span> <span class="small">${esc(j.error || '')}</span></p>`; return; }
  $('emailSendResult').innerHTML = `<p><span class="badge">발송됨</span> <span class="small">${esc(j.from)}에서 보냈습니다.</span></p>`;
  setTimeout(() => { emailSetFolder('out'); }, 800);
}
