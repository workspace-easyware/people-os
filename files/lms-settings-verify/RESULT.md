# 강의실 설정 로컬 검증 (2026-11-17, wrangler dev --local, 포트 8793)

로컬 전용. 원격 D1·R2·배포는 건드리지 않았다. 사용자: A=`lmsS1tokenA`(user), B=`lmsS1tokenB`(임시로 hr_admin, 검증 후 user로 복구).

| 확인 | 결과 |
|---|---|
| `npx tsc --noEmit` | 통과 |
| `node --check public/lms.js` | 통과 |
| 일반 사용자 `DELETE /admin/courses/:id` | 403 |
| 쿠키 없이 `DELETE /admin/courses/:id` | 403 |
| hr_admin, 없는 과정 삭제 | 404 |
| hr_admin 과정 생성 (DRAFT) | 200 |
| DRAFT 과정: 일반 사용자 목록에 없음 / 상세 404 / hr_admin 목록엔 있음 | 확인 |
| 강의 추가 (youtube, r2) / 강의 수정 / 과정 수정(PUBLISHED, ord 유지) | 200, 반영됨 |
| 일반 사용자 진도 저장 후 강의 삭제 → 과정 삭제 | 200 |
| 삭제 후 D1: 과정 0, 강의 0, 진도 0 행 | 확인 |

미확인: 브라우저 화면(설정 탭 렌더링, 버튼 클릭, confirm 창). 이 세션에는 브라우저가 없어 API·문법 수준까지만 확인했다.
