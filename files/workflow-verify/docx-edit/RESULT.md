# Word 기존 .docx 편집 — 라이브 통합 결과 (2026-11-22, Fable 5.2 단일 세션)

## 판정

- **파일럿: 조건부 도입 가능** (ooxml-core 2.0.0의 docx 영역). 근거와 조건은 `../docx-edit-pilot/RESULT.md`.
- **통합: 완료, 라이브에서 동작 확인.** 편집 Worker에 DOCX RPC를 더해 배포하고 이어서 People OS를 배포했다. 라이브에서 업로드 → inspect → ops 편집 → 새 버전 → 다시 읽기를 끝까지 돌렸고, 자연어 지시 편집(실제 Qwen)도 첫 시도에 맞게 됐다. 원본은 바이트 그대로이고 기존 엔드포인트는 배포 전과 바이트 동일하다.
- **남은 확인 1건: Word에서 직접 열어 보지 못했다.** `files/workflow-verify/docx-edit-pilot/out/edited-live.docx`(라이브 편집본, 7,730 B)를 Word에서 열어 복구 대화상자가 뜨지 않는지 봐야 한다. 이 VM에는 Word·LibreOffice가 없다.

## 배포

| 대상 | 버전 | 번들 | 시작 시간 |
|---|---|---|---|
| `people-os-doc-editor` (이름·바인딩 `DOC_EDITOR` 그대로, DOCX 추가) | `2828a924` → **`1dd93ed7-11c4-46d6-a73b-a86020f8ad19`** | 10,014 → **11,765 KiB** / gzip 2,463 → **2,868 KiB** (+405 KiB) | 113 → 192 ms |
| `people-os` | `40194b95` → **`ae40ce70-b281-45cb-9b5d-b248dc7cfef1`** | 9,005 KiB / gzip 1,858 KiB (ooxml-core는 본체에 안 들어감) | 118 ms |

편집 Worker 먼저, People OS 다음으로 직렬 배포했다. 승인 대기로 막힌 적은 없다. 스모크는 People OS 배포 3분 뒤에 했다. D1·DO 마이그레이션은 없다. 롤백은 People OS를 `40194b95`로 되돌리면 된다 (편집 Worker는 PPTX·XLSX RPC가 그대로라 두어도 된다).

- 별도 Worker로 나누지 않았다. 편집 Worker gzip 2,868 KiB는 유료 플랜 상한(10 MiB) 안이다.
- People OS 배포 때 자산이 4개 올라갔다. 3개는 이번에 바꾼 것(`index.html`·`workflow.js`·`docx-edit.js`)이고, 나머지 1개는 확인하지 못했다. 커밋 `8df4f2e`에서 바뀐 `public/architecture.svg`가 그때까지 배포되지 않았던 것으로 추정한다.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `pptx-editor/src/docx.js` (신규) | 편집 코어 (파일럿 `core.js`와 같은 내용). ops 5종, 상한, 저장본 다시 읽기 검증, 바뀐 부품 XML 검사 |
| `pptx-editor/src/index.js` | RPC 3개 추가: **`inspectDocument` / `applyDocumentOps` / `replaceDocumentText`**. PPTX·XLSX RPC는 그대로 |
| `pptx-editor/wrangler.toml` | 주석 1줄 (`[vars] DOCX_MAX_PARAGRAPHS`로 상한을 낮출 수 있음). `package.json`은 그대로 — ooxml-core 2.0.0이 이미 있다 |
| `src/docx/edit-types.ts` (신규) | `DocxEditOp`, `validateDocxEditOps`, `DocxEditorRpc`, 결과 타입 |
| `src/docx/edit.ts` (신규) | 원본 읽기(권한, .docx만) → (지시면 inspect + Qwen 계획) → 적용 → 새 버전 저장, replace 경로, 편집본 목록 |
| `src/index.ts` | import 1줄 + 라우트 3개: `POST /api/docx/inspect` · `POST /api/docx/edit` · `GET /api/docx/versions` |
| `src/workflow/types.ts` · `nodes.ts` · `think-agent.ts` | 노드 **`docx_edit`** (docId, ops 또는 instruction, title). 에이전트 기본 도구 목록에서는 뺐다 (pptx_edit·xlsx_edit과 같다) |
| `public/docx-edit.js` (신규) | Word 편집 화면: ① 찾아 바꾸기 ② 문단·표 셀 직접 고치기 ③ 자연어 지시 ④ ops JSON → 변경 전후 표, 편집본 목록 |
| `public/index.html` | Word 문서 행에 "편집본 만들기" 버튼(`openDocxEdit`). **"Word 편집 미지원" 안내 삭제.** `<script src="/docx-edit.js">` 1줄 |
| `public/workflow.js` | 빌더에 `docx_edit` 노드 폼 + "승인 뒤에 편집" 체크박스 |

`npx tsc --noEmit` 0건. `node --check`는 `public/docx-edit.js`, `public/workflow.js`, `pptx-editor/src/index.js`, `pptx-editor/src/docx.js` 모두 통과.

## 동작 요약

- **ops** (문단 번호는 inspect가 주는 읽는 순서 번호, 모두 편집 전 기준):
  `replace(find, to, all?)` · `paragraph(index, text)` · `cell(table, r, c, text)` · `insert(after, text)` · `delete(index)`
- **저장**: 편집본은 `documents` 새 행 + R2 `docs/edits/doc_<원본id>/<새 문서id>.docx`. 원본은 읽기만 한다. Vectorize 색인 안 함. 다운로드·삭제·목록·소유자 게이트는 기존 문서 경로가 맡는다.
- **편집 대상**: 업로드한 .docx뿐 아니라 "새 Word 문서 만들기"로 만든 문서와 앞선 편집본도 된다 (R2 키가 `.docx`면 된다).
- **승인 게이트**: `docx_edit` 단계의 `requiresApproval: true`를 엔진이 처리한다 (pptx_edit·xlsx_edit과 같은 선택 게이트).
- **자연어 지시**: Qwen3.8이 문서 요약을 보고 ops를 만든다. 닫는 괄호 보정(`closeTruncatedJson` 재사용), 배열만 낸 응답 보정, 문자열로 온 번호 보정을 거친다. 검증에 실패하거나 편집 Worker가 거부하면(없는 문단·못 찾는 글자) 그 오류를 알려 주고 **1번만 다시** 시킨다.
- **상한**: ops 100개, op 글자 10,000자, find 500자, 지시 2,000자, 파일 20 MiB, document.xml 8 MiB, **문단 5,000개**. 넘으면 413.

## 로컬 검증 (`npx wrangler dev --local -c wrangler.toml -c pptx-editor/wrangler.toml`)

| 시험 | 결과 | 근거 |
|---|---|---|
| 업로드 → `POST /api/docx/inspect` | 200, 문단 17·표 1 | `evidence/local-inspect.json` |
| ops 8개 편집 | 201, 바뀐 부품은 document.xml·header1.xml뿐 | `evidence/ops-all.json`, `local-edit.json` |
| 편집본 다운로드 → 다시 inspect | DOCX Content-Type. 김철수·650만 원·32·26·새 문단 확인 | `evidence/local-edited.docx`, `local-reinspect.json` |
| 원본 보존 | 편집 뒤 원본 다운로드가 업로드 파일과 `cmp` 동일 | `evidence/local-original-after.docx` |
| replace 경로 (`all: true`) | 201, 2곳 | `evidence/local-replace.json` |
| 편집본 목록 | 200, 최신순 | (응답) |
| 오류 경로 | 익명 401 ×3 / `deck:` source 400 / 없는 문서 404 / .xlsx 문서 415 / 입력 없음 400 / 없는 문단 422 / 못 찾는 글자 422 / 모르는 op 400 / ops+instruction 400 | (응답) |
| 문단 상한 | 문단 5,200개 문서 → inspect·edit 모두 413 | (응답) |
| **워크플로 `docx_edit` + 승인 게이트** | `waiting_approval`(편집본 없음) → approve → 편집(`{{input.newName}}` 치환, op 3개) → `create_task`가 `{{steps.s1.output.docId}}`를 받아 `succeeded` | `evidence/wf-docx.json`, `local-wf-run.json` |
| PPTX·XLSX 회귀 | `/api/xlsx/inspect`·`/api/pptx/inspect` 200, .docx를 xlsx로 열면 415 그대로 | (응답) |

로컬에서는 Workers AI를 부를 수 없어 자연어 지시 경로는 라이브에서만 시험했다.

## 라이브 검증 (배포 3분 뒤, `evidence/live-smoke/`)

**기존 엔드포인트** (`40194b95` 배포 전 vs `ae40ce70` 배포 후, `cmp`)

| 엔드포인트 | 전 | 후 | 판정 |
|---|---|---|---|
| `GET /api/health` | 200, 140 | 200, 140 | 바이트 동일 |
| `GET /api/auth/me` (익명) | 401, 52 | 401, 52 | 동일 |
| `POST /api/pptx/inspect` (익명) | 401, 52 | 401, 52 | 동일 |
| `POST /api/xlsx/inspect` (익명) | 401, 52 | 401, 52 | 동일 |
| **`POST /api/pptx/inspect` (로그인, 시험 덱)** | 200, 3,241 | 200, 3,241 | **동일** |
| **`POST /api/xlsx/inspect` (로그인, 시험 워크북)** | 200, 1,932 | 200, 1,932 | **동일** |
| `GET /api/library` (익명) | 200, 1,060 | 200, 1,060 | 동일 (정리 뒤에도 동일) |
| `/xlsx-edit.js` · `/pptx-edit.js` · `/docx-create.js` · `/styles.css` | — | — | 4개 모두 동일 |
| `GET /` | 200, 143,722 | 200, 143,845 | 의도한 변화, 로컬 `public/index.html`과 동일 |
| `GET /workflow.js` | 200, 78,403 | 200, 79,033 | 의도한 변화, 로컬과 동일 |
| `GET /docx-edit.js` | 404 | 200, 12,931 | 신규, 로컬과 동일 |
| `POST /api/docx/inspect` (익명) | 404 | 401 "로그인이 필요합니다." | 신규 라우트 |

**끝까지 간 편집** (임시 시험 계정)

1. Word 모양 시험 문서(7,742 B)를 개인 업로드 → 추출 ready.
2. `POST /api/docx/inspect` 200 — 문단 17, 표 1.
3. `POST /api/docx/edit` (ops 8개) **201**, 2.5초. 12개 부품 중 10개 동일, 바뀐 것은 `word/document.xml`·`word/header1.xml`.
4. 편집본을 기존 다운로드 라우트로 받아 **`docx-edit-pilot/out/edited-live.docx`**에 저장 (7,730 B, DOCX Content-Type).
5. 편집본 다시 inspect: 제목 "분기 코칭 리뷰 (라이브 편집됨)", "담당자는 김철수 팀장입니다."(run 3개에 걸쳐 있던 이름), "사내 위키(코칭)", "4분기(10~12월)", "650만 원", 새 문단, 표 32·26, "김철수 팀장 확인 필요". 대조군 문단 그대로.
6. 원본: 편집 뒤 다운로드가 업로드한 파일과 **`cmp` 동일**.
7. **자연어 지시** "문서 전체에서 홍길동을 이영수로 바꾸고, 제목 끝에 " — 최종"을 붙여 줘. 표의 세션 수 목표를 36으로 고치고, 예산 문단 뒤에 … 문단을 넣어 줘" → **201, `planned: true`, 1번째 시도**. Qwen이 만든 ops 4개(`replace all`, 제목 `replace`, `cell(1,1,1)=36`, `insert after 6`)가 지시와 모두 맞는다. `live-instruction.json`
8. 편집본 목록 200 (2개, 최신순). 익명 edit·versions 401.
9. 상한: 문단 5,200개 문서 inspect **413** "문단 수 상한 5,000 (5,200)", ops 101개 **413** "ops는 100개까지입니다 (101개)".

**CPU** (`wrangler tail people-os-doc-editor`, `live-smoke/tail-editor.jsonl`)

| RPC | cpuTime | wallTime |
|---|---|---|
| `inspectDocument` (문단 17개) | 71–104 ms | 81–113 ms |
| **`applyDocumentOps`** (ops 8개 + 다시 읽기·부품 비교·XML 검사) | **189 ms** | 207 ms |
| `applyDocumentOps` (AI 계획 ops 4개) | 219 ms | 235 ms |
| `inspectDocument` (문단 5,200개 → 상한 거부) | 821 ms | 991 ms |
| `inspect` (PPTX) / `inspectWorkbook` (XLSX) — 회귀 확인 | 270 / 28 ms | |

모두 outcome ok. People OS tail도 스모크 동안 23건 모두 ok, exceptions 0.

## 임시 데이터 정리

1. 운영 D1에 임시 사용자 `u_dxsmoke_tmp`(role user, 비밀번호 없음)와 2시간짜리 세션을 넣었다.
2. 스모크 뒤 문서 6개(PPTX 대조 1, XLSX 대조 1, Word 원본 1, 편집본 2, 큰 문서 1)를 `DELETE /api/documents/:id`로 지웠다. 벡터 428개도 함께 지워졌고 errors는 없다.
3. 세션과 사용자를 지웠다.
4. 확인 쿼리: **users 0 / auth_sessions 0 / documents 0 / doc_nodes 0 / chunks 0 / decks 0**. R2의 원본·편집본 키는 "The specified key does not exist". 익명 `/api/library`는 배포 전과 바이트 동일.
5. 시험 Worker `people-os-docx-edit-pilot`는 파일럿 단계에서 삭제했다.

남은 흔적은 AI Gateway 로그(tag `docx-edit-plan` 1건, 업로드 추출 4건)와 Workers Logs의 `docx.edit`·`docx.edit.plan` 이벤트뿐이다.

## 남은 문제·미확인

1. **Word에서 직접 열어 보지 못했다** (위 판정). `edited-live.docx`에서 볼 것: ① 복구 대화상자가 뜨지 않는지 ② 2번째 문단 "김철수"가 굵게인지 ③ 메모·변경 내용 추적·하이퍼링크·머리글이 살아 있는지 ④ 표 실적 셀이 "26" 한 줄인지.
2. **자연어 지시 편집이 71초 걸렸다** (요청 1건 실측, 편집 자체는 CPU 0.2초라 거의 전부 Qwen 응답 시간). XLSX 지시 편집은 16.5초였다. 한 번만 재서 평소 값인지 알 수 없다. 화면에는 "AI가 계획을 만들고 편집하는 중…"만 뜬다.
3. **재시도 경로(2번째 시도)는 라이브에서 일어나지 않았다.** 첫 시도가 성공해서다. JSON 보정·재시도는 코드로만 확인했다.
4. **실제 Word가 저장한 회사 문서로는 시험하지 않았다.** 시험 문서는 Word 구조를 손으로 흉내 낸 것과 docx 라이브러리가 만든 것이다. 각주·목차·콘텐츠 컨트롤·텍스트 상자·SmartArt가 든 문서는 미확인.
5. **문단을 직접 고치면(`paragraph` op) 그 문단의 글자 서식이 첫 run 서식 하나로 합쳐진다.** 화면에 안내를 넣었고, 일부만 바꿀 때는 찾아 바꾸기가 서식을 지킨다.
6. 글자를 고친 문단에서 메모 참조 표시의 글자 스타일(`CommentReference`)이 빠지고 `w:rsidR` 위치가 바뀐다. 보이는 내용에는 영향이 없다.
7. 중첩 표(표 안의 표)는 읽기 전용이다. 머리글·바닥글은 찾아 바꾸기로만 고친다.
8. 로그인 뒤 화면(`docx-edit.js`의 입력칸·결과 표)은 브라우저로 보지 못했다. API, `node --check`, 정적 자산 바이트 비교로만 확인했다.
9. 편집본의 `content`(요약하기용 텍스트)는 미리보기 400블록까지만 담는다.
10. 편집 Worker 시작 시간이 113 → 192 ms로 늘었다 (상한 400 ms 안).

## 이 세션의 교훈 (AGENTS.md 후보 — 세션에서 `~/AGENTS.md`는 쓸 수 없어 여기 적는다)

- **ooxml-core 2.0.0의 `ooxml-core/docx`는 patch 방식 writer다**: 안 고치고 저장하면 파일 전체가 바이트 동일하고, 고친 문단만 다시 쓴다. `nodejs_compat` 없이 돈다.
- **ooxml-core docx 저장본은 ZIP 수정 시각 때문에 요청마다 4바이트가 다르다** (부품 내용은 같다). xlvane과 달리 파일 전체 `cmp`를 회귀 시험에 쓸 수 없다 — 부품 단위로 비교한다.
- **파일럿에서 ooxml-core를 다시 설치할 필요가 없다**: 시험 Worker `wrangler.toml`의 `[alias] "ooxml-core/docx" = "<pptx-editor/node_modules 경로>/dist/docx/index.mjs"`로 편집 Worker의 사본을 그대로 쓴다 (190 MB 설치 생략).
- `-p` 세션에서 `cmp a b; echo "cmp=$?"`와 `E=<dir>; cmp $E/…`는 막힌다. `cmp a b && echo SAME`, 그리고 `cd <절대 경로> && cmp 상대경로 …`는 된다 (`../`로 작업 폴더 밖을 가리키면 막힌다).
- `cd <dir> && curl -o …`처럼 cd와 쓰기를 한 명령에 넣으면 막힐 때가 있다 (cwd가 저장소 루트일 때). 루트에서 상대 경로로 `curl --create-dirs -o`를 쓴다.
- `~/workspace/research_notes/`는 세션 작업 폴더가 아니라 읽을 수 없다. 조사 보고서를 보게 하려면 `--add-dir`에 넣는다.
- 5,000문단 문서를 개인 업로드하면 청크 425개가 Vectorize에 색인된다. 상한 시험용 큰 문서는 지울 때 벡터까지 지워지는지 확인한다 (이번에는 `vectorsDeleted: 425`).

## 산출물

- Word 확인용: **`files/workflow-verify/docx-edit-pilot/out/edited-live.docx`**
- 근거: `files/workflow-verify/docx-edit/evidence/` — `ops-all.json`, `wf-docx.json`, `local-*.json`·`local-*.docx`, `live-smoke/` (before/after, `req-*.json`, `live-*.json`, `tail-*.jsonl`)
- 파일럿: `files/workflow-verify/docx-edit-pilot/` (`RESULT.md` 참조)
- 지워도 되는 것: `files/workflow-verify/docx-edit/harness/` (지운 세션 표시와 0바이트 R2 확인 파일), 로컬 상태 `files/workflow-verify/xlsx-edit-pilot/state/`에 더해진 시험 문서
