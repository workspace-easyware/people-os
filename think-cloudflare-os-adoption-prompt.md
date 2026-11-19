# Project Think + Cloudflare OS 도입 계획 — People OS 에이전트 강화

사용자가 People OS의 에이전트 부분을 Project Think와 Cloudflare OS로 보강하라고 했다. 매력적이면 기존 코드 아키텍처를 전면 수정해도 된다고 했다. 공모전까지 시간이 충분하고 코드 베이스가 있으니 Fable과 작업하면 빠른 시간 안에 구축 가능하다고 본다. 이 세션은 **도입 계획만** 수립한다. 코드는 고치지 않는다.

## 배경 (People OS 현재 상태)

- 스택: React + TypeScript 프런트, Cloudflare Workers 백엔드, D1 + R2 + KV + Vectorize + Durable Objects + Queues + Workers AI. 단일 도메인 peopleos.site.
- 에이전트·워크플로 빌더 (WF-1~WF-12, 2026-11-18 완료·라이브): 워크플로 정의는 D1 JSON, 실행은 Queues(단계마다 메시지 1개), 노드 15종(전사·요약·RAG 질문·메일 발송·할 일 생성 등), 승인 게이트(동기식 — 승인될 때까지 멈춤), 에이전트 루프는 ReAct 방식(WorkflowAgent Durable Object, 도구 하나씩 호출), 템플릿 5개(회의 자동화·휴가 승인·주간 보고·신입 온보딩·지출 결재). 실행 한도: 동시 3·하루 20·run당 30분·에이전트 최대 10스텝.
- 판단 모델 4층: 판정 앙상블(Clef + clef-omni), 의도 라우터, 근거 재순위, 토픽 가드. 관측·평가(S4): 트레이스·골든셋 평가·갭.
- 접근 제어: 역할 기반(hr_admin / user, coaching_role coach / coachee) + 개인 RAG owner_id 격리. 워크플로 승인 게이트는 동기식이다.
- 공모전 일정: 기능 동결 2026-11-25(수), 데모 영상·레포 공개 11-26(목), 제출 2026-11-27(금). 오늘이 2026-11-19(수)이다.
- 현재 진행 중인 별도 작업: XAI 4가지 기능 구현(Opus 세션, 별도 진행 중), 화상회의 계획(Fable 세션, 별도 진행 중). 이 계획 세션은 그 코드와 겹치지 않게 계획 문서만 쓴다.

## 참고 자료 (사용자가 제공)

### Project Think (Cloudflare Agents SDK 새 기본 요소)
- 출처: https://blog.cloudflare.com/ko-kr/project-think
- 내용: 장기 실행 에이전트용 기본 클래스. 파이버(runFiber, 충돌 복구·체크포인트·자동 Keepalive), 하위 에이전트(Facets, 각자 격리된 SQLite·유형 RPC), 영구 세션(트리 구조 메시지·분기·압축·FTS5 전체 텍스트 검색), 샌드박스 코드 실행(Dynamic Workers, Code Mode, 런타임 npm 확인), 실행 래더(Workspace → Dynamic Worker → npm → 브라우저 → 샌드박스), 자체 작성 확장(런타임에 자체 도구 작성).
- Think 기본 클래스(`@cloudflare/think`): 에이전트 루프·메시지 지속성·스트리밍·도구 실행·스트림 재개를 처리하는 독단적 도구 모음. getModel()·getSystemPrompt()·getTools()·maxSteps·configureSession() 재정의. 컨텍스트 블록(영구 메모리), 비파괴 압축, FTS5 검색 내장.
- Code Mode(`@cloudflare/codemode`): 도구 하나씩 호출 대신 LLM이 도구를 호출하는 코드를 짜서 한 번에 실행. 토큰 대폭 절감(Cloudflare API MCP 서버 사례: 117만 토큰 → 1,000 토큰, 99.9% 감소).

### Cloudflare OS (오픈소스, Apache 2.0)
- 출처: https://github.com/cloudflare/cloudflare-os (11,827 스타, 1,470 포크, v2 전면 재작성, early access — README에 "heavy development, rough edges" 경고 있음)
- 내용: 회사 맥락·스킬 위에서 돌아가는 에이전트 워크스페이스(브라우저 채팅 UI), 샌드박스 앱 개발(가젯), Gatekeeper 보안 프레임워크.
- 가젯(Gadget): 파일 하나가 그 자체로 풀스택 앱(클라이언트 + 서버 + API + 지속 상태). Dynamic Worker + Durable Object Facet(자체 SQLite). 기본 비공개, 공유 가능. 블루프린트(템플릿) 공유 시 코드만 가져가고 데이터·자격 증명은 안 가져감.
- 게이트키퍼(Gatekeeper): 능력 기반 보안. 에이전트·앱은 아무 권한 없이 시작, 사용자가 자원을 하나씩 소개해야 쓸 수 있음. 타입 붙은 바인딩(Typed Binding)으로 자격 증명 격리. 읽기(Read)와 행동(Action) 경로 분리. 행동은 정책 집행·결과 시뮬레이션·승인 대기열. **핵심: 승인 필요한 동작을 로컬에서 시뮬레이션해서 에이전트에게 완료됐다고 알리고, 에이전트는 멈추지 않고 계속 일함. 사용자는 나중에 쌓인 동작을 한꺼번에 승인/거부.** 읽기는 승인 없이 제한된 자원만.
- 관찰 기록(Observation Log): 에이전트가 관찰한 모든 자원을 기록. 산출물에 붙어 다님. 다른 사람이 열면 게이트키퍼가 그 사람에게 관찰된 자원 각각에 대한 접근 권한이 있는지 검증. 민감 데이터 읽은 이력이 있으면 외부 쓰기·초대·위임 차단 가능.
- Cap'n Web: 객체 능력 기반 RPC. 클라이언트·서버·에이전트가 같은 API를 씀. MCP 서버를 별도로 만들 필요가 없음.
- Code Mode 에이전트: 코드 작성·실행으로 작업 수행.

## 계획에 담을 것

1. **도입 방식 결정**: Think 베이스 클래스 + Cloudflare OS 개념을 People OS에 어떻게 들여올지. 세 가지 선택지를 비교한다.
   - (a) 점진적 도입: 기존 WorkflowAgent·워크플로 엔진을 유지하고 Think/Cloudflare OS의 개별 요소만 붙인다 (예: Code Mode, 비동기 승인 시뮬레이션, 게이트키퍼식 권한).
   - (b) 전면 수정: 에이전트 런타임을 Think 베이스 클래스로 갈아타고, 워크플로 실행을 Fiber + 하위 에이전트로 재구성한다.
   - (c) 하이브리드: 에이전트 런타임만 Think로 바꾸고 워크플로 정의·UI는 유지한다.
   - 사용자가 전면 수정을 허용했으니 (b)도 진지하게 검토한다. 단, 11-25 동결·11-27 제출 일정을 고려해 현실적인 판단을 한다.
2. **요소별 적용 계획**: 아래 각 요소를 People OS의 어디에, 어떻게 붙일지 구체적으로 정한다.
   - Think 베이스 클래스 (WorkflowAgent DO 대체 여부)
   - Fiber 내구성 실행 (긴 에이전트 작업의 충돌 복구 — 현재 Queues 재시도와 비교)
   - 하위 에이전트 Facets (연구·검토 같은 역할 분담)
   - 영구 세션 (트리 메시지·분기·압축 — 현재 채팅·트레이스와 비교)
   - Code Mode (ReAct 도구 호출 → 코드 실행 전환, 토큰 절감 효과)
   - 실행 래더 (Workspace → Dynamic Worker → npm → 브라우저 → 샌드박스, 어디까지 쓸지)
   - 게이트키퍼 (능력 기반 보안 — 현재 역할 기반 + owner_id와 어떻게 맞물리는지)
   - 관찰 기록 (공유·접근 제어 — 현재 트레이스·owner_id와 비교)
   - 비동기 승인 + 시뮬레이션 (현재 동기식 승인 게이트를 어떻게 바꿀지 — 가장 값어치 있는 변화)
   - 가젯/블루프린트 (파일 하나가 앱 하나 — 현재 워크플로 템플릿과 비교, 어디까지 도입할지)
3. **일정·순서**: 11-25 동결까지 할 것과 공모전 뒤로 미룰 것을 나눈다. 사용자가 "시간이 충분하다"고 보지만, Fable이 코드 규모와 위험을 보고 현실적인 일정을 정한다. 전면 수정이 동결 전에 무리면, 동결 전에 할 수 있는 점진적 도입과 공모전 뒤 전면 수정을 분리한다.
4. **위험·열린 질문**: Cloudflare OS가 early access(rough edges)인 점, Think가 새 SDK라 API가 바뀔 수 있는 점, 기존 워크플로·채팅·관측 데이터와의 호환성, 마이그레이션 범위, 결정이 필요한 항목을 목록으로 적는다.

## 산출물

- 계획 문서: `files/people-os/think-cloudflare-os-adoption-plan.md`에 작성한다. 위 4가지를 모두 담고, 마지막에 "먼저 할 것 / 나중에 할 것"과 "사용자 결정이 필요한 것"을 분리해서 적는다.
- 코드는 일절 고치지 않는다. 마이그레이션·배포도 하지 않는다.
- Think와 Cloudflare OS의 공식 문서·저장소를 직접 확인해서 계획한다. 확인이 안 된 부분은 "미확인"이라고 명시하고 추정치를 만들지 않는다.
- 기존 People OS 코드를 직접 읽어보고(WorkflowAgent, 워크플로 엔진, 승인 게이트, 관측) 현재 구조와 어떻게 맞물리는지 정한다. 읽지 못한 부분은 명시한다.
