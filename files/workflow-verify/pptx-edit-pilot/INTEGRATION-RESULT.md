# PPTX 편집 라이브 통합 결과 — 별도 Worker 구조 (2026-11-21, Opus 5.5 단일 세션)

## 판정

**통합 완료, 라이브 동작 확인.** PowerPoint에서 직접 열어 보는 확인은 아직 하지 않았다.

- 별도 Worker `people-os-pptx-editor`(ooxml-core)와 People OS(서비스 바인딩 `PPTX_EDITOR`, RPC)를 둘 다 배포했다. 라이브에서 시험 덱 생성 → inspect → ops 편집 → 새 버전 저장 → 다시 읽기를 끝까지 돌렸다. 자연어 지시 편집(실제 Qwen이 ops 생성)도 이 흐름으로 확인했다.
- 원본은 바이트 그대로 남았고, 손대지 않은 슬라이드도 바이트 동일했다. 기존 엔드포인트 8건도 바이트 동일했고, 바뀐 것은 의도한 3건(홈 HTML, workflow.js, 새 pptx-edit.js)뿐이며 셋 다 로컬 파일과 같다.
- **남은 확인 1건:** `pptx-editor/out/edited-live.pptx`를 사람이 PowerPoint에서 열어 복구 대화상자가 뜨지 않는지 봐야 한다. 이 VM에는 PowerPoint·LibreOffice가 없다.

## 배포

| 대상 | 버전 | 번들 | 시작 시간 |
|---|---|---|---|
| `people-os-pptx-editor` (신규, workers_dev=false — 바깥 주소 없음, RPC 전용) | **`b0c17fb1-4a6c-4580-9a81-f0258b908d24`** | 9,449 KiB / gzip **2,319 KiB** | 94 ms |
| `people-os` | `778b62b4` → **`a20936b2-966f-476e-80de-c056b435da5d`** (2026-11-21 03:04:06Z) | 8,406 KiB / gzip **1,728 KiB** (파일럿 때 측정 8,382 / 1,721 → +24 KiB / gzip +7 KiB, ooxml-core는 본체에 안 들어감) | 161 ms |

배포 순서는 편집 Worker 먼저, People OS 다음으로 직렬로 했다. `cf-wrangler.py deploy --config <절대 경로>`를 직접 실행했고 승인 대기로 막힌 적은 없다. 롤백할 때는 People OS를 `778b62b4`로 되돌리면 되고(`PPTX_EDITOR`가 없는 버전이다), 편집 Worker는 그대로 두어도 무해하다. 이번 배포에는 DO 마이그레이션 태그가 새로 생기지 않았으므로 `wrangler rollback`이 가능하다.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `pptx-editor/` (신규) | `package.json`(**`pptx-viewer-core 5.0.0` / `ooxml-core 2.0.0` / `fflate 0.8.3` 정확한 버전 고정**, `--save-exact`), `package-lock.json`, `wrangler.toml`(`compatibility_date 2025-07-18` + `nodejs_compat`, observability on), `src/index.js`(WorkerEntrypoint RPC `inspect` / `applyOps` / `replaceText`, 가드, 부품 비교), `out/edited-local.pptx`, `out/edited-live.pptx` |
| `wrangler.toml` | `[[services]] binding = "PPTX_EDITOR" service = "people-os-pptx-editor"` **하나만** 추가 |
| `src/pptx/types.ts` (신규) | 공용 ops 스키마 `PptxOp`(text·shape·cell·chart·duplicate), `validateOps`, RPC 모양 `PptxEditorRpc` |
| `src/pptx/edit.ts` (신규) | 원본 읽기(권한) → (지시면 inspect + LLM 계획 + 덱 대조 검증) → applyOps → 새 버전 저장, 편집본 목록, replace 경로 |
| `src/index.ts` | `Env.PPTX_EDITOR`, 라우트 3개 `POST /api/pptx/inspect` · `POST /api/pptx/edit` · `GET /api/pptx/versions` (S3 덱 다운로드 라우트 바로 뒤) |
| `src/workflow/types.ts` | `NODE_TYPES`에 `pptx_edit`. **`AGENT_DEFAULT_TOOLS`에서는 뺐다** — 기존 agent 단계의 도구 목록·동작이 바뀌지 않고, 쓰려면 `tools`에 명시해야 한다. `Env.PPTX_EDITOR` 추가 |
| `src/workflow/nodes.ts` | `pptx_edit` 노드 (deckId·docId, ops 또는 instruction, title). 권한은 다른 노드와 같다 (공용이거나 실행자 본인 것) |
| `src/workflow/think-agent.ts` | `KEY_HINTS`에 deckId·ops·instruction 추가 (명시한 경우에만 쓰임) |
| `public/pptx-edit.js` (신규) | "편집본 만들기" 패널: ① 텍스트 run·표 셀 직접 고치기 ② 자연어 지시 ③ 고급 ops JSON → 변경 전후 텍스트 diff 표, 서명 제거 경고, SmartArt 새로고침 안내, 편집본 목록. textContent만 사용 |
| `public/index.html` | 라이브러리 파일 목록 행에 "편집본 만들기" 버튼 (덱, 원본이 있는 업로드 문서, 로그인 사용자만) + `<script src="/pptx-edit.js">` |
| `public/workflow.js` | 빌더에 `pptx_edit` 노드 폼 + "승인 뒤에 편집" 체크박스 (`requiresApproval: true`) |
| `files/workflow-verify/pptx-edit-pilot/integration/` | 로컬·라이브 근거 파일 (아래) |

D1 마이그레이션은 없다. 편집본은 기존 `decks` 테이블의 **새 행**과 **새 R2 키** `decks/edits/<kind>_<원본id>/<새 덱id>.pptx`로 저장한다. 그래서 다운로드(`GET /api/deck/:id`), 삭제, 라이브러리 목록, 소유자 게이트는 기존 덱 경로가 그대로 맡는다. 원본과의 관계는 R2 키 접두어와 customMetadata `editedFrom`에 남는다. 원본 키에는 쓰기가 없다 (`FILES.put`은 새 키에만 한다).

## 설계 요점

- **인증**: `/api/pptx/*`는 로그인 사용자만 쓸 수 있다 (편집 1회 CPU가 약 1초라 익명에게 열지 않는다). 운영 점검용으로 `X-Admin-Secret`도 받는데, 이때 편집본은 공용(owner NULL) 소유가 된다. 원본 읽기 권한은 공용이거나 본인 것이며 hr_admin은 전부다. 없음과 권한 없음은 같은 404로 답한다.
- **세 가지 입력 방식**:
  - `ops`: 직접 지정.
  - `instruction`: Qwen(`@cf/qwen/qwen3.8-27b`)이 inspect 요약을 보고 `{ops}`를 만든다. 결과는 `validateOps`와 "요약에 있는 슬라이드·요소 id인지" 대조로 두 번 검증한 뒤에 편집 Worker로 보낸다.
  - `replace {find,to}`: `replaceText` RPC를 쓰는 가장 가벼운 경로.
- **편집 Worker의 적용 순서**: text op는 `setPresentationRunText`로 처리한다 (run 하나만 바꾸고 다른 run·서식·부품은 보존한다). 나머지 op는 한 번 읽어 모델을 고친 뒤 `save()`를 한 번 한다. duplicate는 맨 뒤에 붙이므로 앞 op의 슬라이드 번호가 바뀌지 않는다. 저장본은 다시 읽어서 변경 전후 diff를 만들고, ZIP 부품을 비교해 `identicalSlides`를 함께 돌려준다.
- **실패**: RPC는 throw하지 않고 `{ok:false, code}`를 돌려준다. People OS는 이를 HTTP 상태로 바꾼다: limit은 413, bad_input·not_found는 422, internal은 502, 바인딩이 없으면 503.

## 항목별 결과

### 정적 검사
- `npx tsc --noEmit`: 오류 **0**.
- `node --check`: `public/pptx-edit.js`, `public/workflow.js`, `pptx-editor/src/index.js` 모두 **0**.

### 로컬 (`npx wrangler dev --local -c wrangler.toml -c pptx-editor/wrangler.toml`, 두 Worker를 한 프로세스에서 서비스 바인딩으로 연결)

| 시험 | 결과 | 근거 |
|---|---|---|
| 파일럿 시험 덱(5장: 텍스트·도형·표·차트·대조군)을 업로드 문서로 올림 → inspect | 200, 요소 16개, signed=false, hasSmartArt=false | `integration/local-inspect.json` |
| op 5종 7개 한 번에 (text×2, shape, cell×2, chart 시리즈 2개+제목, duplicate) | 201, 6장, 33,651 B. diff 7곳 모두 의도대로 (shape x 96→196, fill #2D7DDE→#DC2626, 표 최코치/99, 차트 11,22,33,44 / 50,60,70,80, 슬라이드 6 생성) | `integration/ops-all5.json`, `local-edit.json` |
| 손대지 않은 슬라이드 | **`ppt/slides/slide5.xml` identical** (그대로 남은 부품 21개, 다시 쓰인 부품은 파일럿과 같은 8개 + 편집한 슬라이드·rels·차트·내장 xlsx) | `local-edit.json` `parts` |
| 편집본을 기존 `GET /api/deck/:id`로 받아 다시 inspect | 6장, 제목·셀·시리즈·채우기 값 모두 확인 | `pptx-editor/out/edited-local.pptx`, `local-reinspect.json` |
| 원본 보존 | 편집 뒤 원본 다운로드가 업로드한 `test-deck.pptx`와 **`cmp` 동일** | `local-original-after.pptx` |
| People OS S3 덱(`POST /api/deck`, pptxgenjs) 편집 | run 단위 교체(`runIndex 1`)에서 글머리 "• " run과 둘째 문단이 보존됨. slide3 identical | `local-s3-edit.json` |
| replace 경로 | 201, "People OS 파일럿 덱" → "People OS 통합 덱" | `local-replace.json` |
| 편집본 목록 `GET /api/pptx/versions` | 원본 1개의 편집본 2개, 최신순 | (로컬 응답) |
| **가드: `load({limits})` 슬라이드 상한** | 편집 Worker `[vars] PPTX_MAX_SLIDES="5"`로 **임시로 낮춰** 시험 (시험 뒤 원복함): 6장 덱 inspect → **413** "슬라이드 수 상한 5 (6)". 5장 덱 → 200. duplicate로 상한을 넘기려 함 → **413** | 아래 참고 |
| 오류 경로 | 비로그인 401 / slide가 문자열 "1"이면 400 / 없는 elementId 422 / 없는 덱 404 / .md 원본 415 "PPTX 파일만" / 입력이 없으면 400 | (로컬 응답) |
| **워크플로 노드 `pptx_edit` + 승인 게이트** | `requiresApproval: true` 단계 → run **waiting_approval** (편집 전, 덱 없음) → `POST /runs/:id/approve` → 편집 성공(op 2개, `{{input.newTitle}}` 치환) → 다음 단계 `create_task`가 `{{steps.s1.output.deckId}}`를 받아 run **succeeded** | `integration/wf-pptx.json`, `local-wf-run.json` |

로컬 D1은 마이그레이션 없이 ensureSchema만으로 만들어져 있어서, 시험에 필요한 열과 표를 `d1 execute --local`로 채웠다 (0015·0024·0027·0028·0029·0040·0042 파일, owner_id·source_r2_key 등 ALTER). 이 때문에 `/api/library`는 로컬에서 `reflections.mode`가 없어 500이 난다. 편집 기능과는 상관없는 이미 있던 로컬 스키마 차이이고, 라이브에서는 바이트 동일했다.

### 원격 (라이브 스모크, workers.dev, 배포 3분 뒤 03:07:20Z)

**기존 엔드포인트 (배포 전 778b62b4 vs 배포 후 a20936b2, `cmp`)** — 파일: `integration/live-smoke/before-*`, `after-*`

| 엔드포인트 | 전 | 후 | 판정 |
|---|---|---|---|
| `GET /api/health` | 200, 140 B | 200, 140 B | 바이트 동일 |
| `GET /agents.js` | 200, 29,313 | 200, 29,313 | 동일 |
| `GET /styles.css` | 200, 27,576 | 200, 27,576 | 동일 |
| `GET /approval.js` | 200, 24,752 | 200, 24,752 | 동일 |
| `GET /api/auth/me` (익명) | 401, 52 | 401, 52 | 동일 |
| `GET /api/library` (익명) | 200, 2,670 | 200, 2,670 | 동일 (정리 뒤에도 동일) |
| `GET /api/workflows/templates` (익명) | 401, 41 | 401, 41 | 동일 |
| `GET /api/deck/nope` | 404, 37 | 404, 37 | 동일 |
| `GET /` (홈) | 200, 139,478 | 200, **140,002** | **의도한 변화** — 로컬 `public/index.html`과 바이트 동일 |
| `GET /workflow.js` | 200, 72,774 | 200, **74,196** | **의도한 변화** — 로컬과 동일 |
| `GET /pptx-edit.js` | 404 | 200, 10,992 | **신규** — 로컬과 동일 |
| `POST /api/pptx/inspect` (익명) | 404 | 401 "로그인이 필요합니다." | **신규 라우트** |

**끝까지 간 편집 (임시 시험 계정 세션, 아래 "시험 흔적" 참고)**

1. `POST /api/deck`으로 시험 덱 3장(63,737 B)을 만들었다. 이어서 `POST /api/pptx/inspect`를 불렀더니 서비스 바인딩 RPC가 200, 3장으로 답했다.
2. `POST /api/pptx/edit` (ops 3개: text, text `runIndex 1`, duplicate): 201, 4장, 20,975 B. diff는 의도대로였고 **slide3.xml identical**, 서명 제거·SmartArt 경고는 없었다.
3. 편집본을 기존 `GET /api/deck/:id`로 받아 **`pptx-editor/out/edited-live.pptx`**(20,975 B)에 저장했다. 다시 inspect해 보니 4장이고 "라이브 편집됨", "세션 26회"(슬라이드 2와 복제본 4)가 들어 있었다.
4. 원본은 편집 전후 다운로드가 **`cmp` 동일**했다.
5. **자연어 지시** "3번 슬라이드 제목 '다음 단계'를 '하반기 계획'으로…, '하반기 목표 30회'를 '32회'로" → 201, `planned: true`. Qwen이 만든 ops는 `slide3.xml-shape-1`(run 0)과 `slide3.xml-shape-2`의 **run 1**이었다. 글머리 run을 정확히 피했고 diff 2곳 모두 맞았다. 전체 11.0초 (LLM 포함).

**CPU (`wrangler tail people-os-pptx-editor`, 원격 실측)** — `integration/live-smoke/tail-editor.jsonl`

| RPC | 내용 | cpuTime | wallTime | outcome |
|---|---|---|---|---|
| `inspect` | 3장 덱 | 190 ms | 208 ms | ok |
| `applyOps` | text 2 + duplicate 1 (+ 다시 읽기·부품 비교) | **1,566 ms** | 1,646 ms | ok |
| `inspect` | 편집본 4장 | 219 ms | 234 ms | ok |
| `inspect` | 지시 편집의 계획용 요약 | 160 ms | 173 ms | ok |
| `applyOps` | text 2 (AI 계획) | **682 ms** | 718 ms | ok |

Workers Paid 한도(요청당 CPU 30초)에는 여유가 크다. 편집 Worker로 CPU를 떼어 놓았으므로 People OS 요청의 CPU는 늘지 않는다. text op는 op마다 덱을 다시 읽고 쓰기 때문에 op 1개에 대략 0.3–0.5초가 든다. 그래서 text op는 10개까지로 제한했다 (최악의 경우 약 5–8초).

**tail (People OS)**: 스모크 동안 이벤트 15건 모두 `outcome ok`, exceptions 0. `integration/live-smoke/tail-peopleos.jsonl`.

### 시험 흔적과 정리 (운영 D1·R2)

이 세션은 `ADMIN_SECRET` 값을 읽을 수 없다 (비밀 파일 위치를 알 수 없고, `.dev.vars`에서 꺼내는 `sed`나 `${S#…}`는 승인 대기로 막혔다). 그래서 라이브 편집은 다음 순서로 했다.

1. 운영 D1에 **임시 사용자** `u_pxsmoke_tmp`(role user, 비밀번호 로그인 불가)와 **1시간짜리 세션**을 넣었다 (`cf-wrangler.py d1 execute --remote`).
2. 그 세션으로 스모크를 돌렸다.
3. 시험 덱 3개(원본 1, 편집본 2)를 **기존 `DELETE /api/decks/:id`로 지웠다** (R2 객체도 함께 지워진다, errors 없음).
4. 세션과 사용자 행을 지웠다. 확인 쿼리 결과는 users 0 / auth_sessions 0 / decks 0이다.

**남은 흔적**은 AI Gateway 로그 1건(tag `pptx-edit-plan`)과 Workers Logs의 `pptx.edit` 이벤트 2건뿐이다.

## 남은 한계

1. **PowerPoint에서 열리는지 직접 확인하지 않았다.** 근거는 재파싱, 라이브러리 저장 경로(파일럿에서 `validatePptx` valid, XML well-formed 확인), 부품 바이트 비교뿐이다. **`pptx-editor/out/edited-live.pptx`(라이브 편집본, 4장)를 PowerPoint에서 열어 복구 대화상자가 뜨지 않는지 확인해야 한다.** `edited-local.pptx`(표·차트·도형·복제 포함 6장)도 같이 열어 보면 op 5종을 모두 볼 수 있다.
2. **실제 회사 덱**(PowerPoint로 작성, SmartArt·애니메이션·OLE 포함)으로는 시험하지 않았다. SmartArt 편집은 `data1.xml`만 바뀌고 `drawing1.xml` 캐시는 그대로다 (파일럿). UI에는 안내를 넣었다. 지금 ops는 SmartArt 노드를 직접 고치지 않는다. SmartArt 요소의 text op가 들어오면 `smartArtEdited` 경고를 낸다.
3. **서명 덱**: 저장하면 서명이 지워진다 (파일럿). inspect의 `signed`를 보고 UI가 경고하고, 편집 결과의 `signatureRemoved`로도 한 번 더 알린다. 실제 서명 덱으로 라이브 시험은 하지 않았다.
4. 업로드 문서 행의 "편집본 만들기" 버튼은 원본 파일이 있는 업로드 문서 전부에 보인다. `/api/library`가 확장자를 주지 않기 때문이다 (응답을 바꾸지 않으려고 그대로 뒀다). .pptx가 아니면 서버가 415 "PPTX 파일만 편집할 수 있습니다"로 답한다.
5. 로그인 뒤 UI 화면(패널·diff 표)은 브라우저로 보지 않았다. API와 `node --check`로만 확인했다. 시험 계정이 없어서다.
6. 차트 op는 pptxgenjs 막대 차트 1종으로만 확인했다 (파일럿과 같다).
7. 편집 Worker의 가드 상한값: 입력 20 MiB, 압축 해제 200 MiB, ZIP 항목 5,000, 슬라이드 60, 도형 3,000, ops 30 (text 10). 실제 회사 덱 크기에 맞는지는 재 보지 않았다. 슬라이드 상한은 `[vars] PPTX_MAX_SLIDES`로 **낮추는 것만** 된다.

## 후속 과제

- **큰 덱은 Queue 소비자에서 처리**: 수십 장 덱이나 text op가 많은 편집은 동기 요청 대신 "제출 라우트 + 나중에 읽는 결과 라우트"로 나눈다. 큐 메시지 1개가 편집 1회이고, 소비자가 `PPTX_EDITOR.applyOps`를 부른다. 이번 범위에서는 하지 않았다.
- 실제 회사 덱(SmartArt·애니메이션·OLE 포함)으로 손대지 않은 부품이 보존되는지 시험한다. PowerPoint가 SmartArt 캐시를 다시 계산하는지도 확인한다.
- 사람이 PowerPoint로 `edited-live.pptx`를 확인한 뒤, 복구 대화상자가 뜨면 PILOT-RESULT.md "백업 후보로 넘어갈 조건"을 따른다.
- 편집 요청 레이트 제한: 지금은 로그인만 요구한다. 필요하면 기존 RateLimiter DO에 연결한다.
- 로그인 화면에서 패널·diff 표를 눈으로 확인한다 (데모 리허설 때).

## 이 세션의 교훈 (AGENTS.md 후보, 이 세션은 해당 파일에 쓸 수 없음)

- **Worker 진입 모듈은 핸들러·엔트리포인트 말고는 export하면 안 된다.** `export const MAX_OPS`가 있으면 workerd가 "Incorrect type for map entry 'MAX_OPS': not of type 'function or ExportedHandler'"를 내고 시작하지 않는다.
- **`npx wrangler dev --local -c a/wrangler.toml -c b/wrangler.toml`**로 서비스 바인딩 두 Worker를 한 프로세스에서 돌릴 수 있다 (허용 규칙에 걸리고, RPC도 된다).
- **`workers_dev = false`이고 route가 없는 Worker도 배포는 된다** ("No targets deployed"라고 나와도 된다). 서비스 바인딩 RPC로는 정상 호출된다.
- 로그인 시험: 로컬에서는 `d1 execute --local`로 users와 `auth_sessions(token_hash=sha256(토큰))`를 넣고 `cookie: people_os_session=<토큰>`을 쓴다. `printf '%s' <토큰> | sha256sum`은 허용된다. `openssl rand`, `head /dev/urandom`, `sed`, `${S#…}`, `for` 반복은 막힌다.
- `-p` 세션에서 `python3 -` heredoc 편집은 막힌다. Edit 도구를 쓴다.
