// 개인별 RAG 격리 — lib.ts 필터/스코프 헬퍼 단위 검증 (로컬 Vectorize가 없어
// 필터 객체 자체를 검증한다. 원격 Vectorize 필터 동작은 부모가 원격에서 검증.)
import * as lib from "/tmp/per-user-rag-lib.mjs";

let fail = 0;
const assert = (name, cond) => {
  console.log((cond ? "PASS" : "FAIL") + ": " + name);
  if (!cond) fail++;
};

assert("anon filter = shared only",
  JSON.stringify(lib.vectorUserFilter(null)) === JSON.stringify({ user_id: "shared" }));
assert("user filter = $in [shared, id]",
  JSON.stringify(lib.vectorUserFilter({ id: "u-123", role: "user" })) ===
    JSON.stringify({ user_id: { $in: ["shared", "u-123"] } }));
assert("admin filter = same as user (no special-casing)",
  JSON.stringify(lib.vectorUserFilter({ id: "a-1", role: "hr_admin" })) ===
    JSON.stringify({ user_id: { $in: ["shared", "a-1"] } }));
assert("vectorUserIdForDoc(null)=shared", lib.vectorUserIdForDoc(null) === "shared");
assert("vectorUserIdForDoc(id)=id", lib.vectorUserIdForDoc("u-123") === "u-123");
assert("docOwnerClause anon",
  JSON.stringify(lib.docOwnerClause(null, "d")) ===
    JSON.stringify({ clause: "(d.owner_id IS NULL)", params: [] }));
assert("docOwnerClause user",
  JSON.stringify(lib.docOwnerClause({ id: "u-123", role: "user" }, "documents")) ===
    JSON.stringify({ clause: "(documents.owner_id IS NULL OR documents.owner_id = ?)", params: ["u-123"] }));
assert("poolForDoc personal file", lib.poolForDoc("file", "u-123") === "personal");
assert("poolForDoc shared file", lib.poolForDoc("file", null) === "shared");
assert("poolForDoc transcript", lib.poolForDoc("transcript", "u-123") === "personal");
assert("poolForDoc tacit shared", lib.poolForDoc("tacit", null) === "shared");

console.log(fail === 0 ? "ALL PASS" : `FAILURES: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
