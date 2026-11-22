## 2단계: 라이브 통합

### 바뀐 파일
| 파일 | 내용 |
|---|---|
| `package.json`·`package-lock.json` | **`docx` 9.16.0** 고정(`--save-exact`). 기존 의존성은 그대로. 설치는 `--legacy-peer-deps`로 했다 — 레포에 원래 있던 peer 충돌(wrangler 4.165.0 ↔ @cloudflare/workers-types 4.x) 때문에 일반 `npm install`이 ERESOLVE로 실패한다 (docx와 무관). lock에는 docx와 그 하위(nanoid 6, @types/node 26, undici-types — `node_modules/docx/node_modules/` 아래)만 추가됐다 |
| `src/docx/create.ts` (신규) | 파일럿 core를 TS로 옮겼다: `normalizeDocxDef`(검증·상한·제어문자 제거) → `packDocx`(docx) → 저장. `planDocxDef`(Qwen 계획 + 스키마 검증), `runDocxCreate`, `docxContentOf`(마크다운 content). 상한은 `DOCX_LIMITS` |
| `src/index.ts` | import 1줄과 `POST /api/docx/create` 라우트(엑셀 라우트 바로 뒤, S3 덱/편집 라우트 묶음 안). 인증은 `pptxCaller` 재사용 (로그인 필요, 운영 점검용 X-Admin-Secret) |
| `src/workflow/types.ts` | `NODE_TYPES`에 `docx_create`. `AGENT_DEFAULT_TOOLS`에서는 뺐다 (pptx_edit·xlsx_edit과 같다) |
| `src/workflow/nodes.ts` | `docx_create` 노드 (title, instruction, definition — 객체 또는 JSON 문자열). `requiresApproval`은 엔진 게이트가 처리 |
| `src/workflow/think-agent.ts` | 노드별 키 힌트 3개 (`docx_create.title/instruction/definition`) |
| `public/docx-create.js` (신규) | `openDocxCreate()` 패널: 제목 + ① 자연어 지시("AI로 만들기") ② 간단한 개요 텍스트(`#`, `##`, `-`, `1.`, `\| 표 \|`, `---`, 빈 줄 = 문단) → sections 변환("개요로 만들기"). 결과: 섹션 개요, **.docx 다운로드 링크**(기존 다운로드 라우트), "라이브러리에서 보기"(목록 새로 고침 후 파일 목록으로 이동). textContent만 쓴다 |
| `public/index.html` | 라이브러리 파일 목록 필터 줄에 **"새 Word 문서 만들기"** 버튼(로그인 사용자만), `<script src="/docx-create.js">` 1줄 |
| `public/workflow.js` | 빌더에 `docx_create` 노드 폼과 "승인 뒤에 만들기" 체크박스 (pptx_edit·xlsx_edit과 같은 분기) |

### 저장 위치 (코드에서 확인한 것)
- 엑셀 편집본과 같은 방식: **`documents` 새 행 + 새 R2 키 `docs/created/<새 문서id>.docx`**. 행은 kind `file`, extract_status `ready`, r2_key NULL, source_r2_key = 새 키, owner_id = 호출자(관리자 비밀 호출이면 NULL = 공용), content = 정의를 펼친 마크다운. R2 httpMetadata contentType은 DOCX MIME, customMetadata는 `createdBy`·`planned`·`blocks`.
- 그래서 다운로드(`GET /api/documents/:id/download` — 확장자를 R2 키에서, Content-Type을 httpMetadata에서 읽는다)·삭제(`DELETE /api/documents/:id`)·라이브러리 목록·소유자 게이트를 기존 경로가 그대로 맡는다. **D1 마이그레이션 없음.**
- Vectorize에는 색인하지 않는다 (후속 과제 참고).

### 가드 (상한, 초과 시 413 + 한국어 오류)
섹션 50, 섹션당 문단 100, 목록당 항목 100, **문서 블록(문단+목록 항목+표 행) 합계 2,000**, 표 12열·200행, **표 셀 합계 2,000**, 문단·셀 8,000자, 제목 200자, 지시 2,000자. 모양 오류(배열 아님, 제목 없음, 빈 섹션, 행 칸 수 > 헤더, def와 instruction 동시)는 400. 행 칸이 헤더보다 적으면 빈 칸으로 채운다. 숫자·불리언 값은 문자열로 받는다.

### 정적 검사
- `npx tsc --noEmit`: 오류 **0** (최종 코드 기준).
- `node --check public/docx-create.js`, `public/workflow.js`: **0**.
