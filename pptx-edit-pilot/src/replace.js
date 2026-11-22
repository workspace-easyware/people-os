// Minimal edit path: bytes in → replace the first run containing `find` → save → bytes out.
import { PptxHandler, setPresentationRunText } from "pptx-viewer-core";

export async function replaceRun(bytes, find, to) {
  const h = new PptxHandler();
  const data = await h.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (let si = 0; si < data.slides.length; si++) {
    for (const el of data.slides[si].elements) {
      const segs = el.textSegments || [];
      const ri = segs.findIndex((s) => (s.text || "").includes(find));
      if (ri >= 0) return await setPresentationRunText(bytes, si, el.id, ri, segs[ri].text.replace(find, to));
    }
  }
  throw new Error(`text not found: ${find}`);
}
