// Minimal Worker (bundle-size baseline): POST pptx bytes ?find=&to= → replaced pptx bytes. No pptxgenjs.
import { replaceRun } from "./replace.js";

export default {
  async fetch(req) {
    if (req.method !== "POST") return new Response("POST a .pptx with ?find=&to=", { status: 405 });
    const url = new URL(req.url);
    try {
      const out = await replaceRun(new Uint8Array(await req.arrayBuffer()), url.searchParams.get("find") || "", url.searchParams.get("to") || "");
      return new Response(out, { headers: { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" } });
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  },
};
