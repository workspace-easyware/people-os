# Workers AI 모델 폐기 대응 — 모델 교체 + 배포 + 검증 (Sonnet)

## 배경
Cloudflare 메일(2026-11-17): Workers AI 모델 여러 개가 2026-11-20에 영구 폐기. 이후 해당 모델 ID 호출 시 404/model_not_found. 11/20 전 완료 필수 (11/25 동결 전).

## 교체할 것 (정확히 이 3곳만)
1. `src/ask-pipeline.ts:37` — `LLM_MODEL`을 `@cf/qwen/qwen3-30b-a3b-fp8` → `@cf/qwen/qwen3.8-27b`로 교체. (Cloudflare 권장 후계, 동일 Qwen 계열, 소형·저비용 라인)
2. `src/index.ts:1638` — 디버그 진단 엔드포인트의 LLM 후보 목록 `llmCandidates`에서 `@cf/meta/llama-3.2-1b-instruct` 제거. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`는 유지. (목록은 `[LLM_MODEL, "@cf/meta/llama-3.2-1b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"]` 형태)
3. `src/obs/pricing.ts:30` — 가격표에서 `@cf/meta/llama-3.2-1b-instruct` 행 삭제. (라이브 호출이 아니므로 부수 정리. `@cf/meta/llama-3.3-70b-instruct-fp8-fast` 행은 유지.)

## 건드리지 말 것
Clef / clef-omni, llama-4-scout (judge), whisper-large-v3-turbo (전사), bge-m3 (임베딩) — 폐기 대상 아님. 이 모델들을 참조하는 코드는 절대 수정하지 말 것. 다른 파일의 Qwen3-30B 언급(주석·문서·README·pitch 등)은 이번 작업 범위가 아니므로 건드리지 말 것 — 라이브 동작 코드 3곳만 교체한다.

## 검증 순서
1. `npx tsc --noEmit` 통과.
2. 원격 D1 마이그레이션 없음 (스키마 변경 없음) — 확인만 하고 적용하지 말 것.
3. 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지 — 비대화형에서 CLOUDFLARE_API_TOKEN 필요). 배포 버전 ID를 기록할 것.
4. 라이브 검증 (workers.dev 경유로 할 것 — `curl *peopleos.site*`는 settings.json 허용 규칙에 없어 승인 카드가 뜬다. workers.dev는 같은 Worker·같은 D1이라 검증 효력이 같다):
   - `/api/health` 200 + 바인딩 전부 true.
   - HR 질문 1건 (예: 연차 규정 — "연차는 며칠이야?" 류) → 정상 답변 + grounded 확인.
   - 개인 질문 1건 (로그인 세션 필요 — hr.jhkang@peopleos.site 계정으로 로그인 후 `/api/personal/ask`) → 정상 답변 확인.
   - 데모 회귀: 홈 200, 라이브러리 200, 메일함 200, 캘린더 200.
5. 골든셋 평가 재실행 1회: `POST /api/obs/evals/runs {trigger:"manual", datasetId:"ds_core_v1"}` + X-Admin-Secret (값은 `~/workspace/user/people-os-admin-secret.txt` 파일에서 읽을 것 — 채팅·파일·메모리에 값을 적지 말 것). 기존 기준선은 Qwen3-30B 기준 6/6, avgJudge 0.9.
   - **Goodhart 규칙: 평가를 1회만 실행하고 그 결과를 그대로 보고할 것. 점수가 떨어졌다고 재실행을 반복해 점수를 올리려 하지 말 것.** 점수가 떨어지면 원인 분석까지 보고할 것 (예: 새 모델의 답변 스타일·근거 인용 방식 변화 등).
   - 평가 실행은 일일 한도(5회)를 쓰므로, 실행 전 `GET /api/obs/evals/runs` 등으로 오늘 이미 몇 회 썼는지 확인하고, 한도가 모자라면 평가를 건너뛰고 그 사실을 보고할 것.

## 산출물
- 검증 산출물을 `files/workflow-verify/model-swap/RESULT.md`에 작성할 것 (교체 전·후, tsc, 배포 버전 ID, 라이브 HR/개인 질문 결과, 평가 결과, 회귀 결과).
- 진행 기록 `files/people-os/workflow-agent-builder-PROGRESS.md`에 "모델 교체" 항목을 추가할 것 (버전 ID + 평가 결과 요약).

## 보고 형식 (최종 응답)
- 배포 버전 ID:
- 라이브 HR 질문: (질문 → 답변 요약 + grounded 여부)
- 라이브 개인 질문: (질문 → 답변 요약)
- 골든셋 평가 (ds_core_v1): X/6, avgJudge N.NN (기준선 6/6, 0.9와 비교). 떨어졌으면 원인 분석 2~3줄.
- 데모 회귀: 통과/실패 항목.
- 미검증 항목 (있으면 정직하게).
