# Plaud 목록 파일 크기 표시 — RESULT (2026-11-23)

## 변경
- `src/plaud/routes.ts`: `GET /api/plaud/files/:id/size` 추가 (requireUser + FILE_ID_RE + withMcp get_file → findPresignedUrl → `Range: bytes=0-0` GET → Content-Range 전체 크기). 실패·URL 없음·타임아웃(8초)은 `{ok:false}`. 연결 해제(409)만 그대로 올림. Range를 무시하고 200을 주는 서버면 Content-Length를 쓴다. 목록·가져오기·전사 코드는 건드리지 않음.
- `public/plaud.js`: 목록을 그린 뒤 `plaudPumpSizes()`가 동시 4개까지 조회, `rows[id].size/sizeState`에 캐시(실패도 기억 → 재조회 없음). 제목 옆 `(35.5MB)`; 1MB 이상 소수 1자리 MB, 미만 KB 정수; 40MB 초과는 빨강 + title "가져오기 상한 40MB를 넘습니다"; 크기를 모르면 표시 없음, 에러 토스트 없음. 도착 시 해당 제목 span에만 덧붙임(전체 재렌더 없음).

## 검증
- `npx tsc --noEmit`: 0건. `node --check public/plaud.js`: 통과.
- 하네스: `files/plaud-size-verify/` (harness.ts, wrangler.toml). **가짜**: Plaud MCP(get_file이 presigned URL을 줌), S3(전역 fetch를 가로채 `fake-audio.s3.amazonaws.com`에 Range 응답을 만듦 — presigned 호스트 검사가 https+amazonaws라 로컬 http 서버를 못 붙여서 이렇게 함). **진짜**: 실제 `/api/plaud/files`, `/files/:id/size` 라우트 코드, 세션 인증.
- 서버 응답 (로컬 wrangler dev):
  - f0 → `{ok:true,size_bytes:37224448}` (=35.5MB), f3 → 512000 (=500KB), f5(Range 무시 200) → 7340032.
  - (b) f1 → 47185920 (=45MB, 40MB 초과 값 확인).
  - (c) f2(S3 403) → `{ok:false}`, 같은 시점 `/files`는 정상 200. 무로그인 401, 잘못된 id 400.
  - (d) 3초 지연 크기 요청(3.2초)이 도는 동안 `/files` 응답 0.25초 (평소 0.30초) — 목록 라우트는 get_file을 부르지 않고 별도 요청이라 영향 없음.
- 로그로 확인: S3 요청은 전부 `GET` + `range=bytes=0-0`.

## 솔직한 한계 (검증하지 못한 것)
- **프론트(plaud.js) 실행 검증은 못 했다.** 브라우저가 없고, 이 세션에서 `node <스크립트>` 실행이 승인 대기로 막혀 DOM 스텁 시험(`plaud-size-verify/frontend-test.js`, 작성만 해 둠)을 못 돌렸다. 따라서 "(35.5MB)" 표기·빨간색·동시 4개 제한·캐시·목록 먼저 그리기는 **코드 검토 + 문법 검사만** 한 상태다. 위 (a)(b)는 서버가 올바른 바이트 수를 주는 것까지, (c)(d)는 서버 측까지만 확인했다. 화면 확인 필요.
- 실제 Plaud/S3와는 한 번도 통신하지 않음: 실제 presigned URL이 Range GET에 206 + Content-Range를 주는지는 Merlin이 확인한 사실에 의존한다.
- presigned URL이 5분짜리라 크기 조회마다 get_file 1회 + Range GET 1회가 든다 (행당 MCP 호출 1회 추가, 20행 첫 화면 기준 20회, 동시 4개).
- 가짜 S3에서 `redirect:"follow"`가 실제로 따라갈 일은 없었다.

## 배포
- 버전 ID: `2b47a133-e016-4b30-8c71-473abe653805` (`cf-wrangler.py deploy`). 3분 뒤 스모크·라이브 화면 확인은 하지 않음 (지시대로).
- 커밋 안 함.
