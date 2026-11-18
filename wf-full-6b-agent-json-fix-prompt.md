# WF-6b 프롬프트 — 에이전트 JSON 파싱 실패 수정 (D-2 라이브 검증에서 발견)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-FULL-PLAN.md` §2 WF-6행 + `src/workflow/agent-do.ts` + `src/workflow/nodes.ts`(`extractJson`) + 검증 문서 `files/workflow-verify/wf6/RESULT.md` (특히 "설계 메모"와 "미검증" — 실제 Qwen3 JSON 파싱률이 미검증이었다).
> 모델: Sonnet. 이 세션은 **에이전트 JSON 파싱 실패 수정만** 한다. 다른 기능(조건 분기·스케줄·공유·캔버스·관측)은 **하지 않는다**. D1 마이그레이션 파일을 만들지 않는다. **배포하지 않는다** — 코디네이터가 D-2b로 배포·라이브 재검증을 한다.
> **주의: `src/workflow/agent-do.ts`만 고친다** (필요하면 `src/workflow/nodes.ts`의 `extractJson`도 최소한으로). `src/index.ts`·`engine.ts`·다른 노드는 건드리지 않는다.

## 배경 — 라이브에서 재현된 실패 (D-2, 2026-11-18)

- 에이전트 워크플로우(목표: "할 일 1개를 만들어줘. 제목은 '[테스트] 에이전트 할 일', 기한은 2026-11-30으로 해줘.")를 라이브에서 2번 실행했는데, 2번 다 `failed`로 끝났다. 에러: `"에이전트 도구 선택 실패: 모델 응답 형식 오류가 3번 연속 발생했습니다."`
- 진단용 `llm` 노드로 같은 프롬프트를 Qwen3에 보내서 실제 출력을 확인했다. 모델이 돌려준 것:
  ```json
  {"thinking":"할 일을 생성하기 위해 create_task 도구를 사용합니다. 제목과 기한이 명시되어 있으므로 직접 할 일을 만들 수 있습니다.","action":"create_task","tool":"create_task","args":{"title":"[테스트] 에이전트 할 일","dueDate":"2026-11-30"},"final":"할 일 '[테스트] 에이전트 할 일'이 2026-11-30 기한으로 생성되었습니다."}
  ```
- **원인**: 모델이 `"action"`에 도구 이름(`"create_task"`)을 썼다. `parseDecision`은 `action`이 정확히 `"tool"` 또는 `"finish"`일 때만 받으므로, `"action": "create_task"`는 `"action이 올바르지 않습니다: create_task"` 오류가 된다. 프롬프트의 형식 예시(`"action": "tool" 또는 "finish"`)가 모호하다 — 모델은 `action`을 "할 행동"으로 읽고 구체적인 도구 이름을 쓴다. 첫 번째 라이브 실행(목표에 기한이 없어서 모델이 `finish`를 골랐다)은 `"finish"`라서 통과했다. 즉, **도구를 고를 때만** 이 실패가 난다.
- WF-6 하네스는 스크립트 응답(mock)으로만 시험해서 이 문제를 못 잡았다. 이번 수정은 실제 모델 출력에 맞춰 파서를 고치는 것이 핵심이다.

## 할 일

### 1. 파서 관용성 (`parseDecision`, `src/workflow/agent-do.ts`)

- `j.action`이 허용된 도구 목록(`tools`)에 있는 **도구 이름**이면, `action: "tool"`로 받아들인다. 도구 이름은 `j.tool`이 유효한 도구 이름이면 그것을 쓰고, `j.tool`이 없거나 유효하지 않으면 `j.action`을 도구 이름으로 쓴다. `args`는 기존과 같은 규칙으로 읽는다.
- `j.action`이 `"tool"`이면 기존 동작 그대로 (`j.tool`이 유효한 도구 이름이어야 한다).
- `j.action`이 `"finish"`이면 기존 동작 그대로 (`final` 비어 있으면 오류).
- 그 밖의 값이면 기존 오류 (`action이 올바르지 않습니다: ...`).
- **이 변경이 기존 유효 경로를 안 깨는지** 단위 테스트로 확인한다 (아래 검증 1번).

### 2. 프롬프트 명확화 (`SYSTEM_PROMPT`, `src/workflow/agent-do.ts`)

- `action` 필드에 대한 설명을 바꿔서, 모델이 도구 이름을 `action`에 쓰지 않게 한다. 다음을 모두 넣는다:
  - "`action` 필드에는 반드시 `\"tool\"` 또는 `\"finish\"` 중 하나만 쓴다. 도구 이름은 `action`이 아니라 `tool` 필드에 쓴다."
  - 도구를 고를 때의 **전체 JSON 예시 1개**: `{"thinking": "…", "action": "tool", "tool": "create_task", "args": {"title": "…", "dueDate": "…"}}`
  - 끝낼 때의 **전체 JSON 예시 1개**: `{"thinking": "…", "action": "finish", "final": "…"}`
- 기존 규칙 (a)~(e)는 그대로 둔다. 예시를 넣되 프롬프트가 너무 길어지지 않게 한다 (예시 2개만).

### 3. (선택, 파서가 1·2로 충분하면 하지 않는다) `extractJson` 강화

- `extractJson`(`src/workflow/nodes.ts`)가 첫 `{`부터 마지막 `}`까지 자르는 방식은, 모델이 JSON 앞뒤에 `{`·`}`를 포함한 설명을 붙이면 깨진다. 파서 수정(1번)으로 충분하면 `extractJson`은 건드리지 않는다. 건드려야 한다면, **가장 긴 유효 JSON 객체**를 찾는 방식으로만 바꾸고, 기존 호출처(`summarize`·`reflect_*`·`email_draft` 등)의 동작이 바뀌지 않는지 확인한다. 이 판단과 결과를 RESULT.md에 적는다.

## 검증 (반드시 `files/workflow-verify/wf6b/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf6b/`)

- `npx tsc --noEmit` 통과.
- **회귀 테스트 (필수)**: 위 "배경"에 있는 실제 실패 출력(진단용 llm이 받은 JSON — `"action": "create_task"`)을 `parseDecision`에 넣어 **도구 호출로 파싱되는지** 확인한다. 이 케이스를 하네스에 고정 테스트로 남긴다 (다시는 이 형태로 안 깨지게).
- **기존 케이스**: `"action": "tool"` + 유효한 `tool`, `"action": "finish"` + `final`, `"action": "없는도구"`, `"action": "tool"` + `tool` 누락, JSON 파싱 불가(앞뒤 잡문자) — 각각 기존과 같은 결과가 나오는지 확인한다.
- **WF-6 하네스 재실행**: `files/workflow-verify/wf6/`의 하네스를 그대로 다시 돌려서 52개 테스트가 여전히 통과하는지 확인한다 (프롬프트·파서 변경이 기존 동작을 안 깨는지). 하네스를 새로 짜지 말고 WF-6 것을 재사용한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 Qwen3의 JSON 준수율 — 이번 수정으로 좋아졌는지 라이브 재검증이 필요함, 배포·원격 D1, 브라우저 화면).
- PROGRESS.md에 WF-6b 항목을 추가한다 (원인·수정·검증 결과·D-2b에서 할 일).

## 금지

- `src/index.ts`·`engine.ts`·다른 노드를 건드리지 않는다. D1 마이그레이션 파일을 만들지 않는다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 코드 실행 노드를 만들지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
