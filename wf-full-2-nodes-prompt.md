# WF-2 프롬프트 — 노드 레지스트리 (12개 노드)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.1.4 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-2행 + WF-1 산출물(`src/workflow/types.ts`, `src/workflow/store.ts`, `src/workflow/routes.ts`)을 먼저 읽을 것. WF-1의 타입(`NodeContext`, `NodeResult`, `NODE_TYPES`, `resolveVars`, `ApprovalRequest`)을 그대로 쓴다. 타입이 부족하면 `types.ts`를 최소한으로 확장해도 된다 (기존 export는 바꾸지 않는다).
> 모델: Sonnet. 이 세션은 노드 구현만 한다. 실행 엔진(WF-3), 승인 게이트 API(WF-4), UI(WF-5)는 **하지 않는다**. 라우트·마이그레이션도 추가하지 않는다.

## 목표

12개 노드를 `src/workflow/nodes.ts`의 레지스트리로 구현한다. 각 노드는 이미 있는 People OS 함수를 감싼 것이다. 새로 AI를 만드는 게 아니다. WF-3 엔진이 이 레지스트리를 불러서 단계를 실행한다.

## 할 일

### 1. 레지스트리 `src/workflow/nodes.ts`

```ts
export type NodeExecutor = (ctx: NodeContext, config: Record<string, unknown>) => Promise<NodeResult>;
export const NODE_REGISTRY: Record<NodeType, { execute: NodeExecutor; description: string; inputKeys: string[]; outputKeys: string[] }> = { ... };
export async function executeNode(type: NodeType, ctx: NodeContext, rawConfig: Record<string, unknown>): Promise<NodeResult> {
  // 1. rawConfig를 resolveVars로 치환한다 (vars = { input: ctx.input, steps: ctx.stepOutputs }).
  // 2. 레지스트리에서 executor를 찾아 실행한다. 없는 타입이면 { status:'failed', error }.
  // 3. executor가 던진 예외는 잡아서 { status:'failed', error: 메시지 }로 바꾼다 (throw하지 않는다 — 엔진이 실패를 기록하게).
}
```

- `NodeContext`는 WF-1 타입 그대로 쓴다. `ctx.stepOutputs`는 앞 단계의 출력이다 (`{ <stepId>: <output> }` 형태). `resolveVars`는 `{{input.x}}`와 `{{steps.<id>.output.y}}`를 푼다.
- 모든 노드는 **실행한 사람의 권한**으로 돈다. `ask_personal`은 `ctx.user.id`의 개인 문서만 본다. `runAsk`의 pool 필터가 서버에서 강제하는지 확인하고, 아니면 노드 안에서 owner를 명시적으로 넘긴다.
- 노드 출력은 JSON 직렬화 가능해야 한다 (D1 `workflow_run_steps.output_json`에 저장된다). `undefined`·함수·순환 참조를 출력에 넣지 않는다.

### 2. 노드 12개 (재사용 지점 — 파일을 열어 확인할 것)

| 노드 | 재사용 | 입력(config) → 출력 |
|---|---|---|
| `ask_rag` | `runAsk(env, input, {pool:'shared'})` — `src/ask-pipeline.ts:525` | `{question}` → `{answer, sources}` (답 + 근거 목록, 근거는 최대 5개로 줄여서 저장) |
| `ask_personal` | `runAsk(env, input, {pool:'personal'})` | `{question}` → `{answer, sources}` |
| `transcribe` | 전사 완료 여부 조회 (recordings/documents) | `{docId? \| recordingId?}` → `{docId, title}`. **이미 전사 완료된 것만 동기 처리한다. 미완료면 실패 + 안내 문구("전사가 아직 끝나지 않았습니다. 전사가 끝난 뒤 다시 실행하세요")를 error에 넣는다.** 큐에 넣고 기다리는 비동기 대기는 이번에 만들지 않는다 (FULL-PLAN §1 결정). |
| `summarize` | `summarizeDocument(env, docId)` — `src/index.ts:669` | `{docId}` → `{summary: string[], actions: string[]}` |
| `reflect_coach` | POST `/api/coaching/reflect` 로직 — `src/index.ts:1206` | `{docId \| transcript}` → 코치 모드 리플렉션(핵심 질문·패턴·다음 질문). 라우트 핸들러 안에 묵혀 있으면 내부 함수로 추출해 재사용한다 (라우트 동작은 바꾸지 않는다). |
| `reflect_coachee` | 같은 로직의 코칭 대상 모드 | `{docId \| transcript}` → 성찰 포인트 + 기한 있는 액션 플랜 |
| `draft_pptx` | pptxgenjs 덱 생성 — `src/index.ts:394` 부근, decks INSERT (`src/index.ts:1401` 부근) | `{title, bullets?: string[]}` (bullets가 없으면 앞 단계 출력에서 요약을 가져온다) → `{deckId, title, slides}`. R2 `decks/<id>.pptx`에 저장하고 decks 행을 만든다. owner_id는 `ctx.user.id`. |
| `email_draft` | 메일 답장 초안 패턴 — `src/index.ts:1842` (`draftEmailReply`) | `{to, context}` → `{draft}` (저장만, 발송 안 함). 초안은 `emails` 테이블에 초안 상태로 저장하는 것이 아니라, 노드 출력으로만 돌려준다 (저장은 나중에 `send_email` 승인 흐름에서). |
| `send_email` | `sendEmail(env, {...})` — `src/email/send.ts:25` (Resend) | `{to, subject, body}` → `{providerId}`. **안전장치: `ctx.approved`가 true가 아니면 실행하지 않고 `{status:'waiting_approval'}`를 돌려준다.** (`NodeContext`에 `approved?: boolean`을 추가한다 — WF-1 타입 확장.) `send_email` 노드는 WF-1 검증에서 `requiresApproval:true`가 강제된다. |
| `create_task` | POST `/api/tasks` 로직 — `src/index.ts:1346` | `{title, dueDate?}` → `{taskId}`. owner_id는 `ctx.user.id`. |
| `llm` | `env.AI.run(Qwen3)` — ask-pipeline의 모델 상수 재사용 | `{prompt}` (템플릿 + 변수 치환済) → `{text}`. 프롬프트가 비어 있으면 실패. 최대 출력 길이는 기존 ask와 같은 상한을 쓴다. |
| `create_calendar_event` | 캘린더 C1 생성 — `src/calendar/routes.ts`의 POST `/events` 로직 | `{title, start, end, allDay?}` → `{eventId}`. owner_id는 `ctx.user.id`. C1의 검증(최대 31일, 종일 일정 KST 자정 등)을 그대로 따른다. |

- `ask_rag`·`ask_personal`은 `runAsk`의 전체 결과에서 답·근거·grounded 여부만 뽑아 출력에 넣는다 (trace 기록 등 부수 효과는 `runAsk`가 이미 하므로 그대로 둔다).
- `reflect_*`는 `docId`가 오면 문서 본문을 D1에서 읽어 전사본 텍스트를 만든다. 문서가 없거나 타인 소유면 실패 (404相当, error에 이유).
- `draft_pptx`·`create_task`·`create_calendar_event`·`send_email`은 DB/R2에 쓰는 노드라, owner_id를 반드시 `ctx.user.id`로 박는다. config에서 owner를 받아서 쓰지 않는다.

## 제약

- WF-1 파일의 export 이름·동작을 바꾸지 않는다 (확장만, `approved?` 필드 추가 허용).
- 새 마이그레이션·라우트·UI를 만들지 않는다. `src/index.ts`는 건드리지 않는다 (reflect 로직 추출 시에도 라우트 동작이 바뀌지 않게 주의 — 추출한 함수는 같은 파일 안에서 export하거나 `src/workflow/`로 옮기되, 라우트가 기존과 동일하게 동작하는지 tsc + 하네스로 확인한다).
- 비밀번호·토큰·시크릿을 파일에 쓰지 않는다.

## 검증 (반드시 수행하고 결과를 기록할 것)

1. `npx tsc --noEmit` 통과.
2. 단위 하네스 (`files/workflow-verify/wf2/` 아래에 스크립트 + `RESULT.md`): 노드별로 실행 가능한 것을 직접 확인한다.
   - 순수 로직: `resolveVars` 중첩 경로·없는 경로·배열 치환, `executeNode` 없는 타입 실패, executor 예외 → failed 변환.
   - 로컬 D1이 필요한 것: `create_task`, `create_calendar_event`는 테스트 사용자로 실행해 행이 생기고 owner_id가 실행자인지 확인한다.
   - AI가 필요한 것(`ask_*`, `summarize`, `reflect_*`, `llm`, `draft_pptx`는 요약 텍스트만): 로컬 `wrangler dev --local`에서 Workers AI가 안 되면 mock `env.AI`를 주입해 호출 형태(모델·입력)까지만 검증하고, "실제 AI 호출은 미검증"이라고 RESULT.md에 정직하게 적는다. (이전 세션처럼 `wrangler dev`가 포트를 잡고 있으면 `ss`로 pid를 확인해 kill한다. `pkill -f`는 쓰지 않는다 — 자기 셸을 죽인다.)
   - `send_email`: `approved`가 false면 발송하지 않고 `waiting_approval`을 돌려주는지 확인한다 (실제 발송은 하지 않는다 — RESEND_API_KEY를 쓰지 않는다).
   - `transcribe`: 완료된 문서 → 성공, 미완료 → 실패 + 안내 문구.
3. 하네스 마지막에 테스트 데이터(생성한 할 일·일정·덱)를 정리한다.

## 산출물

- `src/workflow/nodes.ts` (레지스트리 + 12개 노드)
- 필요 시 `src/workflow/types.ts` 최소 확장 (`approved?` 필드)
- `files/workflow-verify/wf2/RESULT.md` (검증 결과 + 미검증 항목 명시)

마지막에 무엇을 만들었고, 무엇을 검증했고(통과 수), 미검증 항목이 무엇인지 요약해서 보고할 것.
