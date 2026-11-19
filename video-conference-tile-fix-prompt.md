# 화상회의 V0 — 영상 타일이 안 그려지는 문제 원인 분석·수정

V0 브라우저 검증에서 실제 문제가 나왔다. 두 브라우저(노트북 hr.jhkang + 핸드폰 mercer.jhkang)가 같은 회의에 들어가고 미디어도 흐르는데, 화면에 영상 타일이 전혀 안 그려진다. 이 세션은 원인을 찾고 고친다.

## 배경

- 계획: `files/people-os/video-conference-plan.md`. V0 결과: `files/workflow-verify/video-conference-v0/RESULT.md` (7장 "배포"까지 읽을 것).
- 배포: 버전 `2de19be5`, 마이그레이션 0038 적용됨. 회의 ID `meet_mwndgsg3_tncn4r`, 방은 hr.jhkang–mercer.jhkang 1:1 DM.
- 관련 코드: `src/meet/rtk.ts`, `src/meet/routes.ts`, `public/meet.html`, `public/meet.js`, `public/meet.css`. SDK는 `@latest` CDN (버전 미고정).

## 확인된 사실 (브라우저 라이브 진단, 2026-11-19 19:20~19:39)

- 참가 성공: 콘솔 `[meet] joined` (meet.js:136). `window.__meet` = `{id: 'meet_mwndgsg3_tncn4r', role: 'host', preset: 'group_call_host', meeting: zS}`. meeting 객체에 ai, audio, chat, connectedMeetings, livestream, meta, participants, peerId, plugins, polls, recording, self, stage, stores, __internals__ 전부 있음 — SDK 정상 초기화.
- self: 이름 "강준호", presetName "group_call_host", roomState "joined", userId "aaaba792-1796-408a-b064-3ec50ac9d176", organizationId "f0325814-1db2-4c8e-ba6f-18443d12be13", waitlistStatus "none", Chrome/Windows.
- participants: active/joined/audioSubscribed/videoSubscribed에 각각 1개 항목(피어 'eca80486-4ea9-46c3-80e-0253aea1f0f1'), viewMode "ACTIVE_GRID", lastActiveSpeaker도 같은 피어. 즉 상대방 오디오·비디오를 구독하고 있음.
- 미디어 흐름 양호 (RealtimeKit Troubleshooting): 오디오 "Network & Media Good", Bitrate 32 kbps, Packet Loss 0%, Jitter 0 ms. 비디오 "Good", Bitrate 198 kbps, Packet Loss 0%, Jitter 0 ms.
- 콘솔 오류: favicon.ico 404 1건 + Autofocus 경고 1건뿐. RealtimeKit·SDK·WebSocket 오류 없음.
- Network: 232개 요청, 보이는 것은 ping/telemetry/logs 200/204 성공뿐, 실패한 요청 없음. wss 행은 보이는 구간에 없었음.
- 화면: 상단에 Mic On / Video On / More / Leave 버튼만 보이고, 그 아래 검은 빈 영역. 자기 영상·상대 영상·타일 전혀 없음. DOM에는 김불꽃("김")과 강준호("강준호 (You)") 타일 요소가 존재함. More 메뉴 항목도 DOM에는 있으나 드롭다운이 화면에 안 나타남. Troubleshooting 대화상자는 정상적으로 그려짐.
- 참가자 수 표시 "2", 타이머 계속 증가 (27:53까지 확인).

## 아직 확인 안 된 것 (사용자가 확인 중)

- Elements 탭에서 `<rtk-meeting>`과 타일 요소의 계산된 크기(width/height), display:none / visibility:hidden / 크기 0 여부.

## ⚠️ 핵심 확정 (2026-11-19 19:41, 사용자 콘솔 직접 확인)

```
> window.__meet.meeting.stage.status
< 'ON_STAGE'
> window.__meet.meeting.self.stageStatus
< 'ON_STAGE'
```

**스테이지에는 사람이 올라가 있다.** 가설 (a) "스테이지가 비어 있음"은 틀렸다. 참가자는 ON_STAGE인데 타일이 안 그려진다. 따라서 원인은 (b) 레이아웃/CSS 문제나 (c) SDK 버전 문제 쪽이다. **스테이지에 참가자를 올리는 코드는 추가하지 말 것** — 이미 올라가 있다.

## 할 일

1. **원인 분석**: 위 증거 + `public/meet.js`·`meet.html`·`meet.css` 코드를 읽고, RealtimeKit UI 키트 문서(웹에서 확인)를 참고해 원인을 특정한다. **스테이지에는 사람이 올라가 있다(`stage.status`·`self.stageStatus` 모두 'ON_STAGE')** — 빈 스테이지 가설은 이미 배제됐다. 원인은 (b) 스테이지/타일 레이아웃 문제(컨테이너나 타일의 크기가 0이거나 CSS가 가리는지)나 (c) SDK 버전 문제(`@latest` CDN이 core와 UI 키트 버전을 어긋나게 불러온 것은 아닌지) 쪽이다. Elements 크기 값이 오면 (b)인지 확정할 수 있다. 값이 아직 없으면 코드·문서 기준으로 가장 유력한 원인을 고르고, Elements로 확인할 방법을 RESULT.md에 적는다.
2. **수정**: 원인을 고친다. SDK 버전을 고정할 수 있으면 고정한다 (npm/jsDelivr 조회가 막히면 브라우저에서 실제로 받은 버전을 사용자에게 물어볼 것 — RESULT.md에 적어 둔다).
3. **로컬 검증**: `npx tsc --noEmit` 통과 + 로컬 wrangler dev로 화면·API 동작 확인 (목 서버가 있으면 재사용, 없으면 만든다).
4. **배포하지 않는다. GitHub 푸시도 하지 않는다.** 수정이 끝나면 RESULT.md에 "타일 미표시 수정" 절을 덧붙인다. 내용: 원인, 바꾼 파일, 로컬 검증 결과, 배포 후 브라우저에서 다시 확인할 절차.
5. `wrangler.toml`의 routes 항목은 건드리지 않는다. 토큰 값은 어디에도 기록하지 않는다.
