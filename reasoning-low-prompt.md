# reasoning_effort low 적용 + 평가 (Sonnet) — 모델 교체 3차

## 배경
- 프로덕션은 `8458c9e9` (qwen3.8-27b, responseText 수정 완료). HR 질문은 정상 텍스트 답변, grounded=true.
- **문제: LLM이 18.7초 걸린다** (기준 ~2.3초). 원인은 모델 카탈로그의 `reasoning_effort` 기본값이 `xhigh`(최고 강도)라서 매 답변마다 긴 추론 토큰을 생성한다. 추론을 끌 수는 없고 low/medium/xhigh 중에 고를 수 있다.
- 사용자가 `reasoning_effort: "low"` 적용을 승인했다. 이 세션에서 적용하고 검증하고 평가까지 한다.

## 수정할 것
1. **`LLM_MODEL`(`@cf/qwen/qwen3.8-27b`) 호출 입력에 `reasoning_effort: "low"`를 추가한다.**
   - 최소 ask 경로. 가능하면 `LLM_MODEL`을 쓰는 모든 호출처에 적용한다 (router·gate·rerank·judge·코칭 등 — 단, Clef/clef-omni/llama-4-scout를 쓰는 호출처는 건드리지 말 것. `LLM_MODEL` 상수를 쓰는 곳만).
   - 호출처 목록 (2차 RESULT.md에서 확인): ask-pipeline.ts(ask 895, tree 238 부근), index.ts(722·1279·1302·1643·1909), workflow/nodes.ts(149·222·241·354·423), agent-do(172). 실제 호출 형태를 코드에서 직접 확인할 것.
   - **바인딩 확인이 핵심**: Workers AI 바인딩(`env.AI.run`)이 `reasoning_effort` 파라미터를 받는지 먼저 확인할 것. 모델 카탈로그에는 `supported_efforts: ["xhigh","medium","low"]`로 나와 있지만, 바인딩 입력 형식이 이를 받는지는 코드·문서·라이브 테스트로 확인할 것. 받지 않으면, 바인딩이 받는 다른 방식(예: 별도 옵션 객체)이 있는지 찾을 것. 도저히 안 되면 그 사실을 보고하고 중단할 것 (억지로 우회하지 말 것).
   - `max_tokens: 800` 경로(index.ts:1907 코칭, nodes.ts:352)도 low로 바꾸면 xhigh 추론이 토큰을 다 써서 content가 비는 위험이 줄어든다. 이 경로도 함께 확인할 것.
2. 건드리지 말 것: Clef / clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. `LLM_MODEL` 값 자체는 바꾸지 않는다 (이미 qwen3.8-27b).

## 검증 순서
1. `npx tsc --noEmit` 통과.
2. 로컬 하네스로 `reasoning_effort: "low"`가 호출 입력에 들어가는지 확인할 것 (가능하면).
3. 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록할 것.
4. 라이브 검증 (workers.dev 경유):
   - `/api/health` 200 + 바인딩 전부 true.
   - HR 질문 1건 ("연차는 며칠이야?" force) → 정상 텍스트 답변 + grounded 확인 + **LLM 호출 시간 기록** (18.7초에서 얼마나 줄었는지). 2~3초 수준이면 성공. 답 품질도 확인할 것 (제12조 인용·내용 정확성).
   - 데모 회귀: 홈 200, 라이브러리 200.
5. 골든셋 평가 1회: `POST /api/obs/evals/runs {trigger:"manual", datasetId:"ds_core_v1"}` + X-Admin-Secret.
   - **Admin secret**: `~/workspace/user/people-os-admin-secret.txt` 파일에서 읽을 것. 이 세션은 `--add-dir ~/workspace/user`로 시작했으므로 읽을 수 있다. **secret 값을 채팅·파일·메모리·보고서에 절대 적지 말 것.** 헤더 값으로만 쓰고 버릴 것.
   - 실행 전 오늘 일일 한도(5회) 잔량을 확인할 것. 한도가 모자라면 평가를 건너뛰고 그 사실을 보고할 것.
   - **Goodhart 규칙: 평가를 1회만 실행하고 그 결과를 그대로 보고할 것. 점수가 떨어졌다고 재실행을 반복해 점수를 올리려 하지 말 것.** 기준선은 Qwen3-30B 기준 6/6, avgJudge 0.9. 떨어지면 원인 분석까지 보고할 것.
6. 개인 질문: 로그인 세션이 있으면 1건 확인한다. 세션을 새로 만들지 말 것. 없으면 "미실행 (로그인 세션 없음)"이라고 보고한다.

## 산출물
- 검증 산출물을 `files/workflow-verify/reasoning-low/RESULT.md`에 작성할 것.
- 진행 기록 `files/people-os/workflow-agent-builder-PROGRESS.md`에 "모델 교체 3차(reasoning_effort low)" 항목을 추가할 것.

## 보고 형식 (최종 응답)
- 배포 버전 ID:
- reasoning_effort 적용 범위 (어느 호출처에 넣었는지).
- 바인딩이 파라미터를 받는지 확인 결과.
- 라이브 HR 질문: (질문 → 답변 요약 + grounded 여부 + **LLM 시간** — 18.7초 → X초).
- 골든셋 평가 (ds_core_v1): X/6, avgJudge N.NN (기준선 6/6, 0.9와 비교). 떨어졌으면 원인 분석 2~3줄.
- 개인 질문: (질문 → 답변 요약, 또는 미실행 사유).
- 데모 회귀: 통과/실패 항목.
- 미검증 항목 (있으면 정직하게).
