# DO-1c 프롬프트 — 그룹채팅 백엔드 (D1 멤버십 + 추가/제거 + 미읽음)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `durable-objects-use-cases-plan.md` D1절 그룹채팅 추가분 + `workflow-agent-builder-FULL-PLAN.md` §5 DO-1c행 + DO-1a 산출물(`src/chat/room.ts` — ChatRoom DO, `members` 테이블·`POST /sync-members` 자리, `files/workflow-verify/do1a/RESULT.md`) + DO-1b 산출물(`migrations/0030_chat_rooms.sql` — 이미 있음, `src/chat/routes.ts`의 DM API·방 목록 API·WS Origin 검사, `files/workflow-verify/do1b/RESULT.md`).
> 모델: Sonnet. 이 세션은 **그룹채팅 백엔드만** 만든다. 그룹 UI(DO-1d) · 알림(DO-2) · 레이트 리미터(DO-3)는 **하지 않는다**. **배포하지 않는다** — DO-MIG에서 코디네이터가 0030 원격 적용·v3 태그 추가·배포·라이브 검증을 한 번에 한다.
> **원칙**: 0030 테이블은 DO-1b에서 이미 만들었다 — **새로 만들지 않는다**. DO-1a의 DO·DM API 동작은 바꾸지 않는다. 그룹 메시지도 같은 ChatRoom DO에 저장한다 (방 키만 다르다).

## 목표

여러 명이 한 방에서 대화할 수 있게 한다. 방을 만들고, 멤버를 추가·제거하고, 각 멤버가 안 읽은 메시지가 몇 개인지 알 수 있게 한다. 이 세션이 끝나면 그룹 방 생성·멤버 관리·미읽음 추적이 API로 동작한다.

## 할 일

### 1. 그룹 방 생성 (`src/chat/routes.ts`에 추가 — `src/chat/groups.ts`로 로직을 빼도 된다)

- `POST /api/chat/groups` — 본문 `{name: string (1~100자), member_ids: string[] (1명 이상, 본인 제외 가능 — 본인은 자동 멤버)}`. 방 id는 `uid("chatg")` 같은 생성 id로 만든다 (DM 키와 충돌하지 않게). `chat_rooms`에 type='group' 행 + `chat_room_members`에 생성자 + 지정 멤버를 넣는다. 멤버 id는 D1 `users`에 있는 활성 사용자여야 한다 (없는 id가 있으면 400). 응답 201 + 방(멤버 목록 포함).
  - **⚠️ `updated_at` 형식 (DO-1b 인계)**: `chat_rooms.updated_at`의 컬럼 기본값은 SQLite `datetime('now')` 형식("YYYY-MM-DD HH:MM:SS")인데, DM 코드는 ISO8601로 쓴다. 형식이 섞이면 목록 정렬이 틀어진다. **그룹 행을 만들·갱신할 때는 `updated_at`을 ISO 형식(`new Date().toISOString()`)으로 명시할 것.** `created_at`도 ISO로 명시한다 (기본값에 맡기지 않는다).
- 방 키는 `chat:group:<roomId>` — DO stub은 `idFromName`에 이 키를 쓴다 (DM과 같은 방식).
- 방 생성 직후 DO의 `members` 테이블에 멤버를 동기화한다 (`POST /sync-members` — DO-1a에서 만든 자리). 동기화가 실패해도 방 생성은 성공으로 돌려준다 (`console.error`만 — DO는 첫 메시지 때 멤버를 다시 확인할 수 있게 아래 3번의 WS·전송 검사가 D1을 본다).

### 2. 멤버 추가/제거 (`src/chat/routes.ts`에 추가)

- `GET /api/chat/groups/:roomId/members` — 멤버 목록 (id·이름·이메일·코칭 역할·가입 시각·생성자 여부). 멤버만 볼 수 있다 (비멤버 404).
- `POST /api/chat/groups/:roomId/members` — 본문 `{user_id}`. **방 생성자 또는 hr_admin만** (다른 멤버가 남을 추가하면 403). 추가할 사람은 존재하는 활성 사용자여야 한다 (아니면 404). 이미 멤버면 200으로 기존 멤버를 돌려준다 (중복 생성 없음). 추가 후 DO에 `sync-members`를 부른다.
- `DELETE /api/chat/groups/:roomId/members/:userId` — **방 생성자·hr_admin·본인(나가기)**만. 생성자·hr_admin이 남을 빼면 200, 본인이 나가면 200. 일반 멤버가 남을 빼면 403. 없는 멤버면 404.
  - **제거된 멤버의 WebSocket 끊기**: 제거 후 DO에 `sync-members`를 부르고, DO는 더 이상 멤버가 아닌 사용자의 WebSocket을 닫는다. DO-1a의 `room.ts`가 소켓별 사용자를 어떻게 아는지 먼저 확인할 것 — 소켓에 사용자가 안 붙어 있으면 `serializeAttachment`/`deserializeAttachment`로 소켓에 `user_id`를 붙이는 코드를 추가한다 (Hibernation 표준 방식). 제거된 멤버가 다시 연결하면 WS 업그레이드 검사에서 404가 난다 (아래 3번).
  - 제거해도 그 멤버가 보낸 과거 메시지는 방에 남는다 (삭제하지 않는다).
- **생성자 퇴장 규칙**: 생성자가 방을 나갈 때는 다른 멤버에게 생성자 역할을 넘긴 뒤에만 나갈 수 있다. 본문 `{transfer_to: userId}` (멤버여야 한다)를 함께 보내면, 생성자를 바꾸고 나서 나간다. `transfer_to` 없이 생성자가 나가려고 하면 400 ("생성자를 넘긴 뒤에 나갈 수 있습니다"). 방에 생성자 말고 아무도 없으면 방을 삭제한다 (`chat_rooms` 행 삭제 — 멤버는 CASCADE로 지워진다. DO의 메시지는 그대로 남는다 — DO는 방 키로 살아 있고, 방이 다시 만들어지지 않는 한 접근할 수 없다).

### 3. 그룹 메시지 송수신 (DM API와 같은 패턴으로)

- `POST /api/chat/groups/:roomId/messages` — 본문 `{body}` (1~4000자). **보내기 전에 D1 `chat_room_members`에서 멤버인지 확인한다** (비멤버 404). DO에 `POST /messages`를 fetch로 부른다 (DM과 같은 DO 경로). 성공 시 `chat_rooms.updated_at`을 ISO로 갱신한다 (D1 쓰기 실패는 DM과 같은 원칙 — `console.error`만, 응답은 성공).
- `GET /api/chat/groups/:roomId/messages?before=&limit=` — 멤버만 (비멤버 404). DO의 `GET /messages`를 그대로 돌려준다.
- `GET /api/chat/groups/:roomId/ws` — 멤버만 (비멤버 404, 익명 401, Origin 검사는 DO-1b와 같은 방식). DO stub에 업그레이드를 전달한다.
- `GET /api/chat/rooms` 확장 (DO-1b에서 만든 목록 API): 그룹 행에도 `unread` 수를 붙인다 (아래 4번). DM 행은 그대로 둔다 (1:1 미읽음은 v1에서 안 센다).

### 4. 멤버별 미읽음 (DO seq + D1 `last_read_seq`)

- **seq**: DO가 메시지마다 단조 증가하는 `seq`를 매긴다 (DO-1a에서 이미 한다). 방의 최신 seq는 DO가 안다.
- **읽음 확인**: `POST /api/chat/rooms/:roomId/read` — 본문 `{seq?: number}` (없으면 방의 최신 seq까지 읽은 것으로 한다). 멤버만 (비멤버 404). `chat_room_members.last_read_seq`를 `MAX(기존값, seq)`로 갱신한다 (뒤로 가지 않는다).
- **미읽음 수**: `unread = (방의 최신 seq) - (내 last_read_seq)` (0보다 작으면 0). 방의 최신 seq는 DO에서 가져온다 — `GET /messages?limit=1`로 최신 메시지 1개의 seq를 읽는 방식이면 된다 (새 내부 엔드포인트를 만들지 않는다 — DO-1a의 `GET /messages`를 재사용한다). 단, 방 목록에서 방이 많으면 방마다 DO를 부르게 된다 — 목록이 50개까지만 오므로 v1에서는 허용한다 (성능 측정은 DO-MIG 라이브 검증 때 확인한다).
- **읽음 확인 호출 지점**: 방을 열 때(히스토리 로딩 후) 프런트가 부른다 — 프런트는 DO-1d에서 만든다. 이 세션은 API만 만든다.
- 1:1 DM의 미읽음은 v1에서 안 센다 (DO-1b와 같은 결정). 단, `POST /api/chat/rooms/:roomId/read`는 DM 방에도 쓸 수 있게 만든다 (나중에 DM 미읽음을 붙일 때 API를 다시 만들지 않게).

## 검증 (반드시 `files/workflow-verify/do1c/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/do1c/`)

- `npx tsc --noEmit` 통과. `migrations/0030_chat_rooms.sql` 파일이 **새로 생기지 않았는지** 확인한다 (DO-1b의 파일을 그대로 쓴다).
- 로컬 하네스 (DO-1a·DO-1b의 `do1a/`·`do1b/` 패턴 — Miniflare, 실제 `ChatRoom` DO + 0030 적용된 로컬 D1):
  1. **그룹 생성**: 방 생성 201 (멤버 목록에 생성자 포함), 없는 멤버 id는 400, 빈 이름은 400, `updated_at`이 ISO 형식인지 확인한다.
  2. **멤버 권한**: 생성자는 추가·제거 200, hr_admin도 추가·제거 200, 일반 멤버가 남을 추가·제거하면 403, 본인 나가기는 200, 비멤버의 멤버 목록·메시지·WS는 전부 404.
  3. **제거 시 WS 끊김**: 제거된 멤버의 WebSocket이 닫히는지 확인한다 (Miniflare 클라이언트 2개 — 제거 전 연결, 제거 후 메시지 수신 안 됨 + 재연결 404).
  4. **미읽음**: A·B·C 방에서 A가 3통 보내면 B·C의 unread가 3, B가 읽음 확인을 하면 B만 0, C는 3 유지. A가 1통 더 보내면 B 1·C 4. `last_read_seq`가 뒤로 안 간다 (작은 seq로 읽음 확인을 보내도 그대로).
  5. **생성자 퇴장**: `transfer_to` 없이 생성자가 나가면 400, 넘기고 나가면 새 생성자가 추가·제거를 할 수 있다. 마지막 1명이 나가면 방이 삭제된다 (목록에서 안 보인다).
  6. **회귀**: DO-1a 하네스 41/41 + DO-1b 하네스 77/77을 그대로 돌려서 통과하는지 확인한다. DM 송수신·방 목록이 그대로 동작한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 Cloudflare WebSocket, 배포·원격 DO(v3 미적용)·원격 D1(0030 미적용), 브라우저 화면, 그룹 UI — DO-1d).

## 금지

- 0030 마이그레이션을 새로 만들지 않는다 (DO-1b의 파일을 그대로 쓴다). `wrangler.toml`에 v3 마이그레이션 태그를 추가하지 않는다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 메시지 본문에 실행 코드를 넣지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 이 세션에서 건드리지 않는다 (별도 과제).
