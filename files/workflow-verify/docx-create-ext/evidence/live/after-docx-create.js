// Word 새 문서 만들기 (2026-11-21). 라이브러리 파일 목록의 "새 Word 문서 만들기" 버튼이 openDocxCreate()로 연다.
// 서버: POST /api/docx/create (src/index.ts → src/docx/create.ts, docx 9.16.0). 만든 문서는 GET /api/documents/<id>/download로 받는다.
// 입력 두 가지: ① 자연어 지시(AI가 문서 구조를 씀) ② 간단한 개요 텍스트(# 제목, ## 작은 제목, - 글머리, 1. 번호, | 표 |, 빈 줄 = 문단 구분).
// 보안: 서버 응답·사용자 입력은 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// pptx-edit.js의 pxEl()·pxPanel()·pxClose()·pxPost()를 쓴다 (index.html에서 pptx-edit.js 다음에 읽는다).

const DC_SAMPLE = '# 1. 개요\n이 문서는 **분기 코칭 운영** 결과를 정리합니다.\n\n## 1.1 주요 성과\n- 코칭 세션 54회\n- 만족도 4.6/5\n\n## 1.2 다음 단계\n1. 코치 교육 일정 확정\n2. 분기 리뷰 준비\n\n# 2. 코치별 현황\n| 코치 | 주제 | 세션 수 |\n| 김코치 | 리더십 | 12 |\n| 이코치 | 커리어 | 8 |';

/**
 * 개요 텍스트 → sections 배열. "---" 줄은 다음 섹션 앞 페이지 나누기.
 * 확장 (2026-11-22): "![캡션](그림1)" 줄은 그 자리에 이미지를 놓는다 — imageOf(번호)가 {doc, widthPct?}를 주면 넣고, 없는 번호는 badRefs에 모은다.
 */
function dcParseOutline(text, imageOf, badRefs) {
  const sections = [];
  let cur = null;
  let para = [];
  let pageBreak = false;
  const ensure = () => { if (!cur) { cur = { heading: '', level: 1, paragraphs: [], bullets: [], numbered: [] }; sections.push(cur); } return cur; };
  const flush = () => { if (para.length) { ensure().paragraphs.push(para.join(' ')); para = []; } };
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^-{3,}$/.test(line)) { flush(); pageBreak = true; continue; }
    let m;
    if ((m = /^(#{1,2})\s+(.+)$/.exec(line))) {
      flush();
      cur = { heading: m[2].trim(), level: m[1].length, paragraphs: [], bullets: [], numbered: [] };
      if (pageBreak) { cur.pageBreakBefore = true; pageBreak = false; }
      sections.push(cur);
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(\s*(?:그림|이미지|img)?\s*(\d+)\s*\)$/i.exec(line))) {
      flush();
      const im = imageOf ? imageOf(Number(m[2])) : null;
      if (!im) { if (badRefs) badRefs.push(m[2]); continue; }
      const s = ensure();
      // 문단 앞에 쓰면 제목 바로 아래(start), 문단 뒤에 쓰면 문단 뒤(afterText), 목록·표 뒤에 쓰면 섹션 끝(end)
      const position = s.bullets.length || s.numbered.length || s.table ? 'end' : s.paragraphs.length ? 'afterText' : 'start';
      (s.images = s.images || []).push({ ...im, position, ...(m[1].trim() ? { caption: m[1].trim() } : {}) });
      continue;
    }
    if ((m = /^[-*•]\s+(.+)$/.exec(line))) { flush(); ensure().bullets.push(m[1]); continue; }
    if ((m = /^\d+[.)]\s+(.+)$/.exec(line))) { flush(); ensure().numbered.push(m[1]); continue; }
    if (/^\|.*\|$/.test(line)) {
      flush();
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // 마크다운 구분선 | --- |
      const s = ensure();
      if (!s.table) s.table = { header: cells(line), rows: [] };
      else s.table.rows.push(cells(line));
      continue;
    }
    para.push(line);
  }
  flush();
  return sections.filter((s) => s.heading || s.paragraphs.length || s.bullets.length || s.numbered.length || s.table || (s.images && s.images.length));
}

/**
 * 확장 입력 칸 (2026-11-22): 이미지 고르기(라이브러리에 올린 PNG·JPEG·GIF·BMP)·목차·머리말·바닥글.
 * 돌려주는 값: { box(화면 요소), options() → 요청 본문에 합칠 {images?, toc?, header?, footer?}, imageOf(번호) → {doc, widthPct?} | null }
 */
function dcExtrasBox() {
  const items = (typeof libItems !== 'undefined' && Array.isArray(libItems) ? libItems : []).filter((x) => x.type === 'upload' && x.sourceKind === 'image');
  const rows = items.map((x, i) => {
    const cb = pxEl('input', { type: 'checkbox', id: 'dcImg' + i });
    const width = pxEl('select', { 'aria-label': `그림 ${i + 1} 너비` },
      pxEl('option', { value: '', text: '원래 크기' }), pxEl('option', { value: '25', text: '본문 폭 25%' }), pxEl('option', { value: '50', text: '50%' }),
      pxEl('option', { value: '75', text: '75%' }), pxEl('option', { value: '100', text: '100%' }));
    return { id: x.id, cb, width, el: pxEl('div', { class: 'small', style: 'display:flex;gap:8px;align-items:center;margin:2px 0' }, cb, pxEl('label', { for: 'dcImg' + i, style: 'flex:1', text: `그림 ${i + 1}: ${x.title}` }), width) };
  });
  const pick = (r) => ({ doc: r.id, ...(r.width.value ? { widthPct: Number(r.width.value) } : {}) });
  const toc = pxEl('input', { type: 'checkbox', id: 'dcToc' });
  const header = pxEl('input', { type: 'text', maxlength: '200', style: 'width:100%', placeholder: '머리말 문구 (비우면 머리말 없음. 예: 2026 4분기 코칭 운영 보고서)' });
  const footer = pxEl('input', { type: 'text', maxlength: '200', style: 'width:100%', placeholder: '바닥글 문구 (비워도 됩니다. 예: 사내 한정)' });
  const pageNo = pxEl('input', { type: 'checkbox', id: 'dcPageNo' });
  const box = pxEl('div', {},
    pxEl('h4', { text: '선택: 이미지 · 목차 · 머리말/바닥글 (두 방식 모두에 적용)' }),
    pxEl('p', { class: 'small', text: rows.length
      ? '넣을 이미지를 고르세요 (최대 10장, 한 장 5 MB·합계 10 MB까지). AI로 만들 때는 AI가 맞는 자리에 놓고, 개요에서는 "![캡션](그림1)" 줄로 자리를 정합니다. 자리를 정하지 않은 이미지는 문서 끝에 붙습니다.'
      : '넣을 수 있는 이미지가 없습니다. 업로드 화면에서 PNG·JPEG·GIF·BMP 파일을 먼저 올리면 여기에 나타납니다.' }),
    ...rows.map((r) => r.el),
    pxEl('div', { class: 'small', style: 'margin-top:6px' }, toc, pxEl('label', { for: 'dcToc', text: ' 목차 넣기 (제목 아래. 쪽 번호는 Word에서 열 때 "필드 업데이트"를 누르면 채워집니다)' })),
    pxEl('label', { class: 'small', text: '머리말' }), header,
    pxEl('label', { class: 'small', text: '바닥글' }), footer,
    pxEl('div', { class: 'small' }, pageNo, pxEl('label', { for: 'dcPageNo', text: ' 바닥글에 쪽 번호 넣기 (1 / 3 모양)' })),
  );
  return {
    box,
    imageOf: (n) => (rows[n - 1] ? pick(rows[n - 1]) : null),
    options: () => {
      const o = {};
      const images = rows.filter((r) => r.cb.checked).map(pick);
      if (images.length) o.images = images;
      if (toc.checked) o.toc = true;
      if (header.value.trim()) o.header = header.value.trim();
      if (footer.value.trim() || pageNo.checked) o.footer = { text: footer.value.trim(), pageNumber: pageNo.checked };
      return o;
    },
  };
}

function openDocxCreate() {
  const p = pxPanel();
  const titleIn = pxEl('input', { type: 'text', maxlength: '200', style: 'width:100%', placeholder: '문서 제목 (예: 2026 4분기 코칭 운영 보고서)' });
  const instr = pxEl('textarea', { rows: '4', maxlength: '2000', style: 'width:100%', placeholder: '예: 신규 코치 온보딩 안내 문서를 써 줘. 개요, 첫 주 일정(표), 준비물 목록, 자주 묻는 질문 순서로.' });
  const outline = pxEl('textarea', { rows: '10', style: 'width:100%;font-family:monospace', placeholder: DC_SAMPLE });
  const msg = pxEl('div', { style: 'margin-top:8px' });
  const btnAi = pxEl('button', { class: 'primary', text: 'AI로 만들기' });
  const btnOutline = pxEl('button', { class: 'primary', text: '개요로 만들기' });
  const busy = (on) => { btnAi.disabled = on; btnOutline.disabled = on; };
  const extras = dcExtrasBox(); // 이미지·목차·머리말/바닥글 (2026-11-22)

  const submit = async (body) => {
    busy(true);
    msg.replaceChildren(pxEl('p', { class: 'small', text: body.instruction ? 'AI가 문서를 쓰는 중… (10~40초)' : '문서를 만드는 중…' }));
    const j = await pxPost('/api/docx/create', body);
    busy(false);
    if (!j.ok) { msg.replaceChildren(pxEl('p', { class: 'error', text: '만들지 못했습니다: ' + (j.error || '알 수 없는 오류') })); return; }
    const kb = (j.doc.bytes / 1024).toFixed(1);
    const list = pxEl('ul', { class: 'small' });
    for (const s of j.outline || []) {
      const bits = [s.paragraphs && `문단 ${s.paragraphs}`, s.bullets && `글머리 ${s.bullets}`, s.numbered && `번호 ${s.numbered}`, s.tableRows && `표 ${s.tableRows}행`, s.images && `그림 ${s.images}`].filter(Boolean).join(' · ');
      list.append(pxEl('li', { text: `${s.level === 2 ? '　' : ''}${s.heading || '(제목 없음)'}${bits ? ' — ' + bits : ''}` }));
    }
    msg.replaceChildren(
      pxEl('p', { class: 'badge ok', text: `만들었습니다: ${j.doc.title} (${kb} KB, 섹션 ${j.stats.sections}개${j.planned ? ', AI 작성' : ''})` }),
      j.extras ? pxEl('p', { class: 'small', text: '넣은 것: ' + ([j.extras.images && `그림 ${j.extras.images}장`, j.extras.toc && '목차', j.extras.header && '머리말', j.extras.footer && '바닥글'].filter(Boolean).join(' · ') || '없음') + (j.extras.toc ? ' — 목차 쪽 번호는 Word에서 열 때 필드를 업데이트하면 채워집니다.' : '') }) : null,
      list,
      pxEl('div', { class: 'btnrow' },
        pxEl('a', { href: j.doc.url, class: 'button primary', text: '.docx 다운로드' }),
        pxEl('button', { class: 'secondary', text: '라이브러리에서 보기', onclick: async () => { pxClose(); if (typeof refreshLib === 'function') await refreshLib(); const f = document.getElementById('libFiles'); if (f) f.scrollIntoView({ block: 'start', behavior: 'smooth' }); } })),
    );
  };

  btnAi.addEventListener('click', () => {
    const instruction = instr.value.trim();
    if (!instruction) { msg.replaceChildren(pxEl('p', { class: 'error', text: '자연어 지시를 입력하세요.' })); return; }
    submit({ title: titleIn.value.trim(), instruction, ...extras.options() });
  });
  btnOutline.addEventListener('click', () => {
    const title = titleIn.value.trim();
    if (!title) { msg.replaceChildren(pxEl('p', { class: 'error', text: '개요로 만들 때는 문서 제목이 필요합니다.' })); return; }
    const badRefs = [];
    const sections = dcParseOutline(outline.value, extras.imageOf, badRefs);
    if (badRefs.length) { msg.replaceChildren(pxEl('p', { class: 'error', text: `개요의 그림 번호가 목록에 없습니다: ${badRefs.map((n) => '그림' + n).join(', ')}` })); return; }
    if (!sections.length) { msg.replaceChildren(pxEl('p', { class: 'error', text: '개요를 입력하세요 (# 제목, - 글머리, 1. 번호, | 표 |).' })); return; }
    submit({ title, sections, ...extras.options() });
  });

  p.replaceChildren(
    pxEl('h3', { text: '새 Word 문서 만들기' }),
    pxEl('p', { class: 'small', text: '새 .docx 파일을 만들어 라이브러리에 저장합니다. 만든 문서는 내 개인 문서가 됩니다.' }),
    pxEl('label', { class: 'small', text: '문서 제목' }), titleIn,
    extras.box,
    pxEl('h4', { text: '1. 자연어로 지시 (AI가 제목·문단·목록·표를 씁니다)' }), instr, pxEl('div', { class: 'btnrow' }, btnAi),
    pxEl('h4', { text: '2. 또는 개요를 직접 입력' }),
    pxEl('p', { class: 'small', text: '# 큰 제목 · ## 작은 제목 · - 글머리 · 1. 번호 · | 표 | (첫 줄이 머리글) · 빈 줄로 문단 구분 · --- 다음 제목 앞에서 페이지 나누기 · **굵게** *기울임* · ![캡션](그림1) 그 자리에 이미지' }),
    outline, pxEl('div', { class: 'btnrow' }, btnOutline),
    msg,
    pxEl('div', { class: 'btnrow', style: 'margin-top:8px' }, pxEl('button', { class: 'secondary', onclick: pxClose, text: '닫기' })),
  );
  p.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
