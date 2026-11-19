# 캘린더 C1 로컬 검증 결과 (2026-11-17)

환경: `wrangler dev --local --port 8799 --persist-to files/calendar-c1-verify/state` (격리된 로컬 D1: 0015_auth + `coaching_role` 컬럼 + 0025_calendar + seed-users/seed-events). 원격 D1·배포 없음.
사용자: A(user) / B(user) / H(hr_admin), 세션 토큰은 seed-users.sql.
`npx tsc --noEmit` 통과.

| 시나리오 | 기대 | 결과 |
| --- | --- | --- |
| 0025 미적용 DB에서 GET /events | 503 | 503 "캘린더 스키마가 아직 적용되지 않았습니다 (migration 0025)" |
| 익명 GET | 401 | 401 |
| `X-Admin-Secret`만으로 GET / POST / DELETE | 401 | 401 ×3 |
| B가 A의 개인 일정 GET / PATCH / DELETE | 404 | 404 ×3 |
| hr_admin이 A의 개인 일정 GET | 404 | 404 |
| B가 팀 일정 GET | 200, editable=false | 200, editable=false |
| B가 팀 일정 PATCH / DELETE | 403 | 403 ×2 |
| B 목록 (11월) | 팀 일정만 (A의 개인·종일 제외) | cal_t1, cal_t2만 |
| hr_admin이 팀 일정 PATCH | 200, version 0→1 | 200, version 1, editable=true |
| hr_admin이 팀 일정 visibility 변경 | 403 | 403 |
| 낙관적 잠금: version 불일치 | 409 | 409 |
| PATCH에 version 없음 | 400 | 400 |
| 작성자 A가 팀 일정 PATCH (version 1) | 200, version 2 | 200, version 2 |
| 작성자 DELETE 후 GET | 200 → 404 | 200 → 404 (소프트 삭제) |
| Origin 불일치 POST | 403 | 403 |
| 자정 KST에 걸친 일정(23:00~01:00 KST) | 11/20·11/21 KST 날 모두에 나옴 | 둘 다 나옴 |
| 종일 11/21 KST | 11/20 날, 11/22 날로 새지 않음 | 11/20: 안 나옴, 11/21: 나옴, 11/22: 안 나옴 |
| 조회 기간 62일 / 62일+1초 | 200 / 400 | 200 / 400 |
| 종일 일정 생성 (KST 자정) | 201, start_date/end_date 채움 | 201, 2026-11-28 / 2026-11-29 |
| 종일인데 KST 자정 아님 | 400 | 400 |
| end_at == start_at | 400 | 400 |
| 31일 초과 (31일+1초) | 400 | 400 |
| 시각 형식 오류 / 없는 날짜(2월 30일) | 400 | 400 / 400 |
| category·visibility 목록 밖 | 400 | 400 / 400 |
| 본문 256KB 초과 | 413 | 413 |

참고 / 한계:
- `run.sh`는 전체 시나리오를 한 번에 돌리려고 만든 것이나 이 세션의 권한 규칙상 실행하지 못했다. 위 결과는 같은 요청을 개별 curl로 실행한 것이다 (고정 id 시드 `seed-events.sql` 사용).
- 31일 **정확히** 일정(201)은 따로 실행하지 않았다 (경계 초과 400만 확인). 코드는 `> 31일`만 거부한다.
- 검증용 DB는 전체 마이그레이션이 아니라 필요한 최소 스키마다. `0018`은 `reflections` 테이블이 없어 적용되지 않아 `coaching_role` 컬럼만 직접 추가했다 (`getSessionUser`가 이 컬럼을 읽는다).
