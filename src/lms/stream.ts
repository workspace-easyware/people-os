// 강의실 R2 영상 스트리밍 (lms-plan.md 3.3). GET|HEAD /api/lms/lessons/:id/video
// 계약(lms-plan.md 7장): 서명을 바꾸지 말 것.
//
// 흐름: ① 세션 확인(401) ② D1에서 r2 강의 + 과정 게시 상태 조회(404, 미게시는 hr_admin만)
//       ③ 크기 확인 ④ Range 파싱(단일 범위만, 범위 밖이면 416) ⑤ FILES.get(key, {range}) ⑥ 206/200 스트림 중계.
// R2 키는 응답에 싣지 않는다. 본문은 obj.body 스트림을 그대로 넘긴다 (arrayBuffer로 읽지 않는다).
// HEAD: Hono는 GET 라우트로 HEAD를 처리하면서 본문을 버린다 — 그래도 여기서 HEAD를 직접 알아보고
//       R2 본문을 아예 읽지 않는다(head 호출만).
import type { Context } from "hono";
import { getSessionUser } from "../auth";
import type { LmsEnv } from "./routes";

type ByteRange = { offset: number; length: number };

/**
 * 단일 바이트 범위 파싱 (RFC 9110 14.1.2).
 * - 반환 null   → Range를 무시하고 전체 200 (헤더 없음, 형식 불량, 다중 범위, 단위가 bytes가 아님)
 * - 반환 "unsatisfiable" → 416 (a >= size, a > b, "bytes=-0", 빈 객체)
 * - 그 외       → {offset, length} (끝이 크기를 넘으면 잘라낸다)
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // 다중 범위("a-b,c-d")·다른 단위·쓰레기 값 → 무시
  const [, a, b] = m;
  if (a === "" && b === "") return null; // "bytes=-"
  if (a === "") {
    // 접미 범위: 마지막 n바이트
    const n = Number(b);
    if (!Number.isSafeInteger(n)) return null;
    if (n === 0 || size === 0) return "unsatisfiable";
    const len = Math.min(n, size);
    return { offset: size - len, length: len };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return null;
  if (b !== "") {
    const end = Number(b);
    if (!Number.isSafeInteger(end)) return null;
    if (end < start || start >= size) return "unsatisfiable"; // 계획 3.3: a > b 또는 a >= size → 416
    return { offset: start, length: Math.min(end, size - 1) - start + 1 };
  }
  if (start >= size) return "unsatisfiable";
  return { offset: start, length: size - start };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8", "cache-control": "no-store" },
  });
}

export async function handleVideo(c: Context<{ Bindings: LmsEnv }>): Promise<Response> {
  // ① 인증 — 쿠키 세션만. X-Admin-Secret로는 영상을 주지 않는다.
  const viewer = await getSessionUser(c.env, c.req.header("cookie"));
  if (!viewer) return jsonError(401, "로그인이 필요합니다.");

  // ② 강의 조회 + 게시 게이트. 유튜브 강의·없는 강의·미게시(비관리자)는 모두 같은 404로 구분하지 않는다.
  const lesson = await c.env.DB.prepare(
    `SELECT l.r2_key, l.content_type, l.size_bytes, c.status
     FROM lms_lessons l JOIN lms_courses c ON c.id = l.course_id
     WHERE l.id = ?1 AND l.source = 'r2'`,
  ).bind(c.req.param("id")).first<{ r2_key: string | null; content_type: string | null; size_bytes: number | null; status: string }>();
  if (!lesson || !lesson.r2_key) return jsonError(404, "영상을 찾을 수 없습니다.");
  if (lesson.status !== "PUBLISHED" && viewer.role !== "hr_admin") return jsonError(404, "영상을 찾을 수 없습니다.");
  const key = lesson.r2_key;

  const isHead = c.req.method === "HEAD";

  // ③ 크기: R2 head가 진실이다. D1 size_bytes는 낡을 수 있어(같은 키 덮어쓰기) Range 계산에 그대로 쓰지 않는다.
  //    head는 Class B 1회지만 get과 같은 등급이고, 416/Content-Range를 정확히 만들려면 실제 크기가 필요하다.
  const head = await c.env.FILES.head(key);
  if (!head) return jsonError(404, "영상 파일을 찾을 수 없습니다.");
  const size = head.size;

  // ④ Range. If-Range가 있고 현재 ETag와 다르면 Range를 무시하고 전체를 준다 (RFC 9110 13.1.5).
  let rangeHeader = c.req.header("range");
  const ifRange = c.req.header("if-range");
  if (rangeHeader && ifRange && ifRange.trim() !== head.httpEtag) rangeHeader = undefined;
  const r = parseRange(rangeHeader, size);

  const headers = new Headers();
  headers.set("content-type", lesson.content_type || head.httpMetadata?.contentType || "video/mp4");
  headers.set("accept-ranges", "bytes");
  headers.set("etag", head.httpEtag);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");

  if (r === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-type", "application/json; charset=UTF-8");
    return new Response(isHead ? null : JSON.stringify({ ok: false, error: "요청한 범위가 영상 크기를 벗어났습니다." }), {
      status: 416,
      headers,
    });
  }

  const status = r ? 206 : 200;
  const offset = r ? r.offset : 0;
  const length = r ? r.length : size;
  if (r) headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${size}`);
  headers.set("content-length", String(length));

  if (isHead) return new Response(null, { status, headers });

  // ⑤ 본문. 크기 0 객체는 range 없이 받는다 (length 0 range는 R2가 거부할 수 있다).
  const obj = await c.env.FILES.get(key, r ? { range: { offset, length } } : undefined);
  if (!obj) return jsonError(404, "영상 파일을 찾을 수 없습니다.");
  // head와 get 사이에 객체가 바뀌었으면(키 덮어쓰기) 섞인 바이트를 주지 않는다 — 브라우저가 다시 요청하게 한다.
  if (obj.etag !== head.etag) {
    obj.body.cancel().catch(() => {});
    return jsonError(503, "영상이 갱신되는 중입니다. 다시 시도해 주세요.");
  }
  return new Response(obj.body, { status, headers });
}
