# WF-10 프롬프트 — 비주얼 캔버스 (노드 그래프 편집기)

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.2.4 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-10행 + WF-1~WF-9 산출물(`src/workflow/types.ts`의 정의 v2·`resolveNextStep`·`validateDefinition`, `public/workflow.js`의 `wfCur.steps`·`wfRenderSteps`·`wfRenderStepForm`·`wfSave`, `public/workflow.css`) + 검증 문서(`files/workflow-verify/wf7/RESULT.md`의 "알려진 한계" 2건이 이 세션에서 해결할 과제다).
> 모델: Opus. 이 세션은 **비주얼 캔버스 + WF-7 한계 2건 해결만** 만든다. 관측(WF-11)은 **하지 않는다**. **배포하지 않는다** — D-3 이후 배포는 WF-12 전 코디네이터가 묶어서 한다 (WF-10·WF-11 완료 후 D-3b로 한 번에 배포·라이브 검증한다).
> **원칙**: 캔버스와 폼 빌더는 **같은 정의 JSON**(`wfCur.steps`, `{version: 1, steps}`)을 공유한다. 캔버스는 편집 UI일 뿐, 저장·실행·승인·스케줄·공유 동작은 절대 바꾸지 않는다. 빌드 단계 없음 — 순수 SVG + 바닐라 JS, 외부 라이브러리·CDN 없음. 백엔드 변경은 아래 "분기 종료 표식"에 필요한 최소한(`types.ts`·엔진)으로만 한다.

## 목표

워크플로우를 목록이 아니라 그래프로 보고 편집할 수 있게 한다. 노드를 끌어다 놓고, 간선을 이어서 분기를 만들고, 경로를 중간에 끝낼 수 있게 한다. 이 세션이 끝나면 폼으로 만든 워크플로우를 캔버스로 열면 같은 그래프가 보이고, 캔버스에서 만든 분기·종료 표식을 저장하면 서버 검증이 통과하고, 실행하면 간선대로 돈다.

## 할 일

### 1. 분기 종료 표식 — WF-7 한계 (1) 해결 (`src/workflow/types.ts` + 엔진)

- **문제**: 지금은 배열 중간에서 경로를 끝낼 수단이 없다. 분기한 두 경로가 따로 끝나려면 마지막에 합류하는 단계가 필요했다.
- **해결 — `next: null`을 "여기서 종료"로 쓴다**:
  - 일반·agent 단계: `next?: string | null` — `null`이면 그 단계가 성공하면 run이 거기서 끝난다 (뒤 단계로 안 간다).
  - condition 단계: `next?: { true: string | null; false: string | null }` — 한쪽만 `null`일 수 있다 (`null`인 쪽은 그 분기가 거기서 끝난다). 둘 다 `null`이면 양쪽 다 거기서 끝난다.
  - `StepNext` 타입을 `string | null | { true: string | null; false: string | null }`로 넓힌다.
  - `validateDefinition`이 `null`을 받아들인다. condition의 `next`는 여전히 `{true, false}` 두 키가 다 있어야 한다 (값이 `null`인 것은 허용). `next`가 없는 단계는 지금처럼 배열 다음 단계로 간다 (v1 호환 유지).
  - `resolveNextStep`(엔진)이 `null`을 만나면 `{ kind: 'end' }`를 돌려준다 (배열 끝에 도달한 것과 같은 종료). condition에서 해당 branch가 `null`이면 그 branch는 종료다.
  - 엔진의 간선 추적·`stepOutputsBefore`·run 종료 처리는 `end`를 이미 알고 있으므로, `resolveNextStep`과 검증만 고치면 된다. 다른 엔진 동작은 건드리지 않는다.
- **검증**: `next: null`이 있는 워크플로우가 저장(201)되고, 실행하면 해당 단계에서 run이 `succeeded`로 끝나며 뒤 단계가 실행되지 않는다 (하네스 테스트에 넣는다 — 아래 검증 5번).

### 2. 삭제 시 간선 정리 — WF-7 한계 (2) 해결 (프런트)

- **문제**: 폼에서 단계를 삭제하면 그 단계를 가리키던 `next` 때문에 저장이 400이 됐다.
- **해결**: 단계를 삭제할 때(캔버스·폼 둘 다) 그 단계를 가리키던 모든 `next`를 정리한다:
  - 일반 단계의 `next`가 삭제된 단계를 가리키면 그 `next`를 지운다 (배열 순서로 폴백 — WF-7의 "next 없음 = 배열 다음 단계" 규칙).
  - condition의 `true`/`false` 중 삭제된 단계를 가리키는 쪽만 지운다 — 단, condition `next`는 두 키가 다 있어야 하므로, 한쪽만 지우면 검증이 깨진다. 그래서 condition의 한쪽이 삭제된 단계를 가리키면 **그쪽 값을 `null`로 바꾼다** (해당 분기는 거기서 종료 — 1번 표식과 같은 의미). condition 단계 자체를 삭제하면 그 단계를 가리키던 다른 단계들의 `next`를 위 규칙대로 정리한다.
  - 삭제할 때 정리된 간선이 있으면 사용자에게 알린다 ("삭제된 단계를 가리키던 간선 N개를 정리했습니다 — 해당 분기는 종료로 바뀌었습니다" 류의 문구 1줄, `wfMsg`로).
  - 폼 빌더의 `wfRemove`에도 같은 정리를 넣는다 (폼·캔버스가 같은 `wfCur.steps`를 쓰므로, 정리 로직은 **공용 함수** `wfCleanupEdgesAfterDelete(deletedId)`로 빼서 양쪽에서 부른다).
  - 간선 연결 시 사이클이 생기면 연결을 거부하고 알린다 (정의는 DAG — 사이클은 서버 검증 400이다. 캔버스에서 미리 막는다).

### 3. SVG 캔버스 (`public/workflow-canvas.{js,css}` 신규 + `public/workflow.js` 연동)

- **파일**: `public/workflow-canvas.js`(캔버스 렌더링·드래그·간선 연결), `public/workflow-canvas.css`(노드·간선·포트 스타일). `public/index.html`에 두 파일만 추가한다 (다른 배선은 `workflow.js`에서 한다).
- **공유 상태**: 캔버스는 `wfCur.steps`를 직접 읽고 쓴다 (폼과 같은 배열 객체 — 복사본을 만들지 않는다). 단계 추가·삭제·이름·설정은 폼의 기존 함수(`wfRenderStepForm`·`wfSave`)를 재사용한다 — 캔버스는 노드 배치와 간선 편집만 맡는다.
- **배치**: 처음 열 때는 자동 배치한다 — 배열 순서대로 위에서 아래로, condition의 두 분기는 좌우로 벌려서 그린다 (간단한 계층 배치면 된다, 정교한 알고리즘은 안 쓴다). 사용자가 노드를 드래그하면 위치가 바뀐다.
  - **위치는 정의 JSON에 넣지 않는다** (엔진이 모르는 필드가 정의에 섞이면 안 된다). 위치는 `localStorage`에 워크플로우 id별로 저장한다 (`wf-layout:<workflowId>` — `{ [stepId]: {x, y} }`). 새 워크플로우(아직 id 없음)는 메모리에만 둔다. 저장·실행에는 위치가 안 쓰인다.
- **노드**: 직사각형 + 노드 타입 아이콘/이름 + 단계 이름. 노드 타입별 색은 폼의 기존 색상 체계를 따른다 (새 팔레트를 만들지 않는다). condition 노드는 `true`/`false` 출력 포트를 따로 보여준다 (초록/빨강 또는 참/거짓 라벨). `next: null`인 단계(경로 종료)에는 "종료" 표시를 단다 (예: 노드 아래에 작은 종료 배지). agent 노드와 webhook 노드도 일반 노드처럼 보인다.
- **간선**: SVG path(베지어 곡선). 명시 간선(`next` 있음)은 실선, 암묵 간선(next 없어서 배열 순서로 가는 경우)은 점선으로 구분해서 그린다. condition의 true/false 간선은 라벨을 단다. 간선을 클릭하면 삭제할 수 있다 (확인 없이 삭제하되, 삭제 즉시 `next`가 지워지고 `wfDirty = true`가 된다 — 저장은 `wfSave`로).
- **간선 연결**: 노드의 출력 포트에서 드래그해서 다른 노드의 입력 포트에 놓으면 `next`가 생긴다. condition은 true/false 포트 중 하나에서 시작한다. 자기 자신에게는 연결할 수 없다. 사이클이 생기면 거부한다 (2번). 빈 곳에 놓으면 연결이 취소된다.
- **종료 표식**: 노드의 출력 포트에서 "종료" 타깃(캔버스 구석의 종료 아이콘 또는 노드 우클릭 메뉴의 "여기서 종료")으로 드래그하면 `next: null`이 된다. 반대로 `next: null`인 노드에서 다른 노드로 다시 연결하면 `null`이 그 id로 바뀐다.
- **보기 전환**: 워크플로우 상세 화면에 "폼 보기 / 캔버스 보기" 전환 버튼을 넣는다. 전환해도 `wfCur.steps`는 그대로 (편집 중 내용이 안 날아간다). 캔버스에서 단계를 더블클릭하면 폼의 단계 편집(`wfEditIdx`)이 열린다. 캔버스에도 "단계 추가" 버튼을 둔다 (노드 타입 팔레트 — `WF_NODES` 목록을 그대로 쓴다. 추가하면 폼이 열려 설정을 입력한다).
- **공유받은 워크플로우(읽기 전용)**: `wfCur.shared`면 캔버스는 보기만 된다 (드래그·연결·삭제·추가 버튼 없음, 안내 문구 1줄). 실행 버튼도 없다 (WF-9와 같은 규칙).
- **저장**: 캔버스의 변경은 `wfSave`로 저장한다 (폼과 같은 저장 버튼). 저장 실패(서버 400) 시 에러 문구를 그대로 보여준다 (`wfFail`).

### 4. 폼 빌더 정리 (`public/workflow.js` 최소 변경)

- `wfRemove`에 2번의 간선 정리(공용 함수)를 넣는다.
- `wfRenderSteps`의 단계 카드에 간선 정보를 한 줄 보여준다 (예: "다음: s3 (조건 true)" / "다음: 종료" / "다음: 배열 순서") — 폼에서도 분기 구조가 보이게 한다. 길게 늘리지 않는다 (1줄).
- 그 밖의 폼 동작은 바꾸지 않는다.

## 검증 (반드시 `files/workflow-verify/wf10/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf10/`)

- `npx tsc --noEmit` 통과 (types.ts·엔진을 건드렸으므로). `node --check public/workflow.js public/workflow-canvas.js` 통과.
- 로컬 하네스 (WF-7의 `wf7/` 패턴 — Miniflare, AI·fetch는 mock):
  1. **종료 표식 (가장 중요)**: `next: null`인 단계에서 run이 `succeeded`로 끝나고 뒤 단계가 실행되지 않는다 (단계 행이 안 생긴다). condition의 true만 `null`이면 true 분기는 거기서 끝나고, false 분기는 이어서 간다. `next: null` 정의가 저장 검증(201)을 통과한다.
  2. **삭제 정리**: 간선이 있는 단계를 삭제하면 남은 `next`가 정리돼 저장이 400 없이 통과한다. condition의 한쪽이 삭제된 단계를 가리키면 그쪽이 `null`이 된다. 사이클을 만드는 간선은 검증 400이다 (서버가 막는다는 것을 하네스로 확인 — 캔버스에서도 미리 막지만 서버가 최후 방어선이다).
  3. **정의 JSON 왕복**: 폼으로 만든 정의 → 캔버스 로직으로 읽어서 간선 목록을 뽑으면 서버 정의와 같고, 캔버스에서 간선을 바꿔 저장한 뒤 다시 읽으면 바뀐 간선이 그대로 있다 (폼·캔버스 왕복). `next` 없는 v1 정의도 그대로 읽힌다.
  4. **회귀**: 일반 선형 실행 + 승인 게이트 + agent 루프 + condition 분기 + 스케줄 API + 공유/복사 + 웹훅 SSRF 차단이 그대로 동작한다 (WF-9의 하네스 일부를 재사용해도 된다 — 새로 만들지 말고).
- 로컬 화면 동작: `wrangler dev --local`로 띄워서 (a) 폼→캔버스 전환 시 같은 단계가 보이고, (b) 간선 연결·삭제·종료 표식이 화면에 반영되고, (c) 저장 후 새로고침해도 간선이 유지되는 것을 확인한다. 브라우저 자동화 없이, dev 서버 + `curl`로 정의 JSON을 읽어 확인하는 방식이면 된다 (화면 렌더링 자체는 코디네이터가 나중에 브라우저로 본다 — 미검증 목록에 적는다).
- **미검증 목록을 RESULT.md에 적는다** (브라우저에서 드래그·간선 연결의 실제 손맛, 배포·원격 D1, 화면 시각 확인).

## 금지

- 정의 JSON에 위치(x/y) 같은 UI 필드를 넣지 않는다. 엔진의 실행 순서·승인·에이전트·스케줄 동작을 바꾸지 않는다 (`resolveNextStep`·검증의 `null` 처리 외).
- D1 마이그레이션을 만들지 않는다 (스키마 변경 없음). 배포하지 않는다.
- 외부 라이브러리·CDN을 들이지 않는다 (SVG + 바닐라 JS만). Agents SDK를 들이지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 이 세션에서 건드리지 않는다 (별도 과제).
