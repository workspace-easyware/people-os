# LMS 구현 O1 — Opus 5.5 (Range 스트리밍·진도 저장·플레이어)

## 너의 역할
너는 구현 세션이다. 계획 문서 `lms-plan.md`의 7장 분할표에서 **O1**만 구현한다. S1(Sonnet)은 끝났다 (마이그레이션 0023·시드·API 뼈대·501 자리 표시 완료, `tsc` 통과, L1~L3 로컬 검증 완료). S2(Sonnet, 강의실 화면)는 네가 끝난 뒤에 온다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `lms-plan.md` 3장(R2 업로드·서빙 설계 — 3.3 전체), 5장(API 설계 — 진도 UPSERT), 7장(분할표·세션 간 계약), 8.1(로컬 검증 L4~L21).
- `lms-seed-content.md` (시드 콘텐츠 실제 값).
- S1이 만든 파일: `src/lms/routes.ts`, `src/lms/stream.ts`, `src/lms/progress.ts`, `migrations/0023_lms.sql`, `seeds/lms_seed_v1.sql`.

## S1에서 넘겨받은 것 (알아둘 것)
1. **503 가드 버그를 고쳤다.** 로컬 DB의 `users`에 `coaching_role` 컬럼(0018)이 없어서 세션 조회가 "no such column"을 던졌고, 가드가 이를 "0023 미적용"으로 잘못 503 처리했다. 이제 메시지에 `lms_`가 있을 때만 503으로 답한다. 로컬 DB에는 `users.coaching_role`만 `ALTER`로 추가했고, 원격은 건드리지 않았다.
2. **계약 서명을 넓혔다.** `saveProgress`의 실패 `status`를 `400 | 404`에서 `400 | 404 | 501`로 넓혔다 (자리 표시가 501을 타입에 맞게 돌려주려면 필요). 네가 구현하면서 `400 | 404`로 되돌려도 `routes.ts`는 그대로 동작한다.
3. **로컬 R2 객체는 없다.** `lms/sample.mp4`는 원격 R2에만 있다. 네가 로컬 R2에 테스트 객체를 넣어야 한다 (아래 검증 참조).
4. **보안 한 줄 (L21):** progress 라우트가 `X-Admin-Secret`만으로 접근하면 401을 돌려주는지 실제 호출 검증이 안 됐다. `saveProgress` 구현 후에 확인해라.

## 구현할 것 (O1 범위)
1. **`src/lms/stream.ts`** — Range 스트리밍 (3.3 전체): Range 파싱, 206/200/416, HEAD, 인증·게시 상태 게이트, 헤더. 경계 조건이 많고 틀리면 Safari에서 재생이 안 된다. 인증 누락은 영상 유출이다. `routes.ts`는 고치지 않는다 (HEAD 등록이 필요해질 때만 예외).
2. **`src/lms/progress.ts`** — 진도 저장 (5장의 UPSERT, 입력 검증, 과정 집계 반환). 동시 요청·멱등성 의미를 지켜야 한다. 계약 서명은 7장 그대로 (`saveProgress(env, userId, lessonId, input)`).
3. **`public/lms-player.js`** (신규) — 플레이어: `<video>`/iframe 생성, `ended` 자동 완료, 언마운트 시 정지, (2순위) 위치 저장·이어보기, (2순위) 유튜브 IFrame API. 브라우저 이벤트 수명주기와 정리 누락(소리 계속 남)이 까다롭다.
4. **`files/lms-verify/`** — 로컬 검증 스크립트 (8.1을 실행 가능한 형태로 남긴다). 작업 디렉터리 안이다 (`/tmp` 금지).

## 검증 (로컬, 8.1)
- `npx tsc --noEmit` 통과.
- 로컬 R2 테스트 객체: 내용을 아는 작은 파일(예: 1,000바이트 텍스트)을 `lms/videos/les_test/test.bin`에 로컬 R2로 올리고 r2 강의 행을 넣는다 (`npx wrangler r2 object put * --local` 허용 규칙이 settings.json에 있다). Range 정확성은 실제 영상 없이 바이트 비교로 확인한다.
- `npx wrangler d1 execute people-os-db --local --file migrations/0023_lms.sql` 후 시드 파일 실행. `npx wrangler dev --local` 로 로그인 쿠키를 달고 8.1의 L4~L21을 확인한다 (L4 200 전체, L5~L9 Range 경계, L10 Range 무시, L11~L21 진도·권한·보안). L1~L3은 S1이 이미 검증했으니 회귀만 확인한다.
- 검증 스크립트나 하네스는 `files/lms-verify/` 아래에 둔다. `/tmp` 금지.

## 제약
- O1 파일만 만든다/고친다: `src/lms/stream.ts`, `src/lms/progress.ts`, `public/lms-player.js`, `files/lms-verify/**`. `src/lms/routes.ts`는 고치지 않는다 (HEAD 등록이 필요할 때만 예외). `src/index.ts`, `public/index.html`은 건드리지 마라 (S1/S2 범위).
- 원격 D1·R2·배포 금지. 로컬만. 원격 R2의 `lms/sample.mp4`는 건드리지 마라.
- 끝나면 최종 보고에 만든 파일 목록, tsc 결과, 로컬 검증 결과(L4~L21 표)를 적어라.
