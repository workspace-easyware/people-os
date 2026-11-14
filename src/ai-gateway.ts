// S2: AI Gateway — 모든 Workers AI 호출은 "people-os" 게이트웨이를 경유한다.
//
// 공식 방식(Workers AI 바인딩 + AI Gateway): env.AI.run()의 세 번째 인자로
// gateway 옵션을 넘긴다. wrangler.toml의 [ai] 바인딩은 그대로 둔다.
// https://developers.cloudflare.com/ai-gateway/integrations/aig-workers-ai-binding/
//
// 게이트웨이 자체는 CLI로 만들 수 없다 (wrangler 4.x에 ai-gateway 명령이
// 없음) — 대시보드에서 "people-os" 게이트웨이를 먼저 만들어야 한다.
// 이름 있는 게이트웨이는 자동 생성되지 않는다 ("default"만 첫 인증 요청 때
// 자동 생성). 게이트웨이가 없으면 이 옵션이 붙은 AI 호출은 실패하고,
// 호출처의 try/catch가 로컬 폴백(추출식 요약·템플릿 답·전사 pending)으로
// 떨어지므로 앱이 죽지는 않는다. 되돌리려면 이 파일의 호출처에서
// aiGatewayOptions() 인자만 빼면 된다 (wrangler.toml 변경 없음).
//
// 캐시 정책:
// - 채팅(LLM): 게이트웨이 캐시 사용. 프롬프트에 근거 문맥이 포함돼 있어
//   근거가 바뀌면 캐시 키도 바뀐다 (C5-b 암묵지 게시 후 재질문은 새 답).
//   단, 다시 생성(force)과 운영 진단(debug-ai)은 캐시를 건너뛴다.
//   force는 같은 프롬프트로 다시 물어도 새 답이 나와야 하고, debug-ai는
//   모델 가용성을 탐지하는 용도라 캐시가 실패를 가릴 수 있기 때문이다.
// - 임베딩·전사: 항상 skipCache. 임베딩은 재색인 검증이 흐려지고,
//   전사는 오디오 바이트마다 달라 캐시할 이유가 없다 (대용량 오디오를
//   캐시에 쌓는 것도 낭비).
// - tags: 게이트웨이 대시보드에서 기능별 호출을 구분하기 위한 태그
//   (ask/summary/embed/whisper/coaching/digest/debug).
export const AI_GATEWAY_ID = "people-os";

export function aiGatewayOptions(opts?: { skipCache?: boolean; tag?: string }): {
  gateway: { id: string; skipCache: boolean; tags?: string[] };
} {
  const gateway: { id: string; skipCache: boolean; tags?: string[] } = {
    id: AI_GATEWAY_ID,
    skipCache: opts?.skipCache ?? false,
  };
  if (opts?.tag) gateway.tags = [opts.tag];
  return { gateway };
}

// ---- S4 M2 추가 (기존 aiGatewayOptions 시그니처·동작은 그대로) ----
// GatewayOptions.metadata: @cloudflare/workers-types 4.20260702.1의
// `GatewayOptions.metadata?: Record<string, number|string|boolean|null|bigint>`로
// 바인딩이 받는다는 것을 확인했다 (notes/S4-M2-findings.md §1). 게이트웨이 로그의
// metadata 필드로 돌아오므로 비용 동기화가 eventId로 대조한다.
// 동시 요청에서 env.AI.aiGatewayLogId가 덮어써질 수 있어(§7.3 위험) 이 경로가 기본이다.
export type GatewayMetadata = Record<string, number | string | boolean | null>;

export function aiGatewayOptionsWithMeta(opts?: { skipCache?: boolean; tag?: string; metadata?: GatewayMetadata }): {
  gateway: { id: string; skipCache: boolean; tags?: string[]; metadata?: GatewayMetadata };
} {
  const base = aiGatewayOptions({ skipCache: opts?.skipCache, tag: opts?.tag });
  const meta = opts?.metadata;
  if (!meta || Object.keys(meta).length === 0) return base;
  // AI Gateway는 메타데이터 항목 수를 제한한다(문서상 5개) — 앞에서 5개만 싣는다.
  const trimmed: GatewayMetadata = {};
  for (const [k, v] of Object.entries(meta).slice(0, 5)) trimmed[k] = v;
  return { gateway: { ...base.gateway, metadata: trimmed } };
}

// env.AI.aiGatewayLogId: workers-types의 `abstract class Ai { aiGatewayLogId: string | null }`.
// 게이트웨이를 거친 마지막 run() 뒤에 채워진다. 바인딩이 없거나 값이 없으면 null.
export function readAiGatewayLogId(ai: unknown): string | null {
  try {
    const id = (ai as { aiGatewayLogId?: unknown } | null)?.aiGatewayLogId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// AI Gateway 로그 REST API 경로 (비용 동기화용). 계정 id는 vars(CF_ACCOUNT_ID, 비밀 아님),
// 토큰은 secret(AIG_LOGS_TOKEN)으로만 받는다 — 이 파일에 값을 넣지 않는다.
export function aiGatewayLogsUrl(accountId: string, gatewayId: string = AI_GATEWAY_ID): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/logs`;
}
