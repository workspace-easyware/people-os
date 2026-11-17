# 조직관리 로컬 검증 (2026-11-17)

로컬 전용(`wrangler dev --local --port 8791`, 로컬 D1). 원격 D1·R2·배포 없음.

## 정적 검사
- `npx tsc --noEmit`: 통과
- `node --check public/org.js`: 통과

## API (curl, hr_admin 세션 쿠키 = 로컬에 임시로 넣은 auth_sessions 행, 검증 후 삭제)
| 확인 | 결과 |
|---|---|
| GET /api/admin/users → 각 사용자에 department_id·department_name | PASS (결재 부서장 → `dept_hr`/인사팀, 무소속 → null/null) |
| PATCH 자기 계정 `{name:"  강준호(테스트)  "}` | PASS 200, 공백 제거 후 저장 |
| PATCH 자기 계정 `{name, role:"user"}` | PASS 403 "자기 계정의 역할·상태·코칭 역할은 바꿀 수 없습니다." |
| PATCH `{name:"   "}` | PASS 400 "이름은 1~100자로 입력하세요." |
| PATCH 다른 사용자 `{coaching_role:"coach"}` (회귀) | PASS 200 |
| POST /api/approval/admin/departments 부서 추가 (부서장 없음, 상위 = 인사팀) | PASS |
| 같은 upsert로 부서장 지정 (목록 드롭다운과 같은 경로) | PASS, manager_name 반영 |
| PUT /api/approval/admin/users/:id/department (hr_admin을 테스트 부서로) | PASS, GET users에 department_name 반영 |
| 일반 사용자 쿠키로 GET /api/admin/users | PASS 401 |
| 서빙된 `/`에 조직관리 메뉴·tab-org·org.js·org.css·ADMIN_TABS 'org'·switchTab 연결 | PASS (8개 매치, `../org-verify-index.html`) |
| GET /org.js | PASS 200 |

정리: 이름·코칭 역할을 원래대로 되돌렸고, hr_admin 부서는 다시 미지정으로 했습니다. 테스트 부서 `ORGTEST`(조직검증팀)는 API로 지울 수 없어 비활성화했고(is_active=0), 임시 세션 2개는 삭제했습니다.

## 브라우저 / UI
- 이 세션에는 브라우저(Playwright·Chromium)가 없어서 브라우저로 확인하지 못했습니다.
- `harness.js`는 org.js를 DOM 스텁과 로컬 API로 돌리는 스크립트입니다(렌더링·부서 추가·부서장 지정·부서 지정·이름 수정을 확인). `node` 실행 권한이 없어 **실행하지 못했습니다**. 사용법: `node notes/org-verify/harness.js http://127.0.0.1:8791 <hr_admin 세션 토큰>`
- 일반 사용자에게 메뉴가 숨는지는 코드로만 확인했습니다. `applyRole`가 `data-tab="org"`를 hr_admin이 아니면 숨기고, `ADMIN_TABS`에 'org'가 들어 있어 `switchTab`/`tabAllowed`가 일반 사용자를 홈으로 보냅니다.

참고: 검증 도중 로컬 사용자 `LMS B`의 역할이 hr_admin에서 user로 바뀌었습니다. 이 작업이 바꾼 것이 아니고, 같은 로컬 DB를 쓰는 다른 세션이 바꾼 것으로 보입니다.
