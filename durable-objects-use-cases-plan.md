# People OS Durable Objects 활용 계획서

> 작성: 2026-11-18. 코드 변경 없음, 제안만. 동결(11-25) 전에 만들 것과 공모전 후로 미룰 것을 나눈다.
> 근거: People OS README·ARCHITECTURE.md(2026-11-17 기준), `src/agent-session.ts`, `wrangler.toml`, 아래 GitHub 예시(2026-11-18 직접 확인).
> 전제: 워크플로우·에이전트 빌더는 **별도 코디네이터가 이미 만들고 있다**(2026-11-18 02:17 시작). 이 계획서는 그 **밖의** DO 활용만 다룬다. 중복하지 않는다.

## 요약 (30초)

**결론: DO로 만들 가치가 있는 것은 "실시간"과 "정확한 동시성 제어"뿐이다. People OS에 이미 있는 것(D1 결재 원자성, KV 레이트 리밋, AgentSession 대화 기억)을 DO로 다시 만들지 않는다.**

- **동결 전에 만들 것 3가지**: ① 실시간 채팅 (코치↔코칭 대상 1:1 + 직원↔직원 1:1 + 그룹채팅, WebSocket Hibernation) ② 실시간 알림 푸시 (결재·메일·할 일, 채팅 인프라 재사용) ③ DO 정밀 레이트 리미터 (KV eventual consistency 구멍을 메움). 합계 약 6~8세션.
- **공모전 후**: 공동 문서 편집(가벼운 버전), 라이브 퀴즈/투표(LMS·설문과 함께), 덱 편집 락(스트레치로 동결 전 가능).
- **안 하는 것**: 게임룸, 선착순 예약/재고(수요 없음), 가상 대기열(수요 없음), 멀티테넌트 마이크로 DB(전체 재설계), Containers 코드 샌드박스(제안서가 명시적으로 제외).
- **Agents SDK를 통째로 들이지 않는다.** 패턴과 예시만 참고하고, raw DO + WebSocket Hibernation으로 직접 구현한다. 이유: People OS 프런트는 빌드가 없는 정적 HTML/JS이고, SDK는 React·빌드 단계·무거운 의존성을 끌고 오기 때문이다.

---

## 1. 검증한 오픈소스 예시 (2026-11-18 직접 확인)

| 예시 | 저장소·경로 | 라이선스·상태 | People OS에서 재사용할 것 |
|---|---|---|---|
| **Cloudflare Agents SDK** | `cloudflare/agents` (MIT, 별 6k, 1,855 커밋, 현역) | MIT | 패턴만 참고. `examples/workflows/`(다중 워크플로우 + 승인 게이트 + WebSocket 실시간 진행률)는 **워크플로우 빌더 코디네이터**가 승인 게이트 참고용으로 볼 것. `examples/tictactoe/`는 게임 데모 — 참고만. `packages/hono-agents/`는 Hono 연동 미들웨어이나, 동결 전에는 들이지 않는다. |
| **workers-chat-demo** | `cloudflare/workers-chat-demo` (공식 데모) | — | **채팅·알림의 주 참고.** 방당 DO 1개(ChatRoom) + IP당 RateLimiter DO + WebSocket Hibernation. 의존성 없이 수백 줄. 코드가 주석까지 잘 돼 있다. |
| **DO 공식 예시집** | `developers.cloudflare.com/durable-objects/examples/` | — | `Build a WebSocket server with WebSocket Hibernation`, `Use the Alarms API`(요청 배치·TTL), `Build a counter`, `Durable Object in-memory state`. |
| **DO 레이트 리미터 공식 예시** | `cloudflare-docs/.../durable-objects/examples/build-a-rate-limiter.mdx` | — | 토큰 버킷 + Alarms API로 주기적 보충. IP 기준 DO 1개. **레이트 리미터 항목의 설계 원본.** |
| **agentic-inbox** | `cloudflare/agentic-inbox` (Apache 2.0, 별 8.8k, 2026-04-10 생성, 현역) | Apache 2.0 | 메일함당 DO 1개 + SQLite + R2, Agents SDK `AIChatAgent`. **People OS가 이미 의도적으로 안 가져온 것**과 같음: DO-per-mailbox, Cloudflare Access(필수), postal-mime. 참고만 하고, 가져오지 않는다. 단, Access가 필수라는 점과 "Access를 통과한 사용자는 모든 메일함에 접근 가능(메일함별 인가 없음)"이라는 한계는 People OS가 자체 로그인·owner_id 격리를 유지해야 하는 근거다. |
| **Containers + DO 인터페이스** | `developers.cloudflare.com/containers/examples/durable-object-interface/` | — | DO에서 컨테이너를 직접 제어(명령 실행·스냅샷·이미지 롤아웃). **코드 샌드박스 항목의 참고.** 동결 전에는 안 쓴다 (아래 3장 4번). |

---

## 2. 10개 유스케이스 전수 평가

| # | 유스케이스 | 판정 | 이유 (한 줄) |
|---|---|---|---|
| 1 | 실시간 채팅방·메신저 | **동결 전** | 코칭 1:1 + 직원 1:1 + 그룹채팅. People OS 핵심(코칭·협업)에 실시간이 없음. 데모에서 보임. |
| 2 | 공동 문서 편집·화이트보드 | 공모전 후 | CRDT/OT가 무겁고, People OS 문서 편집은 PPTX 파일 편집이라 실시간 공동편집과 안 맞음. |
| 3 | 상태 저장형 AI 에이전트 | **코디네이터 범위** | 워크플로우·에이전트 빌더 코디네이터가 이미 만듦 (에이전트 DO + Alarms). 중복 금지. |
| 4 | AI 코드 생성 + 격리 샌드박스(Containers) | 안 함 (공모전 후 검토만) | 제안서가 코드 노드를 명시적으로 제외 (보안). Containers는 별도 제품·비용·빌드 필요. |
| 5 | 선착순 예약·재고 차감 | 안 함 | People OS에 재고·티켓 개념 없음. 결재 동시성은 D1 `batch()`로 이미 해결됨. |
| 6 | 가상 대기열(Waiting Room) | 안 함 | 내부용 소규모 도구라 트래픽 급증 시나리오 없음. Waiting Room 자체가 Cloudflare 유료 제품. |
| 7 | 사용자별 정밀 API 레이트 리미터 | **동결 전** | KV 기반 현행은 eventual consistency라 분산 우회가 가능 (fail-open). DO면 원자적 카운팅. |
| 8 | 멀티플레이어 게임룸·매치메이킹 | 안 함 | 게임 없음. Agents SDK `tictactoe/`는 데모용일 뿐. |
| 9 | 라이브 스트리밍·실시간 투표/집계 | 공모전 후 | LMS가 녹화 강의라 라이브 세션이 없음. 설문 기능과 함께 검토. |
| 10 | 멀티테넌트 격리 마이크로 DB | 안 함 | 단일 조직 기준. 마이그레이션은 전체 재설계. 장기 방향으로만. |

---

## 3. 동결 전에 만들 것 (3가지, 약 4~6세션)

순서는 데모 가치 → 공수 → 리스크 순이다. 코디네이터의 워크플로우 빌더와 **순차로** 편입한다 (동시 배포 금지, 6장 참고).

### D1. 실시간 채팅 — 1:1(코칭·직원) + 그룹채팅 (4~5세션) — 최우선

> **범위 확장 (2026-11-18, 사용자 승인 "응, 둘 다 넣어줘")**: 원래 코치↔코칭 대상 1:1만이던 범위에 **직원↔직원 1:1**과 **그룹채팅**이 추가됐다. 세 방식은 같은 `ChatRoom` DO 아키텍처(방당 DO 1개 + WebSocket Hibernation + 방 내 전원 브로드캐스트)로 간다. 직원 1:1은 DO가 역할을 안 보기 때문에 추가 공수가 거의 없다 (참여자 선택만 다름). 그룹채팅 추가분은 DO-1c·DO-1d 2개 세션으로 나눈다 (아래 "그룹채팅 추가분" 참고). 순서 변동 없음 — WF-12 뒤 Phase 4에서 그대로 진행한다.

**무엇인가.** 세 가지 방식을 한 채팅으로 묶는다. 코칭 메뉴 안에 "채팅" 탭을 둔다. 메시지는 DO SQLite에 저장하고, 방에 접속한 모든 브라우저에 WebSocket으로 실시간 전달한다. 접속 중이 아닐 때는 메시지가 DO에 남아 다음 접속 때 읽힌다.
1. **코치↔코칭 대상 1:1** (원래 범위). 방의 두 사람은 `coaching` 관계에서 정해진다.
2. **직원↔직원 1:1** (추가). 아무 두 사용자나 1:1 방을 만들 수 있다. DO는 역할을 안 본다 — 방 키에 들어간 두 id만 본다. 참여자 선택 UI만 코칭 1:1과 다르다.
3. **그룹채팅** (추가). 여러 명이 한 방에서 대화한다. 멤버십·미읽음·멤버 관리가 1:1보다 한 단계 더 있다 (아래 참고).

**왜 People OS에 맞는가.**
- 코칭이 People OS의 핵심인데, 지금 코치와 코칭 대상이 실시간으로 대화할 방법이 없다. 리플렉션은 전사본을 보고 쓰는 비동기 작업이고, 채팅은 그 사이의 대화다.
- 심사위원 데모에서 "실시간"은 눈으로 보인다. 전사·RAG와 달리, 채팅은 두 화면을 나란히 놓고 바로 보여줄 수 있다.
- 이미 있는 것(코칭 역할 `coach`/`coachee`, 사용자 관리, 코칭 대상 지정)을 그대로 쓴다.
- 직원 1:1·그룹채팅은 코칭 1:1과 같은 DO를 재사용하므로, 코칭에만 갇히지 않고 조직의 일상 대화까지 커버한다.

**참조 예시.** `cloudflare/workers-chat-demo` — 방당 DO 1개, WebSocket Hibernation, 의존성 없이 수백 줄. 이 구조를 그대로 가져오되, 아래 두 가지를 People OS 방식으로 바꾼다.
- **인증**: 데모는 익명이다. People OS는 WebSocket 업그레이드 전에 세션 쿠키를 검증한다 (Strict 쿠키는 같은 출처 WebSocket에 실린다). 익명은 방에 못 들어간다.
- **방 키 격리**: 1:1 방 이름에 두 사용자 id를 넣는다 (`chat:dm:<a>:<b>`, 두 id 정렬 — 코칭 1:1과 직원 1:1이 같은 방식). 그룹 방은 `chat:group:<roomId>`. AgentSession이 `<viewerId>:<sessionId>`를 키에 넣어 남의 대화를 못 읽게 한 것과 같은 방식이다. 방 밖 사용자(1:1의 제3자, 그룹의 비멤버)는 404다 (결재·메일의 존재 은닉과 같다).

**설계 (짧게).**
- 새 DO 클래스 `ChatRoom` (SQLite). `wrangler.toml`에 바인딩 추가 + 마이그레이션 태그에 `new_sqlite_classes` 추가 (6장).
- 메시지: `POST /api/chat/:roomId/messages`(REST로 보내기) + WebSocket으로 수신. 또는 WebSocket으로 송수신 전부. 1차는 REST 보내기 + WebSocket 받기로 단순하게.
- Hibernation API 사용: 메시지 없을 때 인스턴스 휴면, 연결은 유지. 비용 절감 + 데모에서 "Hibernation"을 말할 수 있다.
- 기록: DO SQLite에 최근 N개(예: 200개) 유지. D1 미러링은 1차에 안 한다 (관측·검색이 필요해지면 그때).
- 읽음 표시·타이핑 표시는 1:1에서는 안 넣는다 (범위 자르기). **그룹채팅의 멤버별 미읽음은 예외 — 아래 참고.**

**그룹채팅 추가분 (DO-1c·DO-1d, 2세션).**
- **멤버십 저장 위치 — D1로 결정 (DO 스토리지가 아님). 이유**: "내 방 목록"을 보여주려면 모든 방을 훑어야 하는데, DO는 방마다 따로 살아서 전체 목록을 만들 수 없다. 멤버십은 관계형 조회(내 방 목록·멤버 목록·권한 판정)가 본질이라 D1이 맞고, People OS의 나머지 멤버십(사용자·부서)도 D1에 있다. 메시지만 DO SQLite에 둔다 (기존 설계 그대로). 테이블은 **DO-1b에서 DM 목록용으로 먼저 만든다** (`migrations/0030_chat_rooms.sql` — DM 행은 type='dm', id는 DM 키, name은 NULL): 방 목록이 없으면 채팅 UI를 만들 수 없어서다. DO-1c는 같은 테이블에 그룹 행(type='group')을 재사용한다 (테이블을 다시 만들지 않는다). 원격 적용은 DO-MIG에서 v3 태그와 함께 한다.
- **멤버 추가/제거 — 권한: 방 생성자 또는 hr_admin만.** 생성자는 멤버를 추가·제거할 수 있고, hr_admin도 추가·제거할 수 있다. 일반 멤버는 자기 자신을 뺄 수는 있어도 남을 뺄 수 없다. 제거된 멤버는 D1에서 빠지고, DO에도 알려서 그 멤버의 WebSocket을 끊는다 (재접속 시 404). 생성자가 방을 나갈 때는 다른 멤버에게 생성자 역할을 넘긴 뒤에만 나갈 수 있다 (넘길 사람이 없으면 방 삭제 — 세부 규칙은 DO-1c 세션에서 확정).
- **멤버별 미읽음**: 1:1은 두 사람뿐이라 읽음 추적이 단순하지만, 그룹은 멤버마다 읽은 위치가 다르다. DO가 메시지마다 단조 증가하는 seq를 매기고, 각 멤버의 `last_read_seq`를 `chat_room_members`에 둔다. 미읽음 수 = 내 `last_read_seq` 뒤의 메시지 수. 클라이언트는 방을 열 때 읽음 확인(REST 또는 WebSocket)을 보내 `last_read_seq`를 갱신하고, 방 목록에 미읽음 배지를 보여준다. 1:1에는 v1에서 미읽음을 안 넣는다 (같은 메커니즘이라 나중에 붙이기는 쉽다 — DO-1c에서 같이 할지 판단한다).
- **UI (DO-1d)**: 그룹 생성(이름 + 멤버 선택), 멤버 목록 보기, 멤버 추가/제거 버튼, 방 목록의 미읽음 배지. 1:1 UI(DO-1b)와 같은 채팅 탭 안에서 방 종류별로 보여준다.

**공수.** DO 클래스 + API (Sonnet 1, 1:1 두 방식 포함) → 채팅 UI + 배선 (Sonnet 1) → 그룹채팅 백엔드(D1 멤버십·추가/제거·미읽음, Sonnet 1) → 그룹채팅 UI (Sonnet 1) → 로컬 검증 + 배포 + 라이브 확인 (1). 합계 4~5세션.

**리스크.** WebSocket + 인증이 처음이라, 로컬 Miniflare와 라이브의 동작 차이(특히 쿠키·업그레이드)를 라이브에서 확인해야 한다. 실패하면 채팅 탭만 안 보이고 나머지 앱은 정상이어야 한다 (격리 설계).

### D2. 실시간 알림 푸시 (1~2세션) — D1 인프라 재사용

**무엇인가.** 결재 승인 요청·메일 수신·할 일 지정을 새로고침 없이 바로 띄우는 푸시. 사용자마다 DO 1개(`NotificationHub`)가 WebSocket 연결을 들고, `notifications` 테이블에 행이 생기면 해당 사용자의 허브가 브라우저에 밀어준다.

**왜 People OS에 맞는가.**
- 알림 테이블(`notifications`)은 이미 있다. 결재 알림이 쌓이는데, 사용자는 화면을 새로고침해야 본다. "결재 요청이 왔다"는 것을 바로 아는 것은 HR·결재 흐름의 체감 속도를 바꾼다.
- D1 채팅 인프라(WebSocket 업그레이드·인증·Hibernation)를 그대로 재사용한다. D1 없이 단독으로 만들면 공수가 두 배다. D1을 먼저 하고 D2를 붙이는 순서가 맞다.

**참조 예시.** `cloudflare/workers-chat-demo`의 WebSocket 패턴 + DO 공식 예시 `Use the Alarms API`(배치). 알림 전송은 기존 `notifications` INSERT 지점(결재 `notify.ts` 등)에서 허브 DO에 `fetch`로 한 번 더 부르는 방식이다.

**공수.** 허브 DO + 알림 전송 배선 (Sonnet 1) → UI 토스트·배지 연동 + 검증 (0.5~1). D1과 합치면 1~2세션. D1이 없으면 단독 2세션.

**리스크.** 낮음. 푸시가 실패해도 알림 행은 D1에 남아 목록에서 볼 수 있다 (폴백이 이미 있다).

### D3. DO 정밀 레이트 리미터 (1세션) — 안 보이는 정확성

**무엇인가.** 질문 API(`POST /api/ask`, `POST /api/personal/ask`)의 분당 20회 제한을 KV에서 DO로 옮긴다. 사용자(또는 세션)마다 DO 1개가 타임스탬프 배열(슬라이딩 윈도우) 또는 토큰 버킷을 들고 원자적으로 카운팅한다.

**왜 People OS에 맞는가 — 이미 있는 것을 왜 바꾸나.**
- 현행은 KV 키 `rl:ask:<세션>`에 60초 슬라이딩 윈도우로 분당 20회, KV 실패 시 통과(fail-open)다 (`ARCHITECTURE.md` 2.2).
- KV는 전 세계 최종 일관성이라, 쓰기가 다른 데이터센터에 퍼지기 전에 같은 사용자가 다른 경로로 요청하면 제한을 넘길 수 있다. 데모 규모에서는 안 터지지만, "정확한" 제한이 아니다.
- DO는 단일 인스턴스라 카운팅이 원자적이다. 이것이 DO의 교과서적 용도다.

**참조 예시.** DO 공식 예시 `build-a-rate-limiter.mdx` (토큰 버킷 + Alarms API로 보충). `workers-chat-demo`의 IP당 RateLimiter DO도 같은 패턴이다 (참고: 그 데모의 레이트 리미터는 저장소가 없는 순수 조율 객체다 — 최근 기록만 보면 되기 때문이다).

**공수.** DO 클래스 + 배선 + 검증 (Sonnet 1). 작다.

**리스크.** 낮음. DO 실패 시 KV 제한으로 폴백한다 (기존 코드를 지우지 않고, DO를 앞에 두고 DO가 안 되면 KV로). 제한이 느슨해지는 일은 있어도 앱이 안 죽는다.

**데모 가치.** 낮다 (눈에 안 보임). 다만 심사위원에게 "KV의 eventual consistency 구멍을 DO의 원자적 카운팅으로 메웠다"는 한 줄은 아키텍처 설명에 들어간다. D1·D2보다 뒤에 두는 이유다.

### 합계

| 항목 | 세션 | 모델 |
|---|---|---|
| D1 실시간 채팅 (1:1 두 방식 + 그룹) | 4~5 | Sonnet |
| D2 알림 푸시 | 1~2 (D1 재사용 시) | Sonnet |
| D3 레이트 리미터 | 1 | Sonnet |
| **합계** | **약 6~8세션** | |

---

## 4. 공모전 후로 미룰 것

### P1. 공동 문서 편집 — 가벼운 버전부터 (공모전 후)

- **왜 지금 안 하나.** 진짜 공동편집(CRDT/OT)은 무겁다. People OS의 문서 편집은 PPTX 파일 편집(S3)이라, 실시간 텍스트 공동편집과 직접 안 맞는다. 동결 전에 CRDT를 붙이면 회귀 위험이 크다.
- **공모전 후 버전.** "라이브 메모"부터: 코칭 세션 중 코치·코칭 대상이 같이 쓰는 메모장 1개. DO 1개가 메모 상태를 들고 WebSocket으로 동기화한다. CRDT 없이, DO의 단일 스레드 순차 처리로 충돌을 해결한다 (마지막 쓰기가 이긴다 + 버전 번호). 참조: DO 공식 예시 `Durable Object in-memory state`, Agents SDK `examples/`의 상태 동기화 패턴.
- **그 다음.** PPTX 덱 편집에 DO 락을 붙이는 것(아래 스트레치 참고)과, 진짜 CRDT는 그 다음 단계에서 검토한다.

### P2. 라이브 퀴즈·투표 (LMS·설문과 함께)

- **왜 지금 안 하나.** LMS가 녹화 강의(유튜브·R2)라 라이브 세션이 없다. 투표할 장면이 없다. 그룹웨어 우선순위에 설문이 있으나, 그것도 공모전 후다.
- **공모전 후 버전.** 강의실 라이브 세션(또는 설문)에서 실시간 퀴즈·투표를 DO 1개가 집계한다. 투표 1건마다 DO가 카운트를 원자적으로 올리고, 결과를 WebSocket으로 브로드캐스트한다. 참조: DO 공식 예시 `Build a counter`.

### P3. Containers 코드 샌드박스 (검토만)

- **왜 지금 안 하나.** 제안서(4.1.6)가 코드 노드를 명시적으로 제외했다. 사용자 코드를 안전하게 돌리는 것은 보안 사고의 제일 큰 구멍이다. Containers는 별도 제품이라 요금·빌드·이미지 관리가 새로 들어간다.
- **공모전 후 검토.** `developers.cloudflare.com/containers/examples/durable-object-interface/`의 DO→컨테이너 제어 패턴으로, "에이전트가 만든 코드를 격리 실행"하는 것을 다시 검토한다. 단, People OS의 "외부 행동은 사람이 승인한다"는 원칙과 함께 가야 한다.

---

## 5. 명시적으로 안 하는 것

| 안 하는 것 | 이유 |
|---|---|
| 게임룸·매치메이킹 | 게임 없음. Agents SDK `tictactoe/`는 데모용일 뿐, 제품에 붙일 이유가 없다. |
| 선착순 예약·재고 차감 | People OS에 재고·티켓 개념이 없음. 결재 동시성은 D1 `batch()`(INSERT…SELECT…WHERE 전제 + EXISTS 조건, 버전 낙관적 잠금)로 이미 원자적이다. DO로 바꿀 이유가 없다. |
| 가상 대기열 | 내부용 소규모 도구라 트래픽 급증 시나리오가 없다. Waiting Room 자체가 Cloudflare 유료 제품이라, DIY로 흉내낼 가치가 없다. |
| 멀티테넌트 격리 마이크로 DB | README에 "멀티테넌시(한 조직 기준)"라고 적혀 있다. 테넌트당 DO 1개로 바꾸는 것은 데이터 계층 전체 재설계다. 장기 방향으로만 남긴다. |
| DO-per-mailbox로 메일함 이관 | agentic-inbox 방식이다. People OS 메일함은 D1 + owner_id 격리로 이미 동작한다. 이관은 전체 재작성이고, Access 필수라는 조건도 People OS 로그인과 안 맞는다. |
| Agents SDK 통째로 도입 | `npm install agents`는 React 훅·빌드 단계·무거운 의존성을 끌고 온다. People OS 프런트는 빌드가 없는 정적 HTML/JS다. 동결 전에 빌드 단계를 도입하는 것은 회귀 위험이 크다. 패턴·예시만 참고한다. 공모전 후, 에이전트 빌더가 커지면 SDK 도입을 다시 검토한다. |

---

## 6. 코디네이터와 겹치지 않게 하는 법 (순차 편입 규칙)

워크플로우·에이전트 빌더 코디네이터가 먼저 돌고 있다. 이 계획서의 항목은 **그 뒤에 순차로** 붙는다.

1. **배포는 직렬로.** 코디네이터와 이 계획서의 세션이 같은 시간에 배포하지 않는다. 한쪽이 배포·라이브 확인을 끝낸 뒤에 다음이 시작한다.
2. **DO 클래스 추가는 마이그레이션 하나로 묶는다.** `wrangler.toml`의 `[[migrations]]` 태그는 한 번에 하나만 올린다. 코디네이터의 에이전트 DO와 이 계획서의 `ChatRoom`·`NotificationHub`·`RateLimiter`를 **같은 마이그레이션 태그**에 `new_sqlite_classes`로 함께 나열한다. 따로따로 태그를 올리면 충돌한다. 누가 먼저 태그를 올리든, 나중 세션은 그 태그에 클래스를 추가하는 방식으로 합친다.
3. **wrangler.toml 소유권.** DO 바인딩·마이그레이션·크론을 만지는 세션은 동시 실행 금지. `src/index.ts`의 `scheduled()` 분기를 만지는 세션도 마찬가지다 (기존 규칙).
4. **Agents SDK `examples/workflows/`는 코디네이터가 본다.** 이 계획서는 그 예시를 승인 게이트 참고용으로 코디네이터에게 넘기고, 직접 구현하지 않는다.
5. **상태 저장형 AI 에이전트(3번)는 코디네이터 범위다.** 이 계획서에서 에이전트 DO를 새로 만들지 않는다. D1·D2·D3의 DO는 에이전트 실행기가 아니라, 채팅·알림·카운팅이라는 각자의 일만 한다.

---

## 7. 참고 — 확인한 출처 (2026-11-18)

- Cloudflare Agents SDK — https://github.com/cloudflare/agents (MIT, 별 6k, `examples/workflows/` 승인 게이트 + WebSocket 진행률, `examples/tictactoe/`, `packages/hono-agents/`)
- workers-chat-demo — https://github.com/cloudflare/workers-chat-demo (방당 DO + IP당 RateLimiter DO + WebSocket Hibernation, 의존성 없음)
- DO 공식 예시집 — https://developers.cloudflare.com/durable-objects/examples/ (WebSocket Hibernation, Alarms API, counter, in-memory state)
- DO 레이트 리미터 공식 예시 — https://github.com/cloudflare/cloudflare-docs/blob/main/src/content/docs/durable-objects/examples/build-a-rate-limiter.mdx (토큰 버킷 + Alarms API)
- agentic-inbox — https://github.com/cloudflare/agentic-inbox (Apache 2.0, 별 8.8k, 메일함당 DO + SQLite + R2, Agents SDK, Cloudflare Access 필수)
- Containers + DO 인터페이스 — https://developers.cloudflare.com/containers/examples/durable-object-interface/ (DO에서 컨테이너 제어: 명령 실행·스냅샷·이미지 롤아웃)
- People OS — `README.md`, `ARCHITECTURE.md` (2026-11-17 기준), `src/agent-session.ts` (대화 기억 DO, 27행), `wrangler.toml` (AGENT_SESSION 바인딩 1개, 크론 2개)
- 워크플로우·에이전트 빌더 제안서 — `workflow-agent-builder-proposal.md` (2026-11-18, 코디네이터가 구현 중)
