# 제출 전 수정 3건 결과 (2026-11-22, Opus 5.5 단일 세션)

커밋·태그·푸시 안 함. ARCHITECTURE.md·VERIFICATION.md 안 건드림.

## 배포 버전

| 대상 | 이전 | 새 버전 |
|---|---|---|
| 문서 편집 Worker | `people-os-pptx-editor` 84973507 (**삭제함**) | `people-os-doc-editor` **2828a924-5d1c-4116-bcbd-88d25f35ac31** |
| People OS 본체 | 474e11ab | **40194b95-b2fe-40c4-b279-af4c7727181f** (과제 1·2·3을 한 번에 배포) |

순서(직렬): 편집 Worker 새 이름 배포 → `versions list`로 2828a924 확인 → 본체 배포(바인딩 `env.DOC_EDITOR (people-os-doc-editor)` 출력 확인) → 3분 대기 → 라이브 검증 → 옛 Worker 삭제 → 삭제 확인 → 삭제 뒤 PPTX inspect 다시 200.

검사: `npx tsc --noEmit` 0건. `node --check` 통과: `public/pptx-edit.js`, `public/xlsx-edit.js`, `pptx-editor/src/index.js`. `public/index.html`은 HTML이라 `node --check`를 못 돌렸다 (인라인 스크립트에 한 줄만 추가했고, 라이브 HTML에서 그 줄을 눈으로 확인함).

## 과제 1 — 편집 Worker 개명 (`people-os-pptx-editor` → `people-os-doc-editor`)

바뀐 파일:
- `pptx-editor/wrangler.toml` — `name = "people-os-doc-editor"`, 주석
- `wrangler.toml` — `[[services]] binding = "DOC_EDITOR"`, `service = "people-os-doc-editor"`, 주석
- `src/pptx/edit.ts` — `PptxEnv.DOC_EDITOR`, `env.DOC_EDITOR`, 에러 문구 "문서 편집 Worker(DOC_EDITOR)가 연결되지 않았습니다."
- `src/xlsx/edit.ts` — `XlsxEnv.DOC_EDITOR`, `env.DOC_EDITOR`, 에러 문구 같음
- `src/pptx/types.ts`, `src/xlsx/types.ts` — 주석
- `src/workflow/types.ts:31` — `DOC_EDITOR?: Fetcher`
- `src/workflow/nodes.ts` — 주석 2곳
- `src/index.ts` — `Env.DOC_EDITOR`, import 주석, 라우트 주석
- `pptx-editor/src/index.js` — 머리 주석, `GET /` 상태 응답의 `service: "people-os-doc-editor"`
- `public/pptx-edit.js`, `public/xlsx-edit.js` — 머리 주석만

**폴더명 `pptx-editor/`는 그대로 둠.**

잔재 grep (`PPTX_EDITOR|people-os-pptx-editor`, src/·wrangler.toml 두 개·pptx-editor/src·public/): 남은 것은 개명 이력 주석 3줄(두 wrangler.toml, pptx-editor/src/index.js)과 `public/architecture.svg` 2곳뿐이다. SVG는 문서 그림이라 Merlin 몫으로 남겨 뒀다 (아래 목록 참고). 폴더 경로 `pptx-editor/…`를 가리키는 주석은 폴더명을 유지하므로 그대로 뒀다.

라이브 검증 (workers.dev, hr_admin 임시 세션):

| 호출 | 상태 | 확인한 값 |
|---|---|---|
| `POST /api/pptx/inspect` `deck:deck_mwf14fsf_nmvrnq` (기존 샘플 덱) | 200 | slideCount 3 |
| `POST /api/pptx/edit` replace `일잇 PEOPLE OS`→`DOC-FIX 시험` | 201 | 편집본 `deck_mwqo0fjk_lgw0nb`, 18,781 B, 3장 → `DELETE /api/decks/:id` 200으로 삭제 |
| `POST /api/xlsx/inspect` (시험 업로드 `doc_mwqo15mh_fw04ua`, `xlsx-edit-pilot/out/test-book.xlsx`) | 200 | sheetCount 3 |
| `POST /api/xlsx/edit` replace `2026 코칭 현황`→`DOC-FIX 시험` | 201 | 편집본 `doc_mwqo1k7x_zl93qf`, 5,128 B, 3시트 → 삭제함 |
| 옛 Worker 삭제 뒤 `POST /api/pptx/inspect` 다시 | 200 | 숨은 의존 없음 |

- 라이브에 업로드된 .xlsx가 없어서 시험 파일을 hr 개인 문서로 올려 썼다 (끝에 삭제함).
- 옛 Worker 삭제: `cf-wrangler.py delete --name people-os-pptx-editor --force` → "Successfully deleted". 확인: `versions list --name people-os-pptx-editor` → `This Worker does not exist on your account. [code: 10007]`.
- 새 Worker 배포부터 본체 배포까지 걸린 시간은 약 1분이다. 그동안 본체는 옛 Worker를 가리켰고, 옛 Worker도 아직 살아 있었다.

## 과제 2 — 로그아웃 시 새로고침

- `public/index.html` `doLogout()` 끝에 `location.reload();`를 넣고 주석을 달았다.
- 라이브 확인: `curl https://peopleos.site/` → 1047–1055행 `doLogout` 안에 `location.reload();`가 있다 (`files/workflow-verify/doc-fix-2026-11-22/live-index.html`). 브라우저에서 눌러 보는 확인은 Merlin 몫이다.

## 과제 3 — 문서 삭제 시 `doc_nodes` 잔재

- `src/index.ts` `purgeDocument()`: chunks를 지운 뒤 `DELETE FROM doc_nodes WHERE doc_id = ?`를 넣었다. 위 주석의 단계 목록에도 doc_nodes를 넣었다.
- 삭제 경로 확인: `DELETE FROM documents`는 `purgeDocument` 한 곳뿐이다. `DELETE /api/documents/:id`와 `DELETE /api/recordings/:id`가 둘 다 이 함수를 부른다. `DELETE /api/decks/:id`는 decks 행과 R2만 지운다 (doc_nodes는 `documents.id` 기준이라 덱과 관계없다). `src/tree.ts saveTreeNodes`의 DELETE는 다시 만들기용이라 그대로 뒀다.
- **라이브 고아 정리: 0건.** 시험 전 `SELECT COUNT(*) FROM doc_nodes WHERE doc_id NOT IN (SELECT id FROM documents)` = 0 (전체 80행)이었다. 지울 것이 없어서 DELETE는 돌리지 않았다. 시험 뒤에도 0건, 전체 80행.

라이브 검증:

| 경로 | 시험 데이터 | 삭제 전 doc_nodes | 삭제 | 삭제 뒤 |
|---|---|---|---|---|
| 문서 | `doc_mwqo1t6d_cethjc` (kind file, 제목 `#` 있는 텍스트, 개인) | 2 | `DELETE /api/documents/:id` 200 | 0 |
| 문서 (xlsx 업로드) | `doc_mwqo15mh_fw04ua` | 2 | `DELETE /api/documents/:id` 200 | 0 |
| 녹음 | `rec_docfix_test_1122` → 전사본 문서 `doc_mwqo2v8x_qei8cb` | 2 (큐 트리 빌드 약 1분 뒤) | `DELETE /api/recordings/:id` 200, vectorsDeleted 1 | doc_nodes 0, documents 0, chunks 0, recordings 0 |

- 녹음 시험의 한계: 실제 오디오 업로드와 Whisper 전사는 돌리지 않았다. 전사본 문서는 API(`POST /api/documents`, kind transcript)로 만들었다. 녹음 행은 D1에 직접 INSERT해 그 문서에 연결했다 (object_key는 없는 R2 키). 그래서 녹음 삭제 라우트 → `purgeDocument` 경로는 확인했지만, 오디오 R2 삭제는 없는 키로만 확인됐다.

## 정리 확인 (0건)

- `documents`·`decks`·`recordings`에서 `title LIKE 'DOCFIX%'` → 각각 0건. 시험 id의 chunks·doc_nodes → 0건.
- R2: `docs/doc_mwqo15mh_fw04ua/source.xlsx` → "The specified key does not exist".
- 임시 세션: `auth_sessions` 1행을 지웠다 (changes 1). 그 토큰으로 `/api/auth/me` → 401. 토큰 파일도 지웠다.
- 로컬 토큰 하네스(`harness/`, port 8841)는 종료했고 포트가 풀린 것을 확인했다. 하네스 소스 `harness/token.js`·`wrangler.toml`은 남겨 뒀다 (배포하지 않음).
- 임시 시험 계정은 만들지 않았다 (기존 hr_admin에 임시 세션만 붙였다).

## 기존 엔드포인트 스모크 (본체 배포 3분 뒤, peopleos.site)

`/api/health` 200 · 익명 `/api/auth/me` 401 `{"ok":false,"error":"로그인이 필요합니다."}` · 익명 `/api/workflows/templates` 401 `{"error":"로그인이 필요합니다."}` — 이전과 같다.

## Merlin이 갱신할 이름 문자열

- `people-os-pptx-editor` → `people-os-doc-editor`
- `PPTX_EDITOR` → `DOC_EDITOR` (바인딩)
- 편집 Worker 버전 `84973507` → `2828a924`
- 본체 버전 `474e11ab` → `40194b95`
- 에러 문구 "PPTX 편집 Worker(PPTX_EDITOR)가 연결되지 않았습니다." / "문서 편집 Worker(PPTX_EDITOR)…" → "문서 편집 Worker(DOC_EDITOR)가 연결되지 않았습니다."
- 위치 (grep `PPTX_EDITOR|people-os-pptx-editor|84973507|474e11ab` 일치 줄 수): `ARCHITECTURE.md` 5줄, `VERIFICATION.md` 3줄, `public/architecture.svg` 2곳 (`<desc>`와 146행 `서비스 바인딩 PPTX_EDITOR → people-os-pptx-editor`). MEMORY.md는 이 세션에서 읽을 권한이 없어 확인하지 못했다. 같은 grep으로 찾을 것.
- 문서에 "문서 삭제 시 doc_nodes가 남는 기존 버그"라고 적힌 곳(VERIFICATION.md 또는 AGENTS.md 교훈)이 있으면 "수정됨 (40194b95)"으로 고칠 것. AGENTS.md "엑셀 편집 통합 세션 교훈"의 `purgeDocument` 항목도 해당한다.

## 남은 문제·미확인

- 브라우저에서 로그아웃 버튼을 눌러 보는 확인은 하지 않았다 (Merlin 몫).
- 좁은 경쟁 조건 (코드 읽기로만 찾았고 재현은 안 함, 수정 범위 밖): `buildTreeForDoc`(src/tree.ts:378)는 시작할 때 문서가 있는지 확인한다. 그래서 큐 메시지가 처리되기 전에 지운 문서는 건너뛴다. 하지만 트리를 만드는 도중(LLM 호출 중)에 문서를 지우면, 그 뒤의 `saveTreeNodes`가 doc_nodes를 다시 넣을 수 있다. 고아가 다시 생기면 이 경로를 먼저 볼 것.
- 녹음 경로는 실제 오디오가 아니라 D1에 직접 넣은 녹음 행으로 시험했다 (위 참고).
