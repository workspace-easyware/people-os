// DO-2 푸시 헬퍼 (2026-11-18). D1에 알림이 기록된 "뒤에" 호출한다 (D1 batch 안에서 부르지 않는다).
// 실패(예외·비-2xx)는 조용히 무시한다 — 푸시 실패가 알림 저장·결재 결과를 막으면 안 된다. 폴링이 폴백이다.
import type { HubNotification } from "./hub";

export type PushEnv = { NOTIFICATION_HUB?: DurableObjectNamespace };

export async function pushNotification(env: PushEnv, userId: string, notification: HubNotification): Promise<void> {
  try {
    if (!env.NOTIFICATION_HUB || !userId) return;
    const stub = env.NOTIFICATION_HUB.get(env.NOTIFICATION_HUB.idFromName("user:" + userId));
    const res = await stub.fetch(new Request("https://hub/push", { method: "POST", body: JSON.stringify(notification) }));
    if (!res.ok) console.log("[notify:push] hub", res.status);
  } catch (e) {
    console.log("[notify:push] 실패(무시):", e instanceof Error ? e.message : String(e));
  }
}
