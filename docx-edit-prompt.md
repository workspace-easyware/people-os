# Word 기존 .docx 파일 편집 — 파일럿 + 라이브 통합 (2026-11-22, Fable 5.2)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `40194b95`, 문서 편집 Worker `people-os-doc-editor` `2828a924` (바인딩 `DOC_EDITOR`). 커밋 HEAD `c57f691`.
- 모델: Fable 5.2 (이 세션은 Fable 5.2 하나로 끝까지 — 중간에 모델 바꾸지 말 것).
- 먼저 `~/AGENTS.md`를 읽을 것 — 검증된 운용 교훈(권한 규칙, 라이브 호출 방법, 배포 주의)이 들어 있다. 특히:
  - 라이브 HTTP 검증은 `--add-dir ~/workspace/user`(시크릿 읽기)와 `Bash(curl *peopleos.site*)` 규칙이 있어야 한다.
  - `peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다 — 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다.
  - 배포 뒤 약 2분은 옛 버전이 응답한다 — 스모크는 3분 뒤에 할 것.
  - 배포는 직렬로 (동시 배포 금지). `cf-wrangler.py deploy`가 승인 대기로 막히면 우회하지 말고 보고만 하고 멈출 것.
  - `git add`·커밋·태그는 Merlin이 직접 한다 — 세션은 커밋하지 말 것.
  - 문서(ARCHITECTURE.md·VERIFICATION.md)는 건드리지 말 것 — Merlin이 따로 갱신한다.
- `npx tsc --noEmit` 0건, 바뀐 화면 JS는 `node --check` 통과가 매 단계의 조건이다.

## 맥락 (이미 있는 것)

- PPTX 편집은 `people-os-doc-editor` Worker에서 ooxml-core로 한다 (`pptx_edit` 노드·`/api/pptx/*`·UI "편집본 만들기"). XLSX 편집은 같은 Worker에서 xlvane으로 한다 (`xlsx_edit` 노드·`/api/xlsx/*`). 둘 다 편집본을 새 행 + 새 R2 키로 저장하고 원본은 그대로 둔다.
- Word 새로 만들기는 `docx` 9.16.0으로 본체 Worker에서 한다 (`POST /api/docx/create`, `docx_create` 노드). 번들 gzip +118 KiB.
- 오픈소스 문서 라이브러리 조사(2026-11-19, `~/workspace/research_notes/opensource-document-libraries-workers-20261119-1214/report.md`) 결론: 기존 .docx 일반 편집은 **docx Patcher(템플릿·자리표시자 전용) 또는 ooxml-core 파일럿 또는 JSZip+XML 수작업**이 후보. docx는 XML 금지 제어문자를 거르지 않아 정규화가 필요하다.
- 라이브러리 탭에서 Word 문서에는 지금 "Word 편집 미지원 (새로 만들기는 됩니다)"만 뜬다. 이 작업이 끝나면 Word도 "편집본 만들기"가 돼야 한다.

## 과제 1 — 파일럿 (격리 환경, 라이브 코드와 분리)

PPTX 파일럿(커밋 `85753e8`)·엑셀 파일럿과 같은 방식: `files/workflow-verify/docx-edit-pilot/` 아래에 격리 하네스를 만들고, 별도 시험 Worker로 로컬 workerd + 원격에서 검증한다.

- 후보를 이 순서로 본다: ① ooxml-core 2.x (PPTX 편집에 쓴 그 라이브러리 — docx 편집이 되는지, 번들을 얼마나 더 먹는지) ② docx Patcher (자리표시자 치환만 되는지, 일반 텍스트 편집에는 맞지 않는지) ③ JSZip+XML 수작업 (필요하면).
- 검증할 것: 텍스트 치환(문단·표 셀 안의 글자 바꾸기), 손대지 않은 부분 바이트 동일 (또는 XML이 정상이고 Word가 여는지), 저장본이 Word에서 복구 대화상자 없이 열리는지, 번들 크기 (본체에 넣을지 편집 Worker에 붙일지 판단 — 편집 Worker에 붙이는 게 기본 방향, 본체에 넣으면 gzip +118 KiB 수준인지 확인), 편집 1회 CPU 시간.
- 판정을 내린다: 도입 가능 / 조건부 / 불가. 조건이 있으면 무엇인지 적는다. 파일럿 결과는 `files/workflow-verify/docx-edit-pilot/RESULT.md`에 쓴다.
- 파일럿이 **불가**면 여기서 멈추고, 불가한 이유와 대안을 보고한다. 통합으로 가지 않는다.

## 과제 2 — 라이브 통합 (파일럿이 도입 가능·조건부일 때만)

PPTX·XLSX 통합과 같은 모양으로 한다:

- 편집 Worker(`people-os-doc-editor`)에 DOCX RPC를 붙인다 (번들이 크면 별도 Worker로 나눌지 판단 — 기본은 같은 Worker에 붙이기). 본체 `wrangler.toml` 바인딩은 `DOC_EDITOR` 그대로.
- 라우트: `POST /api/docx/inspect`·`POST /api/docx/edit`·`GET /api/docx/versions` (PPTX·XLSX와 같은 모양). 저장: 편집본은 `documents` 새 행 + R2 `docs/edits/doc_<원본id>/<새 문서id>.docx`, 원본 그대로, Vectorize 색인 안 함, D1 마이그레이션 없음.
- 워크플로 노드 `docx_edit` — `send_email`·`webhook`처럼 승인 게이트를 탄다 (기존 `pptx_edit`·`xlsx_edit`이 어떻게 타는지 보고 그대로 따른다).
- UI: 라이브러리에서 Word 문서의 "편집본 만들기" 버튼이 Word 편집기로 열리게 한다. "Word 편집 미지원" 안내는 없앤다. 자연어 지시 → ops 변환은 Qwen3.8로 하되, docx 생성 때처럼 JSON 보정 + 1회 재시도를 넣는다 (Qwen 긴 JSON은 괄호가 자주 틀린다).
- 한도: PPTX·XLSX와 같은 수준의 상한 (ops 수·문서 크기 초과 시 413 + 명확한 오류 문구).
- 라이브 검증: 실제 .docx 업로드 → inspect → edit (텍스트 치환 1건 이상) → 새 버전 → 다시 읽기. 편집본은 Word에서 여는 확인용 파일로 `docx-edit-pilot/out/edited-live.docx`에 남긴다 (사용자가 Word에서 직접 열어 본다).
- 기존 엔드포인트 스모크: 바뀐 뒤 `/api/health` + 익명 `/api/auth/me` 401 + `/api/pptx/inspect`·`/api/xlsx/inspect`가 이전과 동일한지 확인한다.
- 임시 시험 계정·문서·덱은 전부 정리하고 0건임을 재확인한다 (`doc_nodes`까지 — `purgeDocument`가 트리 행까지 지우는지 2026-11-22에 고쳐졌다).

## 공통 규칙

- 파일럿과 통합은 순서대로 (파일럿 판정 없이 통합하지 않는다). 배포는 직렬로.
- GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 이 과제 밖의 기능은 건드리지 않는다.
- `npm install`은 레포 루트에서 `--legacy-peer-deps`가 필요하다 (peer 충돌).

## 보고 (마지막에 `files/workflow-verify/docx-edit-pilot/RESULT.md`와 `files/workflow-verify/docx-edit/RESULT.md`에 쓴다)

- 파일럿 판정 (도입 가능/조건부/불가) + 근거 (번들 크기·CPU·열림 결과).
- 바뀐 파일, 배포한 버전 ID (편집 Worker + 본체), 라이브 검증 결과 (엔드포인트·상태·확인한 값), Word 확인용 파일 경로, 임시 데이터 정리 확인.
- 남은 문제·미확인 항목이 있으면 솔직히 적는다.
