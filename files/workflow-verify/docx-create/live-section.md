### 로컬 (`npx wrangler dev --local`, 포트 8792) — `evidence/local-summary.md`
상태는 엑셀 통합 때 만든 `files/workflow-verify/xlsx-edit-pilot/state/`를 다시 썼다. 그 시험 사용자 `u_xltest`에 새 세션을 넣었다.

| 시험 | 결과 |
|---|---|
| `POST /api/docx/create` (구조화 정의 `evidence/def-test.json`) | 201, 10,685 B, 섹션 5 / 블록 20 / 표 셀 12, R2 `docs/created/<id>.docx` |
| 기존 다운로드 라우트로 받기 | 200, DOCX Content-Type, 한글 파일명(RFC 5987) → `docx-create-pilot/out/created-local.docx` |
| 다시 열어 구조 확인 (파일럿 `/verify`) | **15/15**, XML 17부품 well-formed |
| 라이브러리 목록 | 새 행(kind file, has_source 1, canDelete true) |
| 오류 경로 | 익명 401 / 섹션 51개 **413** "섹션이 너무 많습니다 (상한 50)" / 빈 본문·def+instruction 동시·칸 수 > 헤더·제목 없음·배열 본문 400 |
| instruction (로컬) | 502 "Binding AI needs to be run remotely" (로컬 workerd는 Workers AI를 부를 수 없다. 알려진 한계) |
| **워크플로 `docx_create` + 승인 게이트** | `requiresApproval: true` → run **waiting_approval**(생성 전) → approve → `{{input.coach}}`·`{{input.mentor}}`를 치환해 생성 → `create_task`가 `{{steps.s1.output.docId}}`를 받음 → run **succeeded**. 생성본을 다시 읽어 치환 값 3개를 확인했다 (`evidence/wf-docx.json`, `local-wf-run.json`, `local-wf-reread.json`) |

재사용한 로컬 상태에는 `reflections.mode`(0018)와 `reflections.coach_id/coachee_id`(0020)가 없어서 `/api/library`가 500을 냈다. 이번 변경과 무관한 로컬 스키마 차이라서 그 열만 `d1 execute --local`로 넣었다.

### 원격 (라이브 스모크)

**기존 엔드포인트** (`4a7af7af` 배포 전 vs `5ebf2536` 배포 후, `cmp`) — `evidence/live-smoke/before-*`, `after-*`

| 엔드포인트 | 전 | 후 | 판정 |
|---|---|---|---|
| `GET /api/health` | 200, 140 | 200, 140 | 바이트 동일 |
| `GET /agents.js` | 200, 29,313 | 200, 29,313 | 동일 |
| `GET /styles.css` | 200, 27,576 | 200, 27,576 | 동일 |
| `GET /xlsx-edit.js` | 200, 11,249 | 200, 11,249 | 동일 |
| `GET /pptx-edit.js` | 200, 10,992 | 200, 10,992 | 동일 |
| `GET /api/auth/me` (익명) | 401, 52 | 401, 52 | 동일 |
| `GET /api/library` (익명) | 200, 2,670 | 200, 2,670 | 동일 |
| `GET /api/workflows/templates` (익명) | 401, 41 | 401, 41 | 동일 |
| `GET /api/deck/nope` | 404, 37 | 404, 37 | 동일 |
| `POST /api/xlsx/inspect` (익명) | 401, 52 | 401, 52 | 동일 |
| `GET /` (홈) | 200, 140,200 | 200, **140,476** | **의도한 변화** (버튼 + script 1줄), 로컬 `public/index.html`과 바이트 동일 |
| `GET /workflow.js` | 200, 74,910 | 200, **75,669** | **의도한 변화** (docx_create 폼), 로컬과 동일 |
| `GET /docx-create.js` | 404 | 200, 7,015 | **신규**, 로컬과 동일 |
| `POST /api/docx/create` (익명) | 404 | 401 "로그인이 필요합니다." | **신규 라우트** |

뒤의 배포 4개(`e33736ed`~`67014e0f`)는 `src/docx/create.ts`의 AI 계획 부분만 바꿨다. 정적 자산은 "No updated asset files"였다.

**끝까지 간 생성** (임시 시험 계정 세션)
1. `POST /api/docx/create` (`evidence/def-live.json`, 로컬 시험과 같은 정의) → 201, 10,685 B, `docs/created/doc_mwpygzdl_ysggtc.docx`.
2. 기존 다운로드 라우트로 200, DOCX Content-Type, 한글 파일명 → **`docx-create-pilot/out/created-live.docx`** (Word 확인용).
3. 파일럿 `/verify`로 다시 열어 보니 **15/15**였다 (`evidence/live-smoke/live-verify.json`).
4. 익명으로 받으면 **403**이다 (소유자 게이트). D1 행: kind file, r2_key NULL, source_r2_key = 새 키, extract_status ready, owner = 시험 사용자, content 420자(마크다운).

**CPU (`wrangler tail people-os`, 원격 실측)**

| 요청 | 버전 | cpuTime | wallTime | outcome |
|---|---|---|---|---|
| **구조화 생성 1회** (섹션 5, 블록 20) | 5ebf2536 | **88 ms** | 650 ms | ok |
| AI 생성 — JSON 아님 502 | 5ebf2536 | 12 ms | 11,123 ms | ok |
| AI 생성 — 섹션 1개만 201 | (e33736ed 전후) | 135 ms | 9,265 ms | ok |
| AI 생성 — 표 행 펼침 422 | 53c87008 | 12 ms | 12,224 ms | ok |
| AI 생성 — 재시도 2회 만에 201 | a2363da3 | 83 ms | 47,819 ms | ok |
| AI 생성 — 재시도 2회 만에 201 | 2a237a1f | 102 ms | 46,594 ms | ok |

CPU는 생성 자체(docx 패킹)가 대부분이다. 벽시계 시간은 Qwen 호출이 차지한다 (1회 약 10–25초).
