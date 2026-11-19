// V1+V2 로컬 검증: 방 소켓(채팅 카드 이벤트)과 알림 소켓(NotificationHub 푸시)을 코치 세션으로 듣고 events.log에 적는다.
// 실행: node ws-listen.mjs <초>   (Node 22 내장 WebSocket — undici의 headers 옵션으로 세션 쿠키를 넣는다)
import { appendFileSync, writeFileSync } from "node:fs";
const secs = Number(process.argv[2] || 120);
const out = new URL("./events.log", import.meta.url);
writeFileSync(out, "");
const log = (src, data) => appendFileSync(out, `${new Date().toISOString()} [${src}] ${data}\n`);
const headers = { cookie: "people_os_session=v0-coach-session", origin: "http://localhost:8788" };
for (const [name, path] of [["room", "/api/chat/dm/u_v0_coachee/ws"], ["notify", "/api/notifications/ws"]]) {
  const ws = new WebSocket("ws://localhost:8788" + path, { headers });
  ws.onopen = () => log(name, "open");
  ws.onmessage = (e) => log(name, String(e.data));
  ws.onerror = (e) => log(name, "error " + (e?.message || ""));
  ws.onclose = (e) => log(name, "close " + e.code);
}
setTimeout(() => process.exit(0), secs * 1000);
