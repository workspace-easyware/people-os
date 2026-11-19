# 화상회의 V0 — 타일 미표시 수정 이어하기 (런타임 재시작으로 끊긴 세션 복구)

이전 Opus 세션(2026-11-19 19:42 시작)이 런타임 재시작으로 끊겼다. **수정은 이미 파일에 들어 있다.** 이 세션은 처음부터 다시 분석하지 말고, 현재 상태를 확인하고 로컬 검증을 마친 뒤 RESULT.md를 쓴다. 배포하지 않는다. GitHub 푸시도 하지 않는다.

## 현재 상태 (확인됨)

- `public/meet.css` (19:41 수정): body를 flex column 100vh/100dvh, `#meet-main`은 flex:1 + position:relative, `rtk-meeting`은 absolute inset:0 + width/height 100% + min-height 320px, `rtk-meeting[hidden]{display:none}` 추가.
- `public/meet.html` (19:41 수정): `<rtk-meeting id="rtk" mode="fill" show-setup-screen="true" hidden>`.
- `public/meet.js` (19:42 수정): `enter()`에서 패널을 먼저 숨기고(`meet-panel.hidden=true`), `rtkEl.mode="fill"`, `rtkEl.hidden=false`, 2번 requestAnimationFrame 대기 후 `rtkEl.meeting = meeting` 할당, 500ms 뒤 resize 이벤트 한 번 더. `window.__meetDiag()` 진단 헬퍼 추가 (스테이지 상태, 참가자 수, 뷰포트, #meet-main·rtk-meeting 박스, 섀도 DOM 안쪽 rtk-header·rtk-stage·rtk-grid·rtk-participant-tile·rtk-controlbar·video 박스, jsDelivr에서 받은 SDK 최신 버전).
- `files/workflow-verify/video-conference-v0/seed-tilefix.sql` (19:44), `app.log`·`mock.log` (19:45) 존재. 로컬 서버(앱 8788, 목 8799)는 재시작으로 죽었다.

## 원인 (이전 세션이 특정한 것)

rtk-meeting에 확정된 높이가 없었다. 높이 % 연쇄(html→body→main→rtk-meeting)가 무너져 스테이지 그리드 높이가 0이 됐고, 참가자는 ON_STAGE이고 미디어도 흐르는데 타일이 안 그려졌다. 추가로 기존 `rtk-meeting{display:block}` 규칙이 UA의 `[hidden]{display:none}`을 이겨서 빈 rtk-meeting이 처음부터 패널 아래에 깔려 있었다.

## 라이브 진단 증거 (원본 프롬프트 `video-conference-tile-fix-prompt.md`에 전부 있음)

- `stage.status`·`self.stageStatus` 모두 `'ON_STAGE'` (빈 스테이지 아님).
- 참가 성공, preset `group_call_host` 동작, 상대방 오디오·비디오 구독 중, viewMode `ACTIVE_GRID`, 미디어 오디오 32kbps·비디오 198kbps·손실 0%, 콘솔 오류는 favicon 404뿐, Network 실패 없음, DOM에 타일 요소 존재하나 화면에 안 그려짐.

## 할 일

1. **현재 파일 상태 확인**: meet.js·meet.html·meet.css를 읽고 위 수정이 온전히 들어 있는지 확인한다. 빠진 부분이 있으면 채운다.
2. **`npx tsc --noEmit` 통과** 확인.
3. **로컬 검증** (V0 때 만든 하네스 재사용: `files/workflow-verify/video-conference-v0/`의 mock-rtk-worker.js·mock-rtk.toml·seed.sql·seed-tilefix.sql·state/): 로컬 wrangler dev(앱 8788, 목 8799)를 띄우고 curl로 확인한다.
   - `/meet`·`/meet.css`·`/meet.js`가 200으로 서빙되는지.
   - 수정된 CSS가 서빙본에 들어 있는지 (flex, absolute inset:0, min-height:320px, rtk-meeting[hidden]).
   - 수정된 meet.js가 서빙본에 들어 있는지 (패널 먼저 숨김, 2 rAF 대기, resize 유도, `__meetDiag`).
   - 세션 쿠키로 `/api/meet/rooms/.../start`·`join`이 동작하는지 (V0 하네스 절차대로).
   - 헤드리스 브라우저가 없어 실제 타일 렌더링은 로컬에서 못 본다 — 그 한계를 RESULT.md에 적는다.
4. **RESULT.md 작성**: `files/workflow-verify/video-conference-v0/RESULT.md`에 "타일 미표시 수정" 절을 덧붙인다. 내용: 원인, 바꾼 파일(파일별 변경 요약), 로컬 검증 결과(통과/미확인 항목 구분), **배포 후 브라우저에서 다시 확인할 절차** (사용자 노트북·핸드폰 두 기기로 같은 회의에 들어가 타일이 보이는지, `window.__meetDiag()`로 rtk-meeting·rtk-grid·rtk-participant-tile 박스 크기가 0이 아닌지 확인).
5. **배포하지 않는다.** `wrangler.toml`의 routes 항목은 건드리지 않는다. 토큰 값은 어디에도 기록하지 않는다.
