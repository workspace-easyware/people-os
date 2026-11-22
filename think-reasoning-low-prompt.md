# reasoning_effort medium → low 변경 (ask 답변 경로만)

## 개요

사용자 결정 (2026-11-20 13:05 KST): HR 질문 답변의 `reasoning_effort`를 medium → low로 바꾼다.
**이 세션의 모델은 Sonnet 5.5 하나다. 세션 도중 모델을 바꾸지 않는다.**

- **시작 상태 (2026-11-20 13:05 KST, Merlin이 직접 확인)**: HEAD `97f3f60` (T2 커밋, 태그 `think-t2`). 라이브 배포 `ad64158d`, `AGENT_RUNTIME=legacy`.
- **이미 설치됨**: wrangler **4.165.0** (정확히 고정). **`compatibility_date`는 올리지 않는다** (`2025-07-18` 유지).

## 할 일 (정확히 한 곳만 바꾼다)

**바꿀 곳: `src/ask-pipeline.ts`의 주 답변 호출 1곳** — `runAsk` 안에서 `env.AI.run(LLM_MODEL, { reasoning_effort: "medium", messages: promptMessages }, ...)` (태그 `"ask"` / `"eval-ask"`, 현재 약 1000번 줄). `"medium"` → `"low"`로 바꾼다.

**바꾸지 말 것 (다른 기능의 호출이다)**:
- `src/ask-pipeline.ts` 약 589번 줄 What-If 호출 — 이미 `"low"`이다.
- `src/index.ts` 약 761번 줄 회의 전사본 요약, `src/workflow/nodes.ts` 5곳(워크플로 LLM·요약·리플렉션·메일 초안 노드), `src/workflow/agent-do.ts` 171번 줄(legacy workflow agent), `src/tree.ts` 215번 줄(트리 digest) — 전부 `"medium"` 그대로 둔다.

## 배경 (참고용 수치, 재측정하지 않는다)

- low 배포 `e73c1b61`: 골든셋 6/6, avgJudge 0.8333, LLM 약 6.0초.
- medium 배포 `4f4d63db`: 골든셋 6/6, avgJudge 0.8667, LLM 약 70.2초.
- 라이브 트레이스 `evt_mwo7js0h_4zmp76` (medium, 2026-11-20 08:55): 전체 18.0초, LLM 스팬 9.1초, grounded, judge 0.7.
- **주의: s04(`gi_s04_leave_accrual`)가 low에서 0.7 턱걸이였던 전례가 있다.** 이번 검증 실행에서 s04 점수를 따로 보고하고, 내일 새벽 03:00 자동 평가에서 s04를 특히 봐야 한다는 것을 결과 파일에 적어 둔다.

## 검증

1. `npx tsc --noEmit` 오류 0.
2. `cf-wrangler.py`로 배포 (직렬, `AGENT_RUNTIME=legacy` 유지). 배포 버전 ID를 기록한다.
3. **골든셋 평가 1회만 실행한다** (`POST /api/obs/evals/runs` + `X-Admin-Secret`, 시크릿은 `~/workspace/user/people-os-admin-secret.txt`에서 읽기만 하고 값은 절대 출력하지 않는다). **오늘 수동 평가 한도 5회 중 4회를 이미 썼다 — 이 1회가 마지막이다. 점수 올리기용 재실행은 금지.**
4. LLM 시간 측정: 평가 결과 각 문항의 트레이스에서 `llm` 스팬 시간을 읽어 보고한다 (라이브 HR 질문은 Turnstile 때문에 curl로 할 수 없으므로, 평가 트레이스의 llm 스팬이 측정 근거다. 라이브 브라우저 질문 확인이 필요하면 Merlin이 사용자에게 맡긴다).
5. legacy 라이브 스모크 (workers.dev 경유, 로그인 없이 볼 수 있는 범위): 홈·로그인·질문(403 Turnstile)·템플릿·채팅·결재함·LMS·관측·meet.js — 배포 전과 동일.

## 제약

- **배포는 직렬로.** 다른 세션과 동시 배포 금지. 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py`를 직접 실행한다 (`python3` 경유 금지).
- `curl *peopleos.site*`는 허용 규칙에 없어 승인 카드가 뜬다. **라이브 확인은 workers.dev 경유** (`https://people-os.workspace-easyware.workers.dev`)로 한다.
- 비밀번호·토큰·시크릿은 채팅·파일에 적지 않는다.
- **커밋·태그는 하지 않는다.** `git add`가 이 세션에서 승인 대기로 막힐 수 있다. 커밋·태그는 Merlin이 직접 한다. 파일 작업만 마치고 보고한다.
- 배포 후 라이브에 회귀가 보이면 즉시 보고하고, 지시 없이 되돌리지 않는다 (롤백은 Merlin이 판단한다).

## 결과 파일

`files/workflow-verify/think-full/reasoning-low-RESULT.md`에 적는다: 바꾼 곳(파일·줄), 배포 버전 ID, 골든셋 평가 결과(실행 ID·통과율·평균·문항별 judge 점수 — s04 따로 표시), 문항별 llm 스팬 시간, 스모크 결과, 03:00 자동 평가에서 s04를 볼 것.

## 보고

마지막에 보고할 것: 배포 버전 ID, 라이브 LLM 시간(평가 트레이스 기준), 골든셋 결과(통과율·평균·특히 s04).
