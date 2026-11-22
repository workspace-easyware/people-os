// 화상회의 V0 (2026-11-19, video-conference-plan.md) — 빌드 없는 순수 JS.
//   /meet                 내 채팅방 목록 → [영상 통화] → POST /api/meet/rooms/:roomId/start → ?m=<회의 id>
//   /meet?m=<id>          회의 정보 → [참여] → POST /api/meet/:id/join(세션 쿠키) → authToken → RealtimeKit SDK
// 토큰은 응답 본문으로만 받는다 (URL·localStorage에 남기지 않는다).
//
// SDK 버전: 2026-11-19 사용자 브라우저 진단(__meetDiag의 sdkLatest)에서 latest가 두 패키지 모두 2.1.0으로
// 확인됐다. 그 버전으로 고정한다 (latest가 바뀌어 동작이 달라지는 것을 막는다).
// 가능하면 V1에서 public/vendor/realtimekit/에 내려받아 둔다 (fullcalendar와 같은 방식).
const SDK_CORE_VERSION = "2.1.0";
const SDK_UI_VERSION = "2.1.0";
const SDK_CORE_URL = `https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit@${SDK_CORE_VERSION}/dist/browser.js`;
const SDK_UI_URL = `https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit-ui@${SDK_UI_VERSION}/loader/index.es2017.js`;

const $ = (id) => document.getElementById(id);
const statusEl = $("meet-status");
const bodyEl = $("meet-body");

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const ch of children) e.append(ch);
  return e;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...opts });
  let j = {};
  try { j = await res.json(); } catch { /* 본문 없음 */ }
  if (res.status === 401) {
    const err = new Error("로그인이 필요합니다."); err.login = true; throw err;
  }
  if (!res.ok || j.ok === false) throw new Error(j.error || `요청 실패 (HTTP ${res.status})`);
  return j;
}

function showLogin() {
  setStatus("로그인이 필요합니다. People OS에 로그인한 뒤 이 창을 새로고침하세요.", true);
  bodyEl.replaceChildren(el("a", { href: "/", class: "meet-btn" }, "로그인하러 가기"));
}

function fail(e) {
  if (e && e.login) return showLogin();
  setStatus(String((e && e.message) || e), true);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("SDK를 불러오지 못했습니다: " + src));
    document.head.append(s);
  });
}

let sdkReady = null;
function loadSdk() {
  if (!sdkReady) {
    sdkReady = (async () => {
      const ui = await import(SDK_UI_URL);
      await ui.defineCustomElements();
      await loadScript(SDK_CORE_URL);
      if (!window.RealtimeKitClient) throw new Error("RealtimeKitClient가 없습니다 (SDK 로드 실패)");
    })();
  }
  return sdkReady;
}

// ---- 채팅방 목록 (V0 테스트용 시작 화면. V1에서는 채팅방 헤더의 버튼이 이 역할을 한다) ----
async function showRooms() {
  $("meet-title").textContent = "영상 통화 시작";
  const j = await api("/api/chat/rooms");
  const rooms = j.rooms || [];
  if (!rooms.length) {
    setStatus("채팅방이 없습니다. 먼저 People OS 채팅에서 상대와 대화를 시작하세요.");
    return;
  }
  setStatus("통화할 채팅방을 고르세요. 같은 방의 멤버가 같은 버튼을 누르면 같은 회의에 들어갑니다.");
  // 전사 선택 (V1, 사용자 결정 9장 4번): 코칭 1:1 방은 서버가 항상 전사한다. 그 외는 여기서 고른다 (기본 켜짐).
  const tx = el("input", { type: "checkbox", id: "meet-transcribe" });
  tx.checked = true;
  const txRow = el("label", { class: "meet-notice meet-tx" }, tx, " 통화가 끝나면 한국어로 전사해 녹음전사 목록에 넣기 (코칭 1:1 통화는 항상 전사)");
  const list = el("ul", { class: "meet-rooms" });
  for (const r of rooms) {
    const name = r.type === "dm" ? (r.peer?.name || "1:1 대화") : (r.name || "그룹");
    const btn = el("button", { class: "meet-btn", type: "button" }, "영상 통화");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const s = await api(`/api/meet/rooms/${encodeURIComponent(r.id)}/start`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcribe: tx.checked }),
        });
        location.href = `/meet?m=${encodeURIComponent(s.meeting.id)}`;
      } catch (e) { btn.disabled = false; fail(e); }
    });
    list.append(el("li", {},
      el("div", { class: "meet-room-name" }, name, el("div", { class: "meet-meta" }, r.type === "dm" ? "1:1" : "그룹")),
      btn));
  }
  bodyEl.replaceChildren(txRow, list);
}

// 통화 종료 (시작한 사람 또는 코치만 — 서버가 다시 확인한다). 종료하면 채팅방 카드가 닫힌다 (meeting_ended).
function endButton(id) {
  const b = el("button", { class: "meet-btn danger", type: "button" }, "모두에게 통화 종료");
  b.addEventListener("click", async () => {
    if (!confirm("모든 참가자의 통화를 종료할까요? 종료하면 이 회의에 다시 들어올 수 없습니다.")) return;
    b.disabled = true;
    try {
      await api(`/api/meet/${encodeURIComponent(id)}/end`, { method: "POST" });
      try { await window.__meet?.meeting?.leaveRoom?.(); } catch { /* 이미 나감 */ }
      $("rtk").hidden = true;
      $("meet-panel").hidden = false;
      setStatus("통화를 종료했습니다.");
      bodyEl.replaceChildren(el("a", { href: "/", class: "meet-btn secondary" }, "People OS로"));
    } catch (e) { b.disabled = false; fail(e); }
  });
  return b;
}

// ---- 회의 입장 ----
async function showMeeting(id) {
  const { meeting, can_end: canEnd } = await api(`/api/meet/${encodeURIComponent(id)}`);
  window.__meetCanEnd = !!canEnd;
  $("meet-title").textContent = meeting.title;
  document.title = `${meeting.title} · People OS`;
  if (meeting.status !== "active") {
    setStatus("이미 끝난 회의입니다.");
    bodyEl.replaceChildren(el("a", { href: "/meet", class: "meet-btn secondary" }, "채팅방 목록으로"));
    return;
  }
  setStatus(meeting.is_coaching ? "코칭 영상 통화입니다." : "영상 통화가 진행 중입니다.");
  const join = el("button", { class: "meet-btn", type: "button" }, "참여하기");
  join.addEventListener("click", () => enter(id, join));
  // 전사 안내 (계획 9장 결정 7번: 입장 화면에 표시한다).
  const notice = meeting.transcribe
    ? el("div", { class: "meet-notice meet-notice-tx", role: "note" },
      el("strong", {}, "🔴 이 회의는 전사됩니다. "),
      `통화가 끝나면 참가자별 음성이 한국어로 전사되어 ${meeting.is_coaching ? "코치" : "회의를 시작한 사람"}의 녹음전사 목록에 화자 이름과 함께 저장되고, 요약·검색에 쓰입니다. 입장하면 이에 동의한 것으로 봅니다.`)
    : el("div", { class: "meet-notice", role: "note" }, "이 회의는 전사되지 않습니다.");
  bodyEl.replaceChildren(notice, join, ...(canEnd ? [" ", endButton(id)] : []));
}

async function enter(id, btn) {
  btn.disabled = true;
  try {
    setStatus("참가 토큰을 받는 중…");
    const j = await api(`/api/meet/${encodeURIComponent(id)}/join`, { method: "POST" });
    setStatus("영상 통화 SDK를 불러오는 중…");
    await loadSdk();
    const meeting = await window.RealtimeKitClient.init({ authToken: j.token, defaults: { audio: true, video: true } });
    const rtkEl = $("rtk");
    // 타일 미표시 수정 (2026-11-19): 패널을 먼저 숨기고 rtk-meeting을 보이게 한 다음, 레이아웃이 한 번 잡힌 뒤에
    // meeting을 넘긴다. UI 키트는 처음 받은 크기로 그리드·타일 크기를 계산하므로, 크기가 확정되기 전에 넘기지 않는다.
    $("meet-panel").hidden = true;
    rtkEl.mode = "fill";
    rtkEl.hidden = false;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    rtkEl.meeting = meeting;
    // 그리드가 첫 측정을 놓쳤을 때를 대비해 크기 재계산을 한 번 더 유도한다.
    setTimeout(() => window.dispatchEvent(new Event("resize")), 500);
    // V0 진단용: 콘솔에서 연결 상태를 볼 수 있게 남긴다 (토큰은 남기지 않는다).
    window.__meet = { id, role: j.role, preset: j.preset, meeting, layoutFix: null };
    watchStageLayout(rtkEl);
    console.info("[meet] joined", { id, role: j.role, preset: j.preset });
    meeting.self.on?.("roomLeft", () => {
      rtkEl.hidden = true;
      $("meet-panel").hidden = false;
      setStatus("통화에서 나왔습니다.");
      bodyEl.replaceChildren(
        el("a", { href: `/meet?m=${encodeURIComponent(id)}`, class: "meet-btn" }, "다시 참여"), " ",
        el("a", { href: "/", class: "meet-btn secondary" }, "People OS로"),
        ...(window.__meetCanEnd ? [" ", endButton(id)] : []),
      );
    });
  } catch (e) {
    btn.disabled = false;
    fail(e);
  }
}

// ---- 진단 (콘솔에서 `await __meetDiag()`) ----
// 스테이지 상태, rtk-meeting과 그 안쪽(섀도 DOM) 주요 요소의 실제 크기, 실제로 받은 SDK 버전을 한 번에 보여 준다.
// 토큰·쿠키는 다루지 않는다. 버전 조회는 jsDelivr 공개 API에 패키지 이름만 보낸다.
function boxOf(node) {
  if (!node) return null;
  const r = node.getBoundingClientRect();
  const cs = getComputedStyle(node);
  return { w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility, overflow: cs.overflow, position: cs.position };
}
function findDeep(root, selector, out = [], limit = 20) {
  if (!root || out.length >= limit) return out;
  for (const n of root.querySelectorAll("*")) {
    if (n.matches(selector) && out.length < limit) out.push(n);
    if (n.shadowRoot) findDeep(n.shadowRoot, selector, out, limit);
  }
  return out;
}
// ---- 스테이지 높이 0 보정 (2차 수정의 안전망, 2026-11-19) ----
// 주 수정은 meet.css에서 호스트 display 덮어쓰기를 없앤 것이다. 그래도 rtk-stage 높이가 0이면
// (호스트는 높이가 있는데 stage만 0) stage의 레이아웃 부모를 세로 flex로 만들고 stage가 남은 공간을 차지하게 한다.
// 섀도 DOM 안쪽은 바깥 CSS로 못 건드리므로 열린 shadowRoot의 인라인 스타일로만 고친다. 설정 화면 → 입장 사이에
// stage가 새로 그려지므로 20초 동안 1초마다 확인하고, 고친 내용은 window.__meet.layoutFix에 남긴다.
function watchStageLayout(rtkEl) {
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    if (rtkEl.hidden || tries > 20) return clearInterval(timer);
    const stage = findDeep(rtkEl.shadowRoot || rtkEl, "rtk-stage", [], 1)[0];
    if (!stage) return;
    const hostH = rtkEl.getBoundingClientRect().height;
    if (hostH <= 0 || stage.getBoundingClientRect().height > 0) return;
    const p = stage.parentNode;
    const parent = p instanceof ShadowRoot ? p.host : p;
    if (!(parent instanceof HTMLElement)) return;
    const before = getComputedStyle(parent).display;
    if (!before.includes("flex")) { parent.style.display = "flex"; parent.style.flexDirection = "column"; }
    stage.style.flex = "1 1 auto";
    stage.style.minHeight = "0";
    window.dispatchEvent(new Event("resize"));
    const fix = { at: new Date().toISOString(), parent: parent.tagName.toLowerCase(), parentDisplayBefore: before, stageH: Math.round(stage.getBoundingClientRect().height) };
    if (window.__meet) window.__meet.layoutFix = fix;
    console.warn("[meet] rtk-stage 높이 0 → 레이아웃 보정", fix);
  }, 1000);
}

window.__meetDiag = async function () {
  const m = window.__meet?.meeting;
  const rtkEl = $("rtk");
  const tags = ["rtk-header", "rtk-stage", "rtk-grid", "rtk-participant-tile", "rtk-controlbar", "video"];
  const inner = {};
  for (const t of tags) inner[t] = findDeep(rtkEl.shadowRoot || rtkEl, t, [], 6).map(boxOf);
  const resolved = {};
  for (const pkg of ["@cloudflare/realtimekit", "@cloudflare/realtimekit-ui"]) {
    try {
      const r = await fetch(`https://data.jsdelivr.com/v1/packages/npm/${pkg}/resolved?specifier=latest`);
      resolved[pkg] = (await r.json()).version;
    } catch (e) { resolved[pkg] = "조회 실패: " + e.message; }
  }
  const out = {
    stage: { status: m?.stage?.status, selfStageStatus: m?.self?.stageStatus, roomState: m?.self?.roomState },
    participants: { active: m?.participants?.active?.size, joined: m?.participants?.joined?.size, viewMode: m?.participants?.viewMode },
    viewport: { w: innerWidth, h: innerHeight },
    "#meet-main": boxOf($("meet-main")),
    "rtk-meeting": { ...boxOf(rtkEl), mode: rtkEl.mode, hidden: rtkEl.hidden, flexDirection: getComputedStyle(rtkEl).flexDirection },
    stageParent: (() => {
      const s = findDeep(rtkEl.shadowRoot || rtkEl, "rtk-stage", [], 1)[0];
      if (!s) return null;
      const p = s.parentNode instanceof ShadowRoot ? s.parentNode.host : s.parentNode;
      return { tag: p?.tagName?.toLowerCase(), viaShadowRoot: s.parentNode instanceof ShadowRoot, ...boxOf(p) };
    })(),
    layoutFix: window.__meet?.layoutFix ?? null,
    inner,
    sdkPinned: { core: SDK_CORE_VERSION, ui: SDK_UI_VERSION },
    sdkLatest: resolved,
  };
  console.log("[meet] diag", out);
  return out;
};

const params = new URLSearchParams(location.search);
const meetingId = params.get("m");
(meetingId ? showMeeting(meetingId) : showRooms()).catch(fail);
