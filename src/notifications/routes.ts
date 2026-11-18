// DO-2 알림 WebSocket 라우트. index.ts에서 "/api/notifications"에 mount한다.
//   GET /ws  WebSocket 업그레이드 — 세션 쿠키 필수(익명 401), 같은 출처만(403), 업그레이드 아니면 426.
// 인증 방식은 src/chat/routes.ts와 같다 (getSessionUser + originOk). 내 id의 Hub에만 연결된다.
import { Hono } from "hono";
import { getSessionUser } from "../auth";

type Env = { DB: D1Database; NOTIFICATION_HUB: DurableObjectNamespace };
export const notificationsApp = new Hono<{ Bindings: Env }>();

notificationsApp.get("/ws", async (c) => {
  const me = await getSessionUser(c.env as never, c.req.header("cookie"));
  if (!me) return c.json({ error: "로그인이 필요합니다." }, 401);
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "WebSocket 업그레이드가 필요합니다." }, 426);
  const origin = c.req.header("origin");
  if (origin) {
    let same = false;
    try { same = origin === new URL(c.req.url).origin; } catch { /* 잘못된 URL */ }
    if (!same) return c.json({ error: "허용되지 않는 요청입니다." }, 403);
  }
  const stub = c.env.NOTIFICATION_HUB.get(c.env.NOTIFICATION_HUB.idFromName("user:" + me.id));
  return stub.fetch(new Request("https://hub/ws", { headers: { upgrade: "websocket", "x-ntf-user": me.id } }));
});
