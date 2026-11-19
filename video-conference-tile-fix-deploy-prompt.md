# 화상회의 V0 — 타일 미표시 수정 배포

타일 미표시 수정이 로컬 검증을 마쳤다. 이제 라이브에 배포한다.

## 배포할 변경

- `public/meet.css`: body flex column 100vh/100dvh, `#meet-main` flex:1 + position:relative, `rtk-meeting` absolute inset:0 + width/height 100% + min-height 320px, `rtk-meeting[hidden]{display:none}`.
- `public/meet.html`: `<rtk-meeting id="rtk" mode="fill" show-setup-screen="true" hidden>`.
- `public/meet.js`: `enter()`에서 패널 먼저 숨김 → mode="fill" → rtk-meeting 표시 → 2 rAF 대기 → `rtkEl.meeting = meeting` 할당 → 500ms 뒤 resize 유도. `window.__meetDiag()` 진단 헬퍼 추가.
- **프런트엔드만 변경, DB 마이그레이션 없음.**

## 검증 근거

- `files/workflow-verify/video-conference-v0/RESULT.md` 8절 "타일 미표시 수정"을 읽을 것. 로컬 검증 통과 항목: tsc, `/meet`·`/meet.css`·`/meet.js` 200 서빙, 수정본 서빙 확인, 세션 쿠키로 start 201(`is_coaching:true`)·join 200·익명 401.
- 타일 실제 렌더링은 로컬에서 미확인(헤드리스 브라우저 없음) — 배포 후 사용자 브라우저에서 확인한다.

## 할 일

1. `npx tsc --noEmit` 통과 확인.
2. cf-wrangler 헬퍼(`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`, 직접 실행)로 배포. plain npx wrangler는 쓰지 않는다.
3. 배포 후 라이브 확인 (workers.dev 경유, peopleos.site 직접 curl은 세션 허용 규칙에 없어 막힌다):
   - `https://people-os.workspace-easyware.workers.dev/meet` 200.
   - 서빙본 `/meet.css`에 flex·absolute inset:0·min-height:320px·rtk-meeting[hidden] 포함 확인.
   - 서빙본 `/meet.js`에 패널 먼저 숨김·2 rAF·resize 유도·`__meetDiag` 포함 확인.
   - `https://people-os.workspace-easyware.workers.dev/api/meet/rooms/<DM방>/active`로 현재 회의 상태 확인 (회의 `meet_mwndgsg3_tncn4r`는 사용자가 아직 열어 둔 상태일 수 있음).
4. 배포 버전 ID를 RESULT.md 8절에 적는다.
5. **GitHub 푸시하지 않는다.**

## 주의

- `wrangler.toml`의 routes 항목은 건드리지 않는다.
- 배포는 직렬로 한다 (다른 배포 세션과 겹치지 않게).
- 이전 배포 `2de19be5`가 롤백 지점이다. 배포 실패 시 `2de19be5`로 롤백한다.
