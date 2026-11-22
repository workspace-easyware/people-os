// src/docx/create.ts의 AI 계획 보정 2개를 그대로 옮긴 사본 (파일럿 /repair-test 시험용).
export function closeTruncatedJson(s) {
  const body = s.replace(/[\s\]}]+$/, "");
  const stack = [];
  let out = "";
  let inStr = false;
  let esc = false;
  let fixes = 0;
  for (const ch of body) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") { inStr = true; out += ch; continue; }
    if (ch === "{") { stack.push("}"); out += ch; continue; }
    if (ch === "[") { stack.push("]"); out += ch; continue; }
    if (ch === "}" || ch === "]") {
      const top = stack[stack.length - 1];
      if (top === ch) { stack.pop(); out += ch; continue; }
      if (ch === "}" && top === "]") { fixes++; continue; }
      if (ch === "]" && top === "}" && stack[stack.length - 2] === "]") { stack.pop(); stack.pop(); out += "}]"; fixes++; continue; }
      return null;
    }
    out += ch;
  }
  if (inStr || stack.length > 8 || fixes > 4) return null;
  return out + stack.reverse().join("");
}

export function extractJsonObject(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```json\s*/gi, "").replace(/```\s*/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* 아래에서 보정 */ }
  const closed = closeTruncatedJson(cleaned.slice(start).trim());
  if (!closed) return null;
  try { const v = JSON.parse(closed); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
}

export function repairPlannedTables(obj) {
  let fixed = 0;
  if (!Array.isArray(obj.sections)) return 0;
  for (const s of obj.sections) {
    const t = s && typeof s === "object" ? s.table : undefined;
    if (!t || typeof t !== "object" || !Array.isArray(t.header) || !t.header.length || !Array.isArray(t.rows)) continue;
    const w = t.header.length;
    const rows = t.rows.every((r) => !Array.isArray(r)) && t.rows.length ? [t.rows] : t.rows;
    const out = [];
    for (const r of rows) {
      if (Array.isArray(r) && r.length > w && r.length % w === 0) {
        for (let i = 0; i < r.length; i += w) out.push(r.slice(i, i + w));
        fixed++;
      } else out.push(r);
    }
    if (rows !== t.rows) fixed++;
    t.rows = out;
  }
  return fixed;
}

export function repairTests() {
  const live1 = "{\"title\":\"신규\",\"sections\":[{\"heading\":\"개요\",\"paragraphs\":[\"a }] 괄호 문자\"]},{\"heading\":\"순서\",\"numbered\":[\"x\",\"y\"]}]";
  const flat = { sections: [{ table: { header: ["요일", "할 일"], rows: [["월", "a", "화", "b", "수", "c", "목", "d", "금", "e"]] } }] };
  const flatStrings = { sections: [{ table: { header: ["a", "b"], rows: ["1", "2", "3", "4"] } }] };
  const odd = { sections: [{ table: { header: ["a", "b"], rows: [["1", "2", "3"]] } }] };
  const ok = { sections: [{ table: { header: ["a", "b"], rows: [["1", "2"], ["3"]] } }] };
  const r = (o) => { const n = repairPlannedTables(o); return { fixed: n, rows: o.sections[0].table.rows }; };
  return {
    "라이브 관찰: 마지막 } 빠짐 → 닫힘": extractJsonObject(live1),
    "라이브 관찰 2: 끝 순서 뒤바뀜 ]}}] → 바로잡힘": extractJsonObject("{\"title\":\"분기\",\"sections\":[{\"heading\":\"표\",\"table\":{\"header\":[\"a\",\"b\"],\"rows\":[[\"1\",\"2\"]]}},{\"heading\":\"계획\",\"numbered\":[\"x\",\"y\"]}}]"),
    "중간에 남는 } (배열 안) → 버림": extractJsonObject("{\"sections\":[{\"heading\":\"a\",\"bullets\":[\"x\"]}},{\"heading\":\"b\"}]}"),
    "섹션 사이 } 빠짐 → 채움": extractJsonObject("{\"sections\":[{\"heading\":\"a\",\"t\":{\"rows\":[[\"1\"]]}],\"x\":1}"),
    "닫는 } 가 하나도 없음 → null (고치지 않음)": extractJsonObject("{\"a\":[{\"b\":[1,2]\n  "),
    "중간 괄호 틀림 → null (고치지 않음)": extractJsonObject("{\"a\":[1},\"b\":2}"),
    "정상 JSON 그대로": extractJsonObject("앞말 {\"a\":[1,2]} 뒷말"),
    "문자열 안에서 끊김 → null": extractJsonObject("{\"a\":\"끊긴"),
    "끝 괄호 틀림 {\"a\":[1} → 바로잡힘": extractJsonObject("{\"a\":[1}"),
    "JSON 없음 → null": extractJsonObject("죄송합니다"),
    "표: 10칸 1행 → 5행": r(flat),
    "표: rows가 문자열 배열 → 2행": r(flatStrings),
    "표: 배수 아님 → 그대로 (검증 오류로)": r(odd),
    "표: 정상(모자란 칸) → 그대로": r(ok),
  };
}
