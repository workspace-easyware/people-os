# Fable 5.2 자문 — easy-ware 그룹웨어·결재 분석 + People OS 적용 계획

## 너의 역할
너는 아키텍처 자문이다. 코드를 읽고 분석해서 **계획**을 세우는 것이 임무다. 코드를 수정하거나 배포하지 마라. 결과물은 계획 문서 1개다.

## 배경
- **People OS**는 Cloudflare Workers 위의 HR·코칭 인텔리전스 플랫폼이다. 스택: Workers + D1 + R2 + KV + Vectorize + Workers AI(Qwen3 답변, Clef 판단, bge-m3 임베딩, Whisper 전사) + Durable Objects(세션) + Queues. Free 플랜. 도메인 peopleos.site. 로그인(PBKDF2+페퍼, hr_admin/user 역할, coach/coachee 구분), 개인 RAG 격리(owner_id), 메일함(Resend 발송)이 있다. 메뉴: 홈, 메일함, 할 일, 녹음전사.문서저장, 코칭 리플렉션, 개인 업무 검색, HR 규정 검색, 라이브러리, 관측·평가, 사용자 관리, 소개.
- 사용자는 기존 **JAVA 그룹웨어(easy-ware, 결재 기능 포함)**와 **공통 코드(easy-standards)**를 People OS에 적용하고 싶어한다. 또 유튜브 큐레이션 기반의 간단한 LMS도 검토 중이다.
- 로컬 People OS 코드: 이 작업 디렉터리의 `files/people-os/` (src/, public/, migrations/, wrangler.toml, README 등).

## 분석 대상 (GitHub MCP CLI로 읽는다)
GitHub CLI 사용법 (Bash 허용 규칙 있음):
```
/opt/hatch/bin/github call-read-tool --name get_file_contents --arguments-json '{"owner": "<owner>", "repo": "<repo>", "path": "<path>"}'
```
- 디렉터리 path를 주면 목록을, 파일 path를 주면 내용을 반환한다.
- `search_code`는 이 비공개 저장소들에서 0건을 반환한다 (인덱스가 안 먹음). **반드시 get_file_contents로 디렉터리를 훑고 핵심 파일을 직접 읽어라.**
- 계정: `Junhokang452` 저장소는 `--account 2cede6c0f14046d2bfdd1616a240a310` 플래그를 붙인다. `workspace-easyware` 저장소는 기본 계정이라 플래그 없이 호출한다.

### 1. Junhokang452/easy-ware (JAVA 그룹웨어 + 결재)
- 루트 구조: backend, frontend, lib, supabase, docs, deploy, CLAUDE.md, README.md, Dockerfile, .gitmodules.
- 읽을 것: CLAUDE.md, README.md, backend 구조(결재 도메인·스키마·API·상태 전이), frontend 결재 UI, supabase 스키마(결재 관련 테이블).
- 파악할 것: 결재 프로세스(기안→결재선→승인/반려→시행), 결재선 지정 방식, 상태 전이 규칙, 알림, 결재 외 그룹웨어 기능(전자결재 외에 뭐가 있나 — 일정, 게시판, 조직도, 휴가 등).

### 2. Junhokang452/easy-standards (공통 코드)
- 루트 구조: easy-platform-core, easy-standards, packages, scripts, settings.gradle.kts, package.json, docker-compose.yml.
- 읽을 것: README.md, easy-platform-core와 easy-standards의 구조, packages 목록.
- 파악할 것: 공통 코드의 범위(인증, 권한, 감사, 공통 UI 컴포넌트 등), People OS에 가져올 만한 것이 있는지, JAVA/Gradle 기반이라 Workers(TS) 환경에 직접 이식은 안 되므로 **개념·규칙·스키마 수준에서 무엇을 재사용할 수 있는지**.

### 3. workspace-easyware Sites 저장소 (유튜브 큐레이션 패턴 — LMS용)
- 대상: talent-navigator, easy-slides, flowdesk-cloud, ileet (기본 계정, 플래그 없음).
- 각 저장소 루트와 src 구조를 훑고, 유튜브 관련 코드(임베드, 영상 목록, 큐레이션, 썸네일, 재생)를 찾아라. 파일명에 youtube/embed/video가 있거나, 소스에서 youtube.com/embed, youtu.be, iframe을 쓰는 곳을 찾아라.
- 파악할 것: 어떤 저장소에 유튜브 큐레이션 패턴이 있고, 그 패턴을 People OS LMS(과정·강의·진도)에 어떻게 가져올지.

## 참고할 Cloudflare 기능 (웹 검색 금지 — 아래 요약으로 판단)
### Cloudflare Workflows (GA, durable execution)
- `step.waitForEvent()`로 사람이 승인·반려할 때까지 워크플로우 인스턴스를 멈추는 것이 공식 패턴 ("Human-in-the-Loop Image Tagging with waitForEvent").
- Free 플랜 가능: 하루 3,000스텝, 요청 하루 100,000건, CPU 10ms/호출, 저장소 1GB-월. Paid: 월 500,000스텝 포함 + 초과 100,000스�eps당 $0.80.
- **주의: 대기 중 인스턴스 상태 보관 기간 Free 3일, Paid 7일** — 결재자가 3일 넘게 안 보면 대기 워크플로우가 사라질 수 있다.
- Agents SDK에는 `waitForApproval`/`approveWorkflow`도 있다.

### Cloudflare OS (github.com/cloudflare/cloudflare-os)
- 오픈소스 에이전트 워크스페이스. Gatekeeper가 부작용 있는 행동을 나중에 승인할 수 있게 큐에 쌓는 "deferred approval"이 있다.
- 단 Dynamic Worker 때문에 Workers Paid($5/월) 필요. 결재만 떼어 쓰기엔 덩치가 크다 — 참고용.

## 산출물
**`files/people-os/groupware-approval-plan.md`** (한국어) — 아래 목차로 작성한다:
1. easy-ware 분석 요약 (결재 프로세스, 결재선, 상태 전이, 스키마, 결재 외 그룹웨어 기능 목록)
2. easy-standards 분석 요약 (공통 코드 범위, People OS에 개념적으로 재사용 가능한 것)
3. People OS에 적용할 그룹웨어 기능 후보 (우선순위 순 — 결재 포함, 각 기능마다 easy-ware의 무엇에서 왔는지 명시)
4. 결재 구현 방식 비교 (① Workflows waitForEvent ② D1 테이블+API+UI 경량 방식 ③ Cloudflare OS Gatekeeper 참고) — 장단점, 비용(Free 한도 포함), 3일 대기 소멸 리스크 대응, 추천안
5. LMS(유튜브 큐레이션 + R2 영상) 적용안 — Sites 저장소에서 찾은 패턴 명시, D1 스키마(과정/강의/진도) 초안, R2 Range 스트리밍 vs Stream 비교 한 줄 요약
6. People OS UI 변경안 (메뉴 순서, 새 탭/카드, 결재함·강의실 위치 — 현재 메뉴 순서: 홈, 메일함, 할 일, 녹음전사.문서저장, 코칭 리플렉션, 개인 업무 검색, HR 규정 검색, 라이브러리, 관측·평가, 사용자 관리, 소개)
7. 단계별 실행 계획 (공모전 제출 11-27 마감 이후를 전제로 — 11-25 기능 동결이므로 결재·LMS는 제출 후 작업. 1단계/2단계/3단계로 나눔)
8. 열린 질문 (사용자 결정이 필요한 것 — 예: 결재 대상 문서 종류, 결재선 지정 주체, LMS 수강 대상)

## 제약
- 코드는 읽되 수정하지 마라. 배포하지 마라. D1/R2 등 운영 리소스에 쓰지 마라.
- 추측하지 마라. 파일에서 확인한 것만 근거로 쓴다. 못 찾은 것은 "확인 안 됨"으로 명시한다.
- 계획 문서가 완성되면 최종 보고에 문서 경로와 핵심 결론(추천 결재 방식, 우선순위 1위 기능, LMS 적용안 한 줄)을 요약해라.
