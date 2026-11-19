// Workers Logs용 구조화 로그 (전체 점검 2026-11-18).
//
// wrangler.toml의 [observability] enabled = true 로 Workers Logs가 켜지면, console.log에 넘긴 객체의 필드가
// 대시보드(Workers & Pages → people-os → Logs)에서 그대로 검색·필터 가능한 필드가 된다
// (예: event = "ask.complete" AND status = "no_evidence", totalMs > 20000).
//
// 이 로그는 기존 관측(D1 ask_events·trace_* + R2 원문)을 **대체하지 않는다**. 보완용이다:
// - D1/R2 트레이스: 질문 1건의 전체 내용(근거·프롬프트·점수) — 관측 탭에서 본다.
// - Workers Logs: 숫자와 식별자만 — "어제 느렸던 요청", "실패한 큐 메시지"를 화면 밖에서 빨리 찾는 용도.
//
// 규칙: 질문·답변·프롬프트·문서 제목·메일 주소·세션 id·캐시 키 같은 **내용은 절대 싣지 않는다**.
// 식별자(eventId·runId·userId), 상태, 엔진 이름, 숫자(ms·건수·토큰)만 싣는다.
// 로그 실패가 요청을 망가뜨리지 않게 항상 try/catch로 감싼다.

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function logEvent(event: string, fields: LogFields = {}): void {
  try {
    console.log({ event, ...fields });
  } catch {
    /* 로그는 best-effort */
  }
}
