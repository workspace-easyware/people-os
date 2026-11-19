# RESULT.md 8절 덧붙일 내용 — 타일 미표시 2차 수정 (2026-11-19)

> 이 세션은 `files/workflow-verify/`를 읽거나 쓸 권한이 없었다 (작업 디렉터리 people-os만 허용).
> 아래 내용을 `files/workflow-verify/video-conference-v0/RESULT.md` 8절 끝에 그대로 붙인다.

### 8.x 2차 수정 — 섀도 DOM 안쪽 스테이지 높이 0

**원인 (추정 근거 포함)**
- 1차 수정 뒤 진단: `rtk-meeting` 627×841 **display:block**, `rtk-header` h48, `rtk-controlbar` h56, `rtk-stage`·`rtk-grid` h0, 타일·video 0×0.
- `meet.css`에 `rtk-meeting { display:block }`이 있었다. 이 규칙은 1차 수정 전부터 있었다. 바깥 문서의 저자 스타일은 컴포넌트 섀도 스타일의 `:host` 규칙보다 우선한다 (CSS Scoping 캐스케이드). 그래서 UI 키트가 `:host`에 준 세로 flex 레이아웃이 block으로 덮였다.
- 호스트가 block이면 stage의 `flex:1`은 효과가 없다. 그러면 stage 높이는 내용 높이가 되는데, 그리드 타일은 `position:absolute`라 내용 높이가 0이다. 이 경우 header·controlbar는 자기 내용 높이만큼 보이고 stage만 0이 된다. 진단과 정확히 일치한다.
- 한계: 이 세션은 웹 접근(WebFetch·WebSearch, jsDelivr curl)이 막혀 UI 키트 2.1.0 소스의 `:host` 선언을 직접 확인하지 못했다. 그래서 아래의 런타임 안전망을 함께 넣었다.

**바꾼 파일**
- `public/meet.css`: `rtk-meeting`에서 `display:block`을 뺐다. 위치와 크기(`position:absolute; inset:0; width/height:100%; min-height:320px`)만 남기고 display는 `:host`에 맡긴다. `rtk-meeting[hidden]{display:none}`은 유지한다 (숨김은 계속 동작한다).
- `public/meet.js`:
  - SDK를 `latest`에서 **`2.1.0`으로 고정**했다 (core·ui 둘 다, 사용자 진단의 sdkLatest 값 기준).
  - `watchStageLayout()` 안전망: 입장 후 20초 동안 1초마다 확인한다. 호스트 높이가 0보다 큰데 `rtk-stage` 높이가 0이면, stage의 레이아웃 부모를 세로 flex로 만들고 stage에 `flex:1 1 auto; min-height:0`을 인라인으로 준다. 이 처리는 열린 shadowRoot 안쪽에서만 한다. 보정이 일어나면 `console.warn("[meet] rtk-stage 높이 0 → 레이아웃 보정")`을 남기고 `window.__meet.layoutFix`에 기록한다. 주 수정이 맞으면 이 코드는 아무것도 하지 않는다.
  - `__meetDiag()` 확장: `rtk-meeting.flexDirection`, `stageParent`(stage의 부모 태그·박스, 섀도 루트 바로 아래인지), `layoutFix`, `sdkPinned`.
- `meet.html`은 바꾸지 않았다. `wrangler.toml`도 건드리지 않았다.

**로컬 검증**
- `npx tsc --noEmit` 통과, `node --check public/meet.js` 통과.
- `wrangler dev --local --port 8799`에서 `/meet` 200 text/html, `/meet.css`·`/meet.js`가 수정본(2차 수정 주석, `display` 없는 rtk-meeting 규칙, `2.1.0`, `watchStageLayout`)으로 서빙되는 것을 확인했다.
- 세션 없이 `POST /api/meet/x/join`을 보내면 401 `로그인이 필요합니다.`가 돌아온다 (인증 게이트 정상).
- **하지 못한 것**: 세션 쿠키를 쓰는 start/join 확인. V0 하네스와 목 서버가 `files/workflow-verify/` 아래에 있어 이 세션에서는 읽을 수도 실행할 수도 없었다. 서버 코드(`src/`)는 이번에 바뀌지 않았으므로 V0의 start/join 결과는 그대로 유효하다.
- 헤드리스 브라우저가 없어 실제 타일 렌더링은 로컬에서 보지 못했다.

**배포 후 브라우저 확인 절차**
1. 두 계정으로 `/meet?m=<id>`에 들어가 참여한다 (강력 새로고침으로 캐시를 비운다. meet.css·meet.js가 바뀌었다).
2. 콘솔: `JSON.stringify((await __meetDiag()), null, 1)`
3. 합격 기준:
   - `rtk-meeting.display`가 `block`이 **아님** (UI 키트의 :host 값, 예: `flex`)
   - `inner.rtk-stage[0].h > 0`, `inner.rtk-grid[0].h > 0`
   - `inner.rtk-participant-tile[*]`의 w·h > 0, `inner.video[*]`의 w·h > 0
   - `sdkPinned` = 2.1.0 / 2.1.0
   - `layoutFix`가 `null`이면 CSS 수정만으로 해결된 것이다. 값이 있으면 안전망이 고친 것이므로, `stageParent`와 `parentDisplayBefore`를 기록해 3차에서 정식으로 고친다.
4. 그래도 h가 0이면 `stageParent` 출력을 첨부한다. 그러면 섀도 DOM 안쪽 구조를 확정할 수 있다.
