# LMS O1 로컬 검증 결과 (2026-11-17, workerd / wrangler 3.114.17 dev --local, 포트 8791)

로컬 전용. 원격 D1·R2·배포는 건드리지 않았다.

## 준비 (실행한 그대로)
- `npx tsc --noEmit` → 오류 0.
- `d1 execute --file migrations/0023_lms.sql --local`, `seeds/lms_seed_v1.sql`, `files/lms-s1-verify/users.sql`, `files/lms-verify/test-data.sql`.
- 로컬 R2: `test.bin`(1,000바이트, 25바이트 줄 40개 `B000:`~`B039:`)을 `lms/videos/les_test/test.bin`에 put.
  **주의**: `wrangler dev`는 `preview_bucket_name`(`people-os-dev-preview`)을 FILES로 묶는다. 그래서 `people-os-dev-preview/...`에도 put해야 한다 (`people-os-files`에만 넣으면 404).
- 사용자: A=`lmsS1tokenA`, B=`lmsS1tokenB` (S1 세션 행). hr_admin 확인은 B의 role을 잠시 `hr_admin`으로 바꿨다가 되돌렸다.
- `run.sh`는 같은 항목을 한 번에 도는 스크립트다. 이 세션에서는 `bash` 실행이 승인 대기라 각 항목을 `curl --noproxy '*' ... http://localhost:8791/...`로 하나씩 실행했다. 본문은 줄 번호로 바이트 위치를 눈으로 대조했다.

## 결과

| # | 확인 | 결과 | 실제 값 |
|---|---|---|---|
| L1 (회귀) | 쿠키 없이 courses / progress / video GET·HEAD | PASS | 전부 401 |
| L3 (회귀) | 과정 목록 | PASS | 스토리텔링 1강, 클로드 14강, completed 0 (+ 테스트 과정 3강). DRAFT 과정은 일반 사용자에게 안 보임 |
| L4 | Range 없음 | PASS | 200, Content-Length 1000, Accept-Ranges bytes, Cache-Control private, no-store, nosniff, ETag, 본문 40줄 전체 |
| L5 | bytes=0-1 | PASS | 206, `bytes 0-1/1000`, 본문 `B0` |
| L6 | bytes=100-199 | PASS | 206, `bytes 100-199/1000`, 본문 = B004~B007 줄 (오프셋 100~199) |
| L7 | bytes=900- / bytes=-100 | PASS | 둘 다 206 `bytes 900-999/1000`, B036~B039 |
| L8 | bytes=500-5000 | PASS | 206 `bytes 500-999/1000`, Content-Length 500, B020~B039 |
| L9 | bytes=1000- | PASS | 416, `Content-Range: bytes */1000`. 추가: `bytes=-0`, `bytes=200-100`도 416 |
| L10 | bytes=0-1,5-6 / abc | PASS | 둘 다 200, 1000바이트 |
| L11 | HEAD | PASS | 200 헤더만 (CL 1000). Range 붙이면 206 `bytes 0-1/1000`. **routes.ts 수정 없이 동작** (Hono GET 라우트가 HEAD 처리) |
| L11+ | If-Range | PASS | ETag 일치 → 206, 불일치 → 200 전체 |
| L12 | 없는 강의 / 유튜브 강의 / R2 객체 없음 / 미게시 과정(일반 사용자) | PASS | 404 ×4. 미게시 과정을 hr_admin으로 → 206 |
| L12+ | D1 size_bytes가 낡음(5, 실제 1000) | PASS | 206 `bytes 900-999/1000` (R2 head 크기 기준) |
| L13 | `/courses/:id`에 r2_key 없음 | PASS | 키·경로 문자열 없음 |
| L14 | A 완료 → A의 `/courses/:id` | PASS | completed:true, completed_count 1 |
| L15 | B의 `/courses/:id` | PASS | 같은 강의 completed:false, completed_count 0 |
| L16 | 같은 완료 두 번 | PASS | completed_at `…18:07:04.988Z` 그대로 |
| L17 | position_sec:120만 | PASS | 위치 120, completed·completed_at 유지 |
| L18 | 동시 완료 10개 (`curl -Z --parallel-max 10`) | PASS | 200 ×10, completed_at 1개 값, DB 행 1개 |
| L19 | 본문 user_id=B | PASS | A에만 저장, B summary completed 0 |
| L19+ | 입력 검증 | PASS | 없는 강의 404, `{}` 400, completed:false → 완료 취소(위치 120 유지) |
| L20 | 일반 사용자 `POST /admin/lessons` / X-Admin-Secret | PASS | 403 / 200 (probe 행은 DELETE로 지움) |
| L21 | X-Admin-Secret만으로 progress / video | PASS | 401 / 401 |

## 검증 못 한 것
- `public/lms-player.js`는 브라우저에서 돌려보지 않았다 (이 세션에 브라우저 없음). `tsc --allowJs`로 문법만 확인. 실제 재생·`ended` 자동 완료·탭 이탈 시 정지·유튜브 IFrame API는 S2 화면 연결 뒤 8.2 V4~V13에서 확인한다.
- Safari 실제 재생 (V6), 실제 MP4 (로컬 R2에 sample.mp4 없음 — `les_storytelling_01`은 로컬에서 404 "영상 파일을 찾을 수 없습니다").
