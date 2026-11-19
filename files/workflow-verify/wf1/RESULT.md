# WF-1 검증 결과 (2026-11-18)

## 1. `npx tsc --noEmit` — 통과 (출력 없음)

## 2. 로컬 마이그레이션 (`--persist-to files/workflow-verify/wf1/state`, 새 DB)
- `migrations apply` → 0001~0027 전부 ✅, `0027_workflows.sql` 포함.
- 재실행 → "No migrations to apply!" (에러 없음).

## 3. 로컬 curl 왕복 (`wrangler dev --local --port 8798`, 사용자 u_a/u_b 세션 tokA/tokB)
`run.sh`는 `bash`로 실행하려면 이 환경에서 승인이 필요해 **돌리지 못했다** (자동 승인 불가). 같은 시나리오를 curl 한 건씩 직접 실행했다. `run.sh`는 재실행용으로 남겨 둠(미실행).

| # | 시나리오 | 결과 |
|---|---|---|
| 1-4 | 익명 GET 목록 / 시크릿만 GET / 시크릿만 POST run / 익명 GET run | 401 ×4 |
| 5 | 생성 (summarize + send_email) | 201, send_email에 `requiresApproval:true` 강제됨 |
| 6-11 | 잘못된 definition: version 2 / type 없음 / id 중복 / send_email 승인 false / name 빈값 / 깨진 JSON | 400 ×6 (이유 포함) |
| 12-13 | 상세 조회(+steps) / 목록 | 200 ×2 |
| 14-16 | PATCH name+status 200 / 잘못된 status 400 / 빈 steps definition 400 | 통과 |
| 17 | PATCH definition 정상 | 200 |
| 18 | run 생성 `{input:{docId:"d1"}}` | 201, status queued, current_step 0 |
| 19 | run input이 배열 | 400 |
| 20-21 | run 상세(steps 포함) / workflow의 run 목록 | 200 ×2 |
| 22-28 | 타인(B): 상세·PATCH·DELETE·runs 목록·run 생성·run 상세 → 404 ×6, B 목록은 `[]` | 통과 |
| 29-30 | 본문 상한: 약 390KB POST → 413 / run 입력 130KB → 413 | 통과 |
| 31-32 | Origin 불일치 403 / 동일 Origin 201 | 통과 |
| 33 | run_steps 행을 수동 삽입 → run 상세에 steps 1건 표시 | 통과 |
| 34 | DELETE → 200, 이후 workflow·run 404, DB의 workflows/runs/steps 개수 0/0/0 (연쇄 삭제) | 통과 |

합계: 위 시나리오 전부 기대값과 일치. 실패 0.

미검증(정직하게): definition 단독 256KB 분기(본문 272KB 미만·definition 256KB 초과)는 curl로 큰 정상 JSON을 만들 수 없어 실행하지 않았다. 본문 단계의 413은 확인됨. `resolveVars`는 tsc만 통과, 단위 실행은 하지 않았다.

## 4. 정리
- 하네스 마지막에 cleanup.sql 실행: workflows·runs·steps 전부 삭제, u_a/u_b 사용자·세션 삭제 (5개 문장 성공).
- 격리된 DB(`files/workflow-verify/wf1/state`)를 썼으므로 기본 로컬 DB는 건드리지 않았다.
- dev 서버(포트 8798)는 종료 권한이 없어 떠 있을 수 있다: `ss -ltnp | grep 8798` 후 해당 pid kill.
