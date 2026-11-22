// 시험 워크북 (파일럿). xlvane으로 직접 만든다: 값 셀, 수식 셀(수식 + 캐시 result), 서식(굵게·배경색), 표 1개, 시트 3장.
//   요약   — 제목(굵게·배경), 값 셀, 수식 셀 (합계·평균은 캐시 result를 직접 계산해 넣는다), '데이터' 시트를 참조하는 수식
//   데이터 — 표 "코칭세션" (헤더 + 4행)
//   대조군 — 편집하지 않는 시트 (바이트 동일 확인용)
import { createWorkbook, writeWorkbook } from "xlvane";

export function makeTestBook() {
  const wb = createWorkbook({ properties: { title: "People OS XLSX 파일럿", creator: "people-os" } });
  const head = { font: { bold: true, color: "FFFFFF" }, fill: { color: "2D7DDE" } };
  const s1 = wb.addSheet("요약");
  s1.set("A1", "2026 코칭 현황", { font: { bold: true, size: 14 }, fill: { color: "FFF2CC" } });
  s1.set("A3", "항목", head).set("B3", "값", head);
  s1.set("A4", "상반기 세션").set("B4", 24);
  s1.set("A5", "하반기 세션").set("B5", 30);
  s1.set("A6", "합계", { font: { bold: true } }).set("B6", { formula: "SUM(B4:B5)", result: 54 }, { font: { bold: true } });
  s1.set("A7", "평균").set("B7", { formula: "AVERAGE(B4:B5)", result: 27 });
  s1.set("A8", "표 합계").set("B8", { formula: "SUM(데이터!C2:C5)", result: 26 });
  s1.column("A", { width: 18 });

  const rows = [["김코치", "리더십", 8], ["이코치", "커리어", 6], ["박코치", "온보딩", 5], ["최코치", "리더십", 7]];
  wb.addSheet("데이터").addTable({
    name: "코칭세션",
    ref: "A1",
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: [{ name: "코치" }, { name: "주제" }, { name: "세션" }],
    rows,
  });

  const s3 = wb.addSheet("대조군");
  s3.set("A1", "편집하지 않는 시트", { font: { italic: true } });
  s3.set("A2", 1).set("B2", 2).set("C2", { formula: "A2+B2", result: 3 });

  wb.calculation({ fullCalcOnLoad: true });
  return writeWorkbook(wb);
}
