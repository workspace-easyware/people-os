# 화상회의 V0 — 타일 미표시 2차 수정 (섀도 DOM 안쪽 스테이지 높이 0)

1차 수정(배포 `4b1877d5`)은 바깥 컨테이너 높이는 잡았으나 타일은 여전히 안 보인다. 이제 원인이 안쪽으로 좁혀졌다. 이 세션은 원인을 찾고 고친다.

## 배경

- 계획: `files/people-os/video-conference-plan.md`. V0 결과: `files/workflow-verify/video-conference-v0/RESULT.md` (7장 "배포", 8절 "타일 미표시 수정"까지 읽을 것).
- 현재 라이브 배포: `4b1877d5`. 롤백 지점 `2de19be5`.
- 관련 코드: `public/meet.html`, `public/meet.js`, `public/meet.css`. SDK는 `@latest` CDN (실측 버전은 아래 참조).

## 1차 수정 내용 (이미 배포됨)

- `meet.css`: body flex column 100vh/100dvh, `#meet-main` flex:1 + position:relative, `rtk-meeting` absolute inset:0 + width/height 100% + min-height 320px, `rtk-meeting[hidden]{display:none}`.
- `meet.html`: `<rtk-meeting id="rtk" mode="fill" show-setup-screen="true" hidden>`.
- `meet.js`: `enter()`에서 패널 먼저 숨김 → mode="fill" → rtk-meeting 표시 → 2 rAF 대기 → `rtkEl.meeting = meeting` 할당 → 500ms 뒤 resize 유도. `window.__meetDiag()` 진단 헬퍼 추가.

## 결정적 새 증거 (2026-11-19 20:00, 사용자 콘솔 `JSON.stringify((await __meetDiag()).inner)`)

```json
{
  "rtk-header": {"w":627,"h":48,"display":"grid","visibility":"visible","overflow":"visible","position":"static"},
  "rtk-stage": {"w":627,"h":0,"display":"flex","visibility":"visible","overflow":"hidden","position":"relative"},
  "rtk-grid": [{"w":627,"h":0,"display":"block","visibility":"visible","overflow":"visible","position":"static"}],
  "rtk-participant-tile": [
    {"w":0,"h":0,"display":"flex","visibility":"visible","overflow":"hidden","position":"absolute"},
    {"w":0,"h":0,"display":"flex","visibility":"visible","overflow":"hidden","position":"absolute"}
  ],
  "rtk-controlbar": {"w":627,"h":56,"display":"flex","visibility":"visible","overflow":"visible","position":"relative"},
  "video": [{"w":0,"h":0,"display":"block","visibility":"visible","overflow":"clip","position":"absolute"}]
}
```

그리고 바깥쪽은 정상이다:
- `rtk-meeting`: {w:627, h:841, display:'block', visibility:'visible'} — 0 아님.
- `#meet-main`: {w:627, h:841} — 0 아님.
- `viewport`: {w:627, h:881}.
- `stage`: {status:'ON_STAGE', selfStageStatus:'ON_STAGE', roomState:'joined'}.
- `participants`: {active:1, joined:1, viewMode:'ACTIVE_GRID'}.
- `sdkLatest`: {@cloudflare/realtimekit:'2.1.0', @cloudflare/realtimekit-ui:'2.1.0'} — 두 버전 일치.
- 화면: "2 Participants" 표시, 타이머 진행 중. DOM에 김불꽃·강준호 항목 존재하나 렌더링 안 됨.

## 원인 해석 (확정된 부분)

- **바깥 컨테이너는 고쳐졌다** (rtk-meeting 627×841). 1차 수정은 거기까지만 먹혔다.
- **문제는 섀도 DOM 안쪽이다**: `rtk-stage`와 `rtk-grid`의 높이가 0이고, 타일 2개와 `video`도 0×0이다. 반면 `rtk-header`(48px)와 `rtk-controlbar`(56px)는 높이가 있다.
- 즉 섀도 DOM 안의 flex column에서 stage가 남은 공간을 차지하지 못하고 있다. 컨테이너 높이가 확정되지 않아 flex:1이 0으로 계산되는 형태다. `mode="fill"`이 기대대로 동작하지 않거나, 호스트에 준 position:absolute/inset:0이 섀도 DOM 내부 레이아웃과 안 맞거나, UI 키트 2.1.0의 알려진 문제일 수 있다.
- **스테이지는 비어 있지 않다** (ON_STAGE). 참가자를 스테이지에 올리는 코드는 추가하지 말 것.

## 할 일

1. **원인 특정**: 위 증거 + `public/meet.js`·`meet.html`·`meet.css` + RealtimeKit UI 키트 문서(웹에서 확인)를 보고, 섀도 DOM 안쪽에서 `rtk-stage`·`rtk-grid` 높이가 0이 되는 이유를 특정한다. 확인 후보:
   - UI 키트가 노출하는 CSS 커스텀 프로퍼티(예: 높이 관련 변수)나 `::part`가 있는지, 호스트에 줄 스타일이 있는지.
   - `mode="fill"`이 맞는 값인지 (문서·예시 기준). 다른 mode 값이나 mode를 빼는 것이 맞는지.
   - 호스트의 position:absolute/inset:0이 섀도 DOM 내부 flex와 충돌하는지.
   - UI 키트 2.1.0의 알려진 타일 미표시 이슈가 있는지.
   - `rtk-meeting`에 `height`를 직접 주는 방식(예: `style="height:100%"` 또는 고정 높이)이 맞는지.
2. **수정**: 원인을 고친다. 섀도 DOM 안쪽은 외부 CSS로 못 건드리므로, UI 키트가 제공하는 방식(속성·CSS 변수·part·호스트 스타일)으로 해결한다. SDK 버전을 고정할 수 있으면 고정한다.
3. **로컬 검증**: `npx tsc --noEmit` 통과 + 로컬 wrangler dev + 목 서버로 `/meet`·`/meet.css`·`/meet.js` 서빙 및 수정본 포함 확인 + 세션 쿠키로 start/join 동작 확인 (V0 하네스 재사용). 헤드리스 브라우저가 없어 실제 타일 렌더링은 로컬에서 못 본다 — 그 한계를 RESULT.md에 적는다.
4. **RESULT.md 작성**: `files/workflow-verify/video-conference-v0/RESULT.md` 8절에 2차 수정 내용을 덧붙인다 (원인, 바꾼 파일, 로컬 검증 결과, 배포 후 브라우저 확인 절차 — `await __meetDiag()`로 rtk-stage·rtk-grid·rtk-participant-tile·video 박스가 0이 아닌지 확인).
5. **배포하지 않는다. GitHub 푸시도 하지 않는다.** `wrangler.toml`의 routes 항목은 건드리지 않는다. 토큰 값은 어디에도 기록하지 않는다.
