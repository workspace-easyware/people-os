# 엑셀 편집 구현 — xlvane (파일럿 검증 + 라이브 통합, 한 세션)

## 목표

엑셀(.xlsx) 편집을 People OS에 붙인다. PPTX와 같은 패턴이다: **먼저 격리 파일럿으로 검증하고, 통과하면 같은 세션에서 바로 라이브 통합까지** 한다. 파일럿이 실패하면 라이브 코드는 건드리지 않고 멈춘다.

## 근거 (2026-11-19 조사, 반드시 읽을 것)

- 보고서: `~/workspace/research_notes/opensource-document-libraries-workers-20261119-1214/report.md` §3.
- 라이브러리: **`xlvane`** (MIT, v1.3.4, 2026-11-10 기준 — 설치된 정확한 버전을 확인해 고정한다). 의존성 1개(`fflate`, ~22 kB gzip), ESM 전용, **workerd에서 명시적으로 테스트됨**, 코어는 `Uint8Array`, Node 의존성 없음. 읽기·편집·쓰기, 표, CSV, 스트리밍 지원. `@xlvane/exceljs`는 ExcelJS API가 꼭 필요할 때만 쓰는 호환층이다 — 기본은 일반 xlvane.
- **수식 진실: 어떤 JS 라이브러리도 수식을 계산하지 않는다.** 수식 문자열 + 네가 직접 계산한 캐시 `result`를 쓰고, Excel이 열 때 다시 계산하게 한다 (`fullCalcOnLoad` 설정). 코드로 만든 파일은 Excel이 열기 전까지 수식 셀의 캐시 결과가 없다 — `result`를 아는 경우에만 채운다.
- PPTX 선례: `files/workflow-verify/pptx-edit-pilot/PILOT-RESULT.md` + `INTEGRATION-RESULT.md`, 편집 Worker `pptx-editor/src/index.js`, People OS 쪽 `src/pptx/{types,edit}.ts`를 반드시 읽고 같은 패턴을 따른다.

## 구조 결정 (사용자 결정)

- **엑셀은 PPTX 편집 Worker(`people-os-pptx-editor`)에 합친다.** 별도 Worker를 또 만들지 않는다. Worker 이름은 지금 그대로 둔다 (people-os-doc-editor로 바꾸는 것은 제출 뒤 정리 과제 — 이번에 바꾸지 않는다).
- 편집본은 원본을 절대 덮지 않고 새 버전으로 저장한다 (PPTX와 같은 원칙).

## 1단계: 파일럿 검증 (격리 환경, 라이브 코드 손대지 않음)

- 파일럿 디렉터리: `files/people-os/xlsx-edit-pilot/` (자체 `package.json`, 시험 Worker용 `wrangler.toml` 포함). 이 단계에서는 레포의 `package.json`, `wrangler.toml`, `src/`, `public/`을 일절 건드리지 않는다.
- 검증 항목 (전부 실제 실행으로):
  1. 설치: 현재 npm 버전 확인, 깔끔히 설치되는지, 설치 크기 기록.
  2. 시험 워크북 만들기: xlvane으로 직접 만든다 — 값 셀, **수식 셀(수식 문자열 + 캐시 result)**, 서식(굵게·배경색), 표 1개, 시트 2장 이상.
  3. 편집: 셀 값 교체, 수식 교체(수식 + 캐시 result 함께), 행 추가, 시트 추가(가능하면). 저장 뒤 다시 열어 값을 읽어 확인하고, ZIP을 풀어 XML이 well-formed인지 확인한다. 손대지 않은 시트의 내용이 그대로인지도 확인한다.
  4. Workers 호환: 최소 Worker를 만들어 로컬 `npx wrangler dev --local`로 돌린다. 번들 크기는 `wrangler deploy --dry-run`으로 잰다. 원격 시험 Worker는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy --config <파일럿 wrangler.toml 절대 경로>`로 배포한다 (직접 실행, `python3` 경유 금지, `cd ... && cf-wrangler.py` 금지). Worker 이름 `people-os-xlsx-pilot`. 끝까지 확인한 뒤 `cf-wrangler.py delete --name people-os-xlsx-pilot --force`로 삭제한다.
  5. CPU는 `wrangler tail`의 `cpuTime`으로 잰다 (Workers 안에서 `Date.now()`는 요청 중 흐르지 않는다).
- **게이트: 파일럿에서 막히는 것(번들 한도, CPU 한도, 저장본이 안 열리는 등)이 있으면 2단계로 가지 말고, 결과 파일에 판정(불가/조건부)과 근거를 적고 멈춘다.**

## 2단계: 라이브 통합 (파일럿 통과 시에만)

1. **편집 Worker(`pptx-editor/`)에 xlsx 지원 추가**: xlvane을 고정 버전으로 설치하고, PPTX RPC 옆에 xlsx RPC를 둔다 (`inspectWorkbook` / `applyWorkbookOps` / `replaceCell` 또는 같은 모양 — PPTX RPC는 건드리지 않는다). `wrangler.toml`의 Worker 이름·바인딩은 그대로.
2. **People OS 쪽 공용 ops 스키마** (`src/xlsx/types.ts` 신규, PPTX `src/pptx/types.ts`와 같은 모양): `{op:"cell", sheet, cell, value}`, `{op:"formula", sheet, cell, formula, result}`, `{op:"row", sheet, values}`, `{op:"sheet", name}` 등. `validateOps` 포함.
3. **라우트** (`src/xlsx/edit.ts` 신규 + `src/index.ts`에 연결, PPTX 라우트와 같은 자리): `POST /api/xlsx/inspect` · `POST /api/xlsx/edit` · `GET /api/xlsx/versions`. 로그인 사용자만 (익명은 401). 편집본은 **새 행 + 새 R2 키**로 저장하고 원본은 남긴다. 저장 위치는 기존 문서·덱 저장 경로를 보고 정한다 (코드에서 확인하고 결과 파일에 적는다).
4. **워크플로 노드 `xlsx_edit`** (`src/workflow/types.ts`·`nodes.ts`, PPTX `pptx_edit`과 같은 패턴): 파일 ID + ops 또는 자연어 지시 → LLM이 inspect 요약을 보고 ops JSON 생성. `requiresApproval`을 지원한다.
5. **UI (`public/`)**: 파일 상세에 "편집본 만들기"와 변경 전후 diff를 둔다 (PPTX `public/pptx-edit.js`와 같은 패턴). 수식 셀에는 "수식은 Excel이 열 때 다시 계산합니다" 안내를 넣는다.
6. **가드**: 입력 크기·시트 수·셀 수 상한을 걸고, 상한 초과 시 명확한 오류를 반환한다. 큰 파일의 Queue 소비자 처리는 이번 범위 밖으로 하고 결과 파일에 후속 과제로 적는다.

## 검증 (2단계)

- `npx tsc --noEmit` 오류 0 + 바뀐 `public/*.js` `node --check` 0.
- 로컬: `wrangler dev --local`로 두 Worker를 함께 띄워 끝까지 돌린다 (시험 워크북 → inspect → ops 편집 → 저장 → 다시 읽어 값 확인 → 손대지 않은 시트 내용 동일 확인 → 원본 보존 확인).
- 원격: 편집 Worker를 먼저 배포하고 People OS를 다음에 배포한다. 배포는 직렬로, 한 번에 하나씩. 배포 뒤 스모크는 **3분 뒤**에 한다 (배포 직후 약 2분은 옛 버전이 응답한다).
- 라이브 스모크: 기존 엔드포인트가 의도한 변화 외에는 바이트 동일인지 확인한다 (PPTX 통합 스모크 방식). 끝까지 간 편집본 1개를 `xlsx-edit-pilot/out/edited-live.xlsx`에 남긴다 (사용자가 Excel에서 열어 확인용).
- `wrangler tail`로 편집 1회의 cpuTime을 재고 결과 파일에 적는다.
- 결과 파일: `files/workflow-verify/xlsx-edit-pilot/RESULT.md` — 파일럿 판정 + 통합 판정, 항목별 결과 + 근거(버전·번들 크기·CPU 측정값), 남은 한계(Excel 열림 미확인 포함), 후속 과제. 근거 파일은 `files/workflow-verify/xlsx-edit-pilot/evidence/`에 둔다.

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- `node <스크립트>`가 막히면 실험은 `wrangler dev` 라우트로 돌린다 (PPTX 파일럿 선례).
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다.
- 커밋·태그는 Merlin이 한다. 라이브 편집 스모크에 임시 계정이 필요하면 PPTX 통합 방식(임시 사용자 + 1시간 세션, 끝나면 사용자·세션·시험 파일 전부 삭제하고 확인 쿼리 결과를 결과 파일에 적는다)을 따른다.
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·배포된 버전을 짧게 요약한다.
