// 번들 크기 측정용 최소 Worker: docx 코어만 써서 문서 1개를 만든다 (nodejs_compat 없음).
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";

export default {
  async fetch() {
    const doc = new Document({ sections: [{ children: [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun("최소")] }), new Paragraph("본문")] }] });
    return new Response(await Packer.toArrayBuffer(doc), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" } });
  },
};
