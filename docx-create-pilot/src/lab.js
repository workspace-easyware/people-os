// DOCX 파일럿 시험 Worker (people-os-docx-pilot). People OS Worker가 아니다 — 파일럿이 끝나면 삭제한다.
// Node 실행이 막혀서 만들기·다시 읽기·XML 검사를 이 Worker 라우트로 돌린다 (PPTX·엑셀 파일럿과 같은 방식).
//   GET  /make            시험 문서 (.docx bytes)
//   GET  /selftest        시험 문서 생성 + 다시 읽기 + XML 검사 보고서 JSON
//   POST /create          body: 문서 정의 JSON → .docx bytes (CPU 측정용 최소 경로)
//   POST /read            body: .docx → 구조 JSON
//   POST /limits          상한·오류 경로 시험
//   POST /part?name=a,b   body: .docx → 부품 내용 (unzip 대신)
//   GET  /make-big?sections=N  큰 문서 (CPU 측정용)
import { unzipSync, strFromU8 } from "fflate";
import { repairTests } from "./repair.js";
import {
  createDocx, readDocx, numFormats, checkXml, wellFormed, DocxError, DOCX_LIMITS,
  inspectTables, isPlaceholder, placeholderProblem, normalizeDef, columnWidthsFor, TABLE_TEXT_TWIPS,
} from "./core.js";

// /inspect: 표 XML 수치 + 문단·목록 자리표시자 (docx 표 고치기 검증용)
function inspectBytes(u8) {
  const rd = readDocx(u8);
  const tables = inspectTables(u8);
  const ps = rd.blocks.filter((b) => b.type === "p");
  return {
    tables: tables.map(({ cells, ...t }) => ({ ...t, header: cells[0] })),
    placeholders: {
      tableHeaderCells: tables.reduce((a, t) => a + t.placeholderCells.header, 0),
      tableBodyCells: tables.reduce((a, t) => a + t.placeholderCells.body, 0),
      paragraphsOrItems: ps.filter((b) => isPlaceholder(b.text) || /작성\s*필요|\bTBD\b/i.test(b.text)).map((b) => b.text),
    },
    xml: checkXml(u8),
    blocks: rd.blocks,
  };
}

// /table-test: 열 너비 배분과 자리표시자 판정 단위 시험
function tableTests() {
  const T = (header, rows) => ({ header, rows });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const cases = {
    "요일·할 일 2열 (AI 온보딩 모양)": T(["요일", "할 일"], [["월", "오리엔테이션 및 People OS 계정 설정, 코칭 윤리 강령 숙지"], ["화", "시스템 교육: 세션 기록·리포트 작성법"], ["수", "선배 코치 세션 참관 2회"], ["목", "코칭 대화 모델(GROW) 실습"], ["금", "첫 주 회고 및 담당 코치이 배정"]]),
    "코치·주제·세션 수 3열 (구조화 시험)": T(["코치", "주제", "세션 수"], [["김코치", "리더십", "12"], ["이코치", "커리어", "8"], ["박코치", "팀빌딩", "6"]]),
    "1열": T(["항목"], [["가"]]),
    "12열 (최소 폭 바닥 확인)": T(Array.from({ length: 12 }, (_, i) => (i === 0 ? "아주 긴 설명이 들어가는 열 ".repeat(4) : `c${i}`)), [Array.from({ length: 12 }, (_, i) => (i === 0 ? "긴 내용 ".repeat(20) : "1"))]),
    "빈 표 (헤더만)": T(["A", "B", "C"], []),
  };
  const widths = Object.fromEntries(Object.entries(cases).map(([k, t]) => {
    const w = columnWidthsFor(t);
    return [k, { widths: w, sum: sum(w), sumOk: sum(w) === TABLE_TEXT_TWIPS, min: Math.min(...w), share: w.map((x) => Math.round((x / TABLE_TEXT_TWIPS) * 1000) / 10) }];
  }));
  const ph = ["(작성 필요)", "작성 필요", "TBD", "추후 작성", "예시", "[입력]", "○○○", "...", "**(작성 필요)**", "12명 (작성 필요)", "「추후 기재」"];
  const notPh = ["12", "김코치", "리더십", "예시 문서 검토", "미정인 일정은 다음 주 확정", "-", "N/A", "작성 완료", "TBDX 프로젝트"];
  const nd = (sections) => normalizeDef({ title: "t", sections });
  const problems = {
    "표 전부 (작성 필요)": placeholderProblem(nd([{ table: T(["코치", "주제", "세션 수"], [["(작성 필요)", "(작성 필요)", "(작성 필요)"], ["(작성 필요)", "(작성 필요)", "(작성 필요)"]]) }])),
    "표 헤더가 자리표시자": placeholderProblem(nd([{ table: T(["TBD", "값"], [["a", "1"]]) }])),
    "본문 절반이 자리표시자": placeholderProblem(nd([{ table: T(["a", "b"], [["1", "TBD"], ["2", "TBD"]]) }])),
    "본문 1/4만 자리표시자 (통과)": placeholderProblem(nd([{ table: T(["a", "b"], [["1", "TBD"], ["2", "3"]]) }])),
    "목록 전부 (작성 필요)": placeholderProblem(nd([{ numbered: ["(작성 필요)", "(작성 필요)", "(작성 필요)"] }])),
    "정상 문서 (통과)": placeholderProblem(nd([{ paragraphs: ["코치별 세션 수는 지시에 없어 표에 넣지 않았습니다."], bullets: ["a", "b"], table: T(["요일", "할 일"], [["월", "오리엔테이션"]]) }])),
  };
  return {
    widths,
    isPlaceholder: { shouldBeTrue: Object.fromEntries(ph.map((s) => [s, isPlaceholder(s)])), shouldBeFalse: Object.fromEntries(notPh.map((s) => [s, isPlaceholder(s)])) },
    problems,
    pass: Object.values(widths).every((x) => x.sumOk && x.min >= 700)
      && ph.every(isPlaceholder) && !notPh.some(isPlaceholder)
      && !!problems["표 전부 (작성 필요)"] && !!problems["표 헤더가 자리표시자"] && !!problems["본문 절반이 자리표시자"] && !!problems["목록 전부 (작성 필요)"]
      && problems["본문 1/4만 자리표시자 (통과)"] === null && problems["정상 문서 (통과)"] === null,
  };
}

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const DOCX_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const docx = (u8) => new Response(u8, { headers: { "content-type": DOCX_CT } });

// (진입 모듈에서는 핸들러 말고 export하면 workerd가 시작하지 않는다)
const TEST_DEF = {
  title: "2026 코칭 프로그램 운영 보고서",
  subtitle: "People OS 파일럿 시험 문서",
  sections: [
    { heading: "1. 개요", level: 1, paragraphs: ["이 문서는 **docx 라이브러리**로 Workers 안에서 *새로* 만든 시험 문서입니다.", "두 번째 문단에는 **굵게**와 *기울임*이 함께 있고, 특수문자 <태그> & \"따옴표\"도 들어 있습니다."] },
    { heading: "1.1 주요 성과", level: 2, bullets: ["코칭 세션 54회 진행", "만족도 **4.6**/5", "*신규* 코치 3명 합류"] },
    { heading: "1.2 다음 단계", level: 2, numbered: ["코치 교육 일정 확정", "세션 기록 템플릿 배포", "분기 리뷰 준비"] },
    { heading: "2. 코치별 현황", level: 1, pageBreakBefore: true, paragraphs: ["아래 표는 코치별 세션 수입니다."], table: { header: ["코치", "주제", "세션 수"], rows: [["김코치", "리더십", "12"], ["이코치", "커리어", "8"], ["박코치", "팀빌딩", "6"]] } },
    { heading: "3. 두 번째 번호 목록 (1부터 다시)", level: 1, numbered: ["첫째", "둘째"] },
  ],
};

async function selftest(def = TEST_DEF) {
  const r = await createDocx(def);
  return { ...verifyBytes(r.bytes), stats: r.stats, _bytes: r.bytes };
}

// TEST_DEF(또는 같은 내용의 통합 시험 정의 evidence/def-test.json)로 만든 파일을 검사한다. 제목 줄만 다를 수 있다.
function verifyBytes(bytes) {
  const r = { bytes };
  const rd = readDocx(r.bytes);
  const fmts = numFormats(r.bytes);
  const xml = checkXml(r.bytes);
  const ps = rd.blocks.filter((b) => b.type === "p");
  const byStyle = (s) => ps.filter((b) => b.style === s).map((b) => b.text);
  const tables = rd.blocks.filter((b) => b.type === "table");
  const numIds = (texts) => texts.map((t) => ps.find((b) => b.text === t)?.numId);
  const bulletIds = numIds(TEST_DEF.sections[1].bullets.map((t) => t.replace(/\*/g, "")));
  const num1 = numIds(TEST_DEF.sections[2].numbered);
  const num2 = numIds(TEST_DEF.sections[4].numbered);
  const docXml = strFromU8(unzipSync(r.bytes)["word/document.xml"]);
  const checks = {
    "ZIP 부품 (document·styles·numbering·[Content_Types]·rels)": ["word/document.xml", "word/styles.xml", "word/numbering.xml", "[Content_Types].xml", "_rels/.rels"].every((n) => rd.parts.includes(n)),
    "제목 (Title 스타일)": byStyle("Title")[0] === TEST_DEF.title,
    "Heading1 3개": JSON.stringify(byStyle("Heading1")) === JSON.stringify(["1. 개요", "2. 코치별 현황", "3. 두 번째 번호 목록 (1부터 다시)"]),
    "Heading2 2개": JSON.stringify(byStyle("Heading2")) === JSON.stringify(["1.1 주요 성과", "1.2 다음 단계"]),
    "문단 굵게·기울임 런": /<w:b\/>[\s\S]{0,200}>docx 라이브러리</.test(docXml) && /<w:i\/>[\s\S]{0,200}>새로</.test(docXml),
    "특수문자 이스케이프 후 그대로": ps.some((b) => b.text.includes("<태그> & \"따옴표\"")),
    "글머리 목록 3개 (bullet 형식)": bulletIds.every((id) => id && fmts[id] === "bullet"),
    "번호 목록 3개 (decimal 형식)": num1.every((id) => id && fmts[id] === "decimal") && new Set(num1).size === 1,
    "두 번째 번호 목록은 다른 numId (1부터 다시)": num2.every((id) => id && fmts[id] === "decimal") && num2[0] !== num1[0],
    "표 1개 (헤더 + 3행)": tables.length === 1 && tables[0].rows.length === 4,
    "표 헤더 행 값": JSON.stringify(tables[0]?.rows[0]) === JSON.stringify(["코치", "주제", "세션 수"]),
    "표 셀 값": JSON.stringify(tables[0]?.rows.slice(1)) === JSON.stringify([["김코치", "리더십", "12"], ["이코치", "커리어", "8"], ["박코치", "팀빌딩", "6"]]),
    "표 헤더 반복 (tblHeader)": tables[0]?.headerRow === true,
    "페이지 나누기 (2장 앞)": (() => { const k = ps.findIndex((b) => b.text === "2. 코치별 현황"); return k > 0 && ps[k - 1].pageBreak === true; })(),
    "XML well-formed (전 부품)": xml.errors.length === 0 && xml.checked > 0,
  };
  return { pass: Object.values(checks).every(Boolean), checks, bytes: r.bytes.byteLength, parts: rd.parts, xml, numFormats: fmts, blocks: rd.blocks };
}

async function tryCode(fn) {
  try { await fn(); return "no-error"; } catch (e) { return e instanceof DocxError ? `${e.code}: ${e.message}` : `other: ${e instanceof Error ? e.message : String(e)}`; }
}

async function limits() {
  const many = (n, x) => Array.from({ length: n }, (_, i) => `${x}${i}`);
  return {
    "정의가 배열": await tryCode(() => createDocx([])),
    "제목 없음": await tryCode(() => createDocx({ sections: [] })),
    "sections 없음": await tryCode(() => createDocx({ title: "a" })),
    "섹션 51개": await tryCode(() => createDocx({ title: "a", sections: many(51, "s").map((h) => ({ heading: h })) })),
    "문단 101개": await tryCode(() => createDocx({ title: "a", sections: [{ paragraphs: many(101, "p") }] })),
    "문단 글자 8001": await tryCode(() => createDocx({ title: "a", sections: [{ paragraphs: ["가".repeat(8001)] }] })),
    "표 열 13": await tryCode(() => createDocx({ title: "a", sections: [{ table: { header: many(13, "h"), rows: [] } }] })),
    "표 행 201": await tryCode(() => createDocx({ title: "a", sections: [{ table: { header: ["a"], rows: many(201, "r").map((x) => [x]) } }] })),
    "표 셀 합계 2001 초과 (12열 × 168행)": await tryCode(() => createDocx({ title: "a", sections: [{ table: { header: many(12, "h"), rows: Array.from({ length: 167 }, () => many(12, "c")) } }] })),
    "행 칸 수 > 헤더": await tryCode(() => createDocx({ title: "a", sections: [{ table: { header: ["a"], rows: [["1", "2"]] } }] })),
    "빈 헤더": await tryCode(() => createDocx({ title: "a", sections: [{ table: { header: [], rows: [] } }] })),
    "빈 섹션": await tryCode(() => createDocx({ title: "a", sections: [{}] })),
    "문단이 객체": await tryCode(() => createDocx({ title: "a", sections: [{ paragraphs: [{ x: 1 }] }] })),
    "숫자 셀 (문자열로 허용)": await tryCode(() => createDocx({ title: "a", sections: [{ table: { header: ["n"], rows: [[1]] } }] })),
    "블록 합계 2001 초과 (섹션 50 × 문단 41)": await tryCode(() => createDocx({ title: "a", sections: many(50, "s").map(() => ({ paragraphs: many(41, "p") })) })),
    "제어문자 (\\u0001) 문단": await (async () => {
      try {
        const r = await createDocx({ title: "제어\u0002", sections: [{ heading: "머리\u000b", paragraphs: ["앞\u0001뒤", "탭\t유지"] }] });
        return { xml: checkXml(r.bytes), texts: readDocx(r.bytes).blocks.map((b) => b.text) };
      } catch (e) { return `error: ${e.message}`; }
    })(),
    "XML 검사기 음성 시험 (오류를 잡아야 함)": ["<a><b></a>", "<a x=\"1\" x=\"2\"/>", "<a>&nbsp;</a>", "<a><b/>", "<a/><b/>", "<a x=1/>", "<a>\u0001</a>"].map((x) => [x, wellFormed(x)]),
  };
}

function bigDef(n, paras = 2) {
  return {
    title: `큰 문서 (${n}섹션)`,
    sections: Array.from({ length: n }, (_, i) => ({
      heading: `섹션 ${i + 1}`, level: i % 3 === 0 ? 1 : 2,
      paragraphs: [`섹션 ${i + 1}의 첫 문단 **굵게** 그리고 *기울임*. `.repeat(8), ...Array.from({ length: Math.max(paras - 1, 0) }, (_, k) => `${k + 2}번째 문단 `.repeat(30))],
      bullets: ["항목 하나", "항목 둘", "항목 셋"],
      table: i % 5 === 0 ? { header: ["이름", "값", "비고"], rows: Array.from({ length: 20 }, (_, r) => [`사람${r}`, String(r * 7), "메모"]) } : undefined,
    })),
  };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/make") return docx((await createDocx(TEST_DEF)).bytes);
      if (url.pathname === "/selftest") { const { _bytes, ...rest } = await selftest(); return json(rest); }
      if (url.pathname === "/create" && req.method === "POST") return docx((await createDocx(await req.json(), DOCX_LIMITS, { tableMode: url.searchParams.get("mode") || undefined })).bytes);
      if (url.pathname === "/inspect" && req.method === "POST") return json(inspectBytes(new Uint8Array(await req.arrayBuffer())));
      if (url.pathname === "/table-test") return json(tableTests());
      // 라이브 스모크 임시 세션 토큰 (로컬 전용 — 셸의 난수 도구가 승인 대기라서). 줄바꿈 없이 hex 48자.
      if (url.pathname === "/rand") return new Response([...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join(""));
      if (url.pathname === "/repair-test") return json(repairTests());
      if (url.pathname === "/verify" && req.method === "POST") return json(verifyBytes(new Uint8Array(await req.arrayBuffer())));
      if (url.pathname === "/read" && req.method === "POST") return json(readDocx(new Uint8Array(await req.arrayBuffer())));
      if (url.pathname === "/limits") return json(await limits());
      if (url.pathname === "/make-big") {
        const n = Math.min(Number(url.searchParams.get("sections") || 50), DOCX_LIMITS.maxSections);
        const r = await createDocx(bigDef(n, Math.min(Number(url.searchParams.get("paras") || 2), DOCX_LIMITS.maxParagraphsPerSection)));
        if (url.searchParams.get("out") === "json") return json({ bytes: r.bytes.byteLength, stats: r.stats, xml: checkXml(r.bytes) });
        return docx(r.bytes);
      }
      if (url.pathname === "/part" && req.method === "POST") {
        const files = unzipSync(new Uint8Array(await req.arrayBuffer()));
        const names = (url.searchParams.get("name") || "").split(",").filter(Boolean);
        const out = names.length ? names.map((n) => `===== ${n}\n${files[n] ? strFromU8(files[n]) : "(없음)"}`) : Object.keys(files).map((n) => `${n} ${files[n].length}`);
        return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return json({ ok: true, routes: ["/make", "/selftest", "/create", "/read", "/limits", "/make-big", "/part"] });
    } catch (e) {
      return json({ ok: false, code: e.code || "internal", error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, e instanceof DocxError && e.code !== "internal" ? 400 : 500);
    }
  },
};
