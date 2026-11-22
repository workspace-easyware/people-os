# AI 지시 Queue 이동 — Word 생성·편집의 느린 AI 경로를 Queue로 (2026-11-22, Fable 5.2)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `2e83ebca`, 문서 편집 Worker `1dd93ed7`. 커밋 HEAD `53b6434` (태그 `docx-create-ext-v1`).
- 모델: Fable 5.2 (이 세션은 Fable 5.2 하나로 끝까지 — 중간에 모델 바꾸지 말 것).
- 먼저 `~/AGENTS.md`를 읽을 것 — 검증된 운용 교훈(권한 규칙, 라이브 호출 방법, 배포 주의)이 들어 있다. 특히:
  - 라이브 HTTP 검증은 `--add-dir ~/workspace/user`(시크릿 읽기)와 `Bash(curl *peopleos.site*)` 규칙이 있어야 한다.
  - `peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다 — 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다.
  - 배포 뒤 약 2분은 옛 버전이 응답한다 — 스모크는 3분 뒤에 할 것.
  - 배포는 직렬로 (동시 배포 금지). `cf-wrangler.py deploy`가 승인 대기로 막히면 우회하지 말고 보고만 하고 멈출 것.
  - `git add`·커밋·태그는 Merlin이 직접 한다 — 세션은 커밋하지 말 것.
  - 문서(ARCHITECTURE.md·VERIFICATION.md)는 건드리지 말 것 — Merlin이 따로 갱신한다.
- `npx tsc --noEmit` 0건, 바뀐 화면 JS는 `node --check` 통과가 매 단계의 조건이다.

## 문제 (실측)

- Word 새로 만들기(`POST /api/docx/create`, 자연어 `instruction`)의 AI 경로가 느리다: 생성 1회 약 56초, 재시도 시 112초. 2026-11-22에는 **첫 호출이 122초 뒤 Workers AI `3046 Request timeout`으로 502**가 났고 같은 요청을 다시 보내 성공했다. 지시 생성 시간은 배포 전 13.9초에서 배포 후 62~72초로도 쟀다 (Workers AI 응답 시간 변동이 크다).
- Word 기존 파일 편집(`POST /api/docx/edit`, 자연어 지시)도 1건 실측 71초 (거의 전부 Qwen 응답 시간).
- 지금은 브라우저가 HTTP 요청을 끝까지 붙잡고 기다린다. 길어지면 타임아웃·502가 나고 사용자는 결과를 모른다.
- 구조화 입력(지시 없이 정의만 주는 경우)은 수십 ms~수 초라 Queue가 필요 없다. **Queue로 옮기는 것은 AI 지시 경로뿐이다.**

## 과제

### 설계 (먼저 정한다)

- 요청을 받으면 Qwen 호출을 하지 않고 Queue에 일을 넣고 바로 돌려준다 (202 + 작업 id). 사용자는 작업 상태를 물어보고 (폴링), 끝나면 만든 문서를 받는다.
- 대상: `docx_create`의 AI 지시 경로 + `docx_edit`의 AI 지시 경로. 둘 다 같은 패턴으로 옮긴다. PPTX·XLSX 지시 경로(11초·16.5초)는 이번 범위 밖이다.
- Queue는 이미 있는 것을 재사용한다 — Queues `people-os-pipeline` + DLQ, 그리고 전사·워크플로우에서 쓰는 소비자 패턴을 보고 따른다. 새 Queue가 필요하면 `wrangler.toml`에 추가하고 이유를 적는다.
- 소비자(Queue handler)에서 하는 일: Qwen 계획 호출 (기존 보정 2종 + 1회 재시도 패턴 그대로) → 문서 생성/편집 → `documents` 새 행 + R2 저장. 실패하면 상태를 실패로 남기고, 재시도 정책(Queue 재시도 vs 코드 내 1회 재시도)이 겹쳐 두 번 만들지 않게 멱등성을 둔다 (작업 id 기준).
- 상태 저장: 작업 상태를 D1에 둔다 (새 테이블이 필요하면 마이그레이션을 만들고 번호를 이어간다 — 현재 0042까지 있음. `migrations list --remote`로 먼저 확인하고, out-of-band 적용된 전례가 있어 `d1 execute --remote --file` + `d1_migrations` 기록 방식을 쓴다). 상태는 최소 `queued` → `running` → `done`/`failed`, 실패 사유(한국어), 만든 문서 id를 담는다.
- 클라이언트: UI("새 Word 문서 만들기" 화면, Word 편집 화면)가 202를 받으면 "AI가 만들고 있어요" 표시 + 폴링으로 상태를 보고, 끝나면 문서 목록을 갱신한다. 폴링 간격은 2초 안팎으로 한다 (에이전트 화면의 SSE 폴백 폴링과 같은 수준).
- 워크플로 `docx_create`·`docx_edit` 노드의 지시 경로도 Queue를 타게 할지는 설계에서 판단한다 — 노드는 이미 Queue(단계마다 메시지 1개)로 도는 구조라, 노드 안에서 동기식 Qwen 호출이 길어지는 문제도 같이 본다. 바꾸면 워크플로 로컬 검증까지 한다.

### 검증

- 로컬: 지시 요청 → 202 + 작업 id → 폴링 → done → 문서 확인. 실패 경로(못 만드는 지시)도 failed로 남는지 확인. 구조화 입력은 Queue를 안 타고 바로 201이 되는지 확인 (회귀).
- 라이브: 지시 1건 이상을 끝까지 돌려 문서가 만들어지는지, 폴링이 done을 받는지, 타임아웃·502가 안 나는지 확인한다. 기존 엔드포인트 스모크 (`/api/health`·익명 `/api/auth/me` 401·기존 docx 생성 1건)가 이전과 동일한지 확인한다.
- 임시 시험 계정·문서는 전부 정리하고 0건임을 재확인한다 (`doc_nodes`까지).

## 공통 규칙

- 배포는 직렬로. GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 이 과제 밖의 기능은 건드리지 않는다.
- `npm install`은 레포 루트에서 `--legacy-peer-deps`가 필요하다 (peer 충돌).

## 보고 (마지막에 `files/workflow-verify/docx-ai-queue/RESULT.md`에 쓴다)

- 설계 (Queue 이름·상태 테이블·폴링 방식·멱등성·재시도 정책) + 바뀐 파일, 배포한 버전 ID, D1 마이그레이션 번호.
- 라이브 검증 결과 (엔드포인트·상태·걸린 시간·확인한 값), 임시 데이터 정리 확인.
- 남은 문제·미확인 항목이 있으면 솔직히 적는다 (특히: Queue 소비자에서의 Qwen 호출 시간 상한, 실패 시 사용자에게 보이는 문구).
