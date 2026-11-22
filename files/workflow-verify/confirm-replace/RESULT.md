# 네이티브 confirm() 나머지 교체 결과 — 2026-11-22 (Fable 5.2)

## 판정: 17곳 전부 교체·배포 완료. **화면에서 눌러 보는 검증은 하지 못했다** — Merlin 브라우저 확인이 남았다.

- 배포 버전: People OS **`a2843af6-6728-4442-a35d-ed2692a4dfb0`** (이전 `74bc26f6`). 문서 편집 Worker는 건드리지 않았다 (`1dd93ed7` 그대로).
- 커밋·태그·푸시 안 함. `ARCHITECTURE.md`·`VERIFICATION.md` 안 건드림.
- 이 세션에는 브라우저가 없다: `chromium`·`google-chrome`·`firefox`·`playwright` 없음, `node <스크립트>`·`npx playwright`는 승인 대기로 막힘, 브라우저 MCP 도구도 없음. 그래서 과제의 핵심 검증(대화상자가 뜨고, 확인하면 동작하고, 취소하면 안 하는지)은 **로컬·라이브 모두 미실시**다. 아래 "Merlin 브라우저 확인 목록"으로 넘긴다.

## 교체한 곳 (17곳, 바꾸지 않은 곳 없음)

행 번호는 교체 뒤 기준. "전"은 모두 네이티브 `confirm()` (자동화·내장 브라우저에서 창 없이 취소 → 버튼 무반응).

| # | 파일:행 | 기능 | 대화상자 제목 / 실행 버튼 | 비고 |
|---|---|---|---|---|
| 1 | `public/approval.js:136` | 결재 강제 반려 | 강제 반려 / "강제 반려" (빨강) | 대화상자 뒤 문서가 바뀌었으면 중단 |
| 2 | `public/approval.js:137` | 결재 회수 | 문서 회수 / "회수" | 〃 |
| 3 | `public/calendar.js:578` | 팀 일정으로 저장 | 팀 일정 저장 / "저장" | |
| 4 | `public/calendar.js:719` | 구글 캘린더 연결 해제 | 구글 캘린더 연결 해제 / "연결 해제" (빨강) | |
| 5 | `public/calendar.js:731` | 일정 삭제 | 일정 삭제 / "삭제" (빨강) | |
| 6 | `public/chat.js:45` | `ask` 헬퍼 | — | Promise를 돌려주게 바꿈. 부르는 곳은 아래 2곳뿐 |
| 6a | `public/chat.js:834` | 생성자 넘기고 나가기/제거 | 방 생성자 넘기기 / "넘기고 나가기"·"넘기고 제거" (빨강) | `.then`으로 받고, 그 사이 방이 바뀌었으면(`s.token`) 중단 |
| 6b | `public/chat.js:851` | 그룹 나가기·멤버 제거 | 그룹 나가기·멤버 제거 / "나가기"·"제거" (빨강) | 〃 |
| 7 | `public/lms.js:277` | 과정 삭제 | 과정 삭제 / "삭제" (빨강) | 실패 `alert` → 오류 토스트, 성공 토스트 추가 |
| 8 | `public/lms.js:361` | 강의 삭제 | 강의 삭제 / "삭제" (빨강) | 〃 |
| 9 | `public/meet.js:116` | 모두에게 통화 종료 | 통화 종료 / "모두에게 종료" (빨강) | 아래 "meet 화면" 참고 |
| 10 | `public/plaud.js:225` | Plaud 연결 해제 | Plaud 연결 해제 / "연결 해제" (빨강) | |
| 11 | `public/workflow.js:570` | `wfConfirmLeave` | 저장하지 않은 변경 / "버리고 이동"·"계속 편집" | 아래 참고 |
| 12 | `public/workflow.js:812` | 스케줄 삭제 | 스케줄 삭제 / "삭제" (빨강) | |
| 13 | `public/workflow.js:917` | 단계 삭제 (폼 ×, 캔버스 메뉴 공용) | 단계 삭제 / "삭제" (빨강) | 단계를 객체로 잡아 두고 확인 뒤 위치를 다시 찾는다 |
| 14 | `public/workflow.js:1120` | 워크플로우 삭제 | 워크플로우 삭제 / "삭제" (빨강) | 확인 뒤 다른 워크플로우로 바뀌었으면 중단 |
| 15 | `public/index.html:759` | 녹음 삭제 | 녹음 삭제 / "삭제" (빨강) | `alert` 2개 → 토스트, 성공 토스트 추가 |
| 16 | `public/index.html:1137` | 계정 비밀번호 초기화 | 비밀번호 초기화 / "초기화" (빨강) | 실패 `alert` → 오류 토스트 |
| 17 | `public/index.html:1623` | 라이브러리 파일 삭제 | 파일 삭제 / "삭제" (빨강) | 실패 `alert` → 오류 토스트, 성공 토스트 추가 |

문구는 기존 confirm 문구 그대로다. 취소·Esc·바깥 클릭은 모두 "안 함"이고 기본 포커스는 취소다 (`ui-dialog.js` 기존 동작).

### `wfConfirmLeave` — 바꿨다 (예외 아님)

beforeunload가 아니었다. 부르는 곳은 `wfNew`·`wfShowIntro`·`wfSelect` 3곳이고 전부 화면 안 버튼 클릭이다. 그래서 Promise로 바꾸고 `wfNew`·`wfShowIntro`를 async로 했다 (`wfSelect`는 원래 async, 반환값을 쓰는 곳 없음).
- 저장소 전체에 `beforeunload` 리스너는 원래 없다. 저장 안 한 채 탭을 닫거나 새로고침하거나 다른 메뉴로 가면 경고 없이 사라지는 것은 이전과 같다 (이번에 바꾸지 않음).

### meet 화면 — 로드부터 고침

`meet.html`은 `ui-dialog.js`도 `styles.css`도 부르지 않았다. `meet.html`에 `<script src="/ui-dialog.js">`를 `meet.js` 앞에 넣고, `meet.css` 끝에 어두운 화면용 `.ui-dlg-*`·`.ui-toast*` 스타일을 따로 넣었다 (z-index 10000 — 회의 화면 위).
- `pitch.html`은 confirm을 쓰지 않아 그대로 뒀다. 나머지 화면은 전부 `index.html` 안이라 이미 로드된다.

## 바뀐 파일 (10개)

`public/approval.js`, `calendar.js`, `chat.js`, `lms.js`, `meet.js`, `meet.html`, `meet.css`, `plaud.js`, `workflow.js`, `index.html`. `src/`는 바뀌지 않았다.

## 한 검증

- `node --check` 통과: approval·calendar·chat·lms·meet·plaud·workflow·ui-dialog. `npx tsc --noEmit` 0건.
- grep: `public/`에 남은 `confirm(`는 `uiConfirm`이 없을 때의 대비 4곳(`agents.js:210`, `workflow.js:264`, `chat.js:47`, `meet.js:115`)과 주석뿐이다.
- 로컬 `wrangler dev`: `/meet`에 ui-dialog.js 태그 1, `/ui-dialog.js` 200, `/meet.css`에 `ui-dlg` 9줄, `/api/health` 200, 익명 `/api/auth/me` 401.
- 라이브 (배포 3분 뒤, `peopleos.site`): `/api/health` 200, 익명 `/api/auth/me` 401 — 배포 전과 같다. 새 자산이 나간다 (`/meet`에 ui-dialog.js, `/meet.css`에 `ui-dlg` 9줄, `/workflow.js`의 `wfAsk(` 3 → 7). 라이브 8개 자산에서 `!confirm(` 0건.
- 테스트 데이터: 만들지 않았다 (로그인 호출·쓰기 호출 없음). 로컬 dev 상태는 `files/workflow-verify/confirm-replace/harness/`에만 있다.

## Merlin 브라우저 확인 목록 (미실시 — 이번 세션의 핵심 검증)

각 항목: 버튼 클릭 → 화면 안 대화상자가 뜸 → **취소**하면 아무 일도 없음 → (시험 데이터에서만) 실행 버튼을 누르면 동작. 라이브 실데이터는 대화상자가 뜨는 것과 취소까지만.

1. 워크플로우: 이름을 고친 뒤 다른 워크플로우 클릭 → "저장하지 않은 변경" (계속 편집 / 버리고 이동). "+ 새 워크플로우", "템플릿으로 시작하기"도 같다.
2. 워크플로우: 단계 × (폼), 캔버스 오른쪽 클릭 "단계 삭제", 스케줄 삭제, 워크플로우 삭제.
3. 캘린더: 일정 삭제, 공개 범위를 "팀"으로 바꿔 저장, 구글 연결 해제. **일정 모달 위에 대화상자가 올라오는지** (모달 z-index 50, 대화상자 1000), 대화상자에서 Esc를 눌렀을 때 뒤의 일정 모달이 같이 닫히지 않는지.
4. 채팅(떠 있는 패널, z-index 901): 그룹 멤버 "제거"·"나가기", 생성자 넘기기.
5. 결재: 회수, 강제 반려 (반려 의견을 먼저 넣어야 대화상자가 뜬다).
6. LMS 설정: 과정 삭제, 강의 삭제.
7. 업로드: 녹음 삭제, Plaud 연결 해제. 라이브러리: 파일 삭제. 관리자: 계정 "초기화".
8. `/meet?m=<id>`: "모두에게 통화 종료" → 어두운 대화상자. **통화 중 화면(rtk-meeting) 위에서도 보이는지.**

## 남은 문제·미확인

- **화면 클릭 검증 전부** (위 목록). 코드 경로와 문법만 확인했다.
- `resetUser`·`issueUserLink`는 설정 링크를 네이티브 `prompt()`로 보여 준다 (`index.html:1132`·`1140`). 자동화 브라우저에서는 창이 안 떠서, 초기화는 되는데 링크를 못 본다. 이번 과제(confirm) 밖이라 그대로 뒀다.
- 이번에 손댄 함수 밖의 `alert()`는 그대로다 (`index.html` 등 여러 곳).
- 대화상자가 떠 있는 동안 대상이 바뀌는 경우를 막는 검사(결재 문서 id, 채팅 `token`, 워크플로우 객체)는 화면에서 재현해 보지 않았다.
