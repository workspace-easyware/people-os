# responseText() 수정 + 재배포 + 평가 (Opus) — Workers AI 모델 폐기 대응 2차

## 배경
1차 모델 교체(Sonnet)가 실패해 롤백됨. 프로덕션은 지금 직전 버전 `5ee615c9-0160-4b5e-bb03-14d69d7dc7e6` (Qwen3-30B)으로 정상 동작 중. 소스에는 교체 3곳(`ask-pipeline.ts:37` LLM_MODEL=`@cf/qwen/qwen3.8-27b`, `index.ts:1638` llama-3.2-1b 제거, `pricing.ts:30` llama-3.2-1b 행 삭제)이 이미 남아 있음. 사용자가 responseText 수정 + 재배포를 승인함. 폐기일 11/20 전 완료 필수.

## 원인 (1차 세션 보고 — `files/workflow-verify/model-swap/RESULT.md`를 먼저 읽을 것)
`responseText()`(`src/ask-pipeline.ts:85`)가 `{response: ...}` 형식만 읽는다. `qwen3.8-27b`는 `choices[0].message.content` 형식으로 응답하고 `reasoning`도 따로 내보낸다. 그래서 봉투 전체가 답이 됐고, HR 질문에 원시 JSON이 보였다. LLM 호출도 26.9초 걸렸다(기준 ~2.3초). 같은 함수를 쓰는 라우터·게이트·rerank·judge·코칭 JSON도 영향받을 수 있다. RESULT.md에 실제 원시 응답 형식이 있으니 그걸 기준으로 수정할 것.

## 수정할 것
1. `responseText()`(`src/ask-pipeline.ts:85` 부근)를 고쳐서 두 형식을 다 읽게 할 것:
   - 새 형식: `choices[0].message.content` (chat.completion 형식). `content`가 문자열이면 그걸 반환.
   - 기존 형식: `{response: ...}` — 그대로 유지 (다른 모델(Clef, llama-4-scout 등)이 이 형식을 쓸 수 있으므로 하위 호환 필수).
   - `reasoning` 처리: 새 모델이 `reasoning`을 따로 내보내면, 답에 섞이지 않게 분리할 것. `reasoning`이 `choices[0].message` 안에 있든 최상위에 있든, 최종 답변 텍스트에는 reasoning이 들어가지 않게 할 것. (reasoning을 버리든 별도 필드로 빼든, 답이 깨끗해야 한다.)
   - 빈 응답·형식 불일치 시 기존 동작(에러 또는 빈 문자열)을 유지할 것 — 조용히 잘못된 답을 내지 말 것.
2. 같은 `responseText()`를 쓰는 호출처(라우터·게이트·rerank·judge·코칭 JSON)가 새 형식을 받아도 깨지지 않는지 확인할 것. 필요하다면 각 호출처의 JSON 파싱도 함께 손볼 것. 단, 범위를 넓히지 말 것 — responseText 수정으로 해결되면 호출처는 건드리지 말 것.

## 건드리지 말 것
- LLM_MODEL은 이미 `@cf/qwen/qwen3.8-27b`로 바뀌어 있음 — 다시 바꾸지 말 것.
- Clef / clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3 — 폐기 대상 아님. 이 모델들의 호출 코드는 절대 수정하지 말 것.

## 비밀번호 토글 (소스에 이미 있음 — 검증 후 같이 배포)
소스 `public/index.html`에는 비밀번호 표시 토글(1차와 별개 세션에서 구현)이 이미 들어가 있다. 이 세션에서 배포하면 토글도 같이 나간다. 배포 전에 토글 JS 문법을 확인할 것:
- 인라인 스크립트를 `sed`/`awk`/`grep`으로 추출해 임시 파일로 만들고 `node --check`으로 검사할 것 (`node -e`, `node <스크립트>` 실행은 이 환경에서 승인 대상이라 막힐 수 있으니, 텍스트 추출 + `node --check` 방식을 쓸 것).
- 문법 오류가 있으면 고칠 것. 추출이 불가능하면 보고하고, 그 경우 토글은 배포하지 말고(필요하면 토글 부분을 되돌린 뒤) 모델 수정만 배포할 것. 단, 토글은 단순한 핸들러라 깨끗할 가능성이 높다.

## 검증 순서
1. `npx tsc --noEmit` 통과.
2. 로컬 하네스로 responseText를 검증할 것: (a) 기존 `{response}` 형식 입력 → 기존처럼 반환, (b) 새 `choices[0].message.content` 형식 입력(RESULT.md의 실제 원시 응답 사용) → content만 반환, reasoning 없음, (c) reasoning 포함 입력 → 답에 reasoning 없음. 하네스 산출물을 `files/workflow-verify/model-swap/RESULT.md`에 추가하거나 `files/workflow-verify/responseText-fix/RESULT.md`에 새로 쓸 것.
3. 원격 D1 마이그레이션 없음 (스키마 변경 없음) — 확인만 하고 적용하지 말 것.
4. 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록할 것.
5. 라이브 검증 (workers.dev 경유 — `curl *peopleos.site*`는 승인 카드가 뜬다):
   - `/api/health` 200 + 바인딩 전부 true.
   - HR 질문 1건 ("연차는 며칠이야?" force) → 정상 텍스트 답변 + grounded 확인 + LLM 호출 시간 기록 (26.9초가 아니라 ~2~3초 수준이어야 함).
   - 개인 질문 1건 (로그인 세션 필요 — hr.jhkang@peopleos.site 계정으로 로그인 후 `/api/personal/ask`) → 정상 답변 확인. 로그인 세션이 없으면 그 사실을 보고하고, HR 질문 결과로 대신할 것 (무작정 세션을 만들지 말 것).
   - 데모 회귀: 홈 200, 라이브러리 200, 메일함 200, 캘린더 200.
6. 골든셋 평가 재실행 1회: `POST /api/obs/evals/runs {trigger:"manual", datasetId:"ds_core_v1"}` + X-Admin-Secret (값은 `~/workspace/user/people-os-admin-secret.txt` 파일에서 읽을 것 — 채팅·파일·메모리에 값을 적지 말 것). 기존 기준선은 Qwen3-30B 기준 6/6, avgJudge 0.9.
   - **Goodhart 규칙: 평가를 1회만 실행하고 그 결과를 그대로 보고할 것. 점수가 떨어졌다고 재실행을 반복해 점수를 올리려 하지 말 것.** 점수가 떨어지면 원인 분석까지 보고할 것.
   - 평가 실행 전 오늘 일일 한도(5회) 잔량을 확인할 것. 한도가 모자라면 평가를 건너뛰고 그 사실을 보고할 것.

## 산출물
- 검증 산출물을 `files/workflow-verify/responseText-fix/RESULT.md`에 작성할 것 (또는 `files/workflow-verify/model-swap/RESULT.md`에 2차 항목 추가).
- 진행 기록 `files/people-os/workflow-agent-builder-PROGRESS.md`에 "모델 교체 2차(responseText 수정)" 항목을 추가할 것 (버전 ID + 평가 결과 요약).

## 보고 형식 (최종 응답)
- 배포 버전 ID:
- responseText 수정 요약 (어떤 형식을 어떻게 읽게 했는지, reasoning 처리).
- 비밀번호 토글 JS 검증 결과 (통과/수정/미검증).
- 라이브 HR 질문: (질문 → 답변 요약 + grounded 여부 + LLM 시간)
- 라이브 개인 질문: (질문 → 답변 요약, 또는 미실행 사유)
- 골든셋 평가 (ds_core_v1): X/6, avgJudge N.NN (기준선 6/6, 0.9와 비교). 떨어졌으면 원인 분석 2~3줄.
- 데모 회귀: 통과/실패 항목.
- 미검증 항목 (있으면 정직하게).
