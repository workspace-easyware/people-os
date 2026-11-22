# reasoning_effort medium → low 변경 결과 (2026-11-20 오후, Sonnet 5.5 세션 + Merlin 배포)

## 판정

| 항목 | 결과 |
|---|---|
| 코드 변경 | ✅ `src/ask-pipeline.ts:1000` 한 줄만. What-If(589번 줄)는 원래 low, `index.ts`·`nodes.ts`·`agent-do.ts`·`tree.ts`는 건드리지 않음 |
| `npx tsc --noEmit` | ✅ 오류 0 |
| 배포 | ✅ `307cf8b6-d2c5-46be-9564-ead4977fefe9` (2026-11-20 13:07 KST), `AGENT_RUNTIME=legacy` 유지 |
| 골든셋 평가 | ✅ `run_df07177b374b43c4` **6/6 통과, avgJudge 0.8167** |
| legacy 스모크 | ✅ 홈 200(138,237 B)·`/api/agents/me` 401·`/api/workflows/templates` 401 — 배포 전과 동일 |

## 배포 과정 특이사항

Sonnet 세션은 코드는 바꿨지만 배포하지 못했다 — `-p` 세션에서 `cf-wrangler.py deploy`가 "This command requires approval"로 막혔다. 배포는 Merlin이 직접 실행했다. 세션은 결과 파일도 쓰지 못했다(같은 권한 문제로 보임) — 이 파일은 Merlin이 작성했다.

## 골든셋 평가 상세 (`run_df07177b374b43c4`, 프롬프트 v5 `pv_086c7a84faaa4d19`)

| 문항 | judge | 전체 시간 | LLM 스팬 |
|---|---|---|---|
| gi_s03_leave_3days | 0.8 | 17.3초 | 15.9초 |
| gi_s04_leave_accrual | 0.8 | 40.8초 | 39.4초 |
| gi_s05_tacit_maternity_remote | 0.9 | 15.0초 | 13.8초 |
| gi_s07_hwpx_scope | 0.7 | 7.1초 | 6.0초 |
| gi_s10_training_support | 0.8 | 8.6초 | 7.4초 |
| gi_s11_travel_expense | 0.9 | 9.9초 | 8.7초 |
| **평균** | **0.8167** | **16.4초** | **15.2초** |

- **s04는 0.8로 통과** — low에서 0.7 턱걸이였던 전례와 달리 0.7이 아니다. 다만 LLM 39.4초로 6문항 중 가장 느리다 (질문 자체가 길어 reasoning을 줄여도 줄지 않는 부분). **내일 새벽 03:00 자동 평가에서 s04를 특히 볼 것.**
- medium 기준선(run_33db237d37c24e15, v5): 6/6, avgJudge 0.8667. low는 평균이 0.05 낮지만 6/6 유지, 채점 흔들림 범위 안으로 본다.
- medium/low 1회 측정값(70.2초/6.0초)은 배포 직후 라이브 1회 측정값이지 평가 평균이 아니다. 평가 항목별 실측 medium 평균 21.1초, low 평균 15.2초 — 속도는 질문이 좌우하고 reasoning 설정은 상한만 정한다.

## 커밋

- 커밋·태그는 Merlin이 직접 (이 파일 포함).
