# DO-1a 프롬프트 — 실시간 채팅 DO + API (1:1 두 방식)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `durable-objects-use-cases-plan.md` D1절(범위 확장 반영본 — 코칭 1:1 + 직원 1:1 + 그룹채팅, 멤버십 D1 결정) + `workflow-agent-builder-FULL-PLAN.md` §5 DO-1a행 + WF-6 산출물(`src/workflow/agent-do.ts`의 WorkflowAgent DO 패턴 — `state.storage` SQLite, `idFromName`, `src/index.ts:46` export, `wrangler.toml` 바인딩 + 마이그레이션 태그) + `src/auth.ts`의 `getSessionUser`·`SessionUser` + `src/workflow/routes.ts`의 `requireUser` 패턴.
> 모델: Sonnet. 이 세션은 **1:1 채팅의 DO + API만** 만든다. 그룹채팅 백엔드(DO-1c) · 채팅 UI(DO-1b·DO-1d) · 알림(DO-2) · 레이트 리미터(DO-3)는 **하지 않는다**. **배포하지 않는다** — DO-MIG에서 코디네이터가 v3 태그 추가·배포·라이브 검증을 한 번에 한다.
> **배포 금지 구간 (FULL-PLAN §5)**: 이 세션은 `wrangler.toml`에 `CHAT_ROOM` 바인딩만 추가한다. **v3 마이그레이션 태그는 건드리지 않는다** (DO-MIG에서 `[ChatRoom, NotificationHub, RateLimiter]`를 한 번에 추가한다). 바인딩만 있고 마이그레이션이 없는 상태에서는 `deploy`가 실패한다 — 정상이다, 배포를 시도하지 않는다. 로컬 검증은 하네스 전용 `wrangler.toml`로 한다 (WF-6·WF-8의 `files/workflow-verify/wf*/wrangler.toml` 패턴).

## 목표

두 사용자가 실시간으로 대화할 수 있는 채팅방을 만든다. 코치↔코칭 대상 1:1과 직원↔직원 1:1 모두 같은 방식으로 돈다 (DO는 역할을 안 본다 — 방 키에 들어간 두 id만 본다). 이 세션이 끝나면 두 사용자가 REST로 메시지를 보내고 WebSocket으로 실시간으로 받으며, 접속하지 않았을 때 온 메시지는 다음 접속 때 읽힌다.

## 할 일

### 1. `ChatRoom` DO (`src/chat/room.ts`, 신규)

- **참조**: `cloudflare/workers-chat-demo`의 방당 DO 1개 + WebSocket Hibernation 구조를 가져오되, 인증·방 키 격리만 People OS 방식으로 바꾼다 (아래).
- **방 키**: 1:1 방은 `chat:dm:<a>:<b>` — 두 사용자 id를 정렬해서 넣는다 (`idFromName`에는 이 키 전체를 쓴다). 코칭 1:1과 직원 1:1이 같은 키 방식이라 DO는 둘을 구분하지 않는다.
- **DO SQLite 테이블** (DO 생성 시 `ensureSchema` — WorkflowAgent 패턴):
  ```sql
  CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY,          -- 방마다 단조 증가 (메시지 순서)
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    user_id TEXT PRIMARY KEY,         -- 방 멤버 (1:1은 키의 두 id로 seed)
    joined_at TEXT NOT NULL
  );
  ```
  - `members` 테이블을 두는 이유: 그룹채팅(DO-1c)이 같은 DO를 재사용한다. DO-1c에서 그룹 방의 멤버를 D1에서 읽어 이 테이블에 동기화한다. **DO-1a는 1:1만 seed한다** (키의 두 id) — 그룹 동기화 API는 DO-1c 몫이다. 단, 테이블·`syncMembers` 내부 메서드의 자리는 DO-1a에서 만들어 둔다 (DO-1c가 DO를 다시 쓰지 않게).
  - 메시지는 최근 **200개**만 유지한다 — 새 메시지를 넣을 때 `seq`가 가장 작은 것부터 지운다.
- **메시지 저장·브로드캐스트**: `POST /messages` 내부 처리(아래 2번의 라우트가 DO에 fetch로 부른다) — `seq = MAX(seq)+1` (DO는 단일 스레드라 트랜잭션 없이도 안전하지만, 명시 트랜잭션으로 감싼다), 저장 후 방에 연결된 **모든** WebSocket에 `{type:'message', seq, sender_id, sender_name, body, created_at}`를 브로드캐스트한다.
- **WebSocket Hibernation**: `state.acceptWebSocket(ws)` + DO 클래스의 `webSocketMessage`·`webSocketClose`·`webSocketError` 핸들러를 쓴다 (workers-chat-demo 패턴). 메시지 없을 때 인스턴스가 휴면해도 연결은 유지된다. `state.getWebSockets()`로 현재 연결 목록을 가져온다.
  - 클라이언트가 WebSocket으로 보내는 메시지는 **받지 않는다** (송신은 REST만 — 1차 단순화). WebSocket으로 뭔가 오면 무시한다 (에러를 던지지 않는다).
  - 연결이 끊기면(`webSocketClose`) 따로 정리할 것은 없다 — 다음 접속 때 REST로 히스토리를 읽는다.
- **DO 내부 라우트** (Worker가 DO에 fetch로 부르는 경로 — 외부에 직접 노출하지 않는다):
  - `POST /messages` `{sender_id, sender_name, body}` → 저장 + 브로드캐스트, 201 + 저장된 메시지.
  - `GET /messages?before=<seq>&limit=50` → `seq < before`인 최근 메시지 `limit`개 (기본 50, 최대 100). `before`가 없으면 최신부터.
  - `GET /members` → 멤버 id 목록 (라우트가 멤버십을 확인할 때 쓴다).
  - `POST /sync-members` `{members: [{user_id}]}` → members 테이블 교체 (DO-1c용 자리 — DO-1a에서는 1:1 seed만 쓰고, 이 경로는 만들어만 둔다. 인증 없이 부르면 안 되므로, 호출자는 Worker 라우트뿐이다 — DO는 Worker가 보낸 요청이라고 믿는다).

### 2. 채팅 API (`src/chat/routes.ts`, 신규 + `src/index.ts` 마운트)

- `src/index.ts`에 `export { ChatRoom } from "./chat/room"`을 추가한다 (WorkflowAgent export와 같은 자리) + `Env`에 `CHAT_ROOM: DurableObjectNamespace`를 추가한다 + `app.route("/api/chat", chatApp)`을 마운트한다. **그 밖의 index.ts 동작은 건드리지 않는다.**
- **인증**: 모든 엔드포인트는 `requireUser` 패턴으로 세션 쿠키를 검증한다 (익명 401). `getSessionUser`를 쓴다.
- **방 키 계산**: `dmRoomKey(a, b)` — 두 id를 정렬해서 `chat:dm:<a>:<b>`를 만든다. 자기 자신과의 방은 만들 수 없다 (400).
- **엔드포인트**:
  - `POST /api/chat/dm/:userId/messages` — 상대방 id로 1:1 방에 메시지 보내기. 본문 `{body: string}` (1~4000자, 아니면 400). 상대방이 존재하는 사용자인지 D1 `users`에서 확인한다 (없는 id면 404). DO에 `POST /messages`를 fetch로 부르고 결과를 그대로 돌려준다 (201).
  - `GET /api/chat/dm/:userId/messages?before=&limit=` — 1:1 방 히스토리. DO의 `GET /messages`를 그대로 돌려준다.
  - `GET /api/chat/dm/:userId/ws` — 1:1 방 WebSocket 업그레이드. 세션 검증 후, 연결하려는 사용자가 방의 두 id 중 하나인지 확인한다 (아니면 404 — 존재 은닉). 맞으면 `chatApp`이 아니라 **Worker가 DO stub에 직접** `fetch`로 업그레이드 요청을 전달한다 (Hono의 WebSocket 헬퍼가 아니라, `env.CHAT_ROOM.get(idFromName(key)).fetch(new Request(...))` 패턴 — WorkflowAgent 호출 방식과 같다). DO는 `upgrade` 헤더를 보고 `state.acceptWebSocket`으로 받는다.
  - **그룹 방 엔드포인트는 DO-1c에서 만든다** — 이 세션에서는 `/api/chat/dm/*`만 만든다.
- **방 목록 API는 DO-1b(UI)에서 필요해지면 그때 만든다** — 이 세션에서는 메시지 송수신·히스토리만 만든다 (목록은 DO-1b 세션에서 D1·코칭 관계·DM 상대 목록을 합쳐서 만든다).

### 3. `wrangler.toml` (바인딩만)

- `[[durable_objects.bindings]]`에 `name = "CHAT_ROOM"`, `class_name = "ChatRoom"`을 추가한다. **마이그레이션 태그는 추가하지 않는다** (v3는 DO-MIG에서). 배포하지 않는다.

## 검증 (반드시 `files/workflow-verify/do1a/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/do1a/`)

- `npx tsc --noEmit` 통과.
- 로컬 하네스 (WF-6의 `wf6/` 패턴 — 하네스 전용 `wrangler.toml` + `worker.ts` + Miniflare, DO는 실제 `ChatRoom` 클래스, AI·VECTOR·fetch는 mock):
  1. **송수신**: A가 REST로 보내면 B의 WebSocket으로 실시간 도착한다 (seq·발신자·본문·시각 확인). A·B 둘 다 연결돼 있으면 둘 다 받는다.
  2. **히스토리**: 접속하지 않았을 때 온 메시지가 다음 접속 때 `GET /messages`로 읽힌다 (최신 50개, `before` 페이징). 200개 초과 시 오래된 것부터 지워진다 (201번째 메시지 후 1번째가 안 보인다).
  3. **격리**: 제3자(C)가 같은 방 히스토리를 조회하면 404, WebSocket 업그레이드도 404. 익명은 401. 없는 사용자에게 보내면 404. 자기 자신과의 방은 400.
  4. **검증**: 빈 본문·4001자 본문은 400, 메시지가 안 생긴다. 존재하지 않는 방의 히스토리는 빈 목록 (방이 없어도 404가 아니라 빈 목록 — 1:1 방은 메시지가 생기면서 만들어진다).
  5. **회귀**: 일반 워크플로우 실행 1건 + 로그인 1건이 그대로 동작한다 (index.ts 마운트·export 추가가 기존 동작을 안 깼는지).
- **미검증 목록을 RESULT.md에 적는다** (실제 Cloudflare WebSocket 연결 — 로컬 Miniflare만, 배포·원격 DO(v3 미적용), 브라우저 화면, 그룹 방 — DO-1c, 방 목록 UI — DO-1b).

## 금지

- 그룹 방 API·방 목록 API·UI를 만들지 않는다 (DO-1c·DO-1b 범위). `wrangler.toml`에 v3 마이그레이션 태그를 추가하지 않는다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 메시지 본문에 실행 코드를 넣지 않는다 (텍스트만 저장·전달한다).
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 이 세션에서 건드리지 않는다 (별도 과제).
