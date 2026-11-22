// Limits probe: signatures, SmartArt, what markup gets touched, embedded chart workbook, compression.
import { PptxHandler, validatePptx } from "pptx-viewer-core";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { makeDeck } from "./deck.js";
import { applyEdits } from "./lab.js";

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
const td = new TextDecoder();

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  return { at: i, lenA: a.length, lenB: b.length, a: a.slice(Math.max(0, i - 80), i + 220), b: b.slice(Math.max(0, i - 80), i + 220) };
}

// local-header compression method per entry (0 = STORE, 8 = DEFLATE)
function compressionMethods(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const counts = {};
  for (let i = 0; i + 30 < u8.length; ) {
    if (dv.getUint32(i, true) !== 0x04034b50) break;
    const method = dv.getUint16(i + 8, true);
    const csize = dv.getUint32(i + 18, true);
    const nlen = dv.getUint16(i + 26, true);
    const elen = dv.getUint16(i + 28, true);
    counts[method] = (counts[method] || 0) + 1;
    i += 30 + nlen + elen + csize;
  }
  return counts;
}
const totalUncompressed = (z) => Object.values(z).reduce((s, v) => s + v.length, 0);

export async function limits() {
  const out = {};
  const orig = await makeDeck();
  const { bytes: edited } = await applyEdits(orig);
  const A = unzipSync(orig);
  const B = unzipSync(edited);

  // 1. compression / size explanation
  out.compression = {
    originalMethods: compressionMethods(orig),
    editedMethods: compressionMethods(edited),
    originalUncompressedBytes: totalUncompressed(A),
    editedUncompressedBytes: totalUncompressed(B),
  };

  // 2. what changed in parts we did NOT intend to edit
  const diffs = {};
  for (const p of ["ppt/slideLayouts/slideLayout1.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/viewProps.xml", "ppt/presentation.xml", "docProps/app.xml", "[Content_Types].xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml"]) {
    diffs[p] = A[p] && B[p] ? firstDiff(td.decode(A[p]), td.decode(B[p])) : { missing: !A[p] ? "orig" : "edited" };
  }
  out.diffs = diffs;

  // 3. chart: embedded workbook updated?
  const chartXml = Object.keys(B).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  const emb = Object.keys(B).filter((n) => n.startsWith("ppt/embeddings/"));
  out.chart = { chartParts: chartXml, embeddings: emb };
  for (const e of emb) {
    try {
      const wb = unzipSync(B[e]);
      const sheet = td.decode(wb["xl/worksheets/sheet1.xml"] || new Uint8Array());
      const strings = td.decode(wb["xl/sharedStrings.xml"] || new Uint8Array());
      out.chart[e] = { sheetHas50_60_70_80: ["50", "60", "70", "80"].every((v) => sheet.includes(`<v>${v}</v>`)), sheetHas11_22: sheet.includes("<v>11</v>") && sheet.includes("<v>22</v>"), sheetSnippet: sheet.slice(0, 600), sharedStringsSnippet: strings.slice(0, 300) };
    } catch (err) {
      out.chart[e] = { error: String(err) };
    }
  }
  for (const c of chartXml) {
    const x = td.decode(B[c]);
    out.chart[c] = { cacheHas50: x.includes("<c:v>50</c:v>"), titleEdited: x.includes("(수정)"), hasExternalData: x.includes("c:externalData") };
  }

  // 4. validate original deck too (are the CONTENT_TYPE warnings pptxgenjs' own?)
  out.validateOriginal = await validatePptx(ab(orig));

  // 5. digital signature: inject fake _xmlsignatures parts, load+edit+save, see if they survive
  try {
    const signed = { ...A };
    signed["_xmlsignatures/origin.sigs"] = new Uint8Array();
    signed["_xmlsignatures/sig1.xml"] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/><SignatureValue>AAAA</SignatureValue></Signature>');
    signed["_xmlsignatures/_rels/origin.sigs.rels"] = strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/signature" Target="sig1.xml"/></Relationships>');
    const rootRels = td.decode(A["_rels/.rels"]).replace("</Relationships>", '<Relationship Id="rIdSig" Type="http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin" Target="_xmlsignatures/origin.sigs"/></Relationships>');
    signed["_rels/.rels"] = strToU8(rootRels);
    const ct = td.decode(A["[Content_Types].xml"]).replace("</Types>", '<Default Extension="sigs" ContentType="application/vnd.openxmlformats-package.digital-signature-origin"/><Override PartName="/_xmlsignatures/sig1.xml" ContentType="application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml"/></Types>');
    signed["[Content_Types].xml"] = strToU8(ct);
    const signedBytes = zipSync(signed);
    const h = new PptxHandler();
    const data = await h.load(ab(signedBytes));
    const savedUntouched = await h.save(data.slides);
    const t = data.slides[0].elements.find((e) => (e.text || "").includes("리더십"));
    t.text = "서명 덱 편집";
    if (t.textSegments?.length) t.textSegments = [{ ...t.textSegments[0], text: t.text }];
    const savedEdited = await h.save(data.slides);
    const sigParts = (u8) => Object.keys(unzipSync(u8)).filter((n) => n.startsWith("_xmlsignatures/"));
    out.signature = {
      input: sigParts(signedBytes),
      afterSaveNoEdit: sigParts(savedUntouched),
      afterSaveWithEdit: sigParts(savedEdited),
      rootRelsAfterEditHasSig: td.decode(unzipSync(savedEdited)["_rels/.rels"]).includes("digital-signature"),
    };
  } catch (err) {
    out.signature = { error: String(err), stack: err?.stack?.split("\n").slice(0, 6) };
  }

  // 6. SmartArt: SDK-created SmartArt → save → reload → edit node text → save → reload
  try {
    let h = new PptxHandler();
    let data = await h.load(ab(orig));
    data.slides[1].elements.push({
      type: "smartArt",
      id: "pilot-smartart",
      x: 100, y: 420, width: 800, height: 200,
      smartArtData: {
        layout: "process",
        nodes: [
          { id: "n1", text: "계획" },
          { id: "n2", text: "실행" },
          { id: "n3", text: "회고" },
        ],
      },
    });
    let b1 = await h.save(data.slides);
    h = new PptxHandler();
    data = await h.load(ab(b1));
    const sa = data.slides[1].elements.find((e) => e.type === "smartArt");
    const r = { created: !!sa, diagramParts: Object.keys(unzipSync(b1)).filter((n) => n.startsWith("ppt/diagrams/")), nodesAfterReload: sa?.smartArtData?.nodes?.map((n) => n.text) };
    if (sa) {
      const n = sa.smartArtData.nodes.find((x) => x.text === "실행");
      if (n) n.text = "실행(수정)";
      const b2 = await h.save(data.slides);
      const h3 = new PptxHandler();
      const d3 = await h3.load(ab(b2));
      const sa3 = d3.slides[1].elements.find((e) => e.type === "smartArt");
      r.nodesAfterEditReload = sa3?.smartArtData?.nodes?.map((x) => x.text);
      r.validate = (await validatePptx(ab(b2))).issues?.filter((i) => i.severity !== "info").slice(0, 8);
      const dz = unzipSync(b2);
      r.dataXmlHasEdit = Object.keys(dz).filter((k) => k.startsWith("ppt/diagrams/data")).some((k) => td.decode(dz[k]).includes("실행(수정)"));
      r.drawingXmlHasEdit = Object.keys(dz).filter((k) => k.startsWith("ppt/diagrams/drawing")).some((k) => td.decode(dz[k]).includes("실행(수정)"));
    }
    out.smartArt = r;
  } catch (err) {
    out.smartArt = { error: String(err), stack: err?.stack?.split("\n").slice(0, 6) };
  }

  // 6b. per-shape markup on edited slides: which <p:sp>/<p:graphicFrame> blocks stay byte-identical?
  const blocks = (x) => x.match(/<p:(sp|graphicFrame)>[\s\S]*?<\/p:\1>/g) || [];
  out.perShape = {};
  for (const p of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/slides/slide4.xml"]) {
    const a = blocks(td.decode(A[p]));
    const b = blocks(td.decode(B[p]));
    out.perShape[p] = a.map((blk, i) => ({ i, identical: blk === b[i], lenA: blk.length, lenB: b[i]?.length, d: blk === b[i] ? undefined : firstDiff(blk, b[i] || "") }));
  }
  // master: what grew?
  {
    const ma = td.decode(A["ppt/slideMasters/slideMaster1.xml"]).replace(/>\s+</g, "><").replace(/^<\?xml[^>]*\?>/, "");
    const mb = td.decode(B["ppt/slideMasters/slideMaster1.xml"]).replace(/^<\?xml[^>]*\?>/, "");
    out.masterAfterWhitespaceNormalize = firstDiff(ma, mb);
  }

  // 7. idempotence: load+save with NO edits — which parts change?
  {
    const h = new PptxHandler();
    const data = await h.load(ab(orig));
    const same = await h.save(data.slides);
    const C = unzipSync(same);
    const eq = (x, y) => x && y && x.length === y.length && x.every((v, i) => v === y[i]);
    out.noEditRoundTrip = {
      changed: Object.keys(A).filter((n) => !n.endsWith("/") && C[n] && !eq(A[n], C[n])),
      removed: Object.keys(A).filter((n) => !n.endsWith("/") && !C[n]),
      added: Object.keys(C).filter((n) => !A[n]),
    };
  }
  return out;
}
