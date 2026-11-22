# 제출 전 수정 3건 — 편집 Worker 개명 + 로그아웃 새로고침 + 문서 삭제 doc_nodes 잔재 (2026-11-22)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `474e11ab`, 문서 편집 Worker `84973507`. 커밋 HEAD `37d119f` (태그 `browser-fix-2026-11-21`).
- 모델: Opus 5.5 (이 세션은 Opus 5.5 하나로 끝까지 — 중간에 모델 바꾸지 말 것).
- 먼저 `~/AGENTS.md`를 읽을 것 — 검증된 운용 교훈(권한 규칙, 라이브 호출 방법, 배포 주의)이 들어 있다. 특히:
  - 라이브 HTTP 검증은 `--add-dir ~/workspace/user`(시크릿 읽기)와 `Bash(curl *peopleos.site*)` 규칙이 있어야 한다.
  - `peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다 — 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다.
  - 배포 뒤 약 2분은 옛 버전이 응답한다 — 스모크는 3분 뒤에 할 것.
  - 배포는 직렬로 (동시 배포 금지). `cf-wrangler.py deploy`가 승인 대기로 막히면 우회하지 말고 보고만 하고 멈출 것.
  - `git add`·커밋·태그는 Merlin이 직접 한다 — 세션은 커밋하지 말 것.
  - 문서(ARCHITECTURE.md·VERIFICATION.md)는 건드리지 말 것 — Merlin이 따로 갱신한다.
- `npx tsc --noEmit` 0건, 바뀐 화면 JS는 `node --check` 통과가 매 단계의 조건이다.

## 과제 1 — 편집 Worker 개명: `people-os-pptx-editor` → `people-os-doc-editor`

이유: 처음엔 PPTX 편집만 해서 그렇게 지었는데, 이제 XLSX 편집도 같은 Worker에서 한다. 이름이 하는 일을 안 보여준다.

- `pptx-editor/wrangler.toml`의 `name`을 `people-os-doc-editor`로 바꾼다.
- 본체 `wrangler.toml`의 `[[services]]`에서 `service`를 `people-os-doc-editor`로 바꾸고, 바인딩 이름도 `PPTX_EDITOR` → `DOC_EDITOR`로 바꾼다.
- 코드의 모든 `PPTX_EDITOR` 참조를 `DOC_EDITOR`로 바꾼다 (확인된 위치: `src/pptx/edit.ts`, `src/pptx/types.ts`, `src/xlsx/edit.ts`, `src/xlsx/types.ts`, `src/workflow/types.ts:31`, `src/workflow/nodes.ts` 주석). `env.PPTX_EDITOR` 타입·에러 문구("PPTX 편집 Worker(PPTX_EDITOR)가 연결되지 않았습니다." → "문서 편집 Worker(DOC_EDITOR)가 연결되지 않았습니다.")까지 바꾼다. `grep -rn "PPTX_EDITOR\|pptx-editor\|people-os-pptx-editor" src/ wrangler.toml pptx-editor/wrangler.toml`으로 잔재가 0건인지 확인한다.
- 폴더명 `pptx-editor/`는 그대로 둔다 (폴더 이동은 승인 대기로 막힌다). 보고서에 "폴더명은 그대로"라고 적는다.
- 배포 순서 (직렬): ① 편집 Worker를 새 이름으로 배포 (`cf-wrangler.py deploy`, `pptx-editor/` 디렉터리 — `--config` 절대 경로로, `cd` 없이 실행) ② `versions list`로 새 Worker 버전 확인 ③ 본체 wrangler.toml 바인딩·코드 변경 후 본체 배포 ④ 라이브 검증: `POST /api/pptx/inspect` 200 + `POST /api/pptx/edit` 201 (기존 덱으로) + `POST /api/xlsx/inspect` 200 + `POST /api/xlsx/edit` 201 — 편집본은 삭제해 정리 ⑤ 옛 Worker 삭제 (`cf-wrangler.py delete --name people-os-pptx-editor --force`) ⑥ 삭제 확인 (목록에 옛 이름이 없을 것).
- 주의: 새 Worker 배포와 본체 배포 사이에 본체는 옛 이름을 가리킨다 — 간격을 짧게 하고, 본체 배포 직후 스모크는 3분 뒤에 한다.

## 과제 2 — 로그아웃 시 새로고침

- `public/index.html`의 `doLogout()` (현재: `/api/auth/logout` POST → `currentUser = null` → `applyRole()` → `unmountObs()` → `showAuthOverlay('login')`) 끝에 `location.reload()`를 넣는다.
- 의도: 로그아웃 뒤 화면에 이전 사용자 상태가 남지 않게 한다. API 호출이 실패했을 때는 새로고침하면 서버 세션이 살아 있어 로그인 상태로 다시 보일 수 있는데, 그게 정직한 동작이다 (지금은 API 실패에도 클라이언트만 로그아웃된 것처럼 보이는 게 더 나쁨).
- 검증: `node --check` + 배포 뒤 라이브 홈 JS에서 `doLogout` 안에 `location.reload()`가 있는 것을 확인한다. 브라우저 클릭 확인은 Merlin이 따로 한다.

## 과제 3 — 문서 삭제 시 `doc_nodes` 잔재 버그 수정

- 원인: `src/index.ts`의 `purgeDocument()` (약 1863행)가 Vectorize 벡터 → R2 → chunks → `recordings.doc_id=NULL` → documents 행까지만 지우고 `doc_nodes`를 안 지운다. 2026-11-21 회귀에서 재현됨. 함수 위 주석에도 단계 목록이 있으니 주석에도 `doc_nodes`를 추가한다.
- 수정: `purgeDocument()`에 `DELETE FROM doc_nodes WHERE doc_id = ?`를 넣는다 (`doc_nodes`의 문서 컬럼은 `doc_id`). 녹음 삭제 경로도 `purgeDocument()`를 쓰므로 함께 고쳐진다. `grep -rn "DELETE FROM documents" src/`로 purgeDocument가 유일한 삭제 경로인지 확인하고, 다른 삭제 경로가 있으면 그것도 고친다. 덱(`decks`) 삭제는 문서가 아니라 별도 경로이니 `doc_nodes`와 무관한지 확인만 한다.
- 라이브 고아 정리: 먼저 `SELECT COUNT(*) FROM doc_nodes WHERE doc_id NOT IN (SELECT id FROM documents)`로 고아 행 수를 확인하고, 0건이 아니면 `DELETE FROM doc_nodes WHERE doc_id NOT IN (SELECT id FROM documents)`로 지우고 지운 건수를 보고한다. 단, 방금 만든 테스트 문서의 행이 고아로 잡히지 않게 정리 시점을 주의한다.
- 라이브 검증: 테스트 문서 1건을 만들고 트리(`doc_nodes` 행이 생기는지 확인 — 없으면 `build-tree`를 돌리거나 제목이 있는 파일 문서로 만든다) → `DELETE /api/documents/:id` → `SELECT COUNT(*) FROM doc_nodes WHERE doc_id = '<id>'`가 0인지 확인 → 녹음 삭제 경로도 같은 방식으로 1건 확인 (전사본이 있는 녹음 1건). 테스트 문서·녹음은 정리하고 0건임을 재확인한다.

## 공통 규칙

- 세 과제를 순서대로 (과제 1 → 과제 2 → 과제 3) 하고, 본체 배포는 합쳐서 최소 횟수로 한다 (과제 1의 본체 배포와 과제 2·3의 본체 배포를 합칠 수 있으면 합친다 — 단 과제 1의 편집 Worker 배포는 본체 배포보다 먼저여야 한다).
- 기존 엔드포인트 스모크: 바뀐 뒤 `/api/health` + 익명 `/api/auth/me` 401 + `/api/workflows/templates` 401이 이전과 동일한지 확인한다.
- GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 세 과제 밖의 기능은 건드리지 않는다.
- 임시 시험 계정·문서·녹음·덱은 전부 정리하고 0건임을 재확인한다.

## 보고 (마지막에 `files/workflow-verify/doc-fix-2026-11-22/RESULT.md`에 쓴다)

- 과제별: 바뀐 파일, 배포한 버전 ID (편집 Worker 새 버전 + 본체 새 버전), 라이브 검증 결과 (엔드포인트·상태·확인한 값), 삭제한 옛 Worker 확인, 고아 doc_nodes 정리 건수, 테스트 문서·녹음 정리 확인.
- ARCHITECTURE.md·VERIFICATION.md·MEMORY.md에 바꿔야 할 이름 문자열 목록 (Merlin이 따로 갱신한다).
- 남은 문제·미확인 항목이 있으면 솔직히 적는다.
