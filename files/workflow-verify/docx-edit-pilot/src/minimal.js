// 번들 크기 기준선 (dry-run 전용): ooxml-core/docx loadDocx → run 글자 1개 수정 → save. nodejs_compat 없음.
import { loadDocx } from "ooxml-core/docx";

export default {
  async fetch(req) {
    const l = await loadDocx(new Uint8Array(await req.arrayBuffer()));
    const p = l.model.blocks.find((b) => b.type === "paragraph" && b.runs.length);
    if (p) p.runs[0].text += "!";
    return new Response(await l.save(l.model));
  },
};
