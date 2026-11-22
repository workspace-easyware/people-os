// 엑셀 편집본 만들기 (2026-11-21). 라이브러리 파일 목록의 "편집본 만들기" 버튼이 openDocEdit()로 연다.
// 서버: POST /api/xlsx/inspect · POST /api/xlsx/edit · GET /api/xlsx/versions (src/index.ts, 편집은 별도 Worker DOC_EDITOR의 XLSX RPC).
// 원본은 그대로 두고 편집본을 새 문서로 저장한다 — 다운로드는 GET /api/documents/<새 id>/download.
// 보안: 서버·셀 데이터는 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// pptx-edit.js의 pxEl()·pxPost()와 index.html 인라인 스크립트의 전역 api()를 쓴다 (index.html에서 pptx-edit.js 다음에 읽는다).

let xxState = null; // { source: "doc:<id>", title, summary }
const XX_FORMULA_NOTE = '수식은 Excel이 열 때 다시 계산합니다. 여기 보이는 수식 값은 파일에 저장된 마지막 계산 결과(캐시)입니다.';

/**
 * 라이브러리 행에서 부른다. 덱이면 PPTX 편집, 업로드 문서면 먼저 엑셀로 열어 보고
 * "XLSX 파일만" 응답(.xlsx가 아님)이면 PPTX 편집으로 넘긴다 (/api/library 응답에는 확장자가 없다).
 */
async function openDocEdit(type, id, title) {
  if (type === 'deck') return openPptxEdit(type, id, title);
  const source = 'doc:' + id;
  const p = pxPanel();
  p.replaceChildren(pxEl('h3', { text: `편집본 만들기 — ${title}` }), pxEl('p', { class: 'small', text: '파일 구조를 읽는 중…' }));
  p.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const j = await pxPost('/api/xlsx/inspect', { source });
  if (!j.ok && /XLSX 파일만/.test(j.error || '')) return openPptxEdit(type, id, title);
  if (!j.ok) {
    p.replaceChildren(pxEl('h3', { text: `편집본 만들기 — ${title}` }), pxEl('p', { class: 'error', text: '열 수 없습니다: ' + (j.error || '알 수 없는 오류') }), pxEl('button', { class: 'secondary', onclick: pxClose, text: '닫기' }));
    return;
  }
  xxState = { source, title, summary: j };
  xxRender();
}

const xxColNum = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref); if (!m) return [0, 0]; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return [Number(m[2]), c]; };
const xxColName = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** 입력칸 문자열 → 셀 값. 원래 숫자였거나 숫자 모양이면 숫자로, 비우면 null. */
function xxParse(text, orig) {
  if (text === '') return null;
  if ((typeof orig === 'number' || orig === null || orig === undefined) && /^-?\d+(\.\d+)?$/.test(text.trim())) return Number(text.trim());
  if (typeof orig === 'boolean' && /^(true|false)$/i.test(text.trim())) return text.trim().toLowerCase() === 'true';
  return text;
}

function xxRender() {
  const { title, summary } = xxState;
  const p = pxPanel();
  const kids = [pxEl('h3', { text: `엑셀 편집본 만들기 — ${title}` })];
  const formulaCount = summary.sheets.reduce((a, s) => a + (s.formulas || 0), 0);
  kids.push(pxEl('p', { class: 'small', text: `시트 ${summary.sheetCount}장${formulaCount ? ` · 수식 셀 ${formulaCount}개` : ''}. 원본은 그대로 두고 편집본을 새 문서로 저장합니다.` }));
  if (formulaCount) kids.push(pxEl('p', { class: 'badge warn', text: XX_FORMULA_NOTE }));
  if (summary.hasMacros) kids.push(pxEl('p', { class: 'small', text: '이 파일에는 매크로가 있습니다. 매크로는 실행하지 않습니다.' }));

  // 1) 직접 고치기: 미리보기 격자(시트마다 50행×26열). 값 셀은 입력칸, 수식 셀은 읽기 전용(수식 + 캐시 값).
  const inputs = [];
  const list = pxEl('div', { style: 'max-height:420px;overflow:auto;border:1px solid #e5e7eb;padding:8px;border-radius:6px' });
  for (const s of summary.sheets) {
    const box = pxEl('div', { style: 'margin-bottom:12px' }, pxEl('b', { text: `시트 "${s.name}"` }), pxEl('span', { class: 'small', text: ` ${s.usedRange || '(빈 시트)'}${s.tables.length ? ' · 표 ' + s.tables.map((t) => `${t.name}(${t.ref})`).join(', ') : ''}${s.truncated ? ' · 앞부분만 표시' : ''}` }));
    if (!s.cells.length) { list.append(box); continue; }
    let maxR = 0, maxC = 0;
    const at = new Map();
    for (const c of s.cells) { const [r, col] = xxColNum(c.ref); at.set(c.ref, c); if (r > maxR) maxR = r; if (col > maxC) maxC = col; }
    const tbl = pxEl('table', { style: 'border-collapse:collapse;margin-top:4px;font-size:12px' });
    const head = pxEl('tr', {}, pxEl('th', { text: '' }));
    for (let c = 1; c <= maxC; c++) head.append(pxEl('th', { style: 'padding:2px 4px;color:#6b7280', text: xxColName(c) }));
    tbl.append(head);
    for (let r = 1; r <= maxR; r++) {
      const tr = pxEl('tr', {}, pxEl('td', { style: 'color:#6b7280;padding:2px 4px', text: String(r) }));
      for (let c = 1; c <= maxC; c++) {
        const ref = xxColName(c) + r;
        const cell = at.get(ref);
        if (cell && cell.f) {
          tr.append(pxEl('td', { style: 'padding:2px;background:#f3f4f6', title: `=${cell.f}\n${XX_FORMULA_NOTE}`, text: `=${cell.f} → ${cell.v ?? ''}` }));
          continue;
        }
        const inp = pxEl('input', { type: 'text', style: 'width:7em' });
        const orig = cell ? cell.v : null;
        inp.value = orig === null || orig === undefined ? '' : String(orig);
        inputs.push({ inp, orig, origText: inp.value, op: { op: 'cell', sheet: s.name, cell: ref } });
        tr.append(pxEl('td', { style: 'padding:1px' }, inp));
      }
      tbl.append(tr);
    }
    box.append(tbl);
    list.append(box);
  }
  kids.push(pxEl('h4', { text: '1. 직접 고치기 (값 셀)' }), pxEl('p', { class: 'small', text: '회색 칸은 수식입니다 — 수식을 바꾸려면 2번 지시나 3번 ops를 쓰세요.' }), list);

  // 2) 자연어 지시
  const instr = pxEl('textarea', { rows: '3', style: 'width:100%', placeholder: '예: 요약 시트 상반기 세션을 25로 바꾸고 합계 수식 결과도 맞춰 줘. 데이터 시트에 "정코치, 커리어, 4" 행을 추가해 줘' });
  kids.push(pxEl('h4', { text: '2. 또는 자연어로 지시 (AI가 편집 계획을 만듭니다)' }), instr);

  // 3) ops JSON (고급)
  const opsBox = pxEl('textarea', { rows: '4', style: 'width:100%;font-family:monospace', placeholder: '[{"op":"formula","sheet":"요약","cell":"B6","formula":"SUM(B4:B5)","result":55},{"op":"row","sheet":"데이터","values":["정코치","커리어",4]},{"op":"sheet","name":"메모"}]' });
  kids.push(pxEl('details', {}, pxEl('summary', { text: '3. 고급: ops JSON 직접 입력' }),
    pxEl('p', { class: 'small', text: 'op: cell(sheet, cell, value) · formula(sheet, cell, formula, result?) · row(sheet, values[]) · sheet(name). 수식의 result는 확실히 알 때만 넣습니다 — 없으면 Excel이 열 때 계산합니다.' }), opsBox));

  const titleIn = pxEl('input', { type: 'text', style: 'width:100%', placeholder: `편집본 이름 (비우면 "${title} (편집본)")` });
  const err = pxEl('p', { class: 'error' });
  const result = pxEl('div', { id: 'xxResult' });
  const go = pxEl('button', {
    class: 'primary', text: '편집본 만들기', onclick: async () => {
      err.textContent = '';
      const body = { source: xxState.source };
      if (titleIn.value.trim()) body.title = titleIn.value.trim();
      const rawOps = opsBox.value.trim();
      const direct = inputs.filter((x) => x.inp.value !== x.origText).map((x) => ({ ...x.op, value: xxParse(x.inp.value, x.orig) }));
      if (rawOps) {
        try { body.ops = JSON.parse(rawOps); } catch { err.textContent = 'ops가 올바른 JSON이 아닙니다.'; return; }
        if (Array.isArray(body.ops) && direct.length) body.ops = [...direct, ...body.ops];
      } else if (direct.length) body.ops = direct;
      else if (instr.value.trim()) body.instruction = instr.value.trim();
      else { err.textContent = '고칠 내용을 입력하세요 (직접 고치기, 지시, ops 중 하나).'; return; }
      if (body.ops && instr.value.trim()) { err.textContent = '직접 고치기·ops와 자연어 지시는 함께 쓸 수 없습니다. 하나만 남겨 주세요.'; return; }
      go.disabled = true; go.textContent = body.instruction ? 'AI가 계획을 만들고 편집하는 중…' : '편집하는 중…';
      let r = await pxPost('/api/xlsx/edit', body);
      // 큰 워크북은 202(작업 id)만 온다 — 상태를 2초마다 물어 끝날 때까지 기다린다 (2026-11-22 큰 파일 Queue, src/doc-jobs.ts. docxJobWait는 docx-create.js).
      if (r.ok && r.queued && r.job) {
        const line = pxEl('p', { class: 'small', text: docxJobText(r.job, 0, '고치고') });
        result.replaceChildren(pxEl('p', { class: 'badge', text: '큰 워크북이라 뒤에서 고치고 있어요' }), line);
        r = await docxJobWait(r.job, (job, secs) => { line.textContent = docxJobText(job, secs, '고치고'); });
        if (!r.ok) result.replaceChildren();
      }
      go.disabled = false; go.textContent = '편집본 만들기';
      if (!r.ok) { err.textContent = '편집하지 못했습니다: ' + (r.error || '알 수 없는 오류'); return; }
      xxShowResult(result, r);
      if (typeof refreshLib === 'function') refreshLib().catch(() => {});
    },
  });
  kids.push(pxEl('h4', { text: '저장' }), titleIn, pxEl('div', { class: 'btnrow', style: 'margin-top:8px' }, go, pxEl('button', { class: 'secondary', onclick: () => { xxState = null; pxClose(); }, text: '닫기' })), err, result);
  p.replaceChildren(...kids);
  xxLoadVersions(p);
}

function xxShowResult(box, r) {
  const kids = [pxEl('h4', { text: `편집본 저장됨 — ${r.doc.title}` })];
  // 작업이 중간에 끊겼다 이어진 경우(recovered)에는 문서 정보만 온다 (변경 목록 없음).
  if (!r.ops) { kids.push(pxEl('p', {}, pxEl('a', { href: r.doc.url, text: '편집본 다운로드 (.xlsx)' }), ` · ${Number(r.doc.bytes || 0).toLocaleString()} B`)); box.replaceChildren(...kids); return; }
  kids.push(pxEl('p', {}, pxEl('a', { href: r.doc.url, text: '편집본 다운로드 (.xlsx)' }), ` · 시트 ${r.doc.sheets}장 · ${Number(r.doc.bytes).toLocaleString()} B · op ${r.ops.length}개${r.planned ? ' (AI 계획)' : ''}`));
  const anyFormula = (r.diff || []).some((d) => d.formula) || (r.warnings && r.warnings.formulasNotRecalculated);
  if (anyFormula) kids.push(pxEl('p', { class: 'badge warn', text: XX_FORMULA_NOTE }));
  const tbl = pxEl('table', { class: 'liblist', style: 'width:100%;border-collapse:collapse' },
    pxEl('thead', {}, pxEl('tr', { style: 'text-align:left' }, pxEl('th', { text: '시트' }), pxEl('th', { text: '셀' }), pxEl('th', { text: '변경 전' }), pxEl('th', { text: '변경 후' }))));
  const tb = pxEl('tbody');
  for (const d of r.diff || []) {
    tb.append(pxEl('tr', {},
      pxEl('td', { text: d.sheet }),
      pxEl('td', { text: d.cell || (d.kind === 'sheetAdded' ? '(시트 추가)' : d.kind) }),
      pxEl('td', { style: 'color:#b91c1c', text: d.before === null ? '(없음)' : d.before }),
      pxEl('td', { style: 'color:#047857', text: (d.after === null ? '(삭제됨)' : d.after) + (d.formula ? '  (수식 — 값은 Excel이 다시 계산)' : '') })));
  }
  tbl.append(tb);
  kids.push(pxEl('div', { class: 'small', text: `변경 전후 (${(r.diff || []).length}칸)` }), tbl);
  if (r.parts) kids.push(pxEl('p', { class: 'small', text: `파일 부품: 그대로 ${r.parts.identicalCount}개 · 바뀜 ${r.parts.changed.length}개 · 추가 ${r.parts.added.length}개 · 제거 ${r.parts.removed.length}개` }));
  box.replaceChildren(...kids);
}

async function xxLoadVersions(p) {
  if (!xxState) return;
  let j;
  try { j = await api('/api/xlsx/versions?source=' + encodeURIComponent(xxState.source)); } catch { return; }
  if (!j || !j.ok || !j.versions || !j.versions.length || !xxState) return;
  const ul = pxEl('ul');
  for (const v of j.versions) ul.append(pxEl('li', {}, pxEl('a', { href: v.url, text: v.title }), ` · ${v.created_at}`));
  p.append(pxEl('h4', { text: `이 파일의 편집본 ${j.versions.length}개` }), ul);
}
