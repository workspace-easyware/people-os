# Word 새로 만들기 확장 — 이미지·목차·머리말/바닥글 (2026-11-22, Fable 5.2)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `ae40ce70`, 문서 편집 Worker `1dd93ed7`. 커밋 HEAD `503dec3` (문서 갱신), 태그 `docx-edit-v1`.
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

- Word 새로 만들기는 `docx` 9.16.0으로 본체 Worker에서 한다 (`POST /api/docx/create`, 워크플로 `docx_create` 노드, UI "새 Word 문서 만들기"). 입력: 구조화 `{title, subtitle?, sections}` 또는 `{definition}` 또는 자연어 `{instruction, title?}`. 저장: `documents` 새 행 + R2 `docs/created/<id>.docx`, Vectorize 색인 안 함, D1 마이그레이션 없음. 글꼴 기본값 "Malgun Gothic".
- docx 9.16.0은 Workers에서 `nodejs_compat` 없이 돈다. 번들 gzip 약 110 KiB (본체에 있음). docx는 XML 금지 제어문자를 거르지 않아 정규화 단계에서 제거한다.
- AI 지시 경로는 Qwen JSON이 자주 틀려 보정 2종 + 1회 재시도를 넣었다 (최종 2/2 성공). AI 생성 1회 약 56초 — Queue로 옮기기는 **이번 과제가 아니다** (다음 세션에서 한다). 이 세션은 기존 지시 경로를 그대로 쓴다.
- Word 기존 파일 편집(`docx_edit`)은 ooxml-core로 편집 Worker에서 한다 (방금 끝남, 태그 `docx-edit-v1`). 이 세션은 **새로 만들기** 쪽만 확장한다.

## 과제 1 — 파일럿 (격리 환경, 라이브 코드와 분리)

`files/workflow-verify/docx-create-ext/` 아래에 격리 하네스를 만들고, 로컬 workerd + 원격 시험 Worker에서 검증한다. 세 가지를 각각 파일럿으로 본다:

1. **이미지**: 사용자가 올린 이미지 파일을 문서에 넣는다. 이미지 소스는 사용자가 업로드한 파일(R2에 있는 것)로 한다 — URL 직접 가져오기는 이번 범위 밖이다. docx의 `ImageRun`으로 넣고, 크기 지정(너비 기준)과 위치(문단 안)를 확인한다. 상한(파일 크기·개수)을 정한다.
2. **목차**: `TableOfContents` 필드로 목차를 넣는다. Word는 여는 쪽에서 목차를 갱신하니, 파일럿에서는 목차 필드가 들어가 있고 Word가 열 때 갱신되는지까지만 본다 (이 VM에는 Word·LibreOffice가 없어 직접 갱신 확인은 못 한다 — 확인용 파일을 남긴다).
3. **머리말·바닥글**: docx의 Header/Footer로 머리말(문서 제목 등)과 바닥글(페이지 번호 `PAGE` 필드 포함)을 넣는다. 첫 페이지 다르게 할지는 기본값으로 둔다 (필요하면 옵션으로).

검증할 것: 각 기능이 로컬 workerd와 원격 Workers에서 동작하는지, 저장본 XML이 well-formed인지, 번들 증가분(본체 gzip +몇 KiB인지 — 본체에 두는 게 맞는지 판단), 생성 1회 CPU 시간, 세 기능을 같이 넣은 문서도 되는지.
- 판정을 기능별로 내린다: 도입 가능 / 조건부 / 불가. 불가면 그 기능은 통합에서 빼고, 불가한 이유와 대안을 보고한다.
- 파일럿 결과는 `files/workflow-verify/docx-create-ext/RESULT.md`에 쓴다.

## 과제 2 — 라이브 통합 (파일럿에서 도입 가능·조건부로 판정된 기능만)

- `POST /api/docx/create`의 구조화 입력(`definition`/`sections`)에 새 요소를 넣는다: 이미지(이미 업로드된 문서·파일을 가리키는 방식 — 기존 업로드 경로를 재사용한다), 목차(넣을지 여부), 머리말·바닥글(문구·페이지 번호 여부). 스키마는 기존 모양을 깨지 않게 확장한다 (기존 입력은 그대로 동작해야 한다).
- 자연어 지시 경로도 세 기능을 쓸 수 있게 한다: Qwen이 지시에서 이미지·목차·머리말/바닥글을 알아듣고 정의로 바꾸게 프롬프트와 보정을 확장한다 (기존 보정 2종 + 1회 재시도 패턴을 따른다).
- UI: "새 Word 문서 만들기" 화면에 이미지 선택(업로드한 이미지 파일 목록에서 고르기)·목차 넣기·머리말/바닥글 입력 칸을 넣는다.
- 워크플로 `docx_create` 노드는 새 요소를 쓸 수 있게 한다 (승인 게이트는 그대로).
- 저장·색인·마이그레이션은 기존과 같다 (documents 새 행 + R2 `docs/created/<id>.docx`, Vectorize 색인 안 함, D1 마이그레이션 없음).
- 라이브 검증: 세 기능이 각각 들어간 문서 + 세 기능이 같이 들어간 문서를 만들어 다운로드하고, 다시 읽어 요소가 들어 있는지 확인한다. 확인용 파일은 `docx-create-ext/out/created-ext-live.docx` 등에 남긴다 (사용자가 Word에서 직접 열어 본다).
- 기존 엔드포인트 스모크: 바뀐 뒤 `/api/health` + 익명 `/api/auth/me` 401 + 기존 docx 생성(구조화·지시) 1건씩이 이전과 동일한지 확인한다.
- 임시 시험 계정·문서는 전부 정리하고 0건임을 재확인한다 (`doc_nodes`까지).

## 공통 규칙

- 파일럿과 통합은 순서대로 (파일럿 판정 없이 통합하지 않는다). 배포는 직렬로.
- GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 이 과제 밖의 기능은 건드리지 않는다.
- `npm install`은 레포 루트에서 `--legacy-peer-deps`가 필요하다 (peer 충돌).

## 보고 (마지막에 `files/workflow-verify/docx-create-ext/RESULT.md`에 쓴다)

- 기능별 파일럿 판정 (도입 가능/조건부/불가) + 근거 (번들 크기·CPU·열림 결과).
- 바뀐 파일, 배포한 버전 ID (본체), 라이브 검증 결과 (엔드포인트·상태·확인한 값), Word 확인용 파일 경로, 임시 데이터 정리 확인.
- 남은 문제·미확인 항목이 있으면 솔직히 적는다.
