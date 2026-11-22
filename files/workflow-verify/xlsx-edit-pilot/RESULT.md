# 엑셀(.xlsx) 편집 — xlvane 파일럿 + 라이브 통합 결과 (2026-11-21, Opus 5.5 단일 세션)

## 판정

- **파일럿: 통과 (도입 가능, 조건 없음).** 값·수식(+캐시 result)·행 추가·시트 추가가 로컬 workerd와 원격 Workers 모두에서 동작한다. 저장본은 다시 열리고, XML은 모든 부품이 well-formed이며, 손대지 않은 시트는 바이트가 같다. 번들은 gzip 134 KiB(최소 경로)로 작다. CPU는 시험 워크북에서 90–190 ms, 100k셀 워크북에서 약 4.0초였다.
- **통합: 완료, 라이브에서 동작 확인.** 편집 Worker `people-os-pptx-editor`에 XLSX RPC를 더해 배포했고, 이어서 People OS를 배포했다. 라이브에서 업로드 → inspect → ops 편집 → 새 버전 저장 → 다시 읽기를 끝까지 돌렸다. 자연어 지시 편집(실제 Qwen이 ops를 만듦)도 확인했다. 원본은 바이트 그대로이고, 기존 엔드포인트 10건도 바이트 동일하다.
- **남은 확인 1건: Excel에서 직접 열어 보는 확인은 하지 않았다.** `xlsx-edit-pilot/out/edited-live.xlsx`를 사람이 Excel에서 열어 복구 대화상자가 뜨지 않는지, 수식이 다시 계산되는지 봐야 한다. 이 VM에는 Excel·LibreOffice가 없다. **사용자 확인 완료 (2026-11-21 15:29, "이상없어") — 복구 대화상자 없음, 수식 재계산, 메모 시트 정상.**

## 배포

| 대상 | 버전 | 번들 | 시작 시간 |
|---|---|---|---|
| `people-os-pptx-editor` (이름·바인딩 그대로, xlsx 추가) | `b0c17fb1` → **`84973507-d5e5-4898-873e-1c22462f5b6c`** | 9,449 → **10,014 KiB** / gzip 2,319 → **2,463 KiB** (+144 KiB) | 113 ms |
| `people-os` | `a20936b2` → **`4a7af7af-f6f1-44b8-b027-f85e10bdc156`** | 8,406 → **8,429 KiB** / gzip 1,728 → **1,731 KiB** (xlvane은 본체에 안 들어감) | 106 ms |

편집 Worker를 먼저, People OS를 다음에 직렬로 배포했다. `cf-wrangler.py deploy --config <절대 경로>`를 직접 실행했고 승인 대기로 막힌 적은 없다. 스모크는 People OS 배포 3분 뒤에 했다. 롤백할 때는 People OS를 `a20936b2`로 되돌리면 된다. 편집 Worker는 PPTX RPC가 그대로라서 두어도 무해하다. 이번 배포에는 D1 마이그레이션도 DO 마이그레이션도 없다.

---

## 1단계: 파일럿 (`files/people-os/xlsx-edit-pilot/`)

### 1. 설치 — 통과
- `npm install --save-exact xlvane` → **xlvane 1.3.4** (MIT, 의존성 `fflate` ^0.8.3 → 0.8.3 설치). 2초, 2개 패키지, 경고 없음.
- 설치 크기: `node_modules` 합계 **2.6 MB** (PPTX 파일럿 ooxml-core는 190 MB).
- package.json에 `"xlvane": "1.3.4"`로 고정했다. `npm view`는 이번에 시도하지 않았다 (지난 PPTX 세션에서 승인 대기). 버전은 설치된 package.json 기준이다.

### 2. 시험 워크북 — 통과
`src/book.js`, xlvane `createWorkbook`으로 만든 5,113 B 파일이다.
- `요약`: 굵게·배경색 서식, 값 셀, 수식 셀 3개. `SUM(B4:B5)`은 result 54, `AVERAGE`는 27, 시트를 넘는 `SUM(데이터!C2:C5)`는 26으로 캐시를 직접 계산해 넣었다.
- `데이터`: 표 `코칭세션`(헤더 + 4행, TableStyleMedium2).
- `대조군`: 편집하지 않는 시트 (값 2개와 수식 1개).
- `fullCalcOnLoad: true`.

### 3. 편집 — 통과 (16개 검사 전부 true, 로컬·원격 같음)
ops 9개를 적용했다: 값 교체 2, 수식 교체 4(수식 + 캐시 result), 행 추가 1, 시트 추가 1, 새 시트 채우기 2. 다시 읽은 결과:

| 검사 | 결과 |
|---|---|
| `요약!B4` 24→25, `A7` 평균→최대 | ✅ |
| `B6` `SUM(B4:B5)` → 55, `B7` `AVERAGE`→`MAX(B4:B5)` → 30, `B8` `SUM(데이터!C2:C6)` → 30 | ✅ (`=`로 시작한 수식 입력도 정규화) |
| 서식 유지 (`A1` 굵게·배경, `B6` 굵게) | ✅ |
| 행 추가: `데이터` 6행 정코치/커리어/4, **표 범위 A1:C5 → A1:C6로 늘어남** | ✅ |
| 시트 추가 `메모`(맨 뒤, sheetId 4, rId6), `A1`·`B1=요약!B6 → 55` | ✅ |
| **대조군 `xl/worksheets/sheet3.xml` 바이트 동일**, 값 동일 | ✅ |
| `calcPr fullCalcOnLoad="1"` | ✅ (편집 결과 경고 `XLV_W_FORMULAS_NOT_RECALCULATED`) |
| XML well-formed — 부품 13개 전부 | ✅ (자체 검사기, 음성 시험 6종을 모두 잡음: 태그 짝, 속성 중복, 미정의 엔티티, 미닫힘, 루트 두 개, 따옴표 없는 속성) |
| 원본 입력 bytes가 그대로인지 | ✅ |

- 부품 비교: 그대로 5개 (styles, core.xml, rels, sheet3 …). 바뀐 것 7개는 `[Content_Types].xml`, workbook.xml, workbook.xml.rels, sheet1, sheet2, sharedStrings, table1이다. 추가는 sheet4 1개다.
- **시트 추가는 xlvane에 기존 파일용 API가 없다.** 그래서 ZIP 부품을 직접 고쳤다. 새 worksheet 부품을 넣고, workbook.xml `<sheets>`, workbook.xml.rels, `[Content_Types].xml` Override에 한 줄씩 추가했다. 그다음 `editCells`로 채운다. 다른 부품은 바이트를 건드리지 않는다.
- 로컬 편집본(`out/edited-local.xlsx`)과 원격 편집본(`out/edited-remote.xlsx`)이 **`cmp` 동일**하다. xlvane 출력이 결정적이기 때문이다.

### 4. Workers 호환 — 통과
| 항목 | 결과 |
|---|---|
| 로컬 `npx wrangler dev --local` | 모든 라우트 200 |
| 최소 Worker 번들 (`src/minimal.js`: editCells 1칸, nodejs_compat 없음) | **520 KiB / gzip 134 KiB** |
| 시험 Worker 번들 (`src/lab.js`) | 677 KiB / gzip 177 KiB |
| 원격 `people-os-xlsx-pilot` 배포 | 성공, Startup 20 ms, 버전 `21e88276-6d28-468f-a071-254892ea61b4` |
| 원격 selftest | 16/16 통과 (`out/selftest-remote.json`) |
| 삭제 | `cf-wrangler.py delete --name people-os-xlsx-pilot --force` → "Successfully deleted" ✅ |

### 5. CPU (원격 tail, `evidence/tail-pilot-summary.json`)
| 요청 | cpuTime | wall |
|---|---|---|
| selftest (9 ops + 모든 검증) | 156 ms | 161 ms |
| edit 1칸 | 90 ms | 96 ms |
| 오류·상한 시험 12종 | 521 ms | 535 ms |
| **100,003셀 워크북** (508 KB, 셀 + 행 + 수식 op, 다시 읽기·diff·전체 XML 검사 포함) | **3,975 ms** | 4,238 ms |

모두 outcome ok, exceptions 0. 이 계정은 요청당 CPU 수 초를 허용한다 (PPTX도 1.5초가 통과했다).

### 오류·상한 (`out/limits-*.json`)
셀 상한 초과는 limit, 시트 상한 초과도 limit이다. 없는 시트는 not_found(사용 가능한 시트 목록과 함께)로 답한다. 잘못된 셀 주소·같은 이름 시트·금지 문자 시트·빈 수식·객체 값·ZIP이 아닌 입력은 bad_input이다. 표 헤더 셀을 비우면 xlvane이 bad_input으로 거부한다 (표가 깨지지 않게). result 없는 수식은 허용한다. 값 셀의 `"=1+1"`은 **텍스트로 저장되고 수식이 되지 않는다** (수식 주입 방지).

---

## 2단계: 라이브 통합

### 바뀐 파일
| 파일 | 내용 |
|---|---|
| `pptx-editor/package.json`·lock | **`xlvane` 1.3.4** 추가 (`--save-exact`). 기존 `fflate 0.8.3`, ooxml-core 2.0.0, pptx-viewer-core 5.0.0은 그대로 |
| `pptx-editor/src/xlsx.js` (신규) | 파일럿 core를 옮겼다. 셀 상한 200,000, XML 검사는 바뀐·추가된 부품만 하고 실패하면 internal로 거부한다. 상한 오류는 한국어로 바꾼다. `xlsxLimits(env)`(`[vars] XLSX_MAX_CELLS`/`XLSX_MAX_SHEETS`로 **낮추기만** 가능), `replaceCellText` |
| `pptx-editor/src/index.js` | `PptxEditor`에 RPC 3개를 더했다: **`inspectWorkbook` / `applyWorkbookOps` / `replaceCell`**. PPTX RPC(`inspect`/`applyOps`/`replaceText`)는 그대로다. `toFailure`가 xlsx EditError도 받는다. GET / 상태에 rpc 목록과 xlsxLimits를 보여 준다 |
| `pptx-editor/wrangler.toml` | 주석 1줄만 바꿨다 (이름·바인딩·vars 그대로. 가드 시험 때 잠깐 넣은 `[vars]`는 원복했다) |
| `src/xlsx/types.ts` (신규) | `XlsxOp`(cell·formula·row·sheet), `validateXlsxOps`, `XlsxEditorRpc`, 결과 타입 |
| `src/xlsx/edit.ts` (신규) | 원본 읽기(권한, .xlsx만) → (지시면 inspect + Qwen 계획 + 시트 대조 검증) → applyWorkbookOps → 새 버전 저장, replace 경로, 편집본 목록 |
| `src/index.ts` | import 1줄과 라우트 3개를 PPTX 라우트 바로 뒤에 추가했다: `POST /api/xlsx/inspect` · `POST /api/xlsx/edit` · `GET /api/xlsx/versions` (인증은 `pptxCaller` 재사용) |
| `src/workflow/types.ts` | `NODE_TYPES`에 `xlsx_edit`. **`AGENT_DEFAULT_TOOLS`에서는 뺐다** (pptx_edit과 같다) |
| `src/workflow/nodes.ts` | `xlsx_edit` 노드 (docId, ops 또는 instruction, title). 권한·승인은 pptx_edit과 같다 |
| `src/workflow/think-agent.ts` | 노드별 키 힌트(`"xlsx_edit.ops"` 등)를 추가했다. `keySchema`가 `노드.키` 힌트를 먼저 본다 (pptx_edit 힌트는 그대로) |
| `public/xlsx-edit.js` (신규) | `openDocEdit()` 분기: 덱은 PPTX로 연다. 업로드 문서는 먼저 xlsx inspect를 해 보고, "XLSX 파일만"(415)이면 PPTX 편집으로 넘긴다. 패널: ① 미리보기 격자(값 셀 입력칸, 수식 셀은 회색 읽기 전용 `=수식 → 캐시값`) ② 자연어 지시 ③ ops JSON → 변경 전후 셀 diff 표, 편집본 목록. **수식 안내 "수식은 Excel이 열 때 다시 계산합니다"**는 수식이 있는 파일·수식 diff에 보인다. textContent만 쓴다 |
| `public/index.html` | 라이브러리 행 버튼이 `openPptxEdit` 대신 `openDocEdit`를 부른다 (버튼 표시 조건은 그대로). `<script src="/xlsx-edit.js">` 1줄 추가 |
| `public/workflow.js` | 빌더에 `xlsx_edit` 노드 폼과 "승인 뒤에 편집" 체크박스 (pptx_edit과 같은 분기) |

### 저장 위치 (코드에서 확인한 것)
- 엑셀 원본은 **업로드 문서**뿐이다: `handleDocumentFileUpload`가 R2 `docs/<id>/source.<ext>`에 원본을 두고 `documents.source_r2_key`에 적는다. 덱(`decks`)은 PPTX 전용이다 (`GET /api/deck/:id`가 PPTX Content-Type 고정).
- 그래서 편집본은 **`documents`의 새 행 + 새 R2 키 `docs/edits/doc_<원본id>/<새 문서id>.xlsx`**로 저장한다. 행은 kind `file`, extract_status `ready`, content는 시트 미리보기 텍스트, r2_key는 NULL, source_r2_key는 새 키다. R2 customMetadata는 `editedFrom`·`sourceKey`·`ops`, httpMetadata contentType은 XLSX MIME이다.
- 결과: 다운로드(`GET /api/documents/:id/download`, 확장자·Content-Type이 R2 키·httpMetadata에서 나온다)·삭제(`DELETE /api/documents/:id`)·라이브러리 목록·소유자 게이트를 기존 문서 경로가 그대로 맡는다. **D1 마이그레이션은 없다.** 원본 키에는 쓰지 않는다.
- 편집본은 Vectorize에 **색인하지 않는다**. 같은 표의 여러 버전이 RAG 검색에 겹치지 않게 하려는 것이다.

### 정적 검사
- `npx tsc --noEmit`: 오류 **0**.
- `node --check`: `public/xlsx-edit.js`, `public/workflow.js`, `pptx-editor/src/index.js`, `pptx-editor/src/xlsx.js` 모두 **0**.

### 로컬 (`npx wrangler dev --local -c wrangler.toml -c pptx-editor/wrangler.toml`, 상태 `xlsx-edit-pilot/state/`)
새 상태 디렉터리에 ensureSchema를 돌리고 0012·0015·0021·0024·0027·0028·0029·0040·0042 파일과 ALTER(owner_id·is_coaching·coaching_role)를 `d1 execute --local`로 넣었다. 그다음 시험 사용자와 세션을 만들었다.

| 시험 | 결과 | 근거 |
|---|---|---|
| 시험 워크북 업로드 → `POST /api/xlsx/inspect` | 200, 시트 3, 서비스 바인딩 RPC 동작 | `evidence/local-inspect.json` |
| ops 9개 편집 | 201, 시트 4, 5,529 B, **sheet3.xml identical** | `evidence/ops-all4.json`, `local-edit.json` |
| 편집본을 기존 다운로드 라우트로 받음 | 200, XLSX Content-Type, 한글 파일명. **파일럿 편집본과 `cmp` 동일** | `xlsx-edit-pilot/out/edited-local-integration.xlsx` |
| 다시 inspect | B4 25, B6 55, B7 MAX → 30, 표 A1:C6, 정코치, 메모 시트 | `evidence/local-reinspect.json` |
| 원본 보존 | 편집 뒤 원본 다운로드가 업로드 파일과 **`cmp` 동일** | `evidence/local-original-after.xlsx` |
| replace 경로 | 201, `요약!A1` "2026 코칭 현황" → "…(수정)" | `evidence/local-replace.json` |
| 편집본 목록 | 2개, 최신순 | (응답) |
| 오류 경로 | 익명 401 / `deck:` source 400 / 없는 문서 404 / 없는 시트 422 / 셀 주소 오류 400 / 입력 없음 400 / 표 헤더 비우기 422 / **.pptx 문서를 xlsx로 열면 415 "XLSX 파일만"** (UI 분기 근거), 같은 문서의 `/api/pptx/inspect`는 200 (PPTX 회귀 없음) | (응답) |
| **가드** | 편집 Worker `[vars] XLSX_MAX_CELLS="20"`으로 **잠깐 낮춰** 시험했다 (시험 뒤 원복). inspect와 edit 모두 **413** "워크북이 편집 상한을 넘습니다 — 셀 수 상한 20" | (응답) |
| **워크플로 `xlsx_edit` + 승인 게이트** | `requiresApproval: true` → run **waiting_approval** (편집 전) → approve → 편집(`{{input.coach}}` 치환, op 3개) → `create_task`가 `{{steps.s1.output.docId}}`를 받아 run **succeeded** | `evidence/wf-xlsx.json`, `local-wf-run.json` |

첫 워크플로 실행은 2단계 `create_task`에서 로컬 `tasks.owner_id` 열이 없어서 실패했다 (로컬 스키마 차이). 0021을 넣고 다시 돌려 succeeded를 확인했다. xlsx_edit 단계는 두 번 모두 성공했다.

### 원격 (라이브 스모크, 배포 3분 뒤)

**기존 엔드포인트** (`a20936b2` 배포 전 vs `4a7af7af` 배포 후, `cmp`) — `evidence/live-smoke/before-*`, `after-*`

| 엔드포인트 | 전 | 후 | 판정 |
|---|---|---|---|
| `GET /api/health` | 200, 140 | 200, 140 | 바이트 동일 |
| `GET /agents.js` | 200, 29,313 | 200, 29,313 | 동일 |
| `GET /styles.css` | 200, 27,576 | 200, 27,576 | 동일 |
| `GET /approval.js` | 200, 24,752 | 200, 24,752 | 동일 |
| `GET /pptx-edit.js` | 200, 10,992 | 200, 10,992 | 동일 |
| `GET /api/auth/me` (익명) | 401, 52 | 401, 52 | 동일 |
| `GET /api/library` (익명) | 200, 2,670 | 200, 2,670 | 동일 (정리 뒤에도 동일) |
| `GET /api/workflows/templates` (익명) | 401, 41 | 401, 41 | 동일 |
| `GET /api/deck/nope` | 404, 37 | 404, 37 | 동일 |
| `POST /api/pptx/inspect` (익명) | 401, 52 | 401, 52 | 동일 |
| `GET /` (홈) | 200, 140,002 | 200, **140,200** | **의도한 변화**, 로컬 `public/index.html`과 바이트 동일 |
| `GET /workflow.js` | 200, 74,196 | 200, **74,910** | **의도한 변화**, 로컬과 동일 |
| `GET /xlsx-edit.js` | 404 | 200, 11,249 | **신규**, 로컬과 동일 |
| `POST /api/xlsx/inspect` (익명) | 404 | 401 "로그인이 필요합니다." | **신규 라우트** |

**끝까지 간 편집** (임시 시험 계정 세션)
1. 시험 워크북(5,113 B)을 개인 업로드했다 (라이브에서는 toMarkdown 추출 ready, 원본 청크 1개 색인).
2. `POST /api/xlsx/inspect` 200 → `POST /api/xlsx/edit` (ops 9개) 201, 시트 4, 5,536 B, **sheet3.xml identical**, `fullCalcOnLoad` true.
3. 편집본을 기존 다운로드 라우트로 받아 **`xlsx-edit-pilot/out/edited-live.xlsx`**(5,536 B, XLSX Content-Type)에 저장했다. 다시 inspect하니 B4 25, B6 `SUM` → 55, B7 `MAX` → 30, B8 → 30, 표 A1:C6, 정코치, 메모!A1 "라이브 편집됨"이었다.
4. 원본: 편집 전후 다운로드가 **`cmp` 동일**하고, 업로드한 `test-book.xlsx`와도 동일하다.
5. **자연어 지시** "요약 시트의 하반기 세션 값을 32로 바꾸고, 합계와 평균 수식의 결과도 새 값에 맞게 고쳐 줘" → 201, `planned: true`. Qwen이 만든 ops는 `B5=32`, `B6 SUM(B4:B5) result 56`, `B7 AVERAGE(B4:B5) result 28`이다. **캐시 result 계산까지 맞다** (24+32=56, 평균 28). 전체 16.5초(LLM 포함). `evidence/live-smoke/live-instruction.json`
6. 익명으로 `/api/xlsx/edit`와 `/api/xlsx/versions`를 부르면 401. 로그인하면 편집본 목록 2개, 최신순.

**CPU (`wrangler tail people-os-pptx-editor`, 원격 실측)** — `evidence/live-smoke/tail-summary.json`

| RPC | 내용 | cpuTime | wallTime | outcome |
|---|---|---|---|---|
| `inspectWorkbook` | 시험 워크북 | 53 ms | 63 ms | ok |
| `applyWorkbookOps` | **ops 9개** (+ 다시 읽기·diff·부품 비교·XML 검사) | **175 ms** | 183 ms | ok |
| `inspectWorkbook` | 편집본 다시 읽기 | 42 ms | 48 ms | ok |
| `inspectWorkbook` | 지시 편집 계획용 요약 | 33 ms | 42 ms | ok |
| `applyWorkbookOps` | ops 3개 (AI 계획) | 79 ms | 83 ms | ok |

PPTX 편집 1회(1,566 ms)보다 약 1/9 수준이다. **People OS tail**: 스모크 동안 22건 모두 outcome ok, exceptions 0.

### 시험 흔적과 정리 (운영 D1·R2·Vectorize)
1. 운영 D1에 임시 사용자 `u_xlsmoke_tmp`(role user, 비밀번호 없음 = 로그인 불가)와 **1시간짜리 세션**을 넣었다.
2. 스모크를 마친 뒤 문서 3개(원본 1, 편집본 2)를 **기존 `DELETE /api/documents/:id`로 지웠다**. R2·청크·벡터(원본 1개)도 함께 지워졌고 errors는 없다.
3. `purgeDocument`가 지우지 않는 `doc_nodes` 2행(업로드 때 만든 트리)을 직접 지웠다. 이어서 세션과 사용자를 지웠다.
4. 확인 쿼리: **users 0 / auth_sessions 0 / documents 0 / doc_nodes 0 / chunks 0**. 익명 `/api/library`는 배포 전과 바이트 동일하다.

남은 흔적은 AI Gateway 로그(tag `xlsx-edit-plan` 1건과 업로드 추출 toMarkdown 1건)와 Workers Logs의 `xlsx.edit` 이벤트 2건뿐이다.

---

## 남은 한계

1. **Excel에서 열리는지 직접 확인하지 않았다.** 근거는 xlvane 재파싱, 자체 XML well-formed 검사, 부품 바이트 비교뿐이다. **`xlsx-edit-pilot/out/edited-live.xlsx`(라이브 편집본, 시트 4)를 Excel에서 열어** 두 가지를 봐야 한다. ① 복구 대화상자가 뜨지 않는지 ② 수식이 다시 계산되는지(fullCalcOnLoad). 특히 **직접 추가한 시트 `메모`**가 정상으로 보이는지 확인한다. 이 시트는 xlvane이 아니라 직접 ZIP을 고쳐 만들었다.
2. 시트 추가는 `docProps/app.xml`의 TitlesOfParts(시트 이름 목록)를 고치지 않는다. Excel이 만든 파일이라면 이 목록이 옛것으로 남는다. Excel은 열 때 다시 쓰므로 보통 문제가 없지만 확인하지 않았다. 이번 시험 워크북에는 app.xml이 없다.
3. **실제 회사 엑셀**(Excel이 만든 파일: 피벗·차트·조건부 서식·외부 링크·매크로)로는 시험하지 않았다. xlvane README는 editCells가 다른 부품을 바이트 그대로 둔다고 하고, 파일럿에서도 손대지 않은 시트는 바이트가 같았다. 다만 행 추가(`appendRows`)는 차트·피벗이 그 시트를 참조하면 거부한다(`XLV_E_NOT_SUPPORTED`, 422로 보임).
4. 수식은 계산하지 않는다. result를 주지 않은 수식이나, 값이 바뀌었는데 다시 고치지 않은 수식은 Excel이 열 때까지 **옛 캐시값**을 보여 준다. 웹 미리보기·inspect·편집본의 텍스트 content가 이 경우다. UI와 노드 출력에 안내를 넣었다. AI 계획 프롬프트는 "값이 바뀌면 그 값을 쓰는 수식의 result도 함께 고쳐라"라고 시킨다.
5. xlvane의 bad_input 오류 문구 일부(예: 표 헤더 셀)는 영어로 나온다 (상한 오류만 한국어로 바꿨다).
6. 업로드 문서의 "편집본 만들기" 버튼은 xlsx inspect를 먼저 해 본다. 그래서 .pptx 문서는 요청이 1번 더 간다 (415, R2를 읽기 전에 키 확장자로 거른다). `/api/library` 응답을 바꾸지 않으려고 이렇게 했다.
7. 로그인 뒤 UI 화면(격자·diff 표)은 브라우저로 보지 않았다. API, `node --check`, 정적 자산 바이트 비교로만 확인했다.
8. 가드 상한값: 입력 20 MiB(People OS 업로드는 10 MB), 압축 해제 200 MiB, ZIP 항목 5,000, 시트 50, **셀 200,000**(파일럿에서 100k셀이 CPU 약 4초), ops 200, 행 1개 200칸, 텍스트 32,767자, 수식 8,192자. People OS 쪽 ops 200개 초과 400은 코드로만 확인했고 실제 요청은 보내지 않았다.

## 후속 과제

- **큰 파일은 Queue 소비자에서 처리**: 수만 행 워크북이나 셀 상한에 가까운 편집은 "제출 라우트 + 나중에 읽는 결과 라우트"로 나눈다. 큐 메시지 1개가 편집 1회이고, 소비자가 `PPTX_EDITOR.applyWorkbookOps`를 부른다. 이번 범위에서는 하지 않았다.
- 사람이 Excel에서 `edited-live.xlsx`를 확인한다. 복구 대화상자가 뜨면 먼저 시트 추가(직접 ZIP 편집)를 의심하고, `sheet` op를 막은 채로 다시 시험한다.
- 실제 회사 엑셀(피벗·차트·조건부 서식 포함)로 손대지 않은 부품이 보존되는지 시험한다.
- `purgeDocument`가 `doc_nodes`를 지우지 않는다 (이번 변경과 무관한 기존 동작, 문서 삭제 시 트리 행이 남음). 따로 고친다.
- Worker 이름 `people-os-pptx-editor` → `people-os-doc-editor`는 제출 뒤 정리한다 (사용자 결정대로 이번에는 바꾸지 않았다).
- 편집 요청 레이트 제한: PPTX와 같다 (지금은 로그인만 요구).

## 승인 대기로 막힌 것 (Merlin 보고)

- `unzip -p`(편집본 부품 보기): 막혔다. 시험 Worker에 `/part` 라우트를 만들어 대신 봤다.
- `cp`로 /tmp의 tail 출력이나 PPTX 로컬 상태 디렉터리(`cp -r`)를 복사하는 것: 막혔다. tail은 필요한 필드를 요약 JSON으로 옮겨 적었다. 로컬 상태는 새로 만들었다.
- heredoc으로 파일 끝에 덧붙이기(`cat >> … <<'EOF'`): "expansion obfuscation"으로 막혔다. Edit 도구로 대신했다.
- `Monitor`의 `until [ $(date …) ]` 대기: 막혔다. 백그라운드 `sleep`으로 대신했다.
- 그 밖에 `npm install --prefix`, `wrangler dev --local`, `cf-wrangler.py deploy/--dry-run/tail/delete/d1 execute --remote`, `d1 execute --local`, 로컬·원격 curl, `cmp`, `node --check`, `npx tsc`는 모두 실행됐다.

## 이 세션의 교훈 (AGENTS.md 후보)

- **`-p` 세션에서 `d1 execute`는 `--local`을 맨 뒤에 둬야 허용 규칙에 걸린다** (`npx wrangler d1 execute people-os-db --persist-to <dir> --file <f> --local`).
- `unzip`·`cp -r`은 막힌다. ZIP 부품은 Worker 라우트로 본다.
- xlvane 출력은 결정적이다 (같은 입력과 ops면 로컬·원격 바이트가 같다). 회귀 시험에 `cmp`를 쓸 수 있다.
- 업로드 문서 삭제(`purgeDocument`)는 `doc_nodes`를 남긴다. 라이브 스모크 정리 쿼리에 `doc_nodes`를 넣을 것.

## 산출물

- 파일럿: `files/people-os/xlsx-edit-pilot/`
  - 설정: `package.json`(xlvane 1.3.4 고정), `wrangler.toml`(lab), `wrangler.minimal.toml`
  - 코드: `src/{core,book,lab,minimal}.js`
  - 결과: `out/test-book.xlsx`, `edited-local.xlsx`, `edited-remote.xlsx`, `edited-local-integration.xlsx`, **`edited-live.xlsx`**(Excel 확인용), `big-10k*.xlsx`, `selftest-*.json`, `limits-*.json`, `dryrun-*/`
  - 지워도 되는 것: `.wrangler-state/`
- 근거: `files/workflow-verify/xlsx-edit-pilot/evidence/`
  - 시험 입력: `ops-all4.json`, `wf-xlsx.json`
  - 로컬 응답: `local-*.json`
  - CPU: `tail-pilot-summary.json`
  - 라이브: `live-smoke/` (before/after, live-*.json, tail-summary.json)
- 로컬 상태 `files/workflow-verify/xlsx-edit-pilot/state/` (지워도 됨)
