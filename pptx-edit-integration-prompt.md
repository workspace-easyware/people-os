# PPTX 편집 라이브 통합 — 별도 Worker 구조 (파일럿 결과 기반)

## 목표

파일럿에서 검증한 ooxml-core PPTX 편집을 People OS에 **별도 Worker 구조**로 라이브 통합한다. 파일럿 판정은 **조건부 도입 가능**이었고, 조건 1개(별도 Worker 분리)는 사용자가 선택했다. 조건 2개(CPU 요금제 한도)는 이번 계정이 Workers Paid라 요청당 CPU 30초·월 3,000만 CPU-ms 포함이라 1초짜리 편집에는 여유가 있다. **PowerPoint에서 편집본이 열리는지 직접 확인은 아직 안 됐다** — 이번 통합의 끝까지 간 편집본 1개를 남기고, 사용자가 PowerPoint에서 열어 확인하는 것을 전제로 한다.

## 근거 파일 (반드시 읽을 것)

- `files/workflow-verify/pptx-edit-pilot/PILOT-RESULT.md` — 판정·항목별 결과·한계·통합 개요·백업 조건 전부.
- `pptx-edit-pilot/src/lab.js` — `applyEdits()`가 통합할 편집 로직의 원형이다. `src/deck.js`(시험 덱 생성), `src/minimal.js`(최소 Worker)도 참고.
- `pptx-edit-pilot/package-lock.json` — 설치된 **정확한 버전**을 확인하고 새 Worker에 그 버전으로 고정한다 (파일럿: `pptx-viewer-core 5.0.0`, `ooxml-core 2.x`).

## 현재 상태

- People OS는 `pptxgenjs 4.0.1`으로 새 덱 만들기만 한다 (S3, `src/index.ts` ~L465 근처). 기존 PPTX 편집 기능은 없다.
- R2 바인딩 `FILES`(버킷 `people-os-files`), D1 `people-os-db`, 큐·DO는 기존과 같다.
- 라이브 버전 `778b62b4`, git HEAD `85753e8`(파일럿 커밋). 동결은 11-25, 제출은 11-27이다. 기존 기능을 깨지 않는 것이 최우선이다.

## 통합 범위 (PILOT-RESULT.md 통합 개요 1~5번, 6번 가드는 일부만)

1. **새 Worker `people-os-pptx-editor`** (디렉터리 `files/people-os/pptx-editor/`, 자체 `package.json` + `wrangler.toml`, `compatibility_date 2025-07-18` + `nodejs_compat`은 People OS와 같게). `pptx-viewer-core`를 고정 버전으로 설치. RPC(WorkerEntrypoint)로 `inspect(bytes)` / `applyOps(bytes, ops[])` / `replaceText(bytes, find, to)`를 제공한다. People OS `wrangler.toml`에는 `[[services]] binding = "PPTX_EDITOR"`만 추가한다 (다른 설정은 건드리지 않는다).
2. **ops 스키마**를 People OS 쪽 공용 타입으로 정의한다: `{op:"text", slide, elementId, runIndex?, text}`, `{op:"shape", …x,y,w,h,fill}`, `{op:"cell", slide, elementId, r, c, text}`, `{op:"chart", slide, elementId, series:[[…]], title?}`, `{op:"duplicate", slide}`. 파일럿 `src/lab.js`의 `applyEdits()`가 원형이다.
3. **`src/index.ts`에 "덱 편집" 라우트**를 S3 덱 생성 옆에 둔다. R2 `FILES`에서 원본 pptx를 읽어 `PPTX_EDITOR.inspect`로 슬라이드·요소 요약을 얻고, ops로 `applyOps`를 호출한다. 결과는 **새 R2 키(버전)로 저장**하고 원본은 절대 덮지 않는다. 편집본 다운로드 라우트도 둔다.
4. **`src/workflow/nodes.ts`에 워크플로 노드 `pptx_edit`**를 추가한다 (입력: 파일 ID와 ops 또는 자연어 지시 → LLM이 `inspect` 요약을 보고 ops JSON 생성). `requiresApproval`을 지원해 승인 게이트와 이어 붙일 수 있게 한다.
5. **UI (`public/`)**: 파일 상세에 "편집본 만들기"와 변경 전후 텍스트 diff를 둔다. 서명 덱이면 "저장 시 서명 제거" 경고를 띄우고, SmartArt를 편집했으면 "PowerPoint에서 레이아웃 새로고침 필요할 수 있음"을 표시한다. (파일 상세 UI 위치는 코드에서 찾는다.)
6. **가드**: `load(buffer, { limits })`로 입력 크기·슬라이드 수 상한을 걸고, 상한 초과 시 명확한 오류를 반환한다. 큰 덱의 Queue 소비자 처리는 이번 범위 밖으로 하고 결과 파일에 후속 과제로 적는다.

## 검증 (전부 실제 실행으로)

- `npx tsc --noEmit` 오류 0 + 바뀐 `public/*.js` `node --check` 0.
- 로컬: `wrangler dev --local`로 편집 Worker + People OS 라우트를 끝까지 돌린다 (시험 덱 생성 → inspect → applyOps → 저장 → 다시 읽어 값 확인 → 손대지 않은 슬라이드 바이트 동일 확인).
- 원격: 편집 Worker를 먼저 배포하고(`cf-wrangler.py deploy --config <절대 경로>`, 직접 실행, `python3` 경유 금지, `cd ... && cf-wrangler.py` 금지), People OS를 배포한다. 배포는 직렬로, 한 번에 하나씩. 배포 뒤 스모크는 **3분 뒤**에 한다 (배포 직후 약 2분은 옛 버전이 응답한다).
- 라이브 스모크: 기존 엔드포인트가 의도한 변화 외에는 바이트 동일인지 확인한다 (T3-FIXES 스모크 방식). 끝까지 간 편집본 1개를 `pptx-editor/out/edited-live.pptx`에 남긴다 (사용자가 PowerPoint에서 열어 확인용).
- `wrangler tail`로 편집 1회의 cpuTime을 재고 결과 파일에 적는다.
- 결과 파일: `files/workflow-verify/pptx-edit-pilot/INTEGRATION-RESULT.md` — 판정, 항목별 결과 + 근거(버전·번들 크기·CPU 측정값), 남은 한계(PowerPoint 열림 미확인 포함), 후속 과제(Queue 처리 등).

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- `node <스크립트>`가 막히면 실험은 `wrangler dev` 라우트로 돌린다 (파일럿 선례). CPU 시간은 tail의 `cpuTime`으로 잰다 (Workers 안에서 `Date.now()`는 요청 중 흐르지 않는다).
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다.
- 커밋·태그·운영 배포 외의 배포(새 Worker 배포는 이번 작업의 일부라 한다 — 위 검증 항목대로)는 하지 않는다. 커밋·태그는 Merlin이 한다.
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·배포된 버전을 짧게 요약한다.
