// 강의실 진도 저장 (lms-plan.md 5장). 계약(7장): 서명을 바꾸지 말 것.
//
// 동시성·멱등성 규칙:
// - "읽고 → 판단하고 → 쓰기"를 코드에서 나누지 않는다. 강의 존재 확인·UPSERT·집계를 DB.batch 하나(한 트랜잭션)로 보낸다.
//   UPSERT는 INSERT ... SELECT FROM lms_lessons WHERE id = ? 형태라, 없는 강의면 행이 생기지 않고 RETURNING이 비어 404가 된다.
// - completed 미지정(위치만 저장)은 완료 표시를 건드리지 않는다.
// - completed:true를 여러 번(동시에) 보내도 첫 완료 시각이 유지된다. completed:false는 완료를 지운다(데모 재촬영용).
// - user_id는 호출자(routes.ts)가 세션에서 꺼낸 값만 받는다.
import type { LmsEnv } from "./routes";

export type SaveProgressResult =
  | {
      ok: true;
      lesson_id: string;
      completed: boolean;
      completed_at: string | null;
      position_sec: number;
      course: { lesson_count: number; completed_count: number };
    }
  | { ok: false; status: 400 | 404; error: string };

/** 위치 상한: 24시간. 플레이어 버그로 터무니없는 값이 저장되는 것만 막는다. */
const MAX_POSITION_SEC = 24 * 60 * 60;

const UPSERT_SQL = `
INSERT INTO lms_progress (user_id, lesson_id, position_sec, completed_at, updated_at)
SELECT ?1, l.id, COALESCE(?3, 0), CASE WHEN ?4 = 1 THEN ?5 END, ?5
FROM lms_lessons l WHERE l.id = ?2
ON CONFLICT(user_id, lesson_id) DO UPDATE SET
  position_sec = COALESCE(?3, lms_progress.position_sec),
  completed_at = CASE
                   WHEN ?4 = 1 THEN COALESCE(lms_progress.completed_at, excluded.completed_at)
                   WHEN ?4 = 0 THEN NULL
                   ELSE lms_progress.completed_at
                 END,
  updated_at = excluded.updated_at
RETURNING lesson_id, position_sec, completed_at`;

const COURSE_AGG_SQL = `
SELECT
  (SELECT COUNT(*) FROM lms_lessons x WHERE x.course_id = l.course_id) AS lesson_count,
  (SELECT COUNT(*) FROM lms_lessons x
     JOIN lms_progress p ON p.lesson_id = x.id AND p.user_id = ?1
     WHERE x.course_id = l.course_id AND p.completed_at IS NOT NULL) AS completed_count
FROM lms_lessons l WHERE l.id = ?2`;

export async function saveProgress(
  env: LmsEnv,
  userId: string,
  lessonId: string,
  input: { completed?: boolean; position_sec?: number },
): Promise<SaveProgressResult> {
  // 입력 검증 (routes.ts도 1차 검증하지만, 이 함수는 계약상 단독으로도 안전해야 한다).
  if (!userId) return { ok: false, status: 400, error: "사용자를 확인할 수 없습니다." };
  if (typeof lessonId !== "string" || !lessonId || lessonId.length > 200) {
    return { ok: false, status: 404, error: "강의를 찾을 수 없습니다." };
  }
  const hasCompleted = input.completed !== undefined;
  const hasPosition = input.position_sec !== undefined;
  if (!hasCompleted && !hasPosition) {
    return { ok: false, status: 400, error: "completed 또는 position_sec 중 하나가 필요합니다." };
  }
  if (hasCompleted && typeof input.completed !== "boolean") {
    return { ok: false, status: 400, error: "completed는 true/false여야 합니다." };
  }
  let position: number | null = null;
  if (hasPosition) {
    const n = input.position_sec as number;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      return { ok: false, status: 400, error: "position_sec는 0 이상의 숫자여야 합니다." };
    }
    position = Math.min(Math.floor(n), MAX_POSITION_SEC);
  }
  const completedFlag = hasCompleted ? (input.completed ? 1 : 0) : null;
  const now = new Date().toISOString();

  // 한 batch = 한 트랜잭션: UPSERT 뒤 집계가 같은 스냅샷을 본다.
  const [up, agg] = await env.DB.batch([
    env.DB.prepare(UPSERT_SQL).bind(userId, lessonId, position, completedFlag, now),
    env.DB.prepare(COURSE_AGG_SQL).bind(userId, lessonId),
  ]);
  const row = (up.results as { lesson_id: string; position_sec: number; completed_at: string | null }[] | undefined)?.[0];
  if (!row) return { ok: false, status: 404, error: "강의를 찾을 수 없습니다." };
  const a = (agg.results as { lesson_count: number; completed_count: number }[] | undefined)?.[0];

  return {
    ok: true,
    lesson_id: row.lesson_id,
    completed: row.completed_at !== null,
    completed_at: row.completed_at,
    position_sec: row.position_sec,
    course: { lesson_count: a?.lesson_count ?? 0, completed_count: a?.completed_count ?? 0 },
  };
}
