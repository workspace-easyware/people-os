# Plaud 크기 표시 탭 전환 결함 — RESULT (2026-11-23)

상태: **코드 수정 완료, 동작 검증 미완료, 배포 안 함.**

## 원인 (확정 못 함)
- `public/plaud.js:57` — `plaudPumpSizes()`는 `plaudLoadFiles()` 끝에서만 불렸다. 목록을 그리는 `plaudRender()`(114행~)에는 조회 트리거가 없었다.
- `public/index.html:792` `setUpPane('voice')`가 탭 진입마다 `plaudLoad()`를 부르므로, 코드만 보면 재진입에도 조회는 돌아야 한다. 그래서 "초기 로드 때만 실행된다"는 추정은 코드로 확인되지 않았다.
- 코드에서 찾은 실제 결함: `sizeState`가 `failed`/`loading`으로 남은 행은 영원히 다시 조회되지 않는다. 한 번 실패한 행, 요청이 끝나지 않은 행은 탭을 다시 열어도 크기가 안 뜬다.
- 다른 가능성(미확인): 테스트한 탭이 배포 전 `plaud.js`를 이미 로드한 상태였고, 전체 새로고침으로 새 스크립트를 받았을 수 있다. 브라우저가 없어 가리지 못했다.

## 변경 (`public/plaud.js`만)
- `plaudRender()`가 목록을 그린 뒤 `plaudPumpSizes()`를 부른다 (connected이고 파일이 있을 때). 렌더링은 기다리지 않는다.
- `plaudPumpSizes()`: `size`가 숫자인 행(캐시)은 건너뛴다. `loading`은 60초 안이면 건너뛰고, 넘으면 재시도한다. `failed`는 같은 탭 진입 회차에서는 반복하지 않는다.
- `plaudLoad()`가 탭 진입마다 `plaudRenderSeq`를 올려, 이전에 실패한 행을 한 번 다시 조회한다.
- 동시 4개 제한, 서버 엔드포인트, 가져오기·전사·다른 탭은 그대로다.

## 검증
- `node --check public/plaud.js`: 통과.
- `npx tsc --noEmit`: 0건.
- 로컬 하네스 `notes/plaud-size-navfix-harness.js`(가짜 DOM/fetch로 `plaudLoad()`를 두 번 호출): 작성만 했고 **실행하지 못했다.** 이 세션에서 `node <스크립트>` 실행이 승인 대기로 막혔다. 목록 첫 화면 지연 없음, 두 번째 렌더의 크기 표시, 캐시 행 재요청 없음은 **모두 미검증**이다.
- 라이브 화면 확인 없음 (브라우저 없음).

## 배포
하지 않았다. 동작 검증 없이 배포하지 않기로 했다. 버전 ID 없음 (라이브는 2b47a133 그대로).

## 남은 제한
- 위 원인이 실제 증상의 원인인지 확정하지 못했다.
- 하네스를 승인 후 실행하거나 `wrangler dev` 라우트로 돌리면 검증할 수 있다. 통과하면 `/home/hatch/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`로 배포하면 된다.
- 하네스는 가짜 fetch를 쓰므로, 통과해도 실제 서버 응답 시간과 브라우저 렌더링은 검증하지 못한다.
