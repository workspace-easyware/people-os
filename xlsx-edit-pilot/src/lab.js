// XLSX 파일럿 시험 Worker (people-os-xlsx-pilot). People OS Worker가 아니다 — 파일럿이 끝나면 삭제한다.
// Node 실행이 막혀서 만들기·편집·재파싱·XML 검사를 전부 이 Worker 라우트로 돌린다 (PPTX 파일럿과 같은 방식).
//   GET  /make                 시험 워크북 (.xlsx bytes)
//   POST /inspect              body: xlsx → 요약 JSON
//   POST /selftest[?out=xlsx]  body: xlsx (없으면 /make 결과) → 편집 5종 + 검증 보고서 JSON (out=xlsx면 편집본 bytes)
//   POST /edit?ops=<JSON>      body: xlsx → 편집본 bytes (CPU 측정용 최소 경로)
//   POST /limits               상한·오류 경로 시험
import { readWorkbook, createWorkbook, writeWorkbook } from "xlvane";
import { unzipSync, strFromU8 } from "fflate";
import { makeTestBook } from "./book.js";
import { applyXlsxOps, summarizeBook, loadBook, checkXml, compareParts, wellFormed, EditError, XLSX_LIMITS } from "./core.js";

const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const xlsx = (u8) => new Response(u8, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });

async function bodyBytes(req) {
  const b = new Uint8Array(await req.arrayBuffer());
  return b.byteLength ? b : makeTestBook();
}

const PILOT_OPS = [
  { op: "cell", sheet: "요약", cell: "B4", value: 25 },
  { op: "formula", sheet: "요약", cell: "B6", formula: "SUM(B4:B5)", result: 55 },
  { op: "formula", sheet: "요약", cell: "B7", formula: "=MAX(B4:B5)", result: 30 },
  { op: "cell", sheet: "요약", cell: "A7", value: "최대" },
  { op: "row", sheet: "데이터", values: ["정코치", "커리어", 4] },
  { op: "formula", sheet: "요약", cell: "B8", formula: "SUM(데이터!C2:C6)", result: 30 },
  { op: "sheet", name: "메모" },
  { op: "cell", sheet: "메모", cell: "A1", value: "추가된 시트" },
  { op: "formula", sheet: "메모", cell: "B1", formula: "요약!B6", result: 55 },
];

function selftest(input) {
  const keep = input.slice();
  const r = applyXlsxOps(input, PILOT_OPS);
  const wb = readWorkbook(r.bytes);
  const s = wb.getSheet("요약");
  const d = wb.getSheet("데이터");
  const m = wb.getSheet("메모");
  const orig = readWorkbook(keep);
  const ctrlPart = orig.getSheet("대조군").part.replace(/^\//, "");
  const v = (sh, ref) => sh.cell(ref)?.value ?? null;
  const f = (sh, ref) => sh.cell(ref)?.formula?.text ?? null;
  const checks = {
    "요약!B4 = 25": v(s, "B4") === 25,
    "요약!B6 = SUM(B4:B5) → 55": f(s, "B6") === "SUM(B4:B5)" && v(s, "B6") === 55,
    "요약!B7 = MAX(B4:B5) → 30": f(s, "B7") === "MAX(B4:B5)" && v(s, "B7") === 30,
    "요약!A7 = 최대": v(s, "A7") === "최대",
    "요약!B8 = SUM(데이터!C2:C6) → 30": f(s, "B8") === "SUM(데이터!C2:C6)" && v(s, "B8") === 30,
    "요약!A1 서식(굵게·배경) 유지": !!s.cell("A1")?.style?.font?.bold && !!s.cell("A1")?.style?.fill,
    "요약!B6 굵게 유지": !!s.cell("B6")?.style?.font?.bold,
    "데이터 행 6 = 정코치/커리어/4": v(d, "A6") === "정코치" && v(d, "B6") === "커리어" && v(d, "C6") === 4,
    "표 코칭세션 A1:C6로 늘어남": d.tables[0]?.ref === "A1:C6",
    "메모 시트 추가 (맨 뒤)": wb.sheets[wb.sheets.length - 1]?.name === "메모",
    "메모!A1·B1": v(m, "A1") === "추가된 시트" && f(m, "B1") === "요약!B6" && v(m, "B1") === 55,
    "대조군 시트 XML 바이트 동일": r.parts.identicalSheets.includes(ctrlPart),
    "대조군 값 동일": JSON.stringify([...wb.getSheet("대조군").cells()].map((c) => [c.ref, c.value, c.formula?.text])) === JSON.stringify([...orig.getSheet("대조군").cells()].map((c) => [c.ref, c.value, c.formula?.text])),
    "fullCalcOnLoad": wb.calculation?.fullCalcOnLoad === true,
    "XML well-formed (전 부품)": r.xml.errors.length === 0,
    "원본 bytes 그대로": keep.length === input.length && keep.every((b, i) => b === input[i]),
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    sizes: r.sizes,
    parts: r.parts,
    xml: r.xml,
    log: r.log,
    warnings: r.warnings,
    diff: r.diff,
    readerWarnings: wb.warnings.map((w) => w.code),
    sheets: wb.sheets.map((x) => ({ name: x.name, part: x.part, sheetId: x.sheetId, cells: x.cellCount })),
    bytes: r.bytes,
  };
}

function tryCode(fn) {
  try { fn(); return "no-error"; } catch (e) { return e instanceof EditError ? `${e.code}: ${e.message}` : `other: ${e instanceof Error ? e.message : String(e)}`; }
}

function limits(book) {
  const small = { ...XLSX_LIMITS, maxCells: 10 };
  const fewSheets = { ...XLSX_LIMITS, maxSheets: 3 };
  return {
    "maxCells 10 으로 읽기": tryCode(() => loadBook(book, small)),
    "maxSheets 3 에 시트 추가": tryCode(() => applyXlsxOps(book, [{ op: "sheet", name: "넷째" }], fewSheets)),
    "없는 시트": tryCode(() => applyXlsxOps(book, [{ op: "cell", sheet: "없음", cell: "A1", value: 1 }])),
    "잘못된 셀 주소": tryCode(() => applyXlsxOps(book, [{ op: "cell", sheet: "요약", cell: "1A", value: 1 }])),
    "같은 이름 시트": tryCode(() => applyXlsxOps(book, [{ op: "sheet", name: "요약" }])),
    "금지 문자 시트": tryCode(() => applyXlsxOps(book, [{ op: "sheet", name: "a/b" }])),
    "빈 수식": tryCode(() => applyXlsxOps(book, [{ op: "formula", sheet: "요약", cell: "C1", formula: "=" }])),
    "객체 값": tryCode(() => applyXlsxOps(book, [{ op: "cell", sheet: "요약", cell: "C1", value: { a: 1 } }])),
    "ZIP 아님": tryCode(() => loadBook(new TextEncoder().encode("hello"))),
    "표 헤더 셀을 빈 값으로": tryCode(() => applyXlsxOps(book, [{ op: "cell", sheet: "데이터", cell: "A1", value: null }])),
    "result 없는 수식 (허용)": tryCode(() => applyXlsxOps(book, [{ op: "formula", sheet: "요약", cell: "C4", formula: "B4*2" }])),
    "수식 텍스트 '=' 로 시작하는 값 셀 (텍스트로 저장)": (() => {
      const r = applyXlsxOps(book, [{ op: "cell", sheet: "요약", cell: "C5", value: "=1+1" }]);
      const c = readWorkbook(r.bytes).getSheet("요약").cell("C5");
      return { value: c?.value, formula: c?.formula?.text ?? null, type: c?.type };
    })(),
    "편집 없이 다시 읽은 원본 XML": checkXml(book),
    "XML 검사기 음성 시험 (오류를 잡아야 함)": [
      "<a><b></a>", "<a x=\"1\" x=\"2\"/>", "<a>&nbsp;</a>", "<a><b/>", "<a/><b/>", "<a x=1/>",
    ].map((x) => [x, wellFormed(x)]),
  };
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/make") return xlsx(makeTestBook());
      if (url.pathname === "/make-big") {
        // CPU 측정용 큰 워크북: rows × 10열 (숫자·텍스트 섞음) + 시트 '요약'(수식 1개)
        const n = Math.min(Number(url.searchParams.get("rows") || 10000), 50000);
        const wb = createWorkbook();
        wb.addSheet("요약").set("A1", "합계").set("B1", { formula: `SUM(데이터!C2:C${n + 1})`, result: 0 });
        const s = wb.addSheet("데이터");
        s.set("A1", "id").set("B1", "이름").set("C1", "값");
        for (let r = 2; r <= n + 1; r++) {
          s.set(`A${r}`, r - 1).set(`B${r}`, `사람${r - 1}`).set(`C${r}`, r % 97);
          for (let c = 4; c <= 10; c++) s.set(`${String.fromCharCode(64 + c)}${r}`, (r * c) % 1000);
        }
        return xlsx(writeWorkbook(wb));
      }
      if (url.pathname === "/inspect" && req.method === "POST") return json(summarizeBook(loadBook(await bodyBytes(req))));
      if (url.pathname === "/selftest" && req.method === "POST") {
        const r = selftest(await bodyBytes(req));
        if (url.searchParams.get("out") === "xlsx") return xlsx(r.bytes);
        const { bytes, ...rest } = r;
        return json({ ...rest, editedBytes: bytes.byteLength });
      }
      if (url.pathname === "/edit" && req.method === "POST") {
        const ops = JSON.parse(url.searchParams.get("ops") || "[]");
        return xlsx(applyXlsxOps(await bodyBytes(req), ops).bytes);
      }
      if (url.pathname === "/limits" && req.method === "POST") return json(limits(await bodyBytes(req)));
      if (url.pathname === "/part" && req.method === "POST") {
        // unzip이 승인 대기로 막혀서 부품 내용은 이 라우트로 본다. ?name=xl/workbook.xml (여러 개는 쉼표)
        const files = unzipSync(await bodyBytes(req));
        const names = (url.searchParams.get("name") || "").split(",").filter(Boolean);
        const out = names.length ? names.map((n) => `===== ${n}\n${files[n] ? strFromU8(files[n]) : "(없음)"}`) : Object.keys(files).map((n) => `${n} ${files[n].length}`);
        return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return json({ ok: true, routes: ["/make", "/inspect", "/selftest", "/edit", "/limits"] });
    } catch (e) {
      return json({ ok: false, code: e.code || "internal", error: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined }, 500);
    }
  },
};
