// 로컬 검증용 RealtimeKit 목 Worker (화상회의 V0). 실제 RealtimeKit과 통신하지 않는다.
// 실행: npx wrangler dev --local --config <이 폴더>/mock-rtk.toml --port 8799
//   POST /client/v4/accounts/:acc/realtime/kit/:app/meetings                    → {success, data:{id,title}}
//   POST /client/v4/accounts/:acc/realtime/kit/:app/meetings/:id/participants   → {success, data:{id, token, preset_name, ...}}
//   GET  /client/v4/accounts/:acc/realtime/kit/:app/presets|webhooks            → 목 목록
//   GET  /.well-known/webhooks.json                                            → {data:{publicKey: PEM}}
//   POST /sign   (본문 그대로)                                                   → {signature: base64}  웹훅 서명 테스트용
//   GET  /log                                                                   → 받은 REST 요청 기록 (Authorization은 "Bearer <있음>"으로만)
//   GET  /seed.sql                                                              → 로컬 D1 시드 (가짜 사용자·세션 해시·채팅방)
// 상태는 isolate 메모리에만 있다 (재시작하면 사라짐 — 검증 한 번 분량이면 충분).
let keys = null;
const log = [];
const meetings = new Map(); // rtk id → {title, status}
const sessions = [];        // V1+V2: {id, associated_id, status, transcript}

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
async function sha256hex(t) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function getKeys() {
  if (!keys) {
    keys = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  }
  return keys;
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const raw = await req.arrayBuffer();
    if (p === "/.well-known/webhooks.json") {
      const spki = await crypto.subtle.exportKey("spki", (await getKeys()).publicKey);
      const body = b64(spki).match(/.{1,64}/g).join("\n");
      return json(200, { success: true, data: { publicKey: `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n` } });
    }
    if (p === "/sign" && req.method === "POST") {
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (await getKeys()).privateKey, raw);
      return json(200, { signature: b64(sig) });
    }
    if (p === "/log") return json(200, log);
    // ---- V1+V2 하네스 제어 (2026-11-19) ----
    //   POST /ctl/forget/:rtkId                    회의를 잊는다 (목 재시작 = RealtimeKit 쪽 회의 없음 재현)
    //   POST /ctl/session {meeting, status, transcript?:bool, id?}   세션 추가/갱신 (LIVE·ENDED, 전사 있음/없음)
    //   GET  /files/transcript/:sess.json          전사 파일 (문서 JSON 형식: startTime·endTime·sentence·peerData{cpi,displayName,...})
    const fg = p.match(/^\/ctl\/forget\/(.+)$/);
    if (fg && req.method === "POST") { const had = meetings.delete(fg[1]); return json(200, { ok: true, had }); }
    if (p === "/ctl/session" && req.method === "POST") {
      const b = JSON.parse(new TextDecoder().decode(raw));
      let s = sessions.find((x) => x.id === b.id);
      if (!s) { s = { id: b.id || crypto.randomUUID(), associated_id: b.meeting, created_at: new Date().toISOString(), started_at: new Date().toISOString() }; sessions.push(s); }
      s.status = b.status || "ENDED";
      if (s.status === "ENDED") s.ended_at = new Date().toISOString();
      s.transcript = !!b.transcript;
      return json(200, { ok: true, session: s });
    }
    const tf = p.match(/^\/files\/transcript\/(.+)\.json$/);
    if (tf) {
      // 김코치(u_v0_coach)·이코칭(u_v0_coachee) 대화. displayName은 일부러 다르게 둬서 cpi → People OS 이름 변환을 확인한다.
      const peer = (cpi, dn) => ({ id: "peer-" + cpi, userId: "rtk-" + cpi, displayName: dn, cpi, joinedAt: "2026-11-19T10:00:00.000Z", leftAt: "" });
      const T = [
        [0, 2400, peer("u_v0_coach", "Coach-Kim"), "안녕하세요, 오늘 코칭 시작하겠습니다."],
        [2600, 5200, peer("u_v0_coach", "Coach-Kim"), "지난주 목표는 어떻게 됐나요?"],
        [5800, 9800, peer("u_v0_coachee", "Lee"), "주간 회의 진행을 제가 맡아서 두 번 해 봤습니다."],
        [10200, 14000, peer("u_v0_coach", "Coach-Kim"), "좋네요. 그때 어려웠던 점은 무엇이었나요?"],
        [14500, 19000, peer("u_v0_coachee", "Lee"), "시간 관리가 어려웠고 결론 없이 끝난 안건이 있었습니다."],
        [19500, 24000, peer("u_v0_coach", "Coach-Kim"), "다음 주에는 안건마다 결정 사항을 한 줄로 정리해 보죠."],
      ].map(([s, e, pd, t]) => ({ startTime: s, endTime: e, sentence: t, peerData: pd }));
      return json(200, tf[1].startsWith("empty") ? [] : T);
    }
    if (p === "/seed.sql") {
      const exp = Date.now() + 7 * 24 * 3600 * 1000;
      const room = "chat:dm:u_v0_coach:u_v0_coachee";
      const sql = `INSERT OR REPLACE INTO users (id, email, name, role, status, created_at, coaching_role) VALUES
 ('u_v0_coach', 'coach@v0.test', '김코치', 'user', 'active', datetime('now'), 'coach'),
 ('u_v0_coachee', 'coachee@v0.test', '이코칭', 'user', 'active', datetime('now'), 'coachee'),
 ('u_v0_member', 'member@v0.test', '최멤버', 'user', 'active', datetime('now'), 'coachee'),
 ('u_v0_outsider', 'admin@v0.test', '박관리', 'hr_admin', 'active', datetime('now'), 'coachee');
INSERT OR REPLACE INTO auth_sessions (token_hash, user_id, expires_at) VALUES
 ('${await sha256hex("v0-coach-session")}', 'u_v0_coach', ${exp}),
 ('${await sha256hex("v0-coachee-session")}', 'u_v0_coachee', ${exp}),
 ('${await sha256hex("v0-member-session")}', 'u_v0_member', ${exp}),
 ('${await sha256hex("v0-outsider-session")}', 'u_v0_outsider', ${exp});
INSERT OR REPLACE INTO chat_rooms (id, type, name, creator_id) VALUES ('${room}', 'dm', NULL, 'u_v0_coach'), ('chatg_v0', 'group', 'V0 그룹', 'u_v0_coachee');
INSERT OR REPLACE INTO chat_room_members (room_id, user_id) VALUES
 ('${room}', 'u_v0_coach'), ('${room}', 'u_v0_coachee'),
 ('chatg_v0', 'u_v0_coachee'), ('chatg_v0', 'u_v0_member');
`;
      return new Response(sql, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const m = p.match(/^\/client\/v4\/accounts\/([^/]+)\/realtime\/kit\/([^/]+)(\/.*)$/);
    if (!m) return json(404, { success: false, errors: [{ message: "not found" }] });
    const body = raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : null;
    const auth = req.headers.get("authorization");
    log.push({ method: req.method, account: m[1], app: m[2], path: m[3], auth: auth ? "Bearer <있음>" : "없음", body });
    if (!auth?.startsWith("Bearer ")) return json(401, { success: false, errors: [{ message: "unauthorized" }] });
    const rest = m[3];
    if (req.method === "POST" && rest === "/meetings") {
      const id = crypto.randomUUID();
      meetings.set(id, { title: body?.title, status: "ACTIVE" });
      return json(201, { success: true, data: { id, title: body?.title, status: "ACTIVE", created_at: new Date().toISOString() } });
    }
    const pm = rest.match(/^\/meetings\/([^/]+)\/participants$/);
    if (req.method === "POST" && pm) {
      if (!meetings.has(pm[1])) return json(404, { success: false, errors: [{ message: "meeting not found" }] });
      if (!body?.preset_name || !body?.custom_participant_id) return json(400, { success: false, errors: [{ message: "preset_name and custom_participant_id required" }] });
      return json(201, { success: true, data: { id: crypto.randomUUID(), token: "mock-token-" + crypto.randomUUID().slice(0, 8), preset_name: body.preset_name, custom_participant_id: body.custom_participant_id, name: body.name } });
    }
    // ---- V1+V2 (2026-11-19) ----
    const gm = rest.match(/^\/meetings\/([^/?]+)$/);
    if (gm && req.method === "GET") {
      const mt = meetings.get(gm[1]);
      if (!mt) return json(404, { success: false, errors: [{ message: "meeting not found" }] });
      return json(200, { success: true, data: { id: gm[1], title: mt.title, status: mt.status } });
    }
    if (gm && req.method === "PATCH") {
      const mt = meetings.get(gm[1]);
      if (!mt) return json(404, { success: false, errors: [{ message: "meeting not found" }] });
      if (body?.status) mt.status = body.status;
      return json(200, { success: true, data: { id: gm[1], status: mt.status } });
    }
    if (req.method === "GET" && rest === "/sessions") {
      const aid = url.searchParams.get("associated_id");
      return json(200, { success: true, data: { sessions: sessions.filter((s) => s.associated_id === aid) }, paging: {} });
    }
    const st = rest.match(/^\/sessions\/([^/?]+)\/transcript(\?.*)?$/);
    if (st && req.method === "GET") {
      const s = sessions.find((x) => x.id === st[1]);
      if (!s || !s.transcript) return json(404, { success: false, errors: [{ message: "transcript not found" }] });
      return json(200, { success: true, data: { sessionId: s.id, transcript_download_url: `${url.origin}/files/transcript/${s.id}.json`, transcript_download_url_expiry: new Date(Date.now() + 86400e3).toISOString() } });
    }
    if (req.method === "GET" && rest.startsWith("/presets")) return json(200, { success: true, data: [{ id: "p1", name: "group_call_host" }, { id: "p2", name: "group_call_participant" }] });
    if (req.method === "GET" && rest.startsWith("/webhooks")) return json(200, { success: true, data: [] });
    return json(404, { success: false, errors: [{ message: "unhandled " + rest }] });
  },
};
