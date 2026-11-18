# reasoning_effort medium으로 변경 + 평가 (Sonnet) — 모델 교체 4차

## 배경
- 프로덕션은 `e73c1b61` (qwen3.8-27b, `reasoning_effort: "low"` 적용됨).
- low 적용 결과: LLM 18.7초 → 6.0초 (전체 10.4초). 골든셋 6/6 통과, avgJudge 0.83 (기준선 0.9).
- 사용자가 medium으로 바꿔보라고 승인했다. low보다 품질이 나아지는지, 속도는 얼마나 느려지는지 비교한다.

## 수정할 것
1. **`LLM_MODEL` 호출 입력의 `reasoning_effort: "low"`를 `"medium"`으로 바꾼다.**
   - low 세션이 넣은 12곳 전부 (`files/workflow-verify/reasoning-low/RESULT.md`에 목록 있음: tree.ts 1, ask-pipeline.ts ask 1, index.ts 4, workflow/nodes.ts 5, agent-do.ts 1).
   - 코드 grep으로 12곳을 확인하고, 빠짐없이 바꾼다. `"low"`가 남은 곳이 없어야 한다.
   - 진단용 디버그 라우트(index.ts 1638줄 부근)는 제외 (low 때도 제외했음).
   - Clef / clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3는 건드리지 않는다. `LLM_MODEL` 값은 바꾸지 않는다.
2. 다른 것은 바꾸지 않는다 (responseText, 모델, 프롬프트 등).

## 검증 순서
1. `npx tsc --noEmit` 통과.
2. 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록할 것.
3. 라이브 검증 (workers.dev 경유):
   - `/api/health` 200 + 바인딩 전부 true.
   - HR 질문 1건 ("연차는 며칠이야?" force) → 정상 텍스트 답변 + grounded 확인 + **LLM 호출 시간 기록** (low 때 6.0초와 비교). 답 품질도 확인할 것 (제12조 인용·내용 정확성).
   - 데모 회귀: 홈 200, 라이브러리 200.
4. 골든셋 평가 1회: `POST /api/obs/evals/runs {trigger:"manual", datasetId:"ds_core_v1"}` + X-Admin-Secret.
   - **Admin secret**: `~/workspace/user/people-os-admin-secret.txt` 파일에서 읽을 것. 이 세션은 `--add-dir ~/workspace/user`로 시작했으므로 읽을 수 있다. **secret 값을 채팅·파일·메모리·보고서에 절대 적지 말 것.** 헤더 값으로만 쓰고 버릴 것.
   - 실행 전 오늘 일일 한도(5회) 잔량을 확인할 것. low 때 1회 사용했으므로 잔량은 4회여야 한다. 한도가 모자라면 평가를 건너뛰고 그 사실을 보고할 것.
   - **Goodhart 규칙: 평가를 1회만 실행하고 그 결과를 그대로 보고할 것. 점수가 떨어졌다고 재실행을 반복해 점수를 올리려 하지 말 것.** low 결과(6/6, avgJudge 0.83) 및 기준선(6/6, 0.9)과 비교할 것. 특히 `gi_s04_leave_accrual` 항목이 low 때 0.7이었는데 medium에서 어떻게 나오는지 볼 것.
5. 개인 질문: 로그인 세션이 있으면 1건 확인한다. 세션을 새로 만들지 말 것. 없으면 "미실행 (로그인 세션 없음)"이라고 보고한다.

## 산출물
- 검증 산출물을 `files/workflow-verify/reasoning-medium/RESULT.md`에 작성할 것.
- 진행 기록 `files/people-os/workflow-agent-builder-PROGRESS.md`에 "모델 교체 4차(reasoning_effort medium)" 항목을 추가할 것.

## 보고 형식 (최종 응답)
- 배포 버전 ID:
- 변경 요약 (12곳 low → medium).
- 라이브 HR 질문: (질문 → 답변 요약 + grounded 여부 + **LLM 시간** — low 6.0초와 비교).
- 골든셋 평가 (ds_core_v1): X/6, avgJudge N.NN (low 6/6·0.83, 기준선 6/6·0.9와 비교). `gi_s04` 항목 점수 포함.
- **비교 결론**: medium vs low — 속도·품질 중 무엇이 나아졌고 무엇이 나빠졌는지. 어느 쪽을 유지하는 게 나은지 2~3줄로 정리.
- 개인 질문: (질문 → 답변 요약, 또는 미실행 사유).
- 데모 회귀: 통과/실패 항목.
- 미검증 항목 (있으면 정직하게).
