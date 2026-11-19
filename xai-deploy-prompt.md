# XAI 4가지 + What-If 분리 — 원격 마이그레이션·배포·라이브 확인

XAI 4가지(What-If + 결정적 근거, 차단·전환 사유, 역할 일관성 축, 설명서 발급)와 What-If 분리 변경이 로컬 검증까지 끝났다. 이제 원격에 배포한다.

## 배경

- 결과: `files/workflow-verify/xai-4/RESULT.md` (본문 + "What-If 분리 변경" 절). 두 절을 모두 읽고 배포 범위를 확인하라.
- 마이그레이션: `0037_eval_role_check.sql` (`eval_results`에 `role_check_json` 컬럼 추가). 원격 DB에 아직 적용 안 됨. 적용 전 배포해도 깨지지 않지만 역할 결과는 저장 안 됨.
- What-If 분리 변경: 답은 What-If를 기다리지 않고 바로 반환(로컬 실측 HR 답 4.07초), What-If는 `GET /api/ask/:eventId/whatif`로 따로 불러온다 (별도 호출 6.7초). 새 마이그레이션 없음.
- 현재 라이브 배포: `c2ce46df` (녹음 삭제). 이 배포가 다음 라이브 버전이 된다.

## 할 일

1. **원격 D1 마이그레이션 상태 확인**: `cf-wrangler.py d1 migrations list people-os-db --remote`로 추적 상태를 확인한다. 0037이 이미 적용돼 있으면 다시 적용하지 않는다. AGENTS.md의 D1 주의사항을 따른다 (컬럼 없는 SELECT 금지, `d1q.py`는 `python3 ~/workspace/d1q.py`로).
2. **마이그레이션 0037 원격 적용**: `d1 execute --remote --file migrations/0037_eval_role_check.sql -y`로 적용하고 `d1_migrations`에 기록한다 (AGENTS.md의 out-of-band 적용 절차 참고).
3. **배포**: `cf-wrangler.py deploy`로 배포한다. 배포 버전 ID를 기록한다. `wrangler.toml`의 routes 항목은 건드리지 않는다.
4. **라이브 확인** (workers.dev 경유, 프록시 환경변수 해제하고 curl):
   - HR 질문 1건 ("연차휴가는 며칠인가요?"): 답이 빨리 나오는지, `whatIf` 필드가 없는지, 결정적 근거 배지가 있는지 (API 응답 기준).
   - What-If 별도 호출: `GET /api/ask/:eventId/whatif`로 문장이 나오는지.
   - off-topic 질문 1건 ("파스타 레시피"): 차단 사유 줄이 나오는지.
   - 개인 질문 1건: 전환 사유가 나오는지 (로그인 필요 시 hr.jhkang 계정으로).
   - 트레이스 상세 → 설명서 발급: 버튼이 있고 새 창 문서가 열리는지 (API 응답 기준).
   - 평가 1회: POST /api/obs/evals/runs로 1문항만 돌려 역할 일관성 열이 나오는지 (일일 한도 5회 중 1회 사용 — 2026-11-18에 2/5 사용했으니 한도 안).
   - 브라우저 화면 확인은 이 세션에서 하지 않는다 (사용자 브라우저에서 확인).
5. **결과 파일**: `files/workflow-verify/xai-4/RESULT.md`에 "배포" 절을 덧붙인다. 내용: 마이그레이션 0037 적용 결과, 배포 버전 ID, 라이브 확인 결과 (각 항목), 남은 것 (브라우저 화면 확인, 크론 첫 실행 시간 확인).

## 주의

- 배포는 직렬로 한다. 다른 세션이 배포 중이면 기다린다.
- GitHub 푸시는 하지 않는다.
- 배포 실패 시 롤백 지점을 기록하고 사용자에게 알린다.
