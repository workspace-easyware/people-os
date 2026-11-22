// PPTX 편집본 만들기 (2026-11-21). 라이브러리 파일 목록의 "편집본 만들기" 버튼이 연다.
// 서버: POST /api/pptx/inspect · POST /api/pptx/edit · GET /api/pptx/versions (src/index.ts, 편집은 별도 Worker PPTX_EDITOR).
// 원본은 그대로 두고 편집본을 새 덱으로 저장한다 — 다운로드는 GET /api/deck/<새 id>.
// 보안: 서버·덱 데이터는 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// index.html 인라인 스크립트의 전역 api()를 쓴다.

let pxState = null; // { source: "deck:<id>"|"doc:<id>", title, summary }

function pxEl(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return e;
}

function pxPanel() {
  let p = document.getElementById('pptxEditPanel');
  if (!p) {
    p = pxEl('div', { id: 'pptxEditPanel', class: 'card', style: 'margin-top:12px' });
    // #libResult 바깥(바로 뒤)에 둔다 — refreshLib()이 #libResult를 다시 그려도 패널·결과가 남는다.
    const lib = document.getElementById('libResult');
    if (lib) lib.after(p); else document.body.append(p);
  }
  return p;
}

function pxClose() {
  const p = document.getElementById('pptxEditPanel');
  if (p) p.remove();
  pxState = null;
}

async function pxPost(url, body) {
  try { return await api(url, { method: 'POST', body: JSON.stringify(body) }); }
  catch { return { ok: false, error: '서버에 연결할 수 없습니다' }; }
}

/** 라이브러리 행에서 부른다. type: 'deck' | 'upload' */
async function openPptxEdit(type, id, title) {
  const source = (type === 'deck' ? 'deck:' : 'doc:') + id;
  const p = pxPanel();
  p.replaceChildren(pxEl('h3', { text: `편집본 만들기 — ${title}` }), pxEl('p', { class: 'small', text: '덱 구조를 읽는 중…' }));
  p.scrollIntoView({ block: 'start', behavior: 'smooth' });
  const j = await pxPost('/api/pptx/inspect', { source });
  if (!j.ok) {
    // 업로드 문서가 XLSX도 PPTX도 아니면(openDocEdit가 XLSX → PPTX 순으로 넘겨 온다) 형식 안내를 분명히 한다 (2026-11-21 브라우저 회귀 6번)
    const why = type !== 'deck' && /PPTX 파일만/.test(j.error || '')
      ? '이 파일 형식은 편집할 수 없습니다. 편집본 만들기는 PPTX·XLSX 파일만 됩니다 (Word 문서는 "새 Word 문서 만들기"로 새로 만들 수 있습니다).'
      : '열 수 없습니다: ' + (j.error || '알 수 없는 오류');
    p.replaceChildren(pxEl('h3', { text: `편집본 만들기 — ${title}` }), pxEl('p', { class: 'error', text: why }), pxEl('button', { class: 'secondary', onclick: pxClose, text: '닫기' }));
    return;
  }
  pxState = { source, title, summary: j };
  pxRender();
}

function pxRender() {
  const { title, summary } = pxState;
  const p = pxPanel();
  const kids = [pxEl('h3', { text: `편집본 만들기 — ${title}` })];
  kids.push(pxEl('p', { class: 'small', text: `슬라이드 ${summary.slideCount}장. 원본은 그대로 두고 편집본을 새 덱으로 저장합니다.` }));
  if (summary.signed) kids.push(pxEl('p', { class: 'badge warn', text: '이 덱에는 디지털 서명이 있습니다. 편집본을 저장하면 서명이 제거됩니다 (원본의 서명은 그대로).' }));
  if (summary.hasSmartArt) kids.push(pxEl('p', { class: 'small', text: '이 덱에는 SmartArt가 있습니다. SmartArt를 고치면 PowerPoint에서 레이아웃 새로고침이 필요할 수 있습니다.' }));

  // 1) 직접 고치기: 텍스트 run·표 셀 입력칸 → text/cell op
  const inputs = [];
  const list = pxEl('div', { class: 'px-elements', style: 'max-height:360px;overflow:auto;border:1px solid #e5e7eb;padding:8px;border-radius:6px' });
  for (const s of summary.slides) {
    const box = pxEl('div', { style: 'margin-bottom:10px' }, pxEl('b', { text: `슬라이드 ${s.n}` }));
    let any = false;
    for (const e of s.elements) {
      if (e.runs && e.runs.length) {
        e.runs.forEach((r, ri) => {
          if (!String(r).trim()) return;
          const inp = pxEl('input', { type: 'text', style: 'width:100%' });
          inp.value = r;
          inputs.push({ inp, orig: r, op: { op: 'text', slide: s.n, elementId: e.id, runIndex: ri } });
          box.append(pxEl('label', { class: 'small', style: 'display:block;margin-top:4px', text: `${e.name || e.type} · run ${ri}` }), inp);
          any = true;
        });
      } else if (e.cells) {
        const tbl = pxEl('table', { style: 'border-collapse:collapse;margin-top:4px' });
        e.cells.forEach((row, r) => {
          const tr = pxEl('tr');
          row.forEach((cell, c) => {
            const inp = pxEl('input', { type: 'text', style: 'width:8em' });
            inp.value = cell ?? '';
            inputs.push({ inp, orig: cell ?? '', op: { op: 'cell', slide: s.n, elementId: e.id, r, c } });
            tr.append(pxEl('td', { style: 'padding:2px' }, inp));
          });
          tbl.append(tr);
        });
        box.append(pxEl('div', { class: 'small', style: 'margin-top:4px', text: `${e.name || '표'} (표)` }), tbl);
        any = true;
      } else if (e.chart) {
        box.append(pxEl('div', { class: 'small', style: 'margin-top:4px', text: `차트 "${e.chart.title || ''}" — 시리즈 ${(e.chart.series || []).map((x) => `${x.name}: ${(x.values || []).join(', ')}`).join(' / ')} (차트는 아래 지시나 ops로 고칩니다)` }));
        any = true;
      }
    }
    if (any) list.append(box);
  }
  kids.push(pxEl('h4', { text: '1. 직접 고치기 (텍스트·표 셀)' }), list);

  // 2) 자연어 지시
  const instr = pxEl('textarea', { rows: '3', style: 'width:100%', placeholder: '예: 제목을 "2027 리더십 코칭 중간 보고"로 바꾸고, 차트 제목 끝에 (수정)을 붙여 줘' });
  kids.push(pxEl('h4', { text: '2. 또는 자연어로 지시 (AI가 편집 계획을 만듭니다)' }), instr);

  // 3) ops JSON (고급)
  const opsBox = pxEl('textarea', { rows: '4', style: 'width:100%;font-family:monospace', placeholder: '[{"op":"chart","slide":4,"elementId":"…","series":[[11,22,33,44]],"title":"…"}]' });
  const adv = pxEl('details', {}, pxEl('summary', { text: '3. 고급: ops JSON 직접 입력' }), pxEl('p', { class: 'small', text: 'op: text · shape(x,y,w,h,fill) · cell(r,c) · chart(series,title) · duplicate. elementId는 아래 "요소 id 보기"에서 확인합니다.' }), opsBox,
    pxEl('pre', { class: 'small', style: 'max-height:160px;overflow:auto', text: summary.slides.map((s) => s.elements.map((e) => `${s.n}\t${e.id}\t${e.type}\t${(e.text || '').slice(0, 40)}`).join('\n')).join('\n') }));
  kids.push(adv);

  const titleIn = pxEl('input', { type: 'text', style: 'width:100%', placeholder: `편집본 이름 (비우면 "${title} (편집본)")` });
  const err = pxEl('p', { class: 'error' });
  const result = pxEl('div', { id: 'pxResult' });
  const go = pxEl('button', {
    class: 'primary', text: '편집본 만들기', onclick: async () => {
      err.textContent = '';
      const body = { source: pxState.source };
      if (titleIn.value.trim()) body.title = titleIn.value.trim();
      const rawOps = opsBox.value.trim();
      const direct = inputs.filter((x) => x.inp.value !== x.orig).map((x) => ({ ...x.op, text: x.inp.value }));
      if (rawOps) {
        try { body.ops = JSON.parse(rawOps); } catch { err.textContent = 'ops가 올바른 JSON이 아닙니다.'; return; }
        if (Array.isArray(body.ops) && direct.length) body.ops = [...direct, ...body.ops];
      } else if (direct.length) body.ops = direct;
      else if (instr.value.trim()) body.instruction = instr.value.trim();
      else { err.textContent = '고칠 내용을 입력하세요 (직접 고치기, 지시, ops 중 하나).'; return; }
      if (body.ops && instr.value.trim()) { err.textContent = '직접 고치기·ops와 자연어 지시는 함께 쓸 수 없습니다. 하나만 남겨 주세요.'; return; }
      go.disabled = true; go.textContent = body.instruction ? 'AI가 계획을 만들고 편집하는 중…' : '편집하는 중…';
      const r = await pxPost('/api/pptx/edit', body);
      go.disabled = false; go.textContent = '편집본 만들기';
      if (!r.ok) { err.textContent = '편집하지 못했습니다: ' + (r.error || '알 수 없는 오류'); return; }
      pxShowResult(result, r);
      if (typeof refreshLib === 'function') refreshLib().catch(() => {});
    },
  });
  kids.push(pxEl('h4', { text: '저장' }), titleIn, pxEl('div', { class: 'btnrow', style: 'margin-top:8px' }, go, pxEl('button', { class: 'secondary', onclick: pxClose, text: '닫기' })), err, result);
  p.replaceChildren(...kids);
  pxLoadVersions(p);
}

function pxShowResult(box, r) {
  const kids = [pxEl('h4', { text: `편집본 저장됨 — ${r.deck.title}` })];
  kids.push(pxEl('p', {}, pxEl('a', { href: r.deck.url, text: '편집본 다운로드 (.pptx)' }), ` · 슬라이드 ${r.deck.slides}장 · ${Number(r.deck.bytes).toLocaleString()} B · op ${r.ops.length}개${r.planned ? ' (AI 계획)' : ''}`));
  if (r.warnings && r.warnings.signatureRemoved) kids.push(pxEl('p', { class: 'badge warn', text: '저장하면서 디지털 서명이 제거되었습니다.' }));
  if (r.warnings && r.warnings.smartArtEdited) kids.push(pxEl('p', { class: 'badge warn', text: 'SmartArt를 고쳤습니다. PowerPoint에서 열 때 레이아웃 새로고침이 필요할 수 있습니다.' }));
  const tbl = pxEl('table', { class: 'liblist', style: 'width:100%;border-collapse:collapse' },
    pxEl('thead', {}, pxEl('tr', { style: 'text-align:left' }, pxEl('th', { text: '슬라이드' }), pxEl('th', { text: '변경 전' }), pxEl('th', { text: '변경 후' }))));
  const tb = pxEl('tbody');
  for (const d of r.diff || []) {
    tb.append(pxEl('tr', {},
      pxEl('td', { text: String(d.slide) }),
      pxEl('td', { style: 'color:#b91c1c', text: d.before === null ? '(없음)' : d.before }),
      pxEl('td', { style: 'color:#047857', text: d.after === null ? '(삭제됨)' : d.after })));
  }
  tbl.append(tb);
  kids.push(pxEl('div', { class: 'small', text: `변경 전후 텍스트 (${(r.diff || []).length}곳)` }), tbl);
  if (r.parts) kids.push(pxEl('p', { class: 'small', text: `파일 부품: 그대로 ${r.parts.identicalCount}개 · 바뀜 ${r.parts.changed.length}개 · 추가 ${r.parts.added.length}개 · 제거 ${r.parts.removed.length}개` }));
  box.replaceChildren(...kids);
}

async function pxLoadVersions(p) {
  if (!pxState) return;
  let j;
  try { j = await api('/api/pptx/versions?source=' + encodeURIComponent(pxState.source)); } catch { return; }
  if (!j || !j.ok || !j.versions || !j.versions.length || !pxState) return;
  const ul = pxEl('ul');
  for (const v of j.versions) ul.append(pxEl('li', {}, pxEl('a', { href: v.url, text: v.title }), ` · ${v.slides}장 · ${v.created_at}`));
  p.append(pxEl('h4', { text: `이 파일의 편집본 ${j.versions.length}개` }), ul);
}
