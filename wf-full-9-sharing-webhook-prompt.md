# WF-9 프롬프트 — 공유/템플릿 + 웹훅 노드

> 작업 디렉터리: `/home/hatch/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os`
> 선행 문서: `workflow-agent-builder-proposal.md` 4.2.3 + `workflow-agent-builder-FULL-PLAN.md` §1·§2 WF-9행 + WF-1~WF-8 산출물(`src/workflow/{types,store,routes,engine,approvals,nodes,schedules}.ts`, `migrations/0027·0028`) + 검증 문서(`files/workflow-verify/wf2/RESULT.md`의 send_email 승인 패턴, `wf8/RESULT.md`).
> 모델: Sonnet. 이 세션은 **공유/템플릿 + 웹훅 노드만** 만든다. 캔버스(WF-10), 관측(WF-11)은 **하지 않는다**. **배포하지 않는다** — D-3에서 코디네이터가 0029 적용·배포·라이브 검증을 한다.
> **원칙 (제안서·FULL-PLAN 공통)**: 실행은 항상 실행자 권한으로 돈다. 공유는 보기/복사만 허용한다 — 남의 워크플로우를 직접 실행하거나 남의 run을 볼 수는 없다 (복사해서 내 것으로 만든 뒤 실행한다). 외부 행동(webhook 포함)은 승인 게이트를 거친다. 기존 CRUD·실행·승인·에이전트·조건·스케줄 동작은 절대 바꾸지 않는다.

## 목표

내가 만든 워크플로우를 같은 부서나 전 조직에 공유하고, hr_admin이 만든 조직 템플릿을 누구나 복사해 쓸 수 있게 한다. 또 워크플로우 안에서 외부 HTTP 엔드포인트를 안전하게 호출하는 `webhook` 노드를 쓸 수 있게 한다. 이 세션이 끝나면 공유받은 워크플로우를 보고 복사할 수 있고, 템플릿을 복사해 내 워크플로우로 만들 수 있고, 웹훅 노드가 SSRF 방어·타임아웃·응답 상한을 지키며 동작한다.

## 할 일

### 1. 마이그레이션 0029 (`migrations/0029_workflow_sharing.sql`)

- `workflow_shares` 테이블을 만든다:
  ```sql
  CREATE TABLE IF NOT EXISTS workflow_shares (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,              -- 공유한 사람 (워크플로우 소유자)
    scope TEXT NOT NULL CHECK (scope IN ('department', 'all')),
    permission TEXT NOT NULL CHECK (permission IN ('view', 'copy')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workflow_id, scope)
  );
  CREATE INDEX IF NOT EXISTS idx_wf_shares_workflow ON workflow_shares(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_wf_shares_owner ON workflow_shares(owner_id);
  ```
  - 범위: `department` = 같은 부서(`users.department_id`가 공유자와 같고 둘 다 NULL이 아닌 사용자), `all` = 전체 사용자. "본인만"은 공유 행이 없는 상태가 곧 본인만이다 — 별도 scope를 만들지 않는다.
  - 권한: `view` = 보기만, `copy` = 보기 + 복사. `copy`는 `view`를 포함한다.
  - 한 워크플로우에 scope당 1개 행만 (`UNIQUE(workflow_id, scope)`).
- `workflows`에 템플릿 표시 컬럼을 추가한다:
  ```sql
  ALTER TABLE workflows ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;
  ```
  (D1 `ALTER TABLE ADD COLUMN`은 기본값 있는 컬럼만 가능 — 위 형태 그대로 쓴다.)

### 2. 공유 판정 (`src/workflow/sharing.ts`, 신규)

- `getUserDepartment(db, userId): Promise<string | null>` — `users.department_id`를 읽는다. `SessionUser`(`src/auth.ts`)에는 department가 없으므로 D1에서 직접 읽는다.
- `canViewWorkflow(db, viewerId, workflow: WorkflowRow): Promise<{ view: boolean; copy: boolean }>` — 판정 규칙:
  1. `workflow.owner_id === viewerId` → view+copy 전부 true (내 것).
  2. `workflow.is_template === 1` → view+copy 전부 true (조직 템플릿은 전원이 보고 복사할 수 있다).
  3. `workflow_shares`에서 해당 `workflow_id` 행을 읽는다. 행이 없으면 view/copy 모두 false.
  4. `scope='all'` 행이 있으면 그 행의 permission대로 (`copy`면 view+copy, `view`면 view만).
  5. `scope='department'` 행이 있으면 공유자(`owner_id`)와 보는 사람(viewerId)의 `department_id`를 둘 다 읽어, 둘 다 NULL이 아니고 같으면 그 행의 permission대로. 다르면 false.
  6. `all` 행과 `department` 행이 둘 다 있으면 더 넓은 권한을 합친다 (어느 한쪽이라도 copy면 copy).
- `listSharedWithMe(db, viewerId): Promise<WorkflowRow[]>` — 내가 볼 수 있는 남의 워크플로우 + 템플릿 목록. `workflows` 전체를 읽어 `canViewWorkflow`로 거르는 방식은 안 된다 (행이 많아지면 느려진다) — `workflow_shares` + `is_template=1` 조건으로 후보를 좁힌 뒤 판정한다. 템플릿은 소유자가 달라도 포함한다. 내 워크플로우는 제외한다.
- 공유 행 CRUD: `createShare(db, ownerId, workflowId, scope, permission)`, `listShares(db, ownerId, workflowId)`, `deleteShare(db, ownerId, workflowId, shareId)` — 전부 소유자만 (호출 전에 `getWorkflow`로 소유권을 확인하고, 타인은 404를 던진다 — 403이 아니라 404로 존재 자체를 숨긴다. WF-1~WF-4의 격리 관례와 같다).

### 3. 공유·템플릿·복사 API (`src/workflow/routes.ts`에 추가 — 새 파일로 빼지 않는다)

- `GET /api/workflows/shared` — `listSharedWithMe` 결과. 응답 각 항목에 `shared_via: 'department' | 'all' | 'template'`, `can_copy: boolean`을 붙인다. **라우트 등록 순서 주의**: `/:id`보다 먼저 등록해야 `shared`가 id로 잡히지 않는다 (WF-1의 `/runs/:runId` 선행 등록과 같은 이유).
- `GET /api/workflows/:id` — 기존 동작에 공유를 얹는다: 소유자가 아니면 `canViewWorkflow`로 보고, view가 안 되면 404. 공유로 보는 경우 응답에 `shared: true`, `can_copy`를 붙인다. (소유자면 기존 응답 그대로.)
- `POST /api/workflows/:id/copy` — 복사. `canViewWorkflow`의 copy가 true일 때만 (아니면 404). 새 워크플로우를 만든다: 소유자 = 복사한 사람, 이름 = 원본 이름 + ` (복사)`, 설명·정의는 원본 그대로, `is_template=0`, 공유 행은 **이어받지 않는다** (복사본은 처음부터 비공개). 응답 201 + 새 워크플로우. **복사본의 run은 복사한 사람이 실행한다** — 원본 소유자의 run을 건드리지 않는다.
- `POST /api/workflows/:id/shares` — 공유 생성. 본문 `{ scope: 'department' | 'all', permission: 'view' | 'copy' }`. 소유자만 (타인 404). 같은 scope가 이미 있으면 그 행의 permission을 갱신한다 (upsert — `UNIQUE(workflow_id, scope)` 충돌로 500이 나면 안 된다). 응답 201(신규) 또는 200(갱신) + 공유 행.
- `GET /api/workflows/:id/shares` — 공유 목록 (소유자만, 타인 404).
- `DELETE /api/workflows/:id/shares/:shareId` — 공유 삭제 (소유자만, 타인 404, 없는 shareId도 404).
- `PATCH /api/workflows/:id` 확장 — 본문에 `is_template`이 있으면: `role==='hr_admin'`인 경우에만 허용 (아니면 403). 일반 사용자가 `is_template: true`를 보내면 403을 던진다 (조용히 무시하지 않는다). `is_template: false`로 내리는 것도 hr_admin만. 템플릿으로 지정해도 소유자는 그대로 (hr_admin이 만든 템플릿의 소유자는 hr_admin).
- **바꾸지 않는 것**: `POST /:id/runs`·승인·스케줄 API는 소유자만 그대로 (공유받은 워크플로우는 복사한 뒤 내 복사본으로 실행한다). `GET /api/workflows/` (내 목록)는 내 것만 그대로. `DELETE /:id` 시 공유 행은 `ON DELETE CASCADE`로 같이 지워진다.

### 4. `webhook` 노드 (`src/workflow/types.ts` + `src/workflow/nodes.ts`)

- `NODE_TYPES`에 `'webhook'`을 추가한다 (13번째 도구 노드). `TOOL_NODE_TYPES`에는 자동 포함된다. 단, **에이전트 기본 도구에는 넣지 않는다** — `AGENT_DEFAULT_TOOLS`에서 `send_email`처럼 제외한다 (`filter`에 `'webhook'`을 추가). 에이전트는 `config.tools`에 `webhook`을 명시해야만 쓸 수 있다 (외부 호출이라 기본값으로는 안 준다).
- config: `{ url: string, method?: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE' (기본 POST), headers?: Record<string,string>, body?: unknown }`. `url`은 필수, `method`는 위 5개만 (다른 값은 검증 400), `headers`는 문자열 값만, `body`는 JSON 직렬화 가능해야 한다. `executeNode`가 넘기기 전에 `resolveVars`로 치환한 값을 쓴다 (다른 노드와 같은 패턴 — `{{input.x}}`·`{{steps.s1.output.y}}`를 url·header 값·body 안에서 쓸 수 있다).
- **승인 게이트 (send_email과 같은 패턴)**: `ctx.approved`가 아니면 fetch를 **절대** 하지 않고, 노드가 승인 요청을 낸다 (WF-2의 send_email이 `approved` 검사 → 승인 요청으로 멈추는 흐름과 동일하게). 승인된 뒤에만 실제 fetch를 한다. 승인 없이 fetch가 나가는 테스트가 있으면 실패로 본다.
- **SSRF 방어** — fetch 전에 URL을 검사하고, 아래 중 하나라도 해당하면 fetch 없이 `{ status: 'failed', error: '...' }`를 돌려준다:
  1. 스킴이 `http:`/`https:`가 아니면 차단 (예: `file:`, `ftp:`, `gopher:`).
  2. URL에 사용자 정보(`user:pass@host`)가 있으면 차단.
  3. 호스트가 `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`이면 차단.
  4. 호스트가 리터럴 IP면 사설·루프백·링크 로컬을 차단: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `0.0.0.0/8`, `169.254.0.0/16` (클라우드 메타데이터), `::1`, `fe80::/10`, `fc00::/7`, `::/128`. IPv4·IPv6 둘 다 검사한다.
  5. **정직한 한계**: Workers 런타임에서는 fetch 전에 DNS를 직접 조회할 수 없어, 도메인 이름이 사설 IP로 해석되는 경우(DNS 리바인딩)는 이 검사로 막을 수 없다. 이 한계를 주석 + RESULT.md에 적는다. 도메인 자체를 allowlist로 막지는 않는다 (사용자 웹훅 대상이 다양해서 v1에서는 차단 목록 방식만 쓴다).
- **타임아웃·응답 상한**: `AbortSignal.timeout(10000)`으로 10초 타임아웃 (타임아웃 시 failed, "10초 안에 응답이 없습니다" 류의 한국어 에러). 응답 본문은 최대 256KB까지만 읽는다 — 초과하면 읽기를 중단하고 failed ("응답이 256KB를 초과했습니다"). 본문이 256KB 이하라도 `Content-Length`가 256KB를 초과한다고 선언하면 fetch 전에 차단한다 (읽기 전에 헤더로 거른다).
- **요청·응답 형태**: `Content-Type: application/json`으로 body를 JSON 직렬화해서 보낸다 (body가 없으면 본문 없이 보낸다). config `headers`는 그대로 붙이되, `host`·`connection`·`content-length`는 fetch가 관리하므로 config에 있어도 무시한다 (조용히 제외 — 에러를 던지지 않는다). `cookie` 헤더는 config에 있어도 보내지 않는다 (세션 탈취 방지). 응답 출력(JSON 직렬화 가능해야 한다):
  ```json
  { "status": 200, "ok": true, "contentType": "application/json", "body": "<텍스트, 최대 256KB>", "json": { "파싱되면": "객체" } }
  ```
  `json` 필드는 `content-type`이 JSON이고 파싱에 성공했을 때만 넣는다. HTTP 오류 상태(4xx/5xx)는 노드 실패가 아니라 **성공 출력**으로 돌려준다 (`status`·`body`를 보면 호출자가 condition 노드로 분기할 수 있다) — fetch 자체가 실패한 경우(타임아웃·DNS 오류·SSRF 차단)만 failed이다.
- `validateDefinition`에 webhook config 검사를 추가한다 (WF-1의 `checkDefinition` 패턴 — url 필수·method 화이트리스트·headers 문자열·body 직렬화 가능. 단, SSRF 검사는 정의 검증이 아니라 **실행 시점**에 한다 — URL에 변수가 들어갈 수 있어서 저장 시점에는 호스트를 확정할 수 없다).

### 5. 폼 빌더 UI 최소 배선 (`public/workflow.js` — WF-5 파일만 고친다)

- 노드 추가 목록에 `webhook`을 넣는다 (이름 "웹훅 호출", 설정 폼: URL·메서드 선택·헤더 키/값 1쌍 이상·본문 JSON 텍스트). 저장 시 `validateDefinition`이 잡는 오류를 그대로 보여준다.
- 워크플로우 상세에 **공유 섹션**을 넣는다: 공유 범위 선택(`department`/`all`) + 권한 선택(`view`/`copy`) + 공유 생성 버튼, 공유 목록 + 삭제 버튼. 공유받은 워크플로우(목록에서 `shared` 표시)에는 복사 버튼을 보여주고, 실행 버튼은 보여주지 않는다 (복사한 뒤 실행한다는 안내 문구 1줄).
- 내 목록과 별개로 **"공유받은 워크플로우" 목록**을 `GET /api/workflows/shared`로 불러와 보여준다 (템플릿 포함).
- `workflow.css`는 꼭 필요한 스타일만 추가한다 (공유 섹션·복사 버튼). 메뉴·홈 카드는 건드리지 않는다 (WF-11 범위).

## 검증 (반드시 `files/workflow-verify/wf9/RESULT.md`에 기록한다 — goal 루트 `files/workflow-verify/wf9/`)

- `npx tsc --noEmit` 통과. `public/workflow.js`는 `node --check` 통과.
- 로컬 하네스 (WF-6~WF-8의 `wf6/`·`wf8/` 패턴 — `wrangler.toml` + `worker.ts` + Miniflare, AI·VECTOR는 mock, **fetch는 mock으로 갈아끼울 수 있게** webhook 실행 경로를 만든다 — `globalThis.fetch`를 하네스에서 교체하거나 `ctx` 경유 주입 중 하나로, 하네스에서 실제 외부 호출이 나가지 않게 한다):
  1. **공유 격리 (가장 중요)**: 사용자 A의 비공개 워크플로우는 B가 GET하면 404, 복사하면 404, run 만들면 404. A가 `all`+`view`로 공유하면 B는 GET 200(단, `shared: true`), 복사는 404. `all`+`copy`로 바꾸면 B는 복사 201, 복사본 소유자는 B, 복사본은 비공개(공유 행 없음), 복사본 실행은 B만 가능.
  2. **부서 범위**: A와 B가 같은 `department_id`면 `department`+`copy` 공유가 B에게 보이고, C(다른 부서)에게는 404. `department_id`가 NULL인 사용자에게는 `department` 공유가 안 보인다. 부서를 옮긴 뒤에는 안 보인다 (판정 시점에 읽는다).
  3. **템플릿**: hr_admin이 `is_template: true`로 지정하면 전원이 GET 200·복사 201. 일반 사용자가 `is_template: true`를 PATCH하면 403. 템플릿을 복사한 복사본은 `is_template=0`.
  4. **공유 관리**: 공유 생성·목록·삭제 왕복, 같은 scope upsert 시 500이 아니라 갱신, 타인의 공유 API는 전부 404, 워크플로우 삭제 시 공유 행도 지워진다.
  5. **웹훅 SSRF 차단**: `http://localhost:3000/x`, `http://127.0.0.1/x`, `http://10.0.0.5/x`, `http://192.168.1.1/x`, `http://169.254.169.254/latest/meta-data/`, `http://metadata.google.internal/`, `file:///etc/passwd`, `https://user:pass@example.com/` — 전부 fetch 0회로 failed. `https://example.com/hook`은 mock fetch 1회로 성공.
  6. **웹훅 승인**: 승인 없이 실행하면 fetch 0회로 멈춤(waiting_approval), 승인 뒤 fetch 1회로 succeeded. (WF-4의 승인 흐름과 같은 방식.)
  7. **웹훅 타임아웃·상한**: mock fetch가 10초 넘게 끌면 타임아웃 failed. `Content-Length: 300000` 응답은 읽기 전 차단. 300KB 본문은 256KB에서 중단하고 failed. 4xx 응답은 succeeded 출력으로 돌아오고 `status`가 보인다.
  8. **회귀**: 일반 선형 실행 + 승인 게이트(send_email) + agent 루프 + condition 분기 + 스케줄 API가 그대로 동작한다.
- **미검증 목록을 RESULT.md에 적는다** (실제 외부 웹훅 호출 — 로컬에서는 mock fetch, DNS 리바인딩 차단 불가, 배포·원격 D1, 브라우저 화면).

## 금지

- 공유받은 워크플로우의 직접 실행·run 조회를 허용하지 않는다. 템플릿 지정을 hr_admin以外에 허용하지 않는다.
- D1 마이그레이션 파일은 0029 하나만 만든다. 배포하지 않는다.
- Agents SDK를 들이지 않는다. 코드 실행 노드를 만들지 않는다.
- 비밀·비밀번호·토큰을 파일·프롬프트에 쓰지 않는다. GitHub 푸시를 하지 않는다. 제안서 파일은 수정하지 않는다.
- WF-2 복제 부채(`summarizeDocument`·`buildDeck`·리플렉션 로직이 `nodes.ts`에 복제됨)는 이 세션에서 건드리지 않는다 (별도 과제).
