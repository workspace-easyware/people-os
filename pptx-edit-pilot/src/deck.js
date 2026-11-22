// Test deck built with pptxgenjs 4.0.1 — same library/version/style as People OS S3 deck generation (src/index.ts ~L465).
import PptxGenJS from "pptxgenjs";

export async function makeDeck() {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = "Pilot deck";

  // 1. title slide (text)
  const s1 = pptx.addSlide();
  s1.background = { color: "FFFFFF" };
  s1.addShape("rect", { x: 0.6, y: 0.55, w: 0.9, h: 0.08, fill: { color: "2D7DDE" }, line: { color: "2D7DDE", width: 0 } });
  s1.addText("2026 리더십 코칭 결과 보고", { x: 0.6, y: 2.0, w: 11, h: 1.2, fontSize: 40, bold: true, color: "1F2937", fontFace: "Malgun Gothic" });
  s1.addText("People OS 파일럿 덱", { x: 0.6, y: 3.3, w: 11, h: 0.6, fontSize: 20, color: "6B7280" });

  // 2. shapes
  const s2 = pptx.addSlide();
  s2.addText("도형 슬라이드", { x: 0.6, y: 0.4, w: 11, h: 0.8, fontSize: 28, bold: true });
  s2.addShape("rect", { x: 1.0, y: 1.8, w: 3.0, h: 2.0, fill: { color: "2D7DDE" }, line: { color: "1E40AF", width: 1 } });
  s2.addShape("ellipse", { x: 5.0, y: 1.8, w: 2.5, h: 2.5, fill: { color: "10B981" } });
  s2.addShape("roundRect", { x: 8.5, y: 1.8, w: 3.0, h: 2.0, fill: { color: "F59E0B" }, rectRadius: 0.2 });

  // 3. table
  const s3 = pptx.addSlide();
  s3.addText("표 슬라이드", { x: 0.6, y: 0.4, w: 11, h: 0.8, fontSize: 28, bold: true });
  const hdr = { bold: true, fill: { color: "E5E7EB" } };
  s3.addTable(
    [
      [{ text: "이름", options: hdr }, { text: "역할", options: hdr }, { text: "점수", options: hdr }],
      ["김코치", "코치", "92"],
      ["이리더", "코치이", "85"],
      ["박매니저", "코치이", "78"],
    ],
    { x: 0.6, y: 1.5, w: 10, colW: [4, 3, 3], fontSize: 16, border: { type: "solid", pt: 1, color: "9CA3AF" } },
  );

  // 4. native chart
  const s4 = pptx.addSlide();
  s4.addText("차트 슬라이드", { x: 0.6, y: 0.4, w: 11, h: 0.8, fontSize: 28, bold: true });
  s4.addChart(
    pptx.ChartType.bar,
    [
      { name: "2025", labels: ["1분기", "2분기", "3분기", "4분기"], values: [10, 20, 30, 40] },
      { name: "2026", labels: ["1분기", "2분기", "3분기", "4분기"], values: [15, 25, 35, 45] },
    ],
    { x: 0.8, y: 1.4, w: 11, h: 5.5, showTitle: true, title: "분기별 코칭 세션 수", showLegend: true },
  );

  // 5. control slide — never edited, must stay byte-identical
  const s5 = pptx.addSlide();
  s5.addText("손대지 않는 슬라이드", { x: 0.6, y: 0.4, w: 11, h: 0.8, fontSize: 28, bold: true });
  s5.addText("이 슬라이드는 편집하지 않는다 (바이트 동일성 대조군).", { x: 0.6, y: 1.6, w: 11, h: 0.8, fontSize: 18 });

  return await pptx.write({ outputType: "uint8array" });
}
