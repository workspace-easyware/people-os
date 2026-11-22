// DOCX 편집 파일럿 시험 Worker (people-os-docx-edit-pilot). People OS Worker가 아니다 — 파일럿이 끝나면 삭제한다.
// Node 실행이 막혀서 만들기·편집·다시 읽기·XML 검사를 이 Worker 라우트로 돌린다 (PPTX·엑셀 파일럿과 같은 방식).
//   GET  /make | /make-wordlike | /make-big?n=N   시험 문서 (.docx bytes)
//   GET  /selftest?doc=wordlike|lib               시험 문서 편집 + 모든 검사 보고서 JSON
//   GET  /selftest-out?doc=wordlike|lib           같은 편집의 결과 .docx bytes
//   POST /inspect                                 body: .docx → 요약 JSON
//   POST /edit?ops=<JSON>[&report=1]              body: .docx → 편집본 bytes (report=1이면 보고서 JSON)
//   POST /part?name=a,b                           body: .docx → 부품 내용 (unzip 대신)
//   GET  /limits                                  상한·오류 경로 시험
//   GET  /patcher                                 후보 ②: docx 9.16 patchDocument (자리표시자 치환) 시험
//   GET  /explore?doc=…                           ooxml-core 저장 동작 탐색 (손대지 않고 저장 = 바이트 동일?)
import { loadDocx } from "ooxml-core/docx";
import { unzipSync, strFromU8 } from "fflate";
import { patchDocument, PatchType, TextRun } from "docx";
import { makeLibDoc, makeWordLikeDoc, makeBigDoc } from "./samples.js";
import { EditError, DOCX_EDIT_LIMITS, DOCX_MAX_OPS, loadDoc, summarizeDoc, applyDocxOps, replaceDocxText, checkXml, paraText, wellFormed } from "./core.js";

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const docx = (u8) => new Response(u8, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
const bodyBytes = async (req) => new Uint8Array(await req.arrayBuffer());
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const OPS = {
  wordlike: [
    { op: "replace", find: "홍길동", to: "김철수", all: true }, // run 3개에 걸친 이름 + 표 셀 + 머리글
    { op: "paragraph", index: 1, text: "분기 코칭 리뷰 (수정본)" },
    { op: "cell", table: 1, r: 1, c: 2, text: "26" }, // 문단 2개·run 2개인 셀
    { op: "cell", table: 1, r: 1, c: 1, text: "32" },
    { op: "insert", after: 6, text: "새로 넣은 문단입니다.\t탭 & <특수> \"문자\" 'x'" },
    { op: "replace", find: "500만 원", to: "650만 원" }, // 메모가 달린 run
    { op: "replace", find: "4분기", to: "4분기(10~12월)" }, // 삽입 추적(w:ins) run
    { op: "replace", find: "사내 위키", to: "사내 위키(코칭)" }, // 하이퍼링크 run
  ],
  lib: [
    { op: "replace", find: "김코치", to: "최코치" }, // 처음 1곳만 (3번 문단) — 표·대조군의 김코치는 그대로
    { op: "replace", find: "24회", to: "30회" },
    { op: "cell", table: 1, r: 1, c: 2, text: "15" },
    { op: "paragraph", index: 18, text: "하반기 일정 확정 (7월 첫 주)" },
    { op: "insert", after: 18, text: "외부 코치 풀 검토" }, // 글머리 문단 뒤 → 글머리를 물려받는다
    { op: "delete", index: 19 },
    { op: "replace", find: "머리글", to: "머리글(편집)" },
    { op: "insert", after: 0, text: "[편집본] 맨 앞에 넣은 문단" },
  ],
};

async function selftest(kind) {
  const src = kind === "lib" ? await makeLibDoc() : makeWordLikeDoc();
  const copy = src.slice();
  const r = await applyDocxOps(src, OPS[kind]);
  const A = unzipSync(src);
  const B = unzipSync(r.bytes);
  const da = strFromU8(A["word/document.xml"]);
  const db = strFromU8(B["word/document.xml"]);
  const re = await loadDoc(r.bytes);
  const texts = re.idx.paragraphs.map((e) => paraText(e.p));
  const stories = re.idx.stories.map((e) => `${e.where}: ${paraText(e.p)}`);
  // 대조군 문단의 XML이 바이트 그대로인지
  const ctrlAt = da.indexOf("대조군 문단");
  const ctrlStart = da.lastIndexOf("<w:p", ctrlAt);
  const ctrlStart2 = da.lastIndexOf("<w:p ", ctrlAt) >= 0 && da.lastIndexOf("<w:p ", ctrlAt) > da.lastIndexOf("<w:p>", ctrlAt) ? da.lastIndexOf("<w:p ", ctrlAt) : da.lastIndexOf("<w:p>", ctrlAt);
  const ctrlXml = da.slice(Math.max(ctrlStart2, 0), da.indexOf("</w:p>", ctrlAt) + 6);
  const sect = (s) => { const i = s.lastIndexOf("<w:sectPr"); return i < 0 ? "" : s.slice(i, s.indexOf("</w:sectPr>", i) + 11); };
  const checks = {};
  if (kind === "wordlike") {
    Object.assign(checks, {
      "제목 문단 교체": texts[0] === "분기 코칭 리뷰 (수정본)",
      "run 3개에 걸친 이름 교체 (홍·길·동 → 김철수)": texts[1] === "담당자는 김철수 팀장입니다.",
      "교체 뒤에도 굵게 run 유지": /<w:rPr><w:b\/><\/w:rPr><w:t[^>]*>김철수<\/w:t>/.test(db),
      "표 셀 교체 (gridSpan 셀의 홍길동)": texts.includes("김철수 팀장 확인 필요"),
      "머리글 교체": stories.some((s) => s === "header: 일잇 People OS — 머리글 (김철수)"),
      "cell op: 문단 2개 셀 → 26": texts[12] === "26" && texts[13] === "비고" && !texts.includes("(잠정)"), // 앞에 문단 1개가 들어가 번호가 1씩 밀린다. 셀의 둘째 문단은 없어진다
      "cell op: 32": texts[11] === "32",
      "셀 글자색 유지 (0070C0)": /<w:color w:val="0070C0"\/><\/w:rPr><w:t[^>]*>26<\/w:t>/.test(db),
      "셀 문단 정렬 유지 (jc right)": /<w:jc w:val="right"\/><\/w:pPr><w:r><w:t[^>]*>32<\/w:t>/.test(db),
      "insert: 6번 문단 뒤 새 문단": texts[6] === "새로 넣은 문단입니다.\t탭 & <특수> \"문자\" 'x'" && texts[5] === "예산은 650만 원입니다.",
      "특수문자 이스케이프 (&amp; &lt;)": db.includes("탭 &amp; &lt;특수&gt;"),
      "메모 범위 유지 (commentRangeStart/End/Reference)": /<w:commentRangeStart w:id="1"\/>/.test(db) && /<w:commentRangeEnd w:id="1"\/>/.test(db) && /<w:commentReference w:id="1"\/>/.test(db),
      "삽입 추적 안 글자 교체 + w:ins 유지": /<w:ins w:id="11"[^>]*><w:r><w:t[^>]*>4분기\(10~12월\)<\/w:t><\/w:r><\/w:ins>/.test(db),
      "삭제 추적(w:del 3분기) 그대로": db.includes("<w:del w:id=\"10\" w:author=\"검토자\" w:date=\"2026-11-20T09:00:00Z\"><w:r><w:delText>3분기</w:delText></w:r></w:del>"),
      "하이퍼링크 유지 + 글자 교체": /<w:hyperlink r:id="rId5" w:history="1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t[^>]*>사내 위키\(코칭\)<\/w:t><\/w:r><\/w:hyperlink>/.test(db),
      "책갈피 유지": db.includes('<w:bookmarkStart w:id="0" w:name="_GoBack"/>'),
      "필드(fldSimple DATE) 그대로": db.includes('<w:fldSimple w:instr=" DATE \\@ &quot;yyyy-MM-dd&quot; ">'),
      "탭·줄바꿈 유지": db.includes("<w:tab/>") && db.includes("<w:br/>"),
      "바닥글 부품 바이트 동일": same(A["word/footer1.xml"], B["word/footer1.xml"]),
    });
  } else {
    Object.assign(checks, {
      "맨 앞 insert (after 0)": texts[0] === "[편집본] 맨 앞에 넣은 문단",
      "replace 처음 1곳만 (3번 문단)": texts[3] === "담당 코치: 최코치",
      "표의 김코치는 그대로": texts.includes("김코치"),
      "대조군의 김코치는 그대로": texts.some((t) => t.startsWith("대조군 문단") && t.includes("김코치")),
      "24회 → 30회 (굵게 run)": texts[2] === "2026년 상반기 코칭 세션은 총 30회 진행되었습니다.",
      "cell op 15": texts.includes("15") && !texts.includes("12"),
      "글머리 문단 교체": texts.includes("하반기 일정 확정 (7월 첫 주)"),
      "글머리 뒤 insert": texts.includes("외부 코치 풀 검토"),
      "새 문단이 글머리(numPr)를 물려받음": /<w:numPr>(?:(?!<\/w:p>).)*외부 코치 풀 검토/.test(db),
      "delete: 코치 추가 선발 없어짐": !texts.includes("코치 추가 선발"),
      "머리글 교체": stories.some((s) => s.includes("머리글(편집)")),
    });
  }
  Object.assign(checks, {
    "대조군 문단 XML 바이트 동일": ctrlXml.length > 20 && db.includes(ctrlXml),
    "sectPr(구역 설정) 바이트 동일": sect(da).length > 10 && sect(da) === sect(db),
    "바뀐 부품은 document.xml과 머리글뿐": r.parts.changed.every((n) => n === "word/document.xml" || /^word\/header\d+\.xml$/.test(n)) && r.parts.added.length === 0 && r.parts.removed.length === 0,
    "모든 부품 XML well-formed": checkXml(r.bytes).errors.length === 0,
    "원본 입력 bytes 그대로": same(src, copy),
    "저장본 다시 열림": re.idx.paragraphs.length > 0,
    "같은 입력·ops면 같은 바이트 (결정적)": same((await applyDocxOps(src, OPS[kind])).bytes, r.bytes),
  });
  const failed = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k);
  return {
    report: {
      doc: kind, ok: failed.length === 0, passed: Object.keys(checks).length - failed.length, total: Object.keys(checks).length, failed, checks,
      sizes: r.sizes, parts: r.parts, xml: checkXml(r.bytes), log: r.log, diff: r.diff, warnings: r.warnings,
      documentXml: { before: da.length, after: db.length },
      texts, stories,
    },
    bytes: r.bytes,
  };
}

async function limitsTest() {
  const src = makeWordLikeDoc();
  const out = {};
  const tryOps = async (name, ops, bytes = src, lim) => {
    try { const r = await applyDocxOps(bytes, ops, lim); out[name] = { ok: true, log: r.log }; }
    catch (e) { out[name] = e instanceof EditError ? { code: e.code, error: e.message } : { code: "THROW", error: String(e && e.stack || e) }; }
  };
  await tryOps("ops 없음", []);
  await tryOps("ops 상한 초과", Array.from({ length: DOCX_MAX_OPS + 1 }, () => ({ op: "replace", find: "a", to: "b" })));
  await tryOps("모르는 op", [{ op: "nope" }]);
  await tryOps("없는 문단", [{ op: "paragraph", index: 999, text: "x" }]);
  await tryOps("없는 표", [{ op: "cell", table: 5, r: 0, c: 0, text: "x" }]);
  await tryOps("없는 셀", [{ op: "cell", table: 1, r: 9, c: 0, text: "x" }]);
  await tryOps("못 찾는 글자", [{ op: "replace", find: "없는글자XYZ", to: "x" }]);
  await tryOps("삭제 추적 안 글자는 못 찾음 (3분기)", [{ op: "replace", find: "3분기", to: "x" }]);
  await tryOps("필드 결과는 못 찾음 (2026-11-22)", [{ op: "replace", find: "2026-11-22", to: "x" }]);
  await tryOps("표 안 문단 delete 거부", [{ op: "delete", index: 8 }]);
  await tryOps("표 안 문단 뒤 insert 거부", [{ op: "insert", after: 8, text: "x" }]);
  await tryOps("마지막 문단 delete 거부", [{ op: "delete", index: 17 }]);
  await tryOps("text가 문자열 아님", [{ op: "paragraph", index: 1, text: 5 }]);
  await tryOps("글자 수 상한", [{ op: "paragraph", index: 1, text: "가".repeat(10_001) }]);
  await tryOps("ZIP 아님", [{ op: "paragraph", index: 1, text: "x" }], new TextEncoder().encode("hello world, not a zip"));
  await tryOps("빈 파일", [{ op: "paragraph", index: 1, text: "x" }], new Uint8Array(0));
  await tryOps("문단 수 상한 (상한 10으로 낮춤)", [{ op: "paragraph", index: 1, text: "x" }], src, { ...DOCX_EDIT_LIMITS, maxParagraphs: 10 });
  await tryOps("본문 크기 상한 (1000 B로 낮춤)", [{ op: "paragraph", index: 1, text: "x" }], src, { ...DOCX_EDIT_LIMITS, maxDocumentPartBytes: 1000 });
  await tryOps("파일 크기 상한 (1000 B로 낮춤)", [{ op: "paragraph", index: 1, text: "x" }], src, { ...DOCX_EDIT_LIMITS, maxInputBytes: 1000 });
  // 제어문자: 지워져서 저장돼야 한다
  try {
    const r = await applyDocxOps(src, [{ op: "paragraph", index: 1, text: "제어\u0001문자\u000b와 😀 이모지, 짝 없는 \uD800 서로게이트" }]);
    const re = await loadDoc(r.bytes);
    out["제어문자 정리"] = { ok: true, text: paraText(re.idx.paragraphs[0].p), xml: checkXml(r.bytes).errors };
  } catch (e) { out["제어문자 정리"] = { code: e.code || "THROW", error: String(e.message || e) }; }
  // xlsx 파일을 넣으면
  try {
    const { zipSync, strToU8 } = await import("fflate");
    const fake = zipSync({ "xl/workbook.xml": strToU8("<workbook/>"), "[Content_Types].xml": strToU8("<Types/>") });
    await applyDocxOps(fake, [{ op: "paragraph", index: 1, text: "x" }]);
    out["docx가 아닌 ZIP"] = { ok: true };
  } catch (e) { out["docx가 아닌 ZIP"] = { code: e.code || "THROW", error: String(e.message || e) }; }
  // 가벼운 교체 경로
  try { const r = await replaceDocxText(src, "팀장", "실장", true); out["replace 경로 (all)"] = { ok: true, count: r.count }; } catch (e) { out["replace 경로 (all)"] = { code: e.code, error: e.message }; }
  try { const r = await replaceDocxText(src, "팀장", "실장", false); out["replace 경로 (처음 1곳)"] = { ok: true, count: r.count }; } catch (e) { out["replace 경로 (처음 1곳)"] = { code: e.code, error: e.message }; }
  return out;
}

// 후보 ②: docx 9.16 patchDocument — {{자리표시자}}만 바꾼다.
async function patcherTest() {
  const out = {};
  const src = makeWordLikeDoc();
  try {
    const r = await patchDocument({ outputType: "uint8array", data: src, patches: { name: { type: PatchType.PARAGRAPH, children: [new TextRun("김철수")] } } });
    const A = unzipSync(src); const B = unzipSync(r);
    out.noPlaceholder = {
      ran: true,
      note: "자리표시자가 없는 문서: 바뀌는 글자 없음 (일반 글자 치환 API가 없다)",
      textChanged: strFromU8(B["word/document.xml"]).includes("김철수"),
      identicalParts: Object.keys(A).filter((n) => B[n] && same(A[n], B[n])),
      changedParts: Object.keys(A).filter((n) => !B[n] || !same(A[n], B[n])),
      documentXmlBytes: { before: A["word/document.xml"].length, after: B["word/document.xml"] ? B["word/document.xml"].length : null },
    };
  } catch (e) { out.noPlaceholder = { ran: false, error: String(e && e.stack || e).slice(0, 600) }; }
  try {
    // 자리표시자가 있는 문서 (ooxml 편집으로 만들어 넣는다)
    const withPh = (await applyDocxOps(src, [{ op: "paragraph", index: 1, text: "담당: {{name}} / 기간: {{period}}" }])).bytes;
    const r = await patchDocument({
      outputType: "uint8array", data: withPh,
      patches: { name: { type: PatchType.PARAGRAPH, children: [new TextRun("김철수")] }, period: { type: PatchType.PARAGRAPH, children: [new TextRun("4분기")] } },
    });
    const A = unzipSync(withPh); const B = unzipSync(r);
    const db = strFromU8(B["word/document.xml"]);
    out.withPlaceholder = {
      ran: true,
      replaced: db.includes("김철수") && db.includes("4분기") && !db.includes("{{name}}"),
      identicalParts: Object.keys(A).filter((n) => B[n] && same(A[n], B[n])),
      changedParts: Object.keys(A).filter((n) => !B[n] || !same(A[n], B[n])),
      documentXmlBytes: { before: A["word/document.xml"].length, after: B["word/document.xml"].length },
      controlParagraphKept: db.includes("대조군 문단"),
      wellFormed: wellFormed(db),
    };
  } catch (e) { out.withPlaceholder = { ran: false, error: String(e && e.stack || e).slice(0, 600) }; }
  return out;
}

async function explore(kind) {
  const src = kind === "lib" ? await makeLibDoc() : makeWordLikeDoc();
  const a = await loadDocx(src);
  const saved = await a.save();
  const b = await loadDocx(src);
  return {
    noEditSaveIdentical: same(saved, src),
    idsStableAcrossLoads: JSON.stringify(a.model.blocks.map((x) => x.id)) === JSON.stringify(b.model.blocks.map((x) => x.id)),
    ids: a.model.blocks.map((x) => x.id),
  };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      // 로컬 전용: 임시 세션 토큰 (셸 난수 도구가 막혀서). 줄바꿈 없이 응답한다.
      if (url.pathname === "/token") return new Response(`dxlive-${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""), { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/now") return new Response(String(Date.now()), { headers: { "content-type": "text/plain" } });
      if (url.pathname === "/make") return docx(await makeLibDoc());
      if (url.pathname === "/make-wordlike") return docx(makeWordLikeDoc());
      if (url.pathname === "/make-big") return docx(makeBigDoc(Math.min(20000, Number(url.searchParams.get("n")) || 1000)));
      if (url.pathname === "/selftest") return json((await selftest(url.searchParams.get("doc") === "lib" ? "lib" : "wordlike")).report);
      if (url.pathname === "/selftest-out") return docx((await selftest(url.searchParams.get("doc") === "lib" ? "lib" : "wordlike")).bytes);
      if (url.pathname === "/limits") return json(await limitsTest());
      if (url.pathname === "/patcher") return json(await patcherTest());
      if (url.pathname === "/explore") return json(await explore(url.searchParams.get("doc")));
      if (url.pathname === "/inspect" && req.method === "POST") {
        const { loaded, idx, parts } = await loadDoc(await bodyBytes(req));
        return json(summarizeDoc(loaded, idx, parts));
      }
      if (url.pathname === "/edit" && req.method === "POST") {
        const ops = JSON.parse(url.searchParams.get("ops") || "[]");
        const lim = url.searchParams.get("maxParagraphs") ? { ...DOCX_EDIT_LIMITS, maxParagraphs: Number(url.searchParams.get("maxParagraphs")) } : DOCX_EDIT_LIMITS;
        const r = await applyDocxOps(await bodyBytes(req), ops, lim);
        if (url.searchParams.get("report")) { const { bytes, before, after, ...rest } = r; return json({ ...rest, paragraphs: { before: before.paragraphCount, after: after.paragraphCount } }); }
        return docx(r.bytes);
      }
      if (url.pathname === "/part" && req.method === "POST") {
        const want = (url.searchParams.get("name") || "").split(",").filter(Boolean);
        const files = unzipSync(await bodyBytes(req));
        if (!want.length) return json(Object.entries(files).map(([n, d]) => ({ name: n, bytes: d.length })));
        return new Response(want.map((n) => `===== ${n} =====\n${files[n] ? strFromU8(files[n]) : "(없음)"}`).join("\n\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (e) {
      if (e instanceof EditError) return json({ ok: false, code: e.code, error: e.message }, e.code === "limit" ? 413 : e.code === "internal" ? 500 : 422);
      return json({ ok: false, error: String(e && e.stack || e) }, 500);
    }
  },
};
