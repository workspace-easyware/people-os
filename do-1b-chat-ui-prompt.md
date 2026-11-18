# DO-1b 프롬프트 — 채팅 UI + 배선 (1:1) + 방 목록

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `durable-objects-use-cases-plan.md` D1절 + `workflow-agent-builder-FULL-PLAN.md` §5 DO-1b행 + DO-1a 산출물(`src/chat/{room,routes}.ts` — `POST/GET /dm/:userId/messages`, `GET /dm/:userId/ws`, 방 키 `chat:dm:<a>:<b>`, DO 내부 `POST /sync-members` 자리, `files/workflow-verify/do1a/RESULT.md`) + `public/index.html`의 탭 구조(`TABS`·`COACHEE_TABS`·`switchTab`, 메뉴 순서) + `public/workflow.js`의 탭 패턴 + `src/approval/routes.ts`의 `GET /users?q=` (사용자 검색 재사용).
> 모델: Sonnet. 이 세션은 **1:1 채팅 UI + 방 목록만** 만든다. 그룹채팅 UI(DO-1d) · 그룹 백엔드(DO-1c) · 알림(DO-2) · 레이트 리미터(DO-3)는 **하지 않는다**. **배포하지 않는다** — DO-MIG에서 코디네이터가 0030 원격 적용·v3 태그 추가·배포·라이브 검증을 한 번에 한다.
> **원칙**: 방 목록이 없으면 채팅 UI를 만들 수 없으므로, 방 목록용 D1 테이블을 이 세션에서 만든다 (DO-1c가 그룹 행에 재사용한다 — 아래 1번). DO-1a의 메시지 저장·브로드캐스트 동작은 바꾸지 않는다. 프런트는 무빌드 정적 HTML/JS 유지.

## 목표

채팅 탭을 열면 내 1:1 방 목록이 보이고, 방을 고르면 메시지를 주고받을 수 있다. 새 대화는 사용자를 검색해서 시작한다 (코칭 상대·직원 구분 없이 — DO가 역할을 안 보듯 UI도 역할을 안 가린다. 단, 검색 결과에 코칭 역할은 표시한다). 이 세션이 끝나면 브라우저에서 두 사용자가 실시간으로 대화할 수 있다.

## 할 일

### 1. 방 목록용 D1 테이블 (`migrations/0030_chat_rooms.sql`, 신규 — DO-1c와 공유)

- DO-1a는 DM 방을 D1에 기록하지 않았다 (키만으로 방을 찾았다). 그런데 방 목록("내가 대화한 방")은 DO를 훑을 수 없어 D1 인덱스가 필요하다. 그래서 이 세션에서 만든다:
  ```sql
  CREATE TABLE IF NOT EXISTS chat_rooms (
    id TEXT PRIMARY KEY,              -- DM 행: 방 키 그대로 ('chat:dm:<a>:<b>'). 그룹 행: DO-1c에서 만든 id
    type TEXT NOT NULL CHECK (type IN ('dm', 'group')),
    name TEXT,                        -- DM은 NULL (상대 이름으로 표시), 그룹은 그룹 이름
    creator_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))  -- 마지막 메시지 시각 (목록 정렬용)
  );
  CREATE TABLE IF NOT EXISTS chat_room_members (
    room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_read_seq INTEGER NOT NULL DEFAULT 0,  -- DO-1c 미읽음용. DO-1a·DO-1b는 0으로 두고 안 쓴다
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_room_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_chat_rooms_updated ON chat_rooms(updated_at);
  ```
- **DO-1c가 이 테이블을 재사용한다** — DO-1c 프롬프트에도 적혀 있다. 이 세션은 DM 행만 쓴다 (type='dm').
- **upsert 지점**: `POST /dm/:userId/messages`가 메시지를 DO에 저장한 뒤, D1에 DM 행을 upsert한다 (행이 없으면 `chat_rooms` + 멤버 2명 생성, 있으면 `updated_at`만 갱신). DO 저장이 실패하면 D1에도 안 쓴다 (순서: DO 먼저, 성공 시 D1). D1 쓰기가 실패해도 메시지는 이미 갔으므로, 실패는 `console.error`만 남기고 응답은 성공으로 돌려준다 (목록이 잠깐 안 보이는 것보다 메시지 유실이 더 나쁘다).
- **원격 적용은 DO-MIG에서 한다** — 이 세션은 마이그레이션 파일만 만들고 로컬 하네스 DB에 적용한다.

### 2. 방 목록 API (`src/chat/routes.ts`에 추가)

- `GET /api/chat/rooms` — 내 방 목록. `chat_room_members`에서 내 `user_id`로 방을 찾고 `updated_at` 최신순으로 돌려준다. 각 방에 `peer` (DM 상대: id·이름·이메일·코칭 역할) 또는 `name` (그룹 — DO-1c에서 채운다. DO-1b에서는 DM만 있으므로 peer만 있으면 된다)을 붙인다. 그룹 행이 있어도 목록에는 나오게 한다 (이름으로 표시) — DO-1c의 그룹이 목록에 안 뜨면 안 되므로, 타입별 표시를 지금부터 나눈다.
- `GET /api/chat/users?q=` — 새 대화 상대 검색. 기존 `GET /api/approval/users?q=`를 그대로 쓴다 (새 API를 만들지 않는다 — 프런트에서 그 경로를 부른다). 없으면 그 API의 동작(활성 사용자·이름·이메일·부서 검색)을 확인하고 쓴다.

### 3. 채팅 UI (`public/chat.{js,css}` 신규 + `public/index.html` 배선)

- **메뉴**: `TABS`·`COACHEE_TABS`에 `'chat'`을 추가하고, 네비게이션 버튼 "채팅"을 코칭 리플렉션 다음에 넣는다 (메뉴 순서: 홈·메일함·결재함·할 일·녹음전사.문서저장·코칭 리플렉션·**채팅**·강의실·…). `switchTab('chat')`으로 연다. 코칭 대상(COACHEE_TABS)에게도 보인다 (채팅은 코칭 대상도 쓴다).
- **레이아웃**: 왼쪽 방 목록 + 오른쪽 대화창 (모바일은 방 목록 → 대화창 전환). 방 목록 행: 상대 이름·마지막 메시지 시각(없으면 "대화 시작 전")·미읽음 배지 자리 (1:1은 v1에서 미읽음을 안 세므로 배지는 안 보인다 — DO-1d에서 그룹 배지를 붙일 때 자리를 쓴다).
- **대화창**: 메시지 목록(내 메시지는 오른쪽, 상대는 왼쪽, 발신자 이름·시각 표시) + 입력창 + 보내기 버튼. Enter로 보내기, Shift+Enter는 줄바꿈. 빈 메시지·4000자 초과는 보내지 않고 안내 문구를 보여준다.
- **실시간**: 방을 열면 `GET /dm/:userId/ws`로 WebSocket을 연결한다 (같은 출처라 Strict 세션 쿠키가 실린다). 오는 메시지를 목록에 추가한다. 연결이 끊기면 3초 뒤에 한 번 다시 연결한다 (그 이상은 "연결이 끊겼습니다. 새로고침해 주세요." 문구). 보낸 메시지는 REST 응답이 오면 목록에 추가한다 (WebSocket 에코를 기다리지 않는다 — 내가 보낸 것은 에코로 오면 중복이 되므로, 에코 중 `sender_id`가 나면 건너뛴다).
- **히스토리**: 방을 열 때 `GET /dm/:userId/messages?limit=50`으로 최근 50개를 읽고, 위로 스크롤하면 `before`로 더 읽는다 (50개씩).
- **새 대화**: "새 대화" 버튼 → 사용자 검색 입력창 (`/api/approval/users?q=`) → 결과에서 한 명을 고르면 그 사람과의 방이 열린다 (메시지를 보내기 전에는 방 목록에 안 뜬다 — 첫 메시지를 보내면 목록에 생긴다).
- **Origin 검사 (DO-1a 메모)**: DO-1a에서 WebSocket 업그레이드의 Origin 검사는 POST에만 뒀다. 이 세션에서 업그레이드 요청에도 Origin 검사를 넣는다 (같은 출처만 허용 — `Origin` 헤더가 있으면 우리 도메인인지 확인, 없으면 통과. `src/chat/routes.ts`의 `GET /dm/:userId/ws`에서 한다). 자세한 판정은 기존 `originOk` 패턴(다른 라우트에 있음)을 따른다.
- **실패 처리**: 메시지 전송 실패 시 "보내지 못했습니다. 다시 시도해 주세요." 문구 + 재시도 버튼. WebSocket이 안 열리면 REST로만 보내고 받을 수 없다는 안내를 보여준다 (채팅 탭 자체는 뜬다 — 실패해도 나머지 앱은 정상이어야 한다).

## 검증 (반드시 `files/workflow-verify/do1b/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/do1b/`)

- `npx tsc --noEmit` 통과. `node --check public/chat.js` 통과.
- 로컬 하네스 (DO-1a의 `do1a/` 패턴 — Miniflare, 실제 `ChatRoom` DO + 0030 적용된 로컬 D1):
  1. **방 목록 API**: 메시지 1통을 보내면 `GET /api/chat/rooms`에 방이 생긴다 (상대 정보 포함). 메시지를 안 보낸 방은 목록에 안 뜬다. 타인의 방은 안 보인다. `updated_at` 순서대로 정렬된다.
  2. **메시지 왕복 (API 레벨)**: A→B 전송 후 B의 방 목록·히스토리에 보인다. 4000자 초과·빈 본문은 400.
  3. **WebSocket (Miniflare 클라이언트 2개)**: A·B가 각자 연결하면 A가 보낸 것이 B에게 실시간 도착한다. C가 A-B 방에 연결하면 404 (DO-1a의 키 유도 격리 + DO 멤버 방어선).
  4. **화면 로직**: WF-11의 `ui-run.ts` 패턴(가짜 DOM으로 실제 `public/chat.js` 실행)으로 — 방 목록 렌더링, 방 선택 시 히스토리 로딩, 메시지 전송 시 목록 추가, WebSocket 수신 시 목록 추가(내 에코 중복 없음), 연결 끊김 시 재연결 시도, 전송 실패 시 안내 문구. (브라우저 렌더링 자체는 미검증 목록에 적는다.)
  5. **회귀**: DO-1a 하네스 41/41을 그대로 돌려서 통과하는지 확인한다 (메시지 저장·브로드캐스트·격리가 그대로인지). 일반 워크플로우 실행 1건 + 로그인 1건도 그대로 동작한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 Cloudflare WebSocket, 배포·원격 DO(v3 미적용)·원격 D1(0030 미적용), 브라우저 화면 시각 확인, 그룹 방 — DO-1c·DO-1d).

## 금지

- 그룹 방 API·그룹 UI를 만들지 않는다 (DO-1c·DO-1d 범위). `wrangler.toml`에 v3 마이그레이션 태그를 추가하지 않는다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 메시지 본문에 실행 코드를 넣지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 이 세션에서 건드리지 않는다 (별도 과제).
