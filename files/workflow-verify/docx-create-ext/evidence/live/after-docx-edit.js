// Word 편집본 만들기 (2026-11-22). 라이브러리 파일 목록에서 Word(.docx) 문서의 "편집본 만들기" 버튼이 openDocxEdit()로 연다.
// 서버: POST /api/docx/inspect · POST /api/docx/edit · GET /api/docx/versions (src/index.ts, 편집은 별도 Worker DOC_EDITOR의 DOCX RPC).
// 원본은 그대로 두고 편집본을 새 문서로 저장한다 — 다운로드는 GET /api/documents/<새 id>/download.
// 보안: 서버·문서 데이터는 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// pptx-edit.js의 pxPanel()·pxEl()·pxPost()·pxClose()와 index.html 인라인 스크립트의 전역 api()를 쓴다 (index.html에서 pptx-edit.js 다음에 읽는다).

let dxState = null; // { source: "doc:<id>", title, summary }

async function openDocxEdit(id, title) {
  const source = 'doc:' + id;
  const p = pxPanel();
  p.replaceChildren(pxEl('h3', { text: `Word 편집본 만들기 — ${title}` }), pxEl('p', { class: 'small', text: '문서 구조를 읽는 중…' }));
  p.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const j = await pxPost('/api/docx/inspect', { source });
  if (!j.ok) {
    p.replaceChildren(pxEl('h3', { text: `Word 편집본 만들기 — ${title}` }), pxEl('p', { class: 'error', text: '열 수 없습니다: ' + (j.error || '알 수 없는 오류') }), pxEl('button', { class: 'secondary', onclick: pxClose, text: '닫기' }));
    return;
  }
  dxState = { source, title, summary: j };
  dxRender();
}

/** 글 입력칸: 줄바꿈이 있거나 길면 textarea, 아니면 input. 잘린 미리보기(clipped)는 읽기 전용. */
function dxField(text, clipped, wide) {
  const multi = text.includes('\n') || text.length > 60;
  const el = multi ? pxEl('textarea', { rows: String(Math.min(6, Math.max(2, Math.ceil(text.length / 60)))), style: `width:${wide ? '100%' : '14em'}` }) : pxEl('input', { type: 'text', style: `width:${wide ? '100%' : '9em'}` });
  el.value = text;
  if (clipped) { el.readOnly = true; el.style.background = '#f3f4f6'; el.title = '글이 길어 앞부분만 보입니다. 찾아 바꾸기나 자연어 지시로 고치세요.'; }
  return el;
}

function dxRender() {
  const { title, summary } = dxState;
  const p = pxPanel();
  const kids = [pxEl('h3', { text: `Word 편집본 만들기 — ${title}` })];
  kids.push(pxEl('p', { class: 'small', text: `문단 ${summary.paragraphCount}개 · 표 ${summary.tableCount}개${summary.images ? ` · 그림 ${summary.images}개` : ''}${summary.comments ? ` · 메모 ${summary.comments}개` : ''}. 원본은 그대로 두고 편집본을 새 문서로 저장합니다. 글자만 바꾸고 서식·그림·머리글 구조는 그대로 둡니다.` }));
  if (summary.trackedChanges) kids.push(pxEl('p', { class: 'badge warn', text: '이 문서에는 변경 내용 추적이 남아 있습니다. 여기서 하는 편집은 추적으로 기록되지 않고 바로 반영됩니다 (삭제로 추적된 글자는 건드리지 않습니다).' }));
  if (summary.signed) kids.push(pxEl('p', { class: 'badge warn', text: '서명된 문서입니다. 편집본에서는 디지털 서명이 없어집니다.' }));
  if (summary.protected) kids.push(pxEl('p', { class: 'small', text: '편집 제한(문서 보호)이 걸린 문서입니다. 보호 설정은 편집본에도 그대로 남습니다.' }));

  // 1) 찾아 바꾸기 — 서식을 가장 잘 지킨다
  const findIn = pxEl('input', { type: 'text', style: 'width:14em', placeholder: '찾을 글자' });
  const toIn = pxEl('input', { type: 'text', style: 'width:14em', placeholder: '바꿀 글자' });
  const allIn = pxEl('input', { type: 'checkbox', id: 'dxAll' });
  allIn.checked = true;
  kids.push(pxEl('h4', { text: '1. 찾아 바꾸기' }),
    pxEl('p', { class: 'small', text: '본문·표·머리글·바닥글에서 찾습니다. 글자 서식은 그대로 유지됩니다.' }),
    pxEl('div', { class: 'btnrow' }, findIn, ' → ', toIn, pxEl('label', { for: 'dxAll' }, allIn, ' 모두 바꾸기 (끄면 처음 1곳만)')));

  // 2) 직접 고치기: 문단·표 미리보기 (블록 400개까지)
  const inputs = []; // { el, orig, op }
  const list = pxEl('div', { style: 'max-height:420px;overflow:auto;border:1px solid #e5e7eb;padding:8px;border-radius:6px' });
  for (const b of summary.blocks) {
    if (b.type === 'paragraph') {
      if (!b.text && !b.list) continue; // 빈 문단은 건너뛴다 (번호는 그대로)
      const el = dxField(b.text, b.clipped, true);
      if (!b.clipped) inputs.push({ el, orig: b.text, op: { op: 'paragraph', index: b.index } });
      list.append(pxEl('div', { style: 'display:flex;gap:6px;align-items:flex-start;margin-bottom:4px' },
        pxEl('span', { class: 'small', style: 'min-width:5.5em;color:#6b7280', title: b.style ? `스타일 ${b.style}` : '', text: `${b.index}${b.style ? ' · ' + b.style.slice(0, 10) : ''}${b.list ? ' •' : ''}` }), el));
    } else {
      const tbl = pxEl('table', { style: 'border-collapse:collapse;margin:6px 0 10px;font-size:12px' });
      b.rows.forEach((row, r) => {
        const tr = pxEl('tr');
        row.forEach((cell, c) => {
          const el = dxField(cell.text, cell.clipped, false);
          if (!cell.clipped) inputs.push({ el, orig: cell.text, op: { op: 'cell', table: b.table, r, c } });
          tr.append(pxEl('td', { style: 'padding:1px;border:1px solid #e5e7eb' }, el));
        });
        tbl.append(tr);
      });
      list.append(pxEl('div', { class: 'small', style: 'color:#6b7280', text: `표 ${b.table} (${b.rowCount}행${b.rowCount > b.rows.length ? `, 앞 ${b.rows.length}행만 표시` : ''})` }), tbl);
    }
  }
  kids.push(pxEl('h4', { text: '2. 또는 직접 고치기 (문단·표 셀)' }),
    pxEl('p', { class: 'small', text: `왼쪽 숫자는 문단 번호입니다. 문단을 직접 고치면 그 문단의 글자 서식이 첫 부분 서식 하나로 맞춰집니다 — 일부 글자만 바꿀 때는 1번 찾아 바꾸기를 쓰세요.${summary.truncated ? ' 문서가 길어 앞부분만 보입니다.' : ''}` }), list);
  if (summary.headers.length || summary.footers.length) {
    kids.push(pxEl('p', { class: 'small', text: `머리글: ${summary.headers.join(' / ') || '(없음)'} · 바닥글: ${summary.footers.join(' / ') || '(없음)'} — 머리글·바닥글은 찾아 바꾸기로만 고칩니다.` }));
  }

  // 3) 자연어 지시
  const instr = pxEl('textarea', { rows: '3', style: 'width:100%', placeholder: '예: 문서 전체에서 "홍길동"을 "김철수"로 바꾸고, 제목 끝에 "(수정본)"을 붙여 줘. 표의 세션 수 실적을 26으로 고쳐 줘' });
  kids.push(pxEl('h4', { text: '3. 또는 자연어로 지시 (AI가 편집 계획을 만듭니다)' }), instr);

  // 4) ops JSON (고급)
  const opsBox = pxEl('textarea', { rows: '4', style: 'width:100%;font-family:monospace', placeholder: '[{"op":"replace","find":"홍길동","to":"김철수","all":true},{"op":"paragraph","index":1,"text":"새 제목"},{"op":"cell","table":1,"r":1,"c":2,"text":"26"},{"op":"insert","after":3,"text":"새 문단"},{"op":"delete","index":5}]' });
  kids.push(pxEl('details', {}, pxEl('summary', { text: '4. 고급: ops JSON 직접 입력' }),
    pxEl('p', { class: 'small', text: 'op: replace(find, to, all?) · paragraph(index, text) · cell(table, r, c, text — r·c는 0부터) · insert(after, text — 0이면 맨 앞) · delete(index). 문단 번호는 모두 편집 전 번호입니다.' }), opsBox));

  const titleIn = pxEl('input', { type: 'text', style: 'width:100%', placeholder: `편집본 이름 (비우면 "${title} (편집본)")` });
  const err = pxEl('p', { class: 'error' });
  const result = pxEl('div', { id: 'dxResult' });
  const go = pxEl('button', {
    class: 'primary', text: '편집본 만들기', onclick: async () => {
      err.textContent = '';
      const body = { source: dxState.source };
      if (titleIn.value.trim()) body.title = titleIn.value.trim();
      const ops = [];
      if (findIn.value) ops.push({ op: 'replace', find: findIn.value, to: toIn.value, ...(allIn.checked ? { all: true } : {}) });
      else if (toIn.value) { err.textContent = '찾을 글자를 입력하세요.'; return; }
      for (const x of inputs) if (x.el.value !== x.orig) ops.push({ ...x.op, text: x.el.value });
      const rawOps = opsBox.value.trim();
      if (rawOps) {
        let extra;
        try { extra = JSON.parse(rawOps); } catch { err.textContent = 'ops가 올바른 JSON이 아닙니다.'; return; }
        if (!Array.isArray(extra)) { err.textContent = 'ops는 JSON 배열이어야 합니다.'; return; }
        ops.push(...extra);
      }
      if (ops.length && instr.value.trim()) { err.textContent = '찾아 바꾸기·직접 고치기·ops와 자연어 지시는 함께 쓸 수 없습니다. 하나만 남겨 주세요.'; return; }
      if (ops.length) body.ops = ops;
      else if (instr.value.trim()) body.instruction = instr.value.trim();
      else { err.textContent = '고칠 내용을 입력하세요 (찾아 바꾸기, 직접 고치기, 지시, ops 중 하나).'; return; }
      go.disabled = true; go.textContent = body.instruction ? 'AI가 계획을 만들고 편집하는 중…' : '편집하는 중…';
      const r = await pxPost('/api/docx/edit', body);
      go.disabled = false; go.textContent = '편집본 만들기';
      if (!r.ok) { err.textContent = '편집하지 못했습니다: ' + (r.error || '알 수 없는 오류'); return; }
      dxShowResult(result, r);
      if (typeof refreshLib === 'function') refreshLib().catch(() => {});
    },
  });
  kids.push(pxEl('h4', { text: '저장' }), titleIn, pxEl('div', { class: 'btnrow', style: 'margin-top:8px' }, go, pxEl('button', { class: 'secondary', onclick: () => { dxState = null; pxClose(); }, text: '닫기' })), err, result);
  p.replaceChildren(...kids);
  dxLoadVersions(p);
}

const DX_WHERE = { body: '본문', table: '표', header: '머리글', footer: '바닥글' };

function dxShowResult(box, r) {
  const kids = [pxEl('h4', { text: `편집본 저장됨 — ${r.doc.title}` })];
  kids.push(pxEl('p', {}, pxEl('a', { href: r.doc.url, text: '편집본 다운로드 (.docx)' }), ` · 문단 ${r.doc.paragraphs}개 · ${Number(r.doc.bytes).toLocaleString()} B · op ${r.ops.length}개${r.planned ? ` (AI 계획${r.planAttempts > 1 ? ', 2번째 시도' : ''})` : ''}`));
  const w = r.warnings || {};
  if (w.signatureRemoved) kids.push(pxEl('p', { class: 'badge warn', text: '편집본에서 디지털 서명이 없어졌습니다.' }));
  if (w.trackedChanges) kids.push(pxEl('p', { class: 'small', text: '원본의 변경 내용 추적은 그대로 남아 있습니다. 이번 편집은 추적으로 기록되지 않았습니다.' }));
  if (w.fixedRunsKept) kids.push(pxEl('p', { class: 'small', text: '고친 문단 안의 필드·그림·각주 표시는 그대로 두었습니다 (새 글 뒤에 남습니다). Word에서 위치를 확인하세요.' }));
  if (w.fixedRunsRemoved) kids.push(pxEl('p', { class: 'small', text: '지운 문단에 있던 필드·그림·각주 표시도 함께 지워졌습니다.' }));
  const tbl = pxEl('table', { class: 'liblist', style: 'width:100%;border-collapse:collapse' },
    pxEl('thead', {}, pxEl('tr', { style: 'text-align:left' }, pxEl('th', { text: '위치' }), pxEl('th', { text: '변경 전' }), pxEl('th', { text: '변경 후' }))));
  const tb = pxEl('tbody');
  for (const d of r.diff || []) {
    const where = d.kind === 'added' ? (d.afterIndex ? `${d.afterIndex}번 문단 뒤 (새 문단)` : '맨 앞 (새 문단)')
      : d.where === 'table' && d.table ? `표 ${d.table} (${d.r + 1}행 ${d.c + 1}열)`
      : `${DX_WHERE[d.where] || d.where}${d.index ? ` ${d.index}번 문단` : ''}`;
    tb.append(pxEl('tr', {},
      pxEl('td', { text: where }),
      pxEl('td', { style: 'color:#b91c1c', text: d.before === null ? '(없음)' : d.before }),
      pxEl('td', { style: 'color:#047857', text: d.after === null ? '(삭제됨)' : d.after })));
  }
  tbl.append(tb);
  kids.push(pxEl('div', { class: 'small', text: `변경 전후 (${(r.diff || []).length}곳)` }), tbl);
  if (r.parts) kids.push(pxEl('p', { class: 'small', text: `파일 부품: 그대로 ${r.parts.identicalCount}개 · 바뀜 ${r.parts.changed.length}개 · 추가 ${r.parts.added.length}개 · 제거 ${r.parts.removed.length}개` }));
  box.replaceChildren(...kids);
}

async function dxLoadVersions(p) {
  if (!dxState) return;
  let j;
  try { j = await api('/api/docx/versions?source=' + encodeURIComponent(dxState.source)); } catch { return; }
  if (!j || !j.ok || !j.versions || !j.versions.length || !dxState) return;
  const ul = pxEl('ul');
  for (const v of j.versions) ul.append(pxEl('li', {}, pxEl('a', { href: v.url, text: v.title }), ` · ${v.created_at}`));
  p.append(pxEl('h4', { text: `이 파일의 편집본 ${j.versions.length}개` }), ul);
}
