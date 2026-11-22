// Word 새 문서 만들기 (2026-11-21). 라이브러리 파일 목록의 "새 Word 문서 만들기" 버튼이 openDocxCreate()로 연다.
// 서버: POST /api/docx/create (src/index.ts → src/docx/create.ts, docx 9.16.0). 만든 문서는 GET /api/documents/<id>/download로 받는다.
// 입력 두 가지: ① 자연어 지시(AI가 문서 구조를 씀) ② 간단한 개요 텍스트(# 제목, ## 작은 제목, - 글머리, 1. 번호, | 표 |, 빈 줄 = 문단 구분).
// 보안: 서버 응답·사용자 입력은 전부 textContent / value로만 넣는다 (innerHTML 사용 안 함).
// pptx-edit.js의 pxEl()·pxPanel()·pxClose()·pxPost()를 쓴다 (index.html에서 pptx-edit.js 다음에 읽는다).

const DC_SAMPLE = '# 1. 개요\n이 문서는 **분기 코칭 운영** 결과를 정리합니다.\n\n## 1.1 주요 성과\n- 코칭 세션 54회\n- 만족도 4.6/5\n\n## 1.2 다음 단계\n1. 코치 교육 일정 확정\n2. 분기 리뷰 준비\n\n# 2. 코치별 현황\n| 코치 | 주제 | 세션 수 |\n| 김코치 | 리더십 | 12 |\n| 이코치 | 커리어 | 8 |';

/** 개요 텍스트 → sections 배열. "---" 줄은 다음 섹션 앞 페이지 나누기. */
function dcParseOutline(text) {
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
  return sections.filter((s) => s.heading || s.paragraphs.length || s.bullets.length || s.numbered.length || s.table);
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

  const submit = async (body) => {
    busy(true);
    msg.replaceChildren(pxEl('p', { class: 'small', text: body.instruction ? 'AI가 문서를 쓰는 중… (10~40초)' : '문서를 만드는 중…' }));
    const j = await pxPost('/api/docx/create', body);
    busy(false);
    if (!j.ok) { msg.replaceChildren(pxEl('p', { class: 'error', text: '만들지 못했습니다: ' + (j.error || '알 수 없는 오류') })); return; }
    const kb = (j.doc.bytes / 1024).toFixed(1);
    const list = pxEl('ul', { class: 'small' });
    for (const s of j.outline || []) {
      const bits = [s.paragraphs && `문단 ${s.paragraphs}`, s.bullets && `글머리 ${s.bullets}`, s.numbered && `번호 ${s.numbered}`, s.tableRows && `표 ${s.tableRows}행`].filter(Boolean).join(' · ');
      list.append(pxEl('li', { text: `${s.level === 2 ? '　' : ''}${s.heading || '(제목 없음)'}${bits ? ' — ' + bits : ''}` }));
    }
    msg.replaceChildren(
      pxEl('p', { class: 'badge ok', text: `만들었습니다: ${j.doc.title} (${kb} KB, 섹션 ${j.stats.sections}개${j.planned ? ', AI 작성' : ''})` }),
      list,
      pxEl('div', { class: 'btnrow' },
        pxEl('a', { href: j.doc.url, class: 'button primary', text: '.docx 다운로드' }),
        pxEl('button', { class: 'secondary', text: '라이브러리에서 보기', onclick: async () => { pxClose(); if (typeof refreshLib === 'function') await refreshLib(); const f = document.getElementById('libFiles'); if (f) f.scrollIntoView({ block: 'start', behavior: 'smooth' }); } })),
    );
  };

  btnAi.addEventListener('click', () => {
    const instruction = instr.value.trim();
    if (!instruction) { msg.replaceChildren(pxEl('p', { class: 'error', text: '자연어 지시를 입력하세요.' })); return; }
    submit({ title: titleIn.value.trim(), instruction });
  });
  btnOutline.addEventListener('click', () => {
    const title = titleIn.value.trim();
    if (!title) { msg.replaceChildren(pxEl('p', { class: 'error', text: '개요로 만들 때는 문서 제목이 필요합니다.' })); return; }
    const sections = dcParseOutline(outline.value);
    if (!sections.length) { msg.replaceChildren(pxEl('p', { class: 'error', text: '개요를 입력하세요 (# 제목, - 글머리, 1. 번호, | 표 |).' })); return; }
    submit({ title, sections });
  });

  p.replaceChildren(
    pxEl('h3', { text: '새 Word 문서 만들기' }),
    pxEl('p', { class: 'small', text: '새 .docx 파일을 만들어 라이브러리에 저장합니다. 만든 문서는 내 개인 문서가 됩니다.' }),
    pxEl('label', { class: 'small', text: '문서 제목' }), titleIn,
    pxEl('h4', { text: '1. 자연어로 지시 (AI가 제목·문단·목록·표를 씁니다)' }), instr, pxEl('div', { class: 'btnrow' }, btnAi),
    pxEl('h4', { text: '2. 또는 개요를 직접 입력' }),
    pxEl('p', { class: 'small', text: '# 큰 제목 · ## 작은 제목 · - 글머리 · 1. 번호 · | 표 | (첫 줄이 머리글) · 빈 줄로 문단 구분 · --- 다음 제목 앞에서 페이지 나누기 · **굵게** *기울임*' }),
    outline, pxEl('div', { class: 'btnrow' }, btnOutline),
    msg,
    pxEl('div', { class: 'btnrow', style: 'margin-top:8px' }, pxEl('button', { class: 'secondary', onclick: pxClose, text: '닫기' })),
  );
  p.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
