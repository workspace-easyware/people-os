# 발표자료 구현 O-C — Opus 5.5 (에이전트 활동 타임라인 A1)

## 너의 역할
너는 구현 세션이다. 계획 문서 `presentation-plan.md`의 6장 분할표에서 **O-C (A1만)** 를 구현한다. A2(에이전트 제안 승인 큐)는 조건부라 이번에 하지 않는다. 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `presentation-plan.md` 3장(Agentic 개념 보강 분석 — 3.1 약한 점, 3.2 A1 보강안), 6.2(A1 홈 카드 계약 — `agentActivityCard(el)`), 6.1(O-C 행).
- 기존 테이블 스키마: `migrations/` (recordings, ask_events, emails, digest_runs, eval_runs, knowledge_gaps). 각 테이블의 소유자 컬럼을 직접 확인한다 (`ask_events`의 사용자 컬럼은 0021에서 추가된 것으로 보이나 컬럼명까지 확인 안 됨 — 코드에서 확인한다).
- 기존 패턴: `src/index.ts` (mount 위치), `public/email.js` (홈 카드 렌더링 선례).

## 구현할 것 (O-C A1 범위)
1. **`src/agent/activity.ts`** (신규) — `GET /api/agent/activity`: 기존 테이블을 **읽기만** 한다 (마이그레이션 없음). "에이전트가 최근에 한 일"을 한 목록으로: 녹음 파이프라인 단계(`recordings`), 질문 처리(`ask_events`), 메일 답장 초안(`emails.ai_draft_at`), 아침 다이제스트(`digest_runs`), 평가 실행(`eval_runs`), 지식 공백 기록(`knowledge_gaps`). 항목마다 "무엇을 · 언제 · 결과 · 사람 확인 필요 여부".
2. **`src/index.ts`** (import + mount 2줄만) — **편집 직전에 파일을 다시 읽어라.** 다른 세션이 mount를 넣고 있을 수 있다.
3. **`public/agent-activity.js`** (신규) — 홈 카드 렌더 함수 `agentActivityCard(el)`: `el` 안에 목록을 그린다. 익명이거나 API가 404/503이면 `el`의 부모 카드를 숨긴다.

## 소유자 격리 (가장 중요 — 실수가 곧 정보 유출)
- 일반 사용자는 자기 것만 본다. HR 관리자는 전체를 본다. 평가·다이제스트 같은 시스템 항목은 HR 관리자에게만 보인다. 각 테이블의 소유자 컬럼을 코드에서 확인하고, 소유자 컬럼이 없는 테이블은 HR 관리자에게만 보인다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로 로그인 쿠키를 달고: 일반 사용자는 자기 활동만, HR 관리자는 전체 + 시스템 항목이 보이는지 확인. 익명은 401인지 확인. 스키마 없는 테이블이 있으면 건너뛰는지 확인.
- 검증 스크립트나 하네스는 `files/agent-verify/` 아래에 둔다. `/tmp` 금지.

## 제약
- O-C 파일만 만든다/고친다: `src/agent/activity.ts`, `src/index.ts`(mount 2줄만), `public/agent-activity.js`, `files/agent-verify/**`. A2 파일(`src/agent/actions.ts`, `migrations/0025_agent_actions.sql`)은 만들지 마라. `public/index.html`은 건드리지 마라 (S-B가 홈 카드 자리를 만든다).
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, 소유자 격리 검증 결과, 로컬 검증 결과를 적어라.
