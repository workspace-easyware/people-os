// 구문 확인 전용 (node --check). public/index.html 인라인 스크립트에서 이번에 고친 블록을 그대로 옮겼다.
let currentUser = null; const $ = () => null; const esc = (s) => s; const fmtDate = (s) => s; const fmtSize = (s) => s; const api = async () => ({}); const isCoachee = () => false;
const LIB_TYPES = {};
function libRow(x, dl, warn, ownerCell, coachBtn, del) {
    const editable = x.type === 'deck' || (x.type === 'upload' && x.hasSource && !x.failed && (x.sourceKind === 'pptx' || x.sourceKind === 'xlsx' || !x.sourceKind));
    const editBtn = currentUser && editable
      ? `<button class="secondary" onclick="openDocEdit('${x.type}','${esc(x.id)}', this.dataset.title)" data-title="${esc(x.title)}">편집본 만들기</button> `
      : currentUser && x.type === 'upload' && x.hasSource && !x.failed
        ? `<span class="small muted" title="편집본 만들기는 PPTX·XLSX만 됩니다">${x.sourceKind === 'docx' ? 'Word 편집 미지원 (새로 만들기는 됩니다)' : '편집 미지원 형식'}</span> ` : '';
    const openable = x.type !== 'deck' && !x.failed;
    const titleCell = openable
      ? `<a href="#" class="lib-open" title="요약 화면으로 열기" onclick="libOpenDoc('${esc(x.id)}');return false">${esc(x.title)}</a>`
      : esc(x.title);
    return `<tr><td>${titleCell}${warn}</td><td><span class="badge">${LIB_TYPES[x.type]}</span></td>${ownerCell}<td>${fmtDate(x.created_at)}</td><td>${x.size ? fmtSize(x.size) : '-'}</td><td><a href="${dl}">다운로드</a> ${editBtn}${coachBtn}${del}</td></tr>`;
}
const mapDoc = (d) => ({ id: d.id, title: d.title, type: d.kind === 'transcript' ? 'transcript' : 'upload', created_at: d.created_at, size: d.size, canDelete: d.canDelete, owner: d.owner, failed: d.extract_status === 'failed', err: d.extract_error, isCoaching: !!d.is_coaching, hasSource: !!d.has_source, sourceKind: d.source_kind || null });
let coachingDocs = [], coachingPickSeq = 0;
function coachingDedupe(docs) {
  const seen = new Map(), out = [];
  for (const x of docs) {
    const k = (x.title || '') + '\u0000' + (x.content || '') + '\u0000' + (x.owner_name || '');
    const hit = seen.get(k);
    if (hit) { hit.dupCount++; continue; }
    const y = { ...x, dupCount: 1 };
    seen.set(k, y); out.push(y);
  }
  return out;
}
async function loadCoachingPickers() {
  const seq = ++coachingPickSeq;
  const coachee = isCoachee();
  $('coachingCounterpartLabel').textContent = coachee ? '코치' : '코칭 대상';
  const docsP = api('/api/documents/coaching').then(d => d && d.ok ? { docs: d.documents || [] } : { docs: [], err: (d && d.error) || '불러오지 못했습니다' })
    .catch(() => ({ docs: [], err: '서버에 연결할 수 없습니다' }));
  const usersP = api('/api/users/coaching').then(u => u && u.ok ? { users: u.users || [] } : { users: [], err: (u && u.error) || '불러오지 못했습니다' })
    .catch(() => ({ users: [], err: '서버에 연결할 수 없습니다' }));
  usersP.then(({ users, err }) => {
    if (seq !== coachingPickSeq) return;
    const me = currentUser ? currentUser.id : null;
    const keepCp = $('coachingCounterpart').value;
    const want = coachee ? 'coach' : 'coachee';
    const others = users.filter(x => x.id !== me).sort((a, b) => (a.coaching_role === want ? 0 : 1) - (b.coaching_role === want ? 0 : 1));
    $('coachingCounterpart').innerHTML = '<option value="">' + (err ? `지정 안 함 — 목록 오류: ${esc(err)} (탭을 다시 열어 주세요)` : others.length ? '지정 안 함' : '지정 안 함 (고를 수 있는 다른 계정이 없습니다)') + '</option>' +
      others.map(x => `<option value="${esc(x.id)}">${esc(x.name || x.email)} (${esc(x.email)}) · ${x.coaching_role === 'coach' ? '코치' : '코칭 대상'}</option>`).join('');
    if (others.some(x => x.id === keepCp)) $('coachingCounterpart').value = keepCp;
  });
  const { docs, err: docErr } = await docsP;
  if (seq !== coachingPickSeq) return;
  coachingDocs = coachingDedupe(docs);
  const keepDoc = $('coachingDocPick').value;
  $('coachingDocPick').innerHTML = '<option value="">' + (docErr ? `직접 붙여넣기 — 전사본 목록 오류: ${esc(docErr)}` : '직접 붙여넣기') + '</option>' +
    coachingDocs.map(x => `<option value="${esc(x.id)}">${x.is_coaching ? '[코칭] ' : ''}${esc(x.title)} · ${fmtDate(x.created_at)}${x.owner_name ? ' · ' + esc(x.owner_name) : ''}${x.dupCount > 1 ? ` · 같은 내용 ${x.dupCount}개 (최신만 표시)` : ''}</option>`).join('');
  if (coachingDocs.some(x => x.id === keepDoc)) $('coachingDocPick').value = keepDoc;
  await usersP;
}
