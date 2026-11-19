# XAI 보완 4가지 — 결과 (2026-11-19)

이전 세션이 런타임 재시작으로 중단돼 이어서 완성했다. 이전 세션이 끝낸 것: 구현 1·2의 백엔드(`src/ask-pipeline.ts`, `src/obs/rerank.ts`, `src/obs/types.ts`, `src/obs/trace.ts` SPAN_ORDER). 이번 세션: 구현 1·2 화면, 구현 3 전체, 구현 4 전체, 로컬 검증, 이 문서.

배포 안 함. GitHub 푸시 안 함. `wrangler.toml` 안 건드림.

---

## 1. What-If + 결정적 근거 (HR 규정 검색·개인 업무 검색)

**바꾼 것**
- `src/ask-pipeline.ts`
  - `buildWhatIfMessages` / `cleanWhatIf`: 답을 만든 뒤 같은 근거(최대 3개 × 180자, 답 500자)로 LLM(`@cf/qwen/qwen3.8-27b`, reasoning_effort low)을 1회 더 불러 "결론이 달라지려면" 한두 문장(150자 안팎, 최대 240자)을 받는다.
  - 근거 없음(C5) 답이면 프롬프트를 바꿔 "어떤 근거가 등록되어 있으면 답할 수 있는지"를 만든다.
  - 사용자 경로(origin user·personal)에서만, 전환·차단 답이 아닐 때만 돈다. 평가(origin eval)에서는 안 돈다 → 평가 비용·결과 영향 없음.
  - 응답 필드 `whatIf`(선택), 트레이스 span `what_if`(모델·성공 여부·오류), R2 트레이스 원문에 `whatIf`.
  - `decisiveSourceId`: 근거 재순위(`rerankSources`)가 실제로 고른 근거 id. 재순위가 원래 1위를 그대로 골라도 표시한다(판단 모델이 고른 것이므로). 후보 1개(재순위 생략)·재순위 실패(fail-open)면 없다 → 화면에 표시 안 함.
- `src/obs/rerank.ts`: `RerankOutcome.decidedId` 추가 (원래 순서 유지인 경우 포함).
- `public/index.html` `renderAsk()`: 인용 목록에서 해당 근거에 "결정적 근거" 배지 + 왼쪽 강조선, 답·인용 아래 "이 답이 달라지려면" 상자. 두 창(HR·개인)이 같은 함수를 쓴다.
- `public/styles.css`: `.badge.decisive`, `li.decisive-src`, `.xai-whatif`, `.xai-decision`.

**비용·실패 시 동작**
- 답마다 LLM 1회 추가 (입력 약 300~700 토큰, 출력 짧음). 단가표 기준 답 1건당 약 $0.0002~0.0004 추가.
- **지연이 늘어난다**: 로컬 실측 What-If 3.8s(근거 없음 답), 11.0s(근거 있음 답), 1건은 20s 시간 초과. 시간 상한을 20s → **15s**로 낮췄다. 상한을 넘으면 답에서 whatIf만 빠진다.
- 실패·빈 응답·시간 초과 → `whatIf` 없이 답 그대로 나감 (fail-open, 로컬에서 실제로 확인: 시간 초과 건도 답 정상 반환).
- 답·근거·판정(grounded)은 What-If 전에 이미 정해지고 바뀌지 않는다. What-If는 세션 기록에도 안 들어간다.

## 2. 차단·전환 사유 표시

**바꾼 것**
- `src/ask-pipeline.ts`: `decision = {kind, by, confidence, message}`. 라우터 전환(redirect_personal / redirect_hr)·라우터 off_topic·토픽 가드 off_topic일 때만 만든다. confidence는 라우터/가드가 이미 계산한 값을 그대로 쓴다(새로 계산 안 함). `decisionMessage()`가 문구를 만든다 (소수 둘째 자리).
- `src/obs/types.ts`: `AskDecision` 타입, `AskTrace.decision/whatIf/decisiveSourceId/userRole`.
- `public/index.html`: `decision.message`가 있으면 답 위에 한 줄(주황 띠). 일반 답에는 `decision`이 없어서 안 보인다.

## 3. 편향/일관성 축 — 역할별 비교 (관측·평가)

**바꾼 것**
- `src/obs/role-check.ts` (새 파일): 역할별 재실행·비교.
- `src/obs/runner.ts`
  - `startRun`: `config.role_check_roles` 고정 (기본 `["hr_admin","user"]`). 데이터셋 id에 `personal`이 있으면 빈 배열. 사전 비용 추정에 역할 축(역할 수 × (ask + 최악 verdict))을 더한다. **config_hash에는 넣지 않았다** — 기존 지표 비교·크론 건너뛰기 판단을 바꾸지 않기 위해서.
  - `processEvalItem`: 기본 평가가 오류 없이 끝난 공용 항목만 역할 축을 돈다. 결과는 `eval_results.role_check_json`에만 UPDATE. passed·judge·verdict 컬럼은 건드리지 않는다. 역할 축 실패는 로그만 남기고 항목은 정상 진행. 역할 축 비용은 실행 비용(`cost_estimate_usd`)에 더해 비용 상한 가드가 그대로 적용된다.
  - `getRunDetail`: 항목마다 `roleCheck`, 실행 단위 `roleCheckSummary {roles, checked, inconsistent}`.
- `src/obs/guards.ts`: `metaGet` export (역할 목록 meta 읽기용).
- `migrations/0037_eval_role_check.sql`: `ALTER TABLE eval_results ADD COLUMN role_check_json TEXT`. 마이그레이션 전이면 UPDATE가 실패해도 항목 결과는 이미 저장된다 (try/catch).
- `public/obs/evals.js` + `evals.css`: 항목 목록에 "역할 일관성" 열 (일치/불일치 배지, 개인 항목·미검사는 —), 실행 머리에 "역할 불일치 n/m" 배지, 항목 상세("사유" 펼침)에 역할별 답·처리 결과·판정·인용 근거·트레이스 링크를 나란히.

**적용 범위**: 공용 HR 규정 항목만. 데이터셋 id에 `personal` 또는 항목 태그에 `personal`이 있으면 제외 (원격 ds_personal_v1 항목은 전부 `personal` 태그 확인함). 개인 질문은 사람마다 데이터가 달라 답이 달라지는 게 정상이므로.

**역할 수**: 기본 2개 (hr_admin · user). 옵션: `meta.eval_role_check_roles = "hr_admin,user,coach,coachee"`로 4개, `"off"`로 끔. 허용 목록 밖 값은 버리고, 2개 미만이면 기본값.
- 역할 실행은 합성 조회자 `{id: "eval-role:<role>", role}` + `pool: "shared"`로 돈다. 공용 풀은 `owner_id IS NULL`만 보므로 id는 검색 범위에 영향이 없다. 트레이스는 origin eval·같은 evalRunId로 남고 user_id가 `eval-role:<role>`로 찍힌다.
- 참고(사실): 현재 HR ask 파이프라인은 역할로 분기하지 않는다. 그래서 이 축이 지금 잡는 것은 LLM 비결정성·검색 흔들림이고, 앞으로 역할에 따라 달라지는 로직이 들어오면 회귀를 잡는 안전망이 된다. coach/coachee는 `coaching_role`(별도 필드)인데 ask 파이프라인이 이를 받지 않으므로 4역할 옵션은 role 문자열만 바꿔 넣는 수준이다.

**비교 기준 (2단계, 기준 역할 = 첫 번째 역할)**
1. 1단계 (LLM 추가 호출 없음)
   - 처리 결과(grounded / no_evidence) 일치
   - 인용 근거 겹침: Jaccard(source id) — **0.5 미만이면 불일치**
   - 답 핵심 결론 대용: 문자 bigram Dice 유사도 — **0.35 미만이면 2단계로**, **0.2 미만이면 불일치**
2. 2단계 (1단계가 의심스러울 때만): 역할별 grounded 답에 verdict(Clef 앙상블, 평가와 같은 엔진) → 판정이 다르면 불일치
- 결과: `inconsistent`, `reasons[]`, `statusMatch`, `sourceOverlapMin`, `answerSimMin`, `verdictChecked`, `verdictMatch`, `llmCalls`, `costUsd`, 역할별 `{eventId, status, sourceIds, sourceLabels, answer(1500자), verdict}`.

**실제 비용 배수**
- 단가표(guards.ts EST_TOKENS·$0.27/$0.85 per M) 추정: 항목당 기존 $0.001888 (ask+judge+verdict).
  - 2역할: +$0.001405 (ask 2회) → **×1.74**, 2단계까지 가면 +$0.000804 → **×2.17**
  - 4역할: **×2.49**, 최악 **×3.35**
- **로컬 실측 (1문항 "연차 3일 쓸 수 있어?", 2역할)**: 실행 비용 $0.00380 중 역할 축 $0.00195 (LLM 2회, 2단계 생략) → **실측 ×2.05**. 추정보다 높은 이유: 실제 ask 토큰이 EST_TOKENS(1500/350)보다 많았다. 30문항 상한이어도 2역할 실행 1회 ≈ $0.12 수준 (비용 상한 $0.5 안).
- 시간: 항목당 ask 2회가 더해진다 (로컬 실측 1문항 약 3~4분 → 대부분 qwen 답 생성 시간). 큐 소비는 항목 메시지 단위라 크론 1회 호출 시간 한도에 한꺼번에 걸리지는 않지만, 실행 전체 시간은 약 2~3배가 된다. 그래서 기본 2역할로 두고 4역할은 meta 옵션으로만 남겼다.
- 수동 평가 일일 한도(5회)는 그대로. 크론(새벽 3시)도 같은 `processEvalItem`을 타므로 이 축이 자동 포함된다.

## 4. 트레이스 상세 "설명서 발급"

**바꾼 것**
- `src/obs/trace.ts`: R2 트레이스 원문(TraceBlob)에 `userRole`, `whatIf`, `decisiveSourceId`, `decision` 추가 (새 트레이스부터).
- `src/obs/routes-traces.ts` `GET /api/obs/traces/:id`: 응답 `trace.explain` 추가. 원천은 이미 기록된 값뿐:
  - `viewerRole`: session span `viewerRole` (없으면 R2 `userRole`)
  - `router`, `topicGuard`: 해당 span의 intent·confidence·redirect·offTopic·engine
  - `decisiveSourceId`: rerank span `decisiveId`
  - `decision`, `whatIf`, `sources`: R2 원문 (관리자만 읽는 블록이므로 관리자일 때만, 마스킹 규칙 동일)
- `public/obs/traces.js`: 상세 머리에 "설명서 발급" 버튼 (메타데이터 트레이스에는 없음). 누르면 새 창에 인쇄용 HTML 문서 + "인쇄 / PDF로 저장" 버튼. **LLM 호출 없음** — 응답 JSON만 포맷. `O.traces.buildExplainDoc`으로도 노출 (테스트용).
- `public/obs/obs.css`: 버튼 위치.

**설명서 필드** (없으면 "기록 없음", 지어내지 않음)
- 질문, 답변, 처리 결과(status)
- 전환·차단 사유 (decision 또는 router/guard span에서, 해당할 때만)
- 인용된 근거: 제목 › 조항, 공용/개인, 사내 암묵지, **결정적 근거(재순위 1순위)** 표시. R2가 없으면 `source_ids` + 검색 후보 표의 제목·조항으로 대신
- 판정과 그 이유: trace_scores의 verdict(라벨 + comment=사유), judge_score(점수·단계·사유), 사람 점수
- 이 답이 달라지려면 (기록돼 있을 때만)
- 사용된 모델: 답변 모델(ask_events.model), 라우터·토픽 가드 엔진, What-If 모델 (span에 기록된 것만)
- 프롬프트 버전 · 지식 epoch
- 판단 시각 (KST), 질문자 역할 (hr_admin / user, 익명·평가·이전 트레이스는 "기록 없음")
- 트레이스 ID · 출처
- 끝에 "트레이스 값만 옮겨 적었고 AI 재호출 없음" 주석

참고: 관측·평가 API는 관리자 전용이다 (일반 사용자 tokB → "관리자만 볼 수 있습니다" 확인). 설명서도 관리자가 발급하는 형태다.

---

## 로컬 검증

환경: `cf-wrangler.py dev --local --port 8799 --persist-to files/workflow-verify/xai-4/state` (D1 로컬 새 상태, 0001~0037 마이그레이션 전부 적용 성공, Workers AI는 원격). 검증 사용자: `seed-users.sql` (u_a hr_admin = tokA, u_b user = tokB).
※ 기본 `.wrangler/state` 로컬 DB는 오래돼서(0017 `node_id` 없음) /api/ask 500 — 이번 변경과 무관. 그래서 새 상태 디렉터리를 썼다. 기본 상태에도 0037은 적용해 두었다.
※ 처음엔 `npx wrangler dev`로 띄웠는데 API 토큰이 없어 AI 호출이 전부 실패 → 모든 단계 fail-open(엔진 local-template, whatIf·decisiveSourceId 없음)으로 답 정상 반환 — fail-open 경로 확인. 이후 cf-wrangler로 다시 띄워 정상 경로 확인.

| 확인 | 결과 |
|---|---|
| `npx tsc --noEmit` | 통과 |
| `node --check` public/obs/traces.js, evals.js | 통과 |
| HR "연차휴가는 며칠인가요?" | engine workers-ai, `whatIf` 있음 ("근속연수에 따라… 결론이 달라질 수 있습니다"), `decisiveSourceId: policy-leave-chunk-0`, what_if 10,973ms |
| HR "오늘 저녁 메뉴로 파스타 레시피" | `decision {kind: off_topic, by: router, confidence: 0.9322, message: "HR 규정과 관련 없는 질문으로 판단되어 답변하지 않습니다 (신뢰도 0.93)"}`, whatIf 없음 |
| HR "내가 지난주 회의에서 맡기로 한 내 할 일" | `decision {kind: redirect_personal, confidence: 0.9755, "개인 질문으로 판단되어 개인 업무 검색으로 안내합니다 (신뢰도 0.98)"}` |
| HR "사내 동호회 활동비 지원 한도" (근거 없음) | 근거 없음 답 + `whatIf` "…조항이 등록되어 있으면 답할 수 있습니다." (3,810ms) |
| HR "출장비 일비" (tokB, user) | 근거 1개 → 재순위 생략 → decisiveSourceId 없음(정상). What-If 20s 시간 초과 → whatIf 없이 답 정상 (fail-open) |
| 트레이스 상세 `explain` (관리자) | viewerRole "user"(tokB 건), router/guard confidence, decisiveSourceId, whatIf, sources(R2) 모두 채워짐 |
| 트레이스 상세 (일반 사용자) | "관리자만 볼 수 있습니다" |
| 평가 1문항 × 2역할 (`run_b65fc29325904155`) | status done, 기본 평가 passed true·verdict grounded (기존 동작 그대로). roleCheck: hr_admin·user 둘 다 grounded, 근거 3개 동일(overlap 1.0), 답 유사도 0.454, 2단계 생략, inconsistent false, llmCalls 2, $0.00195. `roleCheckSummary {roles:[hr_admin,user], checked:1, inconsistent:0}` |

검증 산출물: `trace-detail.json` (설명서 원천 응답), `eval-run-detail.json` (역할 축 결과), `seed-users.sql`.

**로컬에서 못 한 것**
- 브라우저 화면 확인 (답변 카드·평가 표·설명서 새 창) — 헤드리스 브라우저 없음. API 응답 필드와 렌더 코드만 확인.
- `explain-doc-check.js` (실제 trace-detail.json으로 buildExplainDoc을 돌려 `explain-doc-sample.html`을 쓰고 필수 항목 11개를 검사) — 이 세션 권한으로 node 스크립트 실행이 막혀 **실행 안 됨**. 실행: `node files/workflow-verify/xai-4/explain-doc-check.js`.
- 개인 업무 검색 창 실제 호출 (개인 문서가 있는 사용자 필요). 같은 `runAsk`·`renderAsk`를 쓰므로 동작은 같다.
- 역할 불일치(inconsistent true) 경로와 2단계 verdict 비교 — 실측 1건이 일치였다. 로직은 코드 리뷰만.

## 배포 전 남은 것

1. 원격 D1에 `0037_eval_role_check.sql` 적용 (먼저 `migrations list --remote`로 추적 상태 확인 — AGENTS.md 참고). 적용 전 배포해도 깨지지는 않는다 (role_check_json UPDATE만 실패·로그).
2. 배포 후 라이브 확인: HR 질문 1건 (whatIf·결정적 근거 배지), off-topic 1건 (사유 줄), 트레이스 상세 → 설명서 발급 새 창·인쇄, 평가 1회 (역할 일관성 열).
3. What-If 지연 판단: 답 체감 지연이 3~15s 늘어난다. 너무 길면 (a) 시간 상한을 더 낮추거나 (b) What-If를 답과 분리해 따로 불러오는 엔드포인트로 바꾸는 것을 고려.
4. 크론 첫 실행 후 실행 시간 확인 (항목당 ask 2회 추가). 길면 `meta.eval_role_check_roles = off` 또는 항목 수 축소.
5. 선택: 4역할(`hr_admin,user,coach,coachee`)은 meta로만 켠다.

---

## What-If 분리 변경 (2026-11-19)

답이 What-If를 기다리지 않고 바로 나가도록 바꿨다. What-If는 화면이 답을 그린 뒤 따로 불러온다. 다른 XAI 기능(결정적 근거·차단 사유·역할 일관성·설명서)은 그대로다. `npx tsc --noEmit` 통과. 배포·푸시 안 함. 새 마이그레이션 없음 (0037 그대로).

### 바꾼 파일
- `src/ask-pipeline.ts`: 답 생성 뒤 What-If LLM 동기 호출 제거. `AskResponse.whatIf` 제거. 대신 트레이스에 `whatIfContext`(근거 최대 3개 × 180자: 제목·조항 경로·발췌)만 남긴다 — 전환·차단 답에는 안 남김. `generateWhatIf()` 추가 (기존 `buildWhatIfMessages`·`cleanWhatIf` 재사용, 상한 15초, 실패해도 throw 안 함). 답 트레이스에는 `what_if` span·`timings.what_if`가 더 이상 안 들어간다.
- `src/index.ts`: `GET /api/ask/:eventId/whatif` 추가 (HR·개인 창 공용).
- `src/obs/types.ts`, `src/obs/trace.ts`: `AskTrace.whatIf` → `whatIfContext`, `WhatIfSource` 타입. R2 원문에 `whatIfContext` 저장.
- `src/obs/routes-traces.ts`: 설명서 `explain.whatIf` 필드 제거 (What-If는 이제 트레이스 원문에 저장되지 않음).
- `public/index.html`: `renderAsk()`가 답·인용을 그린 뒤 "이 답이 달라지려면 / 불러오는 중…" 상자를 두고 `loadWhatIf()`로 따로 채운다. 실패·빈 값이면 상자를 지운다. 두 창 공통 (같은 `renderAsk`). 전환·차단 답(`decision` 있음)에는 상자 없음.

### 엔드포인트 `GET /api/ask/:eventId/whatif[?sessionId=...]`
- 읽는 곳: D1 `ask_events`(질문·답·소유자) + R2 `traces/<eventId>.json`의 `whatIfContext`. R2 기록이 응답 뒤(waitUntil)라 방금 끝난 답이면 최대 ~1.2초 재시도. 근거 있는 답인데 요약이 없으면(예전 트레이스) 만들지 않고 `whatIf: null`. 근거 없음 답은 "어떤 근거가 있으면 답할 수 있는지" 프롬프트.
- 인증: 로그인 사용자의 질문(user_id 있음)은 **본인 세션만** (개인 업무 검색은 이쪽, hr_admin도 남의 것은 403). 익명 질문(HR 창만 가능)은 질문 때 쓴 `sessionId`를 `?sessionId=`로 보내야 한다 (상수 시간 비교). 평가 트레이스·없는 id는 404.
- 응답: `{ok:true, whatIf:"…"|null, ms, error?}`. 실패·시간 초과도 200 + `whatIf:null` (fail-open). 결과는 KV에 1시간 캐시 (재호출 시 LLM 안 부름).
- 트레이스 span `what_if`는 이 호출 때 `trace_spans`에 기록 (id `<eventId>:what_if`, `attrs.separate=true`).

### 실측 (로컬, cf-wrangler dev, Workers AI 원격)
| 항목 | 이전 (동기) | 이후 (분리) |
|---|---|---|
| HR "연차휴가는 며칠인가요?" 답 반환 | What-If 11.0s 포함 → 약 21s (이전 span start 21,208ms) | **답 total 4.07s, `whatIf` 필드 없음** |
| 그 What-If | 답에 포함 | 별도 호출 6.7s |
| HR 근거 없음 "동호회 활동비 지원 한도" | 답 3.5s + What-If 3.8s | 답 3.5s / What-If 별도 2.9s |
| 개인 "출장비 일비 기준은?" (tokB, 근거 없음) | — | 답 1.0s / What-If 별도 5.1s |

(이전 수치는 위 "로컬 검증" 절의 기록. 답 자체는 같은 파이프라인이라 답 시간은 What-If 만큼 줄어든다.)

### 로컬 검증 결과
- 답에 `whatIf` 없음, 답이 What-If를 기다리지 않음 — 확인.
- 익명 HR: 잘못된 sessionId → 403, 맞는 sessionId → 200 + 문장. 같은 호출 두 번째는 KV 캐시 (7ms, `cached:true`).
- 근거 없음(C5) 답: "…조항이 등록되어 있으면 답할 수 있습니다" 형태 문장 생성 — 확인.
- 개인 창: 익명 → 401, hr_admin(tokA, 소유자 아님) → 403, 소유자(tokB) → 200 — 확인.
- `what_if` span이 `trace_spans`에 별도 기록됨 — 확인.
- **직접 확인하지 못한 것**: (1) 브라우저 화면 — "불러오는 중…" → 채움/숨김 동작은 코드 검토만 했고 실제 브라우저에서 보지 않았다 (인라인 스크립트 구문 검사도 못 돌림, tsc는 html을 검사하지 않음). (2) What-If 호출이 실패·시간 초과일 때 응답 `whatIf:null` 경로는 이번 변경 후 재현하지 않았다 (이전 동기 방식에서 시간 초과·AI 인증 실패로 fail-open 확인한 코드를 그대로 옮겼다).

### 배포 전 남은 것
1. 브라우저에서 HR 창·개인 창 각 1건: 답이 먼저 뜨고 상자가 "불러오는 중…" → 문장으로 바뀌는지, 근거 없는 질문·전환 답에서 상자가 안 보이는지 확인.
2. 이전 트레이스(변경 전)에는 `whatIfContext`가 없어, 근거 있는 옛 답에 대해 호출하면 `whatIf:null`이 온다 (정상, 화면은 상자를 숨김).
3. 설명서·트레이스 상세 화면에서 What-If 문장은 이제 나오지 않는다 (`explain.whatIf` 제거). 설명서에서 What-If를 보이게 하려면 엔드포인트 결과를 저장하는 후속 작업이 필요.
4. 기존 `배포 후 라이브 확인` 목록의 What-If 항목은 "답이 먼저 뜬 뒤 상자가 채워지는지"로 바꿔서 확인.

---

## 배포 (2026-11-19)

**마이그레이션 0037**: `migrations list --remote`로 미적용 1건(0037)만 확인 → `d1 execute --remote --file migrations/0037_eval_role_check.sql -y` 성공 → `INSERT INTO d1_migrations(name)` 기록 → 재확인 "No migrations to apply". 원격 추적 상태 동기화됨.

**배포**: `cf-wrangler.py deploy` 성공. **Current Version ID: `7d0739f3-209c-4302-ae18-7a9db9f6291f`** (https://people-os.workspace-easyware.workers.dev). 정적 파일 6개 업로드, 크론 3개(`0 22`, `0 18`, `*/15`) 유지, `wrangler.toml` 안 건드림. GitHub 푸시 안 함.
**롤백 지점**: 직전 라이브 `c2ce46df` (녹음 삭제). 배포는 성공했으므로 롤백 불필요.

**라이브 확인 — 인증이 필요한 항목은 이 세션에서 못 했다**
이 세션에는 hr.jhkang 로그인 정보와 `ADMIN_SECRET` 파일 경로가 없고, 익명 `/api/ask`는 라이브에서 Turnstile 봇 확인이 켜져 있어 토큰 없이는 403이다. 자격증명을 찾으러 작업 폴더 밖을 뒤지지 않았다.

| 항목 | 결과 |
|---|---|
| HR 질문 (답 속도·`whatIf` 필드 없음·결정적 근거) | **미확인** — 익명 호출 403 "봇 확인이 아직 끝나지 않았습니다" |
| What-If 별도 호출 문장 | **미확인** (질문 이벤트를 만들 수 없음). 엔드포인트 존재만 확인: 없는 id → 404 `not found` (라우트 등록됨) |
| off-topic 차단 사유 줄 | **미확인** (같은 이유) |
| 개인 질문 전환 사유 | **미확인** (로그인 필요) |
| 설명서 발급 | **미확인** (관리자 인증 필요) |
| 평가 1회 (역할 일관성 열) | **미실행** — `POST /api/obs/evals/runs` 비로그인 401 "로그인이 필요합니다." 일일 한도 사용 안 함 |
| 새 화면 코드 배포 | 확인 — 라이브 `/` HTML에 `loadWhatIf`·`decisive-src` 포함 |

**남은 것**
1. 위 미확인 항목: 로그인한 브라우저에서 확인하거나, `ADMIN_SECRET` 경로/세션 쿠키를 주면 API로 확인.
2. 브라우저 화면 확인 (답 먼저 → "불러오는 중…" → What-If 채움, 설명서 새 창·인쇄, 평가 표 역할 일관성 열).
3. 크론 첫 실행(새벽 3시 KST = `0 18` UTC) 후 실행 시간 확인 (항목당 ask 2회 추가). 길면 `meta.eval_role_check_roles = off`.
