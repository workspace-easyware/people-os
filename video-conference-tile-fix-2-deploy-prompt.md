# 화상회의 V0 — 타일 미표시 2차 수정 배포

2차 수정이 로컬 검증을 마쳤다. 이제 라이브에 배포한다.

## 배포할 변경

- `public/meet.css`: `rtk-meeting`에서 `display:block` 제거 (위치·크기만 남기고 display는 UI 키트의 `:host`에 맡긴다). `rtk-meeting[hidden]{display:none}` 유지.
- `public/meet.js`: SDK를 `latest`에서 **`2.1.0`으로 고정** (core·ui 둘 다). `watchStageLayout()` 안전망 추가 (입장 후 20초간 1초마다 확인, 호스트 높이 있는데 `rtk-stage` 높이 0이면 stage 레이아웃 부모를 세로 flex로 만들고 stage에 `flex:1 1 auto; min-height:0` 인라인 적용, 보정 시 `console.warn` + `window.__meet.layoutFix` 기록). `__meetDiag()` 확장 (`rtk-meeting.flexDirection`, `stageParent`, `layoutFix`, `sdkPinned`).
- `meet.html` 변경 없음. **프런트엔드만 변경, DB 마이그레이션 없음.**

## 원인 요약

`rtk-meeting { display:block }`이 UI 키트의 `:host` 세로 flex 레이아웃을 덮었다. 호스트가 block이면 stage의 `flex:1`이 안 먹혀 stage 높이가 내용 높이(=0, 타일은 absolute라 내용 높이 0)가 된다. header·controlbar만 내용 높이로 보이고 stage만 0이 된 진단과 일치한다.

## 검증 근거

- `files/workflow-verify/video-conference-v0/RESULT.md` 8절(1차) + 8.x절(2차)을 읽을 것. 로컬 검증 통과 항목: tsc, `node --check public/meet.js`, `/meet` 200, `/meet.css`·`/meet.js` 수정본 서빙 확인, 세션 없이 join 401.
- 타일 실제 렌더링은 로컬에서 미확인(헤드리스 브라우저 없음) — 배포 후 사용자 브라우저에서 확인한다.
- 세션 쿠키 start/join은 이번 세션에서 못 했다 (V0 하네스가 `files/workflow-verify/` 아래라 세션 권한 밖). 서버 코드(`src/`)는 바뀌지 않았으므로 V0의 start/join 결과는 그대로 유효하다.

## 할 일

1. `npx tsc --noEmit` 통과 확인.
2. cf-wrangler 헬퍼(`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`, 직접 실행)로 배포. plain npx wrangler는 쓰지 않는다.
3. 배포 후 라이브 확인 (workers.dev 경유, peopleos.site 직접 curl은 세션 허용 규칙에 없어 막힌다):
   - `https://people-os.workspace-easyware.workers.dev/meet` 200.
   - 서빙본 `/meet.css`에 `rtk-meeting` 규칙에서 `display:block`이 없고 `rtk-meeting[hidden]`이 있는지 확인.
   - 서빙본 `/meet.js`에 `2.1.0` 고정, `watchStageLayout`, `layoutFix`, `sdkPinned` 포함 확인.
4. 배포 버전 ID를 RESULT.md 8.x절에 적는다.
5. **GitHub 푸시하지 않는다.**

## 주의

- `wrangler.toml`의 routes 항목은 건드리지 않는다.
- 배포는 직렬로 한다 (다른 배포 세션과 겹치지 않게).
- 이전 배포 `4b1877d5`가 롤백 지점이다 (그 전은 `2de19be5`). 배포 실패 시 `4b1877d5`로 롤백한다.
