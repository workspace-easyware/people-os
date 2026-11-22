# 네이티브 confirm() 나머지 교체 — uiConfirm + uiToast로 (2026-11-22, Fable 5.2)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `74bc26f6`, 문서 편집 Worker `1dd93ed7`. 커밋 HEAD은 세션 5 커밋(`calendar-c5c6-v1` 태그) 이후다.
- 모델: Fable 5.2 (이 세션은 Fable 5.2 하나로 끝까지 — 중간에 모델 바꾸지 말 것).
- 먼저 `~/AGENTS.md`를 읽을 것 — 검증된 운용 교훈(권한 규칙, 라이브 호출 방법, 배포 주의)이 들어 있다. 특히:
  - 라이브 HTTP 검증은 `--add-dir ~/workspace/user`(시크릿 읽기)와 `Bash(curl *peopleos.site*)` 규칙이 있어야 한다.
  - `peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다 — 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다.
  - 배포 뒤 약 2분은 옛 버전이 응답한다 — 스모크는 3분 뒤에 할 것.
  - 배포는 직렬로 (동시 배포 금지). `cf-wrangler.py deploy`가 승인 대기로 막히면 우회하지 말고 보고만 하고 멈출 것.
  - `git add`·커밋·태그는 Merlin이 직접 한다 — 세션은 커밋하지 말 것.
  - 문서(ARCHITECTURE.md·VERIFICATION.md)는 건드리지 말 것 — Merlin이 따로 갱신한다.
- `npx tsc --noEmit` 0건, 바뀐 화면 JS는 `node --check` 통과가 매 단계의 조건이다.

## 문제

2026-11-21 브라우저 화면 회귀에서 네이티브 `confirm()`이 원인이었다: 자동화 브라우저가 `confirm()`을 기본 거절해서 일괄 승인·대화 지우기가 무반응이었다. 그때 만든 페이지 내 확인 대화상자 `uiConfirm()` + 토스트 `uiToast()`(`public/ui-dialog.js`)로 일괄 승인·거절·대화 지우기·동기식 승인 4곳만 교체했고, 나머지는 남아 있다.

`confirm()`은 동기, `uiConfirm()`은 Promise라 호출부를 async로 바꿔야 한다.

## 과제 — 남은 17곳 전부 교체

2026-11-22 grep 실측 목록 (교체 전에 다시 grep으로 확인할 것 — 행 번호가 바뀌었을 수 있다):

- `public/approval.js`:135·136 (강제 반려·회수)
- `public/calendar.js`:541·653·665
- `public/chat.js`:44 (`ask` 헬퍼 — confirm 래퍼)
- `public/lms.js`:277·360
- `public/meet.js`:114
- `public/plaud.js`:225
- `public/workflow.js`:567 (`wfConfirmLeave` — 저장 안 한 변경 버리고 이동; beforeunload성이라 비동기 전환 가능 여부 판단 필요)·806·909·1108
- `public/index.html`:757·1134·1618

### 규칙

- 교체 방식: 브라우저 수정 때 만든 `uiConfirm()` + `uiToast()`를 쓴다. 문구는 기존 confirm 문구와 같은 뜻으로, 버튼은 "확인/취소"가 아니라 문맥에 맞는 말로 쓴다 (예: "삭제", "보내기").
- **예외를 판단한다**: `wfConfirmLeave`(workflow.js:567)처럼 beforeunload성·페이지 이탈 확인은 Promise 대화상자로 못 바꿀 수 있다. 바꾸면 안 되는 곳은 바꾸지 않고 이유를 RESULT에 적는다 (그 경우 `beforeunload` 이벤트나 다른 방식으로 남긴다).
- `chat.js:44`의 `ask` 헬퍼는 confirm 래퍼라 부르는 곳이 여러 곳일 수 있다 — 헬퍼를 바꾸면 호출부 전체가 영향을 받으니 호출부를 전부 확인한다.
- 교체 뒤에는 해당 기능을 화면에서 실제로 눌러 본다 — 자동화 브라우저로 눌러 대화상자가 뜨고, 확인을 누르면 동작하고, 취소를 누르면 안 하는지 확인한다. **이것이 이번 세션의 핵심 검증이다** (2026-11-21 회귀가 화면에서 발견된 문제였기 때문).
- `ui-dialog.js`가 아직 로드되지 않은 화면이 있으면 로드부터 고친다 (모든 화면에서 대화상자가 떠야 한다).

### 검증

- 로컬: `node --check` + 교체한 각 기능을 브라우저에서 눌러 보기 (확인/취소 둘 다).
- 라이브: 배포 3분 뒤, VM 클라우드 브라우저(hr.jhkang 로그인, 읽기 전용 — 실제 삭제·발송은 하지 않는다)로 교체한 곳 중 눌러 볼 수 있는 것을 확인한다. 실제 데이터를 바꾸는 동작(삭제·회수·반려)은 라이브에서 하지 않고, 대화상자가 뜨는 것까지만 확인한다. 테스트 데이터가 생기면 전부 정리하고 0건임을 재확인한다.
- 기존 엔드포인트 스모크 (`/api/health`·익명 `/api/auth/me` 401)가 이전과 동일한지 확인한다.

## 공통 규칙

- 배포는 직렬로. GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 이 과제 밖의 기능은 건드리지 않는다.
- `npm install`은 레포 루트에서 `--legacy-peer-deps`가 필요하다 (peer 충돌).

## 보고 (마지막에 `files/workflow-verify/confirm-replace/RESULT.md`에 쓴다)

- 교체한 곳 목록(파일·행·전/후 동작) + 바꾸지 않은 곳과 이유 + 바뀐 파일, 배포한 버전 ID.
- 브라우저 검증 결과 (눌러 본 기능·확인/취소 결과), 임시 데이터 정리 확인.
- 남은 문제·미확인 항목이 있으면 솔직히 적는다 (특히: 라이브에서 눌러 보지 못한 동작, `wfConfirmLeave` 처리 결과).
