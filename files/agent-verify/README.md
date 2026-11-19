# A1 에이전트 활동 — 로컬 검증 (2026-11-17, O-C)

공유 로컬 DB(`.wrangler/state`)는 건드리지 않았다. 격리 DB 두 개를 이 폴더 아래에 만들었다.

| 파일 | 용도 |
|---|---|
| `seed-common.sql` | 사용자 3명(av-admin=hr_admin, av-a, av-b) + 세션. 쿠키 `people_os_session=agentverify-{admin,usera,userb}-token` |
| `seed-full.sql` | 6개 소스 테스트 행 (A / B / 소유자 NULL / origin=eval / 시스템) |
| `partial-schema.sql` | 0013·0014·0021·0022 없는 옛 스키마 흉내 + 행 |
| `state-full/`, `state-partial/` | `--persist-to` 격리 DB |
| `full-*.json`, `partial-*.json` | 실제 응답 |

## 재현
```
npx wrangler d1 migrations apply people-os-db --persist-to files/agent-verify/state-full --local
npx wrangler d1 execute people-os-db --persist-to files/agent-verify/state-full --file files/agent-verify/seed-common.sql --local
npx wrangler d1 execute people-os-db --persist-to files/agent-verify/state-full --file files/agent-verify/seed-full.sql --local
npx wrangler d1 execute people-os-db --persist-to files/agent-verify/state-partial --file files/agent-verify/partial-schema.sql --local
npx wrangler d1 execute people-os-db --persist-to files/agent-verify/state-partial --file files/agent-verify/seed-common.sql --local
npx wrangler dev --local --port 8793 --inspector-port 9233 --persist-to files/agent-verify/state-full
curl --noproxy '*' -H 'cookie: people_os_session=agentverify-usera-token' http://localhost:8793/api/agent/activity
```

## 결과
| 확인 | 결과 |
|---|---|
| `npx tsc --noEmit` | 오류 0 |
| `node --check public/agent-activity.js` | 통과 |
| 익명 `GET /api/agent/activity` | 401 |
| 사용자 A (전체 스키마) | AV-A 항목 5개만 (녹음·질문 2·메일 초안·공백). AV-B·AV-NULL·시스템 0. scope=mine |
| 사용자 B (전체 스키마) | AV-B 항목 4개만. AV-A·AV-NULL·시스템 0 |
| HR 관리자 (전체 스키마) | 16개: A·B·소유자 NULL 전부 + 다이제스트 1 + 평가 2. 소유자 이름 붙음. origin=eval 질문은 제외 (평가 실행 항목으로 대신 보임) |
| 메일 초안 후 같은 스레드로 답장 발송 | "사람이 답장 발송함", needsReview=false |
| 옛 스키마, 사용자 A | 200. 녹음 1개. ask·knowledge_gap은 `no-owner-column`(읽지 않음), email_draft는 `no-table` |
| 옛 스키마, HR 관리자 | 200. 있는 테이블 전부. email_draft·eval은 `no-table` |
| `/agent-activity.js` 정적 서빙 | 200 application/javascript |

메모: `seed-full.sql`의 knowledge_gaps `asked_at` 값이 2025-11-17이다 (테스트 데이터 입력 실수 — 코드 문제 아님).
공유 로컬 DB는 0021이 적용돼 있지 않아(ask_events·knowledge_gaps에 user_id 없음) 일반 사용자에게는 이 두 소스가 `no-owner-column`으로 건너뛰어진다 — 의도한 fail-closed 동작이다.
