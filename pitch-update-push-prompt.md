# 소개·발표자료·데모 반영 + GitHub 푸시 (Sonnet)

## 배경
Fable 감사(`files/workflow-verify/pitch-audit/RESULT.md`)가 끝났다. 9개 기능 중 세 문서에 반영된 것은 0개이고, 사실과 다른 문장이 남아 있다. 사용자가 데모 축소안과 범위(소개 탭까지 포함)를 승인했다. 이 세션에서 문서를 고치고 배포하고 GitHub에 푸시한다.

## 먼저 읽을 것
- **`files/workflow-verify/pitch-audit/RESULT.md` (필독)**: P0~P3 우선순위, 문서별 행 번호, 빠진 기능 목록, 데모 개편안(4장)이 들어 있다. 이 파일을 기준으로 고친다.
- `public/pitch-content.html` (발표자료 본문 — `public/pitch.html`은 32행 껍데기라 본문은 pitch-content.html이다. `pitch.js`가 `data-nav`·`data-key`로 목차를 자동 생성하므로 섹션 추가 시 이 속성만 맞춘다.)
- `README.md`, `DEMO-SCRIPT.md`, `public/index.html` (소개 탭 453~519행).

## 사용자 결정 (승인됨)
1. **데모 축소안 (제안대로)**: 워크플로우 장면(~40초) + 채팅 장면(~15초)을 넣기 위해 55초를 덜어낸다. 줄일 것: "할 일 + PPTX 개요 편집" 25초 → 10초, "코칭 리플렉션" 30초 → 15초, RAG 장면의 후속 질문 삭제.
2. **범위**: 3개 문서(pitch-content.html, README.md, DEMO-SCRIPT.md) + **앱 소개 탭**(`public/index.html` 453~519행)까지. `architecture.svg`, `ARCHITECTURE.md`, `VERIFICATION.md`는 이번에 안 고친다 (후속).
3. **reasoning low/medium은 아직 미결**이다. 문서에 속도 수치·"빠르다" 표현을 절대 적지 않는다. reasoning 설정은 적지 않거나 "조정 중"으로만 쓴다.

## 고칠 것 (감사 RESULT.md의 P0 → P1 → P2 → P3 순서)

### P0 — 사실과 다른 문장 (가장 먼저)
- pitch-content.html 208·276·281·285행, README.md 3·62·98·204행: "자유형 에이전트 없음 / 승인 구조 없음 / DO는 대화 기억만" → 워크플로우 에이전트(ReAct, WorkflowAgent DO, 최대 10스텝)·승인 게이트(send_email·webhook 승인 대기 → 승인 → 실행)·DO 5개 기준으로 다시 쓴다. 남은 한계는 사실대로 남긴다.
- 모델명: pitch-content.html 172·222행, README.md 3·31·108행 → `@cf/qwen/qwen3.8-27b`. 속도 수치 금지.
- 레이트 리밋 KV → RateLimiter DO: pitch-content.html 146·223·240행, README.md 57행. RateLimiter DO 토큰 버킷(용량 20, 3초당 1개 보충)이 1차, KV는 폴백.
- 마이그레이션 0001~0031, 크론 3개(다이제스트·새벽 평가·15분마다 워크플로우 스케줄), 큐에 워크플로우 단계 실행 포함: README.md 42·43·55·61·63·138·197행, pitch-content.html 119·120·129·220·221·244·246행.
- **노드 수**: 12개가 아니라 **15종**이다 (코드 `NODE_TYPES`, `src/workflow/types.ts:26`). WF-2의 12종 + `agent` + `condition` + `webhook`. 문서에는 "노드 15종" 또는 "도구 노드 13종 + 에이전트 + 조건 분기"로 적는다.
- **실행 한도**: 동시 3개, 하루 20회, run당 30분, 에이전트 최대 10스텝 (`src/workflow/engine.ts:415`, `types.ts:34`).

### P1 — 핵심 기능 추가
- 워크플로우 빌더 소개: pitch-content.html 08 섹션(에이전트 루프 ④ + 193~202행 표) 또는 새 섹션, 10 섹션 표의 Queues·DO·Cron 행. README.md 기능 목록·에이전트 표·저장소 구조. 내용: 노드 15종, Queues 기반 실행 엔진(멱등·재시도), 승인 게이트, 폼 빌더 + 비주얼 캔버스(SVG 자체 제작, 무빌드), 에이전트 노드(ReAct, WorkflowAgent DO), 조건 분기, 스케줄(15분 틱) + 이벤트 트리거, 공유·템플릿·복사, 웹훅(SSRF 차단), 관측 "워크플로우" 탭.
- DO 활용 5가지: pitch-content.html 151·245행, README.md 32·62행. AgentSession(대화 기억), WorkflowAgent(에이전트 루프 상태), ChatRoom(채팅방 + 접속 로비, WebSocket Hibernation), NotificationHub(알림 푸시), RateLimiter(토큰 버킷 + Alarm). "KV의 eventual consistency 구멍을 DO로 메웠다 — 라이브 동시 25회 중 정확히 20회 허용"은 근거로 넣는다.
- README.md 69~83행 기능 목록을 실제 메뉴 16개 + 채팅·알림 기준으로 다시 쓴다. 순서: 홈·메일함·결재함·캘린더·할 일·녹음전사·코칭 리플렉션·강의실·워크플로우·개인 업무 검색·HR 규정 검색·라이브러리·관측·평가·사용자 관리·조직관리·소개·발표자료. 캘린더·조직관리 포함. 채팅(우하단 버튼)과 실시간 알림도 넣는다.
- DEMO-SCRIPT.md 화면 불일치 수정: 로그인 단계 추가, 메뉴 이름(26·29·51·67행: "녹음전사 · 문서저장", "HR 규정 검색", "코칭 리플렉션"), 마무리 나레이션(79~80행: Queues 추가, DO 역할, 워크플로우·실시간 한마디).

### P2 — 데모 개편 (사용자 승인된 축소안 적용)
- DEMO-SCRIPT.md에 워크플로우 장면(~40초) + 채팅 장면(~15초) 추가:
  - 워크플로우: 워크플로우 메뉴 → 미리 만들어 둔 워크플로우 열기 → "캔버스 보기"로 단계·분기 보여 주기 → 실행 → `send_email` 단계에서 승인 대기 → 화면에 알림 토스트(NotificationHub) → 승인 → 완료. 나레이션: "단계를 이어 붙이면 큐가 순서대로 실행합니다. 밖으로 나가는 메일은 사람이 승인해야 나갑니다."
  - 채팅: 어느 화면에서든 우하단 버튼 클릭 → 상대 이름 옆 녹색불 → 메시지 전송 → 옆의 "1" → 상대가 읽으면 사라짐 → 이모지 반응. 준비물: 계정 2개를 창 2개(일반 + 시크릿)로 띄워야 함. 대화 상대와 기존 대화를 미리 만들어 둔다.
- 기존 장면 축소 (승인됨): "할 일 + PPTX 개요 편집" 25초 → 10초, "코칭 리플렉션" 30초 → 15초, RAG 장면의 후속 질문 삭제.
- 준비물 갱신: 워크플로우를 녹화 전에 미리 만들어 둔다 (시드에 워크플로우 템플릿이 없음). LLM 단계가 있으면 대기 시간이 길 수 있으니 컷 편집 지점을 정한다. 수신 주소는 내부 `@peopleos.site`로.
- **속도 전제**: reasoning 미결인 동안 대본에 소요 시간을 적지 않는다. "1분 이내 완료", "40초 안에 질문 4번" 같은 전제는 빼거나 "컷 편집"으로 처리한다.
- pitch-content.html 13 섹션 "3분 따라 하기", README.md 168~176행 따라 하기 단계를 대본과 맞춘다 (워크플로우 단계 1개 추가, 우하단 채팅 버튼 안내).

### P3 — 보조
- 채팅·알림·캘린더를 pitch 02·04 섹션과 144행 D1 표에 한 줄씩. 신뢰 원칙(11 섹션)에 SSRF 차단·승인 강제·워크플로우 실행 한도.
- README.md 시크릿 표(GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET), 배포 리소스(DO 마이그레이션 태그 v1~v3, 크론 3개), 210행 "작업 VM에서 workers.dev에 접속할 수 없음" 문구 삭제(지금은 접속됨), 36행 행 번호 수정.
- 비밀번호 토글·좁은 화면 로그아웃·그룹 자동 이름은 문서에 넣지 않아도 된다 (README 기능 목록에 반 줄로 넣어도 된다).
- **소개 탭** (`public/index.html` 453~519행): "무엇을 할 수 있나요"(481~494행)에 워크플로우·캘린더·조직관리·채팅을 추가한다. 477행 "AI는 메일 답장 초안까지만 씁니다"는 워크플로우 승인 발송과 어긋나므로 고친다 (예: "밖으로 나가는 메일·웹훅은 사람이 승인해야 나갑니다").

## 주의
- **속도 수치 금지**: reasoning low/medium 미결이라 LLM 시간·"빠르다" 같은 표현을 문서·대본에 적지 않는다.
- `public/pitch.html`은 껍데기다. 본문은 `public/pitch-content.html`을 고친다.
- `architecture.svg`, `ARCHITECTURE.md`, `VERIFICATION.md`는 이번에 안 고친다.

## 검증
- `npx tsc --noEmit` 통과 (문서만 고쳤으면 영향 없음 — 그래도 확인).
- 수정한 HTML이 깨지지 않는지 확인한다 (`public/pitch-content.html`은 정적 HTML, `pitch.js`가 data-nav·data-key로 목차를 만드니 섹션 추가 시 속성 확인).
- 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록할 것.
- 배포 후 라이브에서 `/pitch-content.html`에 "워크플로우", "qwen3.8", "캘린더"가 들어갔는지 curl로 확인한다.

## GitHub 푸시 (문서 반영까지 끝난 뒤)
- 전체 스냅샷을 `workspace-easyware/people-os`에 푸시한다. 절차는 `/opt/hatch/connectors/github/references/snapshot-push.md`를 따른다 (배치로 나눌 것, 삭제·바이너리 불가).
- **루트 `architecture.svg` GitHub 사본은 스냅샷 도구로 삭제 불가** — 이번엔 푸시만 하고 삭제는 안 한다 (11-26 공개 전환 전 별도 삭제).
- 푸시 전 `git status` 성격의 변경 목록을 확인하고, 이번 스냅샷에 들어갈 변경분(워크플로우 빌더·DO·채팅·모델 교체·문서 반영)이 모두 포함됐는지 확인한다.
- 최종 head 커밋을 보고한다.

## 산출물
- 검증 산출물을 `files/workflow-verify/pitch-update/RESULT.md`에 작성할 것.
- 진행 기록 `files/people-os/workflow-agent-builder-PROGRESS.md`에 "소개·발표자료·데모 반영 + GitHub 푸시" 항목을 추가할 것.

## 보고 형식 (최종 응답)
- 배포 버전 ID:
- 고친 문서 (pitch-content.html / README.md / DEMO-SCRIPT.md / 소개 탭) + 핵심 변경 요약.
- 라이브 확인 (`/pitch-content.html`에 "워크플로우"·"qwen3.8"·"캘린더" 포함 여부).
- GitHub 푸시: 최종 head 커밋 (해시 + 메시지), 푸시한 배치 수.
- 미반영 항목 (있으면 정직하게 — 예: architecture.svg·ARCHITECTURE.md·VERIFICATION.md는 이번 범위 밖).
