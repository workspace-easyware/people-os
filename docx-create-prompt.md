# 워드(.docx) 새로 만들기 — docx 라이브러리 (파일럿 검증 + 라이브 통합, 한 세션)

## 목표

워드 문서를 **새로 만드는** 기능을 People OS에 붙인다. `docx` 라이브러리로 생성한다. 기존 .docx 파일 편집은 이번 범위 밖이다. PPTX·엑셀과 같은 패턴이다: **먼저 격리 파일럿으로 검증하고, 통과하면 같은 세션에서 바로 라이브 통합까지** 한다. 파일럿이 실패하면 라이브 코드는 건드리지 않고 멈춘다.

## 근거 (2026-11-19 조사, 반드시 읽을 것)

- 보고서: `~/workspace/research_notes/opensource-document-libraries-workers-20261119-1214/report.md` §4.
- 라이브러리: **`docx`** (dolanmiu/docx, MIT, v9.15.3 기준 — 설치된 정확한 버전을 확인해 고정한다). 매우 활발히 유지보수됨. `Packer.toBuffer()`/`toBlob()`, 코어 경로에 fs 없음, Node + 브라우저 빌드, 서브패스 트리쉐이킹 가능(도형·워터마크·차트·HTML·매크로·임베드 파일·서지 기능은 코어 밖에 있음). 기능: 문단·텍스트런·제목·표·이미지·머리말/바닥글·목차·번호 매기기·스타일·섹션, 네이티브 워드 차트(`docx/charts`), 도형, HTML→docx. **주의: Workers에서 돌아간다는 명시적 테스트는 조사에서 찾지 못했다 — 파일럿에서 반드시 확인한다.** 기존 .docx 편집은 Patcher가 `{{플레이스홀더}}`만 채우므로 이번 범위 밖이다.
- PPTX 선례: People OS의 S3 덱 생성(`src/index.ts`의 `POST /api/deck`, pptxgenjs)이 새 문서 만들기의 패턴이다. 엑셀 통합 결과(`files/workflow-verify/xlsx-edit-pilot/RESULT.md`)도 읽고 저장·라우트·워크플로 노드·UI 패턴을 따른다.

## 1단계: 파일럿 검증 (격리 환경, 라이브 코드 손대지 않음)

- 파일럿 디렉터리: `files/people-os/docx-create-pilot/` (자체 `package.json`, 시험 Worker용 `wrangler.toml` 포함). 이 단계에서는 레포의 `package.json`, `wrangler.toml`, `src/`, `public/`을 일절 건드리지 않는다.
- 검증 항목 (전부 실제 실행으로):
  1. 설치: 현재 npm 버전 확인, 깔끔히 설치되는지, 설치 크기 기록.
  2. 시험 문서 만들기: docx로 직접 만든다 — 제목, 제목 스타일(Heading 1/2), 문단(굵게·기울임 포함), 글머리 목록, 번호 목록, 표(헤더 + 3행), 페이지 나누기. 이미지·목차·차트는 이번 시험에서 제외한다 (후속 과제).
  3. 저장 뒤 검증: 다시 열어 구조를 읽어 확인하고(제목·표 셀 값), ZIP을 풀어 XML이 well-formed인지 확인한다.
  4. Workers 호환: 최소 Worker를 만들어 로컬 `npx wrangler dev --local`로 돌린다. **번들 크기는 `wrangler deploy --dry-run`으로 잰다 (docx 9.x 번들은 조사에서 미확인).** 원격 시험 Worker는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy --config <파일럿 wrangler.toml 절대 경로>`로 배포한다 (직접 실행, `python3` 경유 금지, `cd ... && cf-wrangler.py` 금지). Worker 이름 `people-os-docx-pilot`. 끝까지 확인한 뒤 `cf-wrangler.py delete --name people-os-docx-pilot --force`로 삭제한다.
  5. CPU는 `wrangler tail`의 `cpuTime`으로 잰다 (Workers 안에서 `Date.now()`는 요청 중 흐르지 않는다).
  6. **배치 결정**: 파일럿 번들 측정값을 보고 docx 생성 코드를 어디에 둘지 정한다. 작으면(본체 번들 증가가 pptxgenjs 수준) People OS 본체 Worker에, 크면 편집 Worker(`people-os-pptx-editor`, 서비스 바인딩)에 둔다. 결정과 근거를 결과 파일에 적는다.
- **게이트: 파일럿에서 막히는 것(번들 한도, CPU 한도, 저장본 문제 등)이 있으면 2단계로 가지 말고, 결과 파일에 판정(불가/조건부)과 근거를 적고 멈춘다.**

## 2단계: 라이브 통합 (파일럿 통과 시에만)

1. **생성 코드**: 1단계 결정에 따라 본체 또는 편집 Worker에 docx 생성 모듈을 둔다. 입력은 구조화된 문서 정의(제목, 섹션 배열: `{heading, level, paragraphs[], bullets[], table?}`) + 자연어 지시(아래 3번)다. `docx`를 고정 버전으로 설치한다.
2. **라우트** (`src/index.ts`, S3 덱 생성 라우트 옆): `POST /api/docx/create` (구조화 입력 → .docx 생성 → 저장 → 문서 id 반환). 저장 위치는 기존 문서 저장 경로를 보고 정한다 (엑셀 편집본과 같은 방식: `documents` 새 행 + 새 R2 키, 코드에서 확인하고 결과 파일에 적는다). D1 마이그레이션은 피한다.
3. **자연어 지시**: `instruction`을 받으면 Qwen(`@cf/qwen/qwen3.8-27b`)이 문서 구조 JSON(제목·섹션·문단·표)을 만든다. 결과를 스키마 검증한 뒤 생성한다 (엑셀·PPTX의 AI 계획 패턴과 같다).
4. **워크플로 노드 `docx_create`** (`src/workflow/types.ts`·`nodes.ts`, `pptx_edit`·`xlsx_edit`과 같은 패턴): 입력은 문서 정의 또는 instruction + title. `requiresApproval`을 지원한다.
5. **UI (`public/`)**: 라이브러리에 "새 Word 문서 만들기"를 둔다. 제목 입력 + 자연어 지시 입력(또는 간단한 섹션 입력) → 생성 → 다운로드 링크와 문서 행으로 이동. 생성된 문서는 기존 다운로드 라우트로 받는다.
6. **가드**: 입력 크기(섹션·문단·표 셀 수) 상한을 걸고, 상한 초과 시 명확한 오류를 반환한다. 큰 문서의 Queue 소비자 처리는 이번 범위 밖으로 하고 결과 파일에 후속 과제로 적는다.

## 검증 (2단계)

- `npx tsc --noEmit` 오류 0 + 바뀐 `public/*.js` `node --check` 0.
- 로컬: `wrangler dev --local`로 끝까지 돌린다 (생성 → 저장 → 다운로드 → 다시 열어 구조 확인).
- 원격: 배포는 직렬로, 한 번에 하나씩 (편집 Worker를 건드렸으면 편집 Worker 먼저, People OS 다음). 배포 뒤 스모크는 **3분 뒤**에 한다 (배포 직후 약 2분은 옛 버전이 응답한다).
- 라이브 스모크: 기존 엔드포인트가 의도한 변화 외에는 바이트 동일인지 확인한다 (PPTX·엑셀 통합 스모크 방식). 끝까지 간 생성본 1개를 `docx-create-pilot/out/created-live.docx`에 남긴다 (사용자가 Word에서 열어 확인용).
- `wrangler tail`로 생성 1회의 cpuTime을 재고 결과 파일에 적는다.
- 결과 파일: `files/workflow-verify/docx-create/RESULT.md` — 파일럿 판정 + 통합 판정, 항목별 결과 + 근거(버전·번들 크기·CPU 측정값·배치 결정), 남은 한계(Word 열림 미확인 포함), 후속 과제. 근거 파일은 `files/workflow-verify/docx-create/evidence/`에 둔다.

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- `node <스크립트>`가 막히면 실험은 `wrangler dev` 라우트로 돌린다 (PPTX·엑셀 파일럿 선례).
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다.
- 커밋·태그는 Merlin이 한다. 라이브 스모크에 임시 계정이 필요하면 PPTX·엑셀 통합 방식(임시 사용자 + 1시간 세션, 끝나면 사용자·세션·시험 파일 전부 삭제하고 확인 쿼리 결과를 결과 파일에 적는다)을 따른다.
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·배포된 버전을 짧게 요약한다.
