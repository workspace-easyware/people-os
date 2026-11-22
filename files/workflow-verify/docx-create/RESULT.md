# Word(.docx) 새로 만들기 — docx 파일럿 + 라이브 통합 결과 (2026-11-21, Opus 5.5 단일 세션)

## 판정

- **파일럿: 통과 (도입 가능, 조건 없음).** docx **9.16.0**으로 제목, Heading 1/2, 굵게·기울임 문단, 글머리 목록, 번호 목록(목록마다 1부터), 표(헤더 + 3행, 머리글 반복), 페이지 나누기를 만들었다. 로컬 workerd와 원격 Workers에서 모두 15/15 검사를 통과했고, XML 17부품이 모두 well-formed다. 최소 경로 번들은 gzip **107 KiB**다. CPU는 시험 문서에서 44–58 ms, 상한에 가까운 문서(1,910블록)에서 **281 ms**였다.
- **배치 결정: People OS 본체 Worker.** 본체 번들은 gzip 1,731 → 1,849 KiB(**+118 KiB**)로 늘었다. 엑셀 통합 때 편집 Worker 증가분(+144 KiB)보다 작다. CPU도 작아서 서비스 바인딩을 거칠 이유가 없다. 편집 Worker(`people-os-pptx-editor`)는 건드리지 않았다.
- **통합: 완료, 라이브에서 동작 확인.** 구조화 입력 경로는 생성 → 저장 → 기존 다운로드 라우트 → 다시 열기 15/15 → 소유자 게이트(익명 403)까지 확인했다. 기존 엔드포인트 10건은 바이트가 같고, 바뀐 자산 3건은 로컬 파일과 바이트가 같다. 생성 1회 CPU는 **88 ms**다. 자연어 지시 경로도 실제 Qwen으로 동작한다 (최종 버전에서 2/2 성공, 22–44초). 다만 **Qwen의 JSON 출력이 자주 불안정했다** (괄호 빠짐·뒤바뀜·남음, 표 행 펼침, 목록을 배열 여러 개로 씀). 그래서 라이브 관찰을 바탕으로 보정 2종과 1회 재시도를 넣었다. 자세한 내용은 아래 "AI 지시 경로"에 있다.
- **남은 확인: Word에서 직접 열어 보지 않았다.** 이 VM에는 Word도 LibreOffice도 없다. **`docx-create-pilot/out/created-live.docx`**(구조화 입력)와 `out/created-live-ai.docx`(AI 작성)를 사람이 Word에서 열어 봐야 한다.

## 배포

| 대상 | 버전 | 번들 | 시작 시간 |
|---|---|---|---|
| `people-os` | `4a7af7af` → `5ebf2536`(기능) → `e33736ed`·`53c87008`(AI 진단 로그) → `a2363da3`(표 보정 + 재시도) → `2a237a1f`(끝 괄호 보정) → `67014e0f`(끝 괄호 순서) → **`cd392c91-cf8e-49d8-9e40-4103e7000355`**(본문 괄호 보정 + 파싱 오류 위치 로그, **최종**) | 8,428.92 → **8,971.11 KiB** / gzip 1,731.04 → **1,850.67 KiB** | 127 ms |
| `people-os-pptx-editor` | 바꾸지 않음 (`84973507` 그대로) | — | — |
| `people-os-docx-pilot` (시험) | `75cbe680` → `b67c44c9`, **삭제함** | 550.67 KiB / gzip 123.38 KiB | 12 ms |

모든 배포는 `cf-wrangler.py deploy --config <절대 경로>`를 직접 실행했고, 승인 대기로 막힌 적은 없다. 배포는 직렬로 하나씩 했고, 스모크는 각 배포 뒤 3분이 지나서 했다. 롤백은 People OS를 `4a7af7af`로 되돌리면 된다. 생성된 문서는 기존 문서 행이라 되돌린 뒤에도 다운로드·삭제가 된다. **D1 마이그레이션과 DO 마이그레이션은 없다.**

---

## 1단계: 파일럿 (`files/people-os/docx-create-pilot/`)

### 1. 설치 — 통과
- `npm install --prefix docx-create-pilot --save-exact docx`로 **docx 9.16.0**이 설치됐다 (조사 당시 9.15.3보다 새 버전, MIT). 4초 걸렸고, 패키지 5개(docx, fflate 0.8.3, nanoid 6, @types/node 26, undici-types)가 들어왔다. 경고는 없었다.
- 설치 크기는 `node_modules` **24 MB**다. docx 자체가 20 MB인데, dist에 cjs/mjs/umd/iife × 서브패스 10개가 들어 있어서다. 번들에 들어가는 것은 `dist/index.mjs`(1.0 MB) 하나다. 이 파일은 **import가 하나도 없는** 자체 완결 ESM이다 (fs·Buffer·node: 내장 모듈 없음).
- `npm --version`은 승인 대기로 막혔다 (아래 "승인 대기" 참고). 버전은 설치된 package.json 기준이다.

### 2. 시험 문서 — 통과
`src/core.js`의 `createDocx(def)`가 `Packer.toArrayBuffer()`로 만든다. 시험 정의는 `src/lab.js`의 TEST_DEF다.
- 제목(Title) + 부제
- Heading 1 × 3, Heading 2 × 2
- 굵게·기울임이 섞인 문단(`**…**`, `*…*`), 특수문자 `<태그> & "따옴표"`
- 글머리 3개, 번호 3개, 두 번째 번호 목록 2개(1부터 다시)
- 표: 헤더 + 3행, 머리글 행 반복·음영
- 2장 앞 페이지 나누기

결과 파일은 10,741 B다.

### 3. 저장 뒤 검증 — 통과 (15/15, 로컬·원격 같음)
ZIP을 풀어 `word/document.xml`과 `numbering.xml`을 직접 읽는 자체 리더(`readDocx`, `numFormats`)로 확인했다.

| 검사 | 결과 |
|---|---|
| 부품: document·styles·numbering·[Content_Types]·rels (전체 17개) | ✅ |
| 제목 Title 스타일 / Heading1 3개 / Heading2 2개 (문구 일치) | ✅ (styles.xml에 Title·Heading1~6·ListParagraph 정의가 있다) |
| 문단 굵게·기울임 런 (`<w:b/>`, `<w:i/>`) | ✅ |
| 특수문자를 이스케이프한 뒤 원문 그대로 | ✅ |
| 글머리 3개는 numFmt bullet, 번호 3개는 decimal이고 같은 numId | ✅ |
| 두 번째 번호 목록은 다른 numId (1부터 다시) | ✅ |
| 표 1개, 헤더 + 3행, 셀 값 일치, `tblHeader` | ✅ |
| 페이지 나누기 (`<w:br w:type="page"/>`가 2장 제목 바로 앞) | ✅ |
| XML well-formed — 17부품 전부 | ✅ (xlsx 파일럿 검사기에 **XML 금지 제어문자 검사를 더했다**. 음성 시험 7종을 모두 잡는다) |

**발견 1건 (고침)**: 입력에 제어문자(`\u0001` 등)가 있으면 docx가 그대로 XML에 넣는다. 그러면 Word가 열지 못하는 파일이 된다. 그래서 정규화 단계에서 XML 1.0 금지 문자와 짝 없는 서로게이트를 지우게 했다 (탭·줄바꿈은 남긴다). 시험: `"앞\u0001뒤"`는 "앞뒤"가 되고 XML 검사를 통과한다.

### 4. Workers 호환 — 통과
| 항목 | 결과 |
|---|---|
| 로컬 `npx wrangler dev --local` (포트 8791) | 모든 라우트 200 |
| 최소 Worker 번들 (`src/minimal.js`, nodejs_compat 없음) | **487.49 KiB / gzip 107.12 KiB** |
| 시험 Worker 번들 (`src/lab.js`) | 549.90 KiB / gzip 123.11 KiB |
| 원격 `people-os-docx-pilot` | 배포 성공, Startup 12 ms, 버전 `75cbe680-…` → `b67c44c9-fce2-46c2-8244-fb68bf1ded30` |
| 원격 selftest | 15/15 (`out/selftest-remote.json`). limits 출력이 로컬과 `cmp` 동일 |
| 삭제 | `cf-wrangler.py delete --name people-os-docx-pilot --force` → "Successfully deleted" ✅ |

`nodejs_compat` 없이 돈다. docx는 Buffer 없이 `toArrayBuffer`만 쓴다.

### 5. CPU (원격 tail, `evidence/tail-pilot-summary.json`)
| 요청 | cpuTime | wall |
|---|---|---|
| 시험 문서 생성 (/make) | **44 / 58 ms** | 47 / 64 ms |
| 생성 + 다시 읽기 + XML 검사 (/selftest) | 94 (콜드) / 146 ms | 99 / 152 ms |
| 50섹션·510블록·표 셀 630 | 190–265 ms | 233–310 ms |
| **상한에 가까운 문서: 1,910블록(상한 2,000), 26 KB** | **281 ms** | 327 ms |

모두 outcome ok, exceptions 0이다.

### 6. 배치 결정 — **People OS 본체 Worker**
- 최소 번들은 gzip 107 KiB다. 실제로 본체에 넣고 잰 증가분은 8,428.92 → 8,965.67 KiB, gzip **1,731.04 → 1,849.27 KiB (+118 KiB)**다. 엑셀 통합 때 편집 Worker 증가분(+144 KiB)보다 작다. 이미 본체에 있는 pptxgenjs와 같은 성격(새 문서 생성)이기도 하다.
- CPU는 상한 문서에서도 0.3초 미만이다. 편집 Worker로 떼어 내 격리할 이유가 없고, 떼어 내면 서비스 바인딩 왕복과 RPC 직렬화만 더 생긴다.
- 그래서 편집 Worker(`people-os-pptx-editor`)는 이번에 손대지 않았고, People OS 하나만 배포했다.

---

## 2단계: 라이브 통합

### 바뀐 파일
| 파일 | 내용 |
|---|---|
| `package.json`·`package-lock.json` | **`docx` 9.16.0** 고정(`--save-exact`). 기존 의존성은 그대로다. 설치는 `--legacy-peer-deps`로 했다. 레포에 원래 있던 peer 충돌(wrangler 4.165.0 ↔ @cloudflare/workers-types 4.x) 때문에 일반 `npm install`이 ERESOLVE로 실패하기 때문이다 (docx와는 무관하다). lock에는 docx와 그 하위 패키지만 추가됐다 |
| `src/docx/create.ts` (신규) | 파일럿 core를 TS로 옮겼다. `normalizeDocxDef`(검증·상한·제어문자 제거) → `packDocx`(docx) → 저장. `planDocxDef`(Qwen 계획 + AI 출력 보정 + 1회 재시도 + 진단 로그), `runDocxCreate`, `docxContentOf`(마크다운 content). 상한은 `DOCX_LIMITS` |
| `src/index.ts` | import 1줄, 그리고 `POST /api/docx/create` 라우트를 엑셀 라우트 바로 뒤(S3 덱·편집 라우트 묶음 안)에 넣었다. 인증은 `pptxCaller`를 재사용한다 (로그인 필요, 운영 점검용 X-Admin-Secret). 입력은 `{title, subtitle?, sections}` 또는 `{definition}` 또는 `{instruction, title?}`이다 |
| `src/workflow/types.ts` | `NODE_TYPES`에 `docx_create`를 넣었다. `AGENT_DEFAULT_TOOLS`에서는 뺐다 (pptx_edit·xlsx_edit과 같다) |
| `src/workflow/nodes.ts` | `docx_create` 노드 (title, instruction, definition — 객체 또는 JSON 문자열). `requiresApproval`은 엔진 게이트가 처리한다 |
| `src/workflow/think-agent.ts` | 노드별 키 힌트 3개 (`docx_create.title/instruction/definition`) |
| `public/docx-create.js` (신규) | `openDocxCreate()` 패널. 제목 입력 + ① 자연어 지시("AI로 만들기") ② 간단한 개요 텍스트("개요로 만들기")가 있다. 개요 텍스트는 `#`, `##`, `-`, `1.`, `\| 표 \|`, `---`, 빈 줄(문단 구분)을 sections로 바꾼다. 결과로 섹션 개요, **.docx 다운로드 링크**(기존 다운로드 라우트), "라이브러리에서 보기"(목록을 새로 고친 뒤 파일 목록으로 이동)를 보여 준다. textContent만 쓴다 |
| `public/index.html` | 라이브러리 파일 목록 필터 줄에 **"새 Word 문서 만들기"** 버튼(로그인 사용자만), `<script src="/docx-create.js">` 1줄 |
| `public/workflow.js` | 빌더에 `docx_create` 노드 폼과 "승인 뒤에 만들기" 체크박스 (pptx_edit·xlsx_edit과 같은 분기) |

### 저장 위치 (코드에서 확인한 것)
- 엑셀 편집본과 같은 방식이다: **`documents` 새 행 + 새 R2 키 `docs/created/<새 문서id>.docx`**.
  - 행: kind `file`, extract_status `ready`, r2_key NULL, source_r2_key = 새 키, owner_id = 호출자(관리자 비밀로 호출하면 NULL = 공용), content = 정의를 펼친 마크다운.
  - R2: httpMetadata contentType은 DOCX MIME, customMetadata는 `createdBy`·`planned`·`blocks`.
- 그래서 다운로드(`GET /api/documents/:id/download` — 확장자는 R2 키에서, Content-Type은 httpMetadata에서 읽는다)·삭제(`DELETE /api/documents/:id`)·라이브러리 목록·소유자 게이트를 기존 경로가 그대로 맡는다. **D1 마이그레이션은 없다.**
- Vectorize에는 색인하지 않는다 (후속 과제).

### 가드 (상한을 넘으면 413 + 한국어 오류)
- 섹션 50, 섹션당 문단 100, 목록당 항목 100
- **문서 블록(문단 + 목록 항목 + 표 행) 합계 2,000**
- 표 12열·200행, **표 셀 합계 2,000**
- 문단·셀 8,000자, 제목 200자, 지시 2,000자

모양이 틀리면 400이다 (배열 아님, 제목 없음, 빈 섹션, 행 칸 수 > 헤더, def와 instruction 동시). 행 칸이 헤더보다 적으면 빈 칸으로 채운다. 숫자·불리언 값은 문자열로 받는다.

### 정적 검사
- `npx tsc --noEmit`: 오류 **0** (최종 코드 기준).
- `node --check public/docx-create.js`, `public/workflow.js`: **0**.

### 로컬 (`npx wrangler dev --local`, 포트 8792) — `evidence/local-summary.md`
상태는 엑셀 통합 때 만든 `files/workflow-verify/xlsx-edit-pilot/state/`를 다시 썼다. 그 시험 사용자 `u_xltest`에 새 세션을 넣었다.

| 시험 | 결과 |
|---|---|
| `POST /api/docx/create` (구조화 정의 `evidence/def-test.json`) | 201, 10,685 B, 섹션 5 / 블록 20 / 표 셀 12, R2 `docs/created/<id>.docx` |
| 기존 다운로드 라우트로 받기 | 200, DOCX Content-Type, 한글 파일명(RFC 5987) → `docx-create-pilot/out/created-local.docx` |
| 다시 열어 구조 확인 (파일럿 `/verify`) | **15/15**, XML 17부품 well-formed |
| 라이브러리 목록 | 새 행 (kind file, has_source 1, canDelete true) |
| 오류 경로 | 익명 401 / 섹션 51개 **413** "섹션이 너무 많습니다 (상한 50)" / 빈 본문·def와 instruction 동시·칸 수 > 헤더·제목 없음·배열 본문은 모두 400 |
| instruction (로컬) | 502 "Binding AI needs to be run remotely" (로컬 workerd는 Workers AI를 부를 수 없다. 알려진 한계) |
| **워크플로 `docx_create` + 승인 게이트** | `requiresApproval: true` → run **waiting_approval**(생성 전) → approve → `{{input.coach}}`·`{{input.mentor}}`를 치환해 생성 → `create_task`가 `{{steps.s1.output.docId}}`를 받음 → run **succeeded**. 생성본을 다시 읽어 치환된 값 3개를 확인했다 (`evidence/wf-docx.json`, `local-wf-run.json`, `local-wf-reread.json`) |

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
| `GET /api/library` (익명) | 200, 2,670 | 200, 2,670 | 동일 (정리 뒤 최종 버전에서도 동일) |
| `GET /api/workflows/templates` (익명) | 401, 41 | 401, 41 | 동일 |
| `GET /api/deck/nope` | 404, 37 | 404, 37 | 동일 |
| `POST /api/xlsx/inspect` (익명) | 401, 52 | 401, 52 | 동일 |
| `GET /` (홈) | 200, 140,200 | 200, **140,476** | **의도한 변화** (버튼 + script 1줄). 로컬 `public/index.html`과 바이트 동일 |
| `GET /workflow.js` | 200, 74,910 | 200, **75,669** | **의도한 변화** (docx_create 폼). 로컬과 동일 |
| `GET /docx-create.js` | 404 | 200, 7,015 | **신규**. 로컬과 동일 |
| `POST /api/docx/create` (익명) | 404 | 401 "로그인이 필요합니다." | **신규 라우트** |

뒤의 배포 5개(`e33736ed`~`cd392c91`)는 `src/docx/create.ts`의 AI 계획 부분만 바꿨다. 정적 자산은 매번 "No updated asset files"였다. 최종 버전에서 health·익명 library를 다시 받아 배포 전과 바이트가 같고, 홈·docx-create.js가 로컬 파일과 같은 것을 확인했다 (`final-*`).

**끝까지 간 생성** (임시 시험 계정 세션)
1. `POST /api/docx/create` (`evidence/def-live.json`, 로컬 시험과 같은 정의) → 201, 10,685 B, `docs/created/doc_mwpygzdl_ysggtc.docx`.
2. 기존 다운로드 라우트로 받았다: 200, DOCX Content-Type, 한글 파일명 → **`docx-create-pilot/out/created-live.docx`** (Word 확인용).
3. 파일럿 `/verify`로 다시 열어 보니 **15/15**였다 (`evidence/live-smoke/live-verify.json`).
4. 익명으로 받으면 **403**이다 (소유자 게이트). D1 행: kind file, r2_key NULL, source_r2_key = 새 키, extract_status ready, owner = 시험 사용자, content 420자(마크다운).

**CPU (`wrangler tail people-os`, 원격 실측)**

| 요청 | 버전 | cpuTime | wallTime | 결과 |
|---|---|---|---|---|
| **구조화 생성 1회** (섹션 5, 블록 20) | 5ebf2536 | **88 ms** | 650 ms | 201 |
| AI 생성 | 5ebf2536 | 12 ms | 11,123 ms | 502 JSON 아님 |
| AI 생성 | e33736ed 전후 | 135 ms | 9,265 ms | 201 (섹션 1개만) |
| AI 생성 | 53c87008 | 12 ms | 12,224 ms | 422 표 행 펼침 |
| AI 생성 (2회 시도) | a2363da3 | 83 ms | 47,819 ms | 201 |
| AI 생성 (2회 시도) | 2a237a1f | 102 ms | 46,594 ms | 201 |
| AI 생성 (2회 모두 실패) | 67014e0f | 10 ms | 27,604 ms | 502 |
| AI 생성 (2회 시도) | **cd392c91** | 116 ms | 44,084 ms | 201 (섹션 4: 문단·글머리 4·표 4행·번호 4) |
| AI 생성 (**1회에 성공**) | **cd392c91** | 210 ms | 22,802 ms | 201 (섹션 4: 문단·표 5행·글머리 5·번호 5) |

모두 outcome ok, exceptions 0이다. CPU는 대부분 docx 패킹이고, 벽시계 시간은 Qwen 호출이 차지한다 (1회 약 10–25초).

### AI 지시 경로 (Qwen `@cf/qwen/qwen3.8-27b`, reasoning_effort low) — `evidence/live-smoke/ai-plan-attempts.json`, `live-instruction-*.json`

흐름은 이렇다. `instruction`(+선택 `title`) → Qwen이 문서 정의 JSON을 쓴다 → (AI 출력에만) 보정 → `normalizeDocxDef`로 엄격하게 검증 → 생성. 사용자가 준 제목이 항상 우선이다. 검증에 실패하면 오류를 알려 주고 **1번만** 다시 시킨다 (Qwen 호출 최대 2회). 응답이 잘린 경우(finish length)는 다시 시키지 않는다.

**라이브에서 본 Qwen JSON 오류**. 진단 로그 `docx.plan`이 시도 번호, 파싱 여부, finish, 토큰, 섹션 수, 앞뒤 200자, 파싱 오류 위치 앞뒤 80자를 남긴다.

| # | 모양 | 대응 |
|---|---|---|
| 1 | 맨 끝 `}` 빠짐 (`…]}]`) | 끝의 괄호 묶음을 떼고 짝에 맞게 다시 닫는다 |
| 2 | 맨 끝 순서 뒤바뀜 (`…]}}]`) | 같은 보정 |
| 3 | 본문 중간, 배열이 열린 채로 `}`가 하나 더 붙음 / `]` 앞에 `}`가 빠짐 | 남는 `}`는 버리고 빠진 `}`는 채운다 (`cd392c91`). 그 밖의 어긋남은 고치지 않는다 |
| 4 | 2열 5행 표를 칸 10개짜리 행 1개로 폄 | 칸 수가 헤더의 정확한 배수면 행으로 나눈다 |
| 5 | 번호 목록 항목을 배열 여러 개로 씀 (`"numbered":["a"],["b"]…`) | 고치지 않는다. 재시도로 회복됐다 (`cd392c91` 1회) |
| 6 | 섹션 4개를 지시했는데 1개만 씀 (형식은 맞음) | 검증으로는 못 잡는다. 결과 개요(섹션 목록)를 보여 주고 사용자가 다시 만든다 |

보정은 "고친 결과가 JSON으로 파싱되고 스키마 검증도 통과할 때만" 쓰인다. 그래서 잘못 고치더라도 엉뚱한 문서가 생기지 않고 422나 502로 끝난다. 보정 시험(로컬 workerd, `evidence/repair-test.json`): 라이브 모양 1·2·3을 살리고 4를 나눈다. 문자열 안에서 끊김·중간 `:` 오류·`}` 없음·JSON 없음은 null로 남는다.

**최종 버전 `cd392c91`에서 2회 시험해 2회 모두 201이었다** (1회는 재시도로, 1회는 첫 시도에 성공). 지시한 4개 부분(문단·표·글머리·번호)이 모두 들어갔다. AI 작성본은 `docx-create-pilot/out/created-live-ai.docx`(온보딩, a2363da3)와 `created-live-ai-2.docx`(분기 보고서, cd392c91)에 있다. 세션 전체로 보면 AI 생성 8회 중 201이 5회(섹션 1개만 쓴 1회 포함)였고, 실패가 3회였다 (502 `5ebf2536`, 422 `53c87008`, 502 `67014e0f` — 셋 다 최종 보정 전 버전). 표본이 작아서 성공률은 아직 말할 수 없다.

### 시험 흔적과 정리 (운영 D1·R2)
1. 운영 D1에 임시 사용자 `u_docxsmoke_tmp`(role user, coaching_role coach, 비밀번호 없음 = 로그인 불가)와 **1시간짜리 세션**을 넣었다.
2. 스모크를 마친 뒤 생성 문서 6개(구조화 1, AI 5)를 **기존 `DELETE /api/documents/:id`로 지웠다** (6건 모두 200, errors []). R2 객체도 같이 지워졌다 (다운로드 404 확인). 생성본은 doc_nodes·chunks·벡터를 만들지 않는다.
3. 세션과 사용자를 지웠다.
4. 확인 쿼리 결과: **users 0 / auth_sessions 0 / documents 0** (`owner_id` 시험 사용자 또는 `source_r2_key LIKE 'docs/created/%'`) **/ doc_nodes 0 / chunks 0**. 익명 `/api/library`는 배포 전과 바이트가 같다.

남은 흔적은 AI Gateway 로그(tag `docx-create-plan` 12건 안팎)와 Workers Logs의 `docx.create`·`docx.plan` 이벤트뿐이다. 로컬 상태(`xlsx-edit-pilot/state/`)에는 시험 문서 2개, 워크플로 1개, 할 일 1개, 세션 1개가 남아 있다 (지워도 됨).

---

## 남은 한계

1. **Word에서 열리는지 직접 확인하지 않았다.** 근거는 세 가지뿐이다: 자체 리더로 다시 읽기(제목·스타일·목록 형식·표 셀), 17부품 XML well-formed 검사(제어문자 포함), styles.xml의 스타일 정의 확인. **`docx-create-pilot/out/created-live.docx`(라이브 생성본)를 Word에서 열어** 다음을 봐야 한다.
   - ① 복구 대화상자가 뜨지 않는지
   - ② 제목·Heading 1/2가 탐색 창에 보이는지
   - ③ 글머리, 번호(두 번째 목록이 1부터), 표 머리글 음영, 2장 앞 페이지 나누기

   AI 작성본은 `out/created-live-ai.docx`와 `created-live-ai-2.docx`에 있다.
2. 글꼴은 기본값으로 "Malgun Gothic"(맑은 고딕)을 지정했다. 이 글꼴이 없는 환경(Mac Word 등)에서는 대체 글꼴로 보인다.
3. **AI 작성 품질과 안정성은 모델에 좌우된다.** 위 표의 JSON 오류 5종 중 4종은 보정이나 재시도로 막았다. 하지만 새 모양이 나오면 422나 502가 날 수 있다 (사용자에게는 "다시 시도" 수준의 오류로 보인다). "지시보다 적게 쓴" 결과는 형식이 맞아서 검증으로 잡을 수 없다. 재시도가 붙으면 AI 생성 1회가 최대 약 50초 걸린다.
4. 이미지·목차·차트·머리말/바닥글·사용자 스타일은 범위 밖이다 (docx는 지원한다, 후속 과제). 기존 .docx 편집도 범위 밖이다.
5. 마크다운은 `**굵게**`와 `*기울임*`만 해석한다. 문단 안 줄바꿈·링크·코드는 글자 그대로 들어간다.
6. 생성본은 Vectorize에 색인하지 않는다 (RAG 검색에 안 나온다). 요약하기 등 문서 흐름은 content(마크다운)로 동작한다.
7. 라이브러리에서 이 문서 행에도 기존 "편집본 만들기" 버튼이 보인다 (업로드 문서와 같은 조건 `has_source`). 누르면 xlsx → pptx 순으로 열어 보고 "PPTX/XLSX만" 안내가 나온다. 업로드한 .docx도 원래 이렇게 동작한다.
8. 로그인 뒤 UI 화면(패널·개요 입력·다운로드 링크)은 브라우저로 보지 않았다. API, `node --check`, 정적 자산 바이트 비교로만 확인했다. 개요 텍스트 파서(`dcParseOutline`)는 실행해 보지 않았다.
9. 생성 요청 레이트 제한은 없다 (로그인만 요구한다. PPTX·엑셀 편집과 같다).
10. 워크플로 `docx_create`는 로컬에서만 끝까지 돌렸다 (라이브는 라우트로만 확인했다. 같은 `runDocxCreate`를 쓴다).

## 후속 과제

- **큰 문서는 Queue 소비자에서 처리**: 지금 상한(2,000블록)은 동기 요청 안에서 CPU 0.3초라 문제가 없다. 하지만 상한을 크게 올리거나 이미지·차트를 넣으면 "제출 라우트 + 나중에 읽는 결과 라우트"로 나눈다 (큐 메시지 1개 = 문서 1개). AI 지시(재시도 시 최대 약 50초)도 같은 방식으로 옮기면 요청이 오래 붙잡히지 않는다. 이번 범위에서는 하지 않았다.
- 사람이 Word에서 `created-live.docx`·`created-live-ai*.docx`를 확인한다.
- AI 계획을 Workers AI JSON 모드(`response_format` json_schema)로 바꿀 수 있는지 Qwen3.8에서 확인한다. 되면 괄호 보정이 필요 없어진다.
- 이미지(`ImageRun`, R2에서 읽기)·목차(`TableOfContents`)·머리말/바닥글·`docx/charts`를 하나씩 파일럿한다.
- 기존 .docx 편집: docx Patcher(`{{플레이스홀더}}` 템플릿)나 ooxml-core를 파일럿한다.
- 생성본을 Vectorize에 색인할지 정한다 (원본이 없는 새 문서라 중복 문제는 없다).
- 진단 로그 `docx.plan`(앞뒤 200자, 오류 위치 앞뒤 80자)은 품질이 안정되면 줄인다.
- 레포의 peer 충돌(wrangler 4.165.0 ↔ @cloudflare/workers-types 4.x)을 정리한다. 지금은 `npm install`에 `--legacy-peer-deps`가 필요하다.

## 승인 대기로 막힌 것 (Merlin 보고)

- `npm --version`, `ls ../workflow-verify` 등이 섞인 복합 명령, `git diff --stat`, `echo "exit $?"`가 섞인 명령: 막혔다. 버전은 설치된 package.json으로, 변경 범위는 lock 파일 grep으로 확인했다.
- 포그라운드 `sleep 100`: 막혔다 (백그라운드 `sleep`으로 대신). `timeout … tail -f /dev/null`(작업 폴더 밖 읽기)과 `$(…)`가 든 Monitor 명령도 막혔다.
- 그 밖에 `npm install --prefix`, `npx wrangler dev --local`, `cf-wrangler.py deploy / --dry-run / tail / delete / d1 execute --remote`, `d1 execute --local`, 로컬·원격 curl, `cmp`, `node --check`, `npx tsc`, `printf | sha256sum`, `ss -ltnp`는 모두 실행됐다. 배포가 막힌 적은 없다.

## 이 세션의 교훈 (AGENTS.md 후보)

- **docx 9.16.0은 Workers에서 nodejs_compat 없이 돈다** (`Packer.toArrayBuffer`). 번들 gzip 약 110 KiB라 본체에 둬도 된다.
- **docx는 XML 금지 제어문자를 거르지 않는다.** 입력을 정규화할 때 지워야 Word가 연다.
- **Qwen3.8의 긴 JSON은 괄호가 자주 틀린다** (끝 `}` 빠짐·순서 뒤바뀜·중간에 남는 `}`). 진단 로그로 모양을 본 뒤 보정한다. 보정 결과도 스키마 검증을 통과해야만 쓴다.
- **`npm install`(레포 루트)은 기존 peer 충돌 때문에 `--legacy-peer-deps`가 필요하다.**
- 3분 대기는 백그라운드 `sleep 185`로 한다. 출력 파일이 비어 있어 끝났는지 알 수 없으니 완료 알림을 기다린다.

## 산출물

- 파일럿: `files/people-os/docx-create-pilot/`
  - 설정: `package.json`(docx 9.16.0 고정), `wrangler.toml`(lab), `wrangler.minimal.toml`
  - 코드: `src/core.js`(생성·리더·XML 검사), `src/lab.js`(시험 라우트: /make /selftest /verify /read /limits /make-big /part /repair-test), `src/minimal.js`, `src/repair.js`(AI 보정 사본)
  - 결과: `out/test-local.docx`, `test-remote.docx`, `big-50.docx`, `created-local.docx`, `created-local-wf.docx`, **`created-live.docx`**(Word 확인용), `created-live-ai.docx`, `created-live-ai-2.docx`, `created-live-ai-1.docx`(섹션 1개짜리 실패 사례), `selftest-*.json`, `limits-*.json`, `styles-local.xml.txt`, `dryrun-*/`
  - 지워도 되는 것: `.wrangler-state/`
- 근거: `files/workflow-verify/docx-create/evidence/`
  - 시험 입력: `def-test.json`, `def-live.json`, `def-too-many-sections.json`, `wf-docx.json`
  - 로컬: `local-*.json`, `local-summary.md`, `local-download-headers.txt`
  - CPU: `tail-pilot-summary.json`
  - 보정 시험: `repair-test.json`
  - 라이브: `live-smoke/` (before/after/final, live-create·live-verify·live-instruction-1~8, ai-plan-attempts.json, live-ai-*-reread.json)
- 작업 메모(본문에 합쳤음, 지워도 됨): `pilot-section.md`, `integration-section.md`, `live-section.md`, `ai-section.md`, `tail-section.md`
