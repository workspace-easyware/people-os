// 번들 기준선: bytes → editCells 1칸 → bytes (xlvane 최소 경로, nodejs_compat 없음).
import { editCells } from "xlvane";

export default {
  async fetch(req) {
    const u8 = new Uint8Array(await req.arrayBuffer());
    const { bytes } = editCells(u8, [{ sheet: "요약", cell: "B4", value: 99 }]);
    return new Response(bytes);
  },
};
