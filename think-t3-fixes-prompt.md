# T3 남은 문제 6개 수정 프롬프트 (Opus 5.5 단일 세션)

## 배경

T3 완료(2026-11-20, 커밋 `8880010`, 태그 `think-t3`) 뒤 남은 마이너 6개를 지금 고친다. 동결은 11-25. 현재 HEAD `a289eee`(데모 결정 반영 커밋), 라이브 버전 `f6954a89`. **먼저 `files/workflow-verify/think-full/T3-RESULT.md`의 "남은 문제" 1~6번을 읽는다** — 아래 각 항목의 정확한 재현·원인·힌트가 거기에 있다. T1-RESULT·T2-RESULT의 관련 주의사항도 함께 읽는다.

## 고칠 6개

### 1. 엔진 run 30회 LLM 캡이 agent 뒤 LLM 노드에서 agent 사용량을 세지 않는다
- T3-RESULT 8번 재현: llm 26 + agent 4 = 30 뒤에도 llm 노드 #27이 실행됐다. 엔진의 `LLM 호출 상한` 검사(8번)가 `LLM_NODE_TYPES` 단계 수만 센다.
- 고치는 방향: engine.ts 8번 검사에 `priorLlmCalls()`(agent turns 포함)를 써서 agent 뒤 LLM 노드도 agent 사용량을 합산하게 한다.
- **주의: 엔진 수정이다.** 동기식·지연(agent 포함) 경로 회귀를 함께 확인한다. P1~P3 대기 동작 코드(`pending-actions.ts`, 큐 소비자)는 건드리지 않고, 지연 run이 여전히 동작하는지 하네스에서 확인한다.

### 2. 토큰 단위 스트리밍 없음
- 지금은 스텝 단위 진행만 보이고 긴 답은 턴이 끝날 때 한 번에 보인다.
- 고치는 방향: Think `runTurn`의 스트림 모드를 써서 토큰 단위로 SSE로 흘려보내고, 에이전트 화면에서 이어 붙여 보여준다. 2초 폴링은 폴백으로 유지한다(스트리밍이 안 되면 기존 동작 그대로).
- **판단 기준: 프런트+백엔드+폴백까지 깨끗하게 안 되면 이 항목은 건드리지 말고 결과 파일에 "미완 — 이유·필요 작업"으로 적는다. 백엔드만 스트림하고 화면은 안 받는 식의 반만은 금지.**

### 3. 판단 근거(thinking)가 영어
- 어시스턴트·워크플로 agent 둘 다 실제 실행에서 영어로 나왔다("According to rule (g)…", "Goal: …"). 화면에는 "판단 근거:"로 그대로 보인다.
- 고치는 방향: 시스템 프롬프트에 한국어 사고 지시를 넣어 실제 실행에서 한국어 thinking이 나오는지 확인한다.
- **Qwen이 지시를 안 따르면 억지로 번역기를 붙이지 말고 결과 파일에 "미완 — 모델이 지시를 안 따름"으로 적는다.** 화면의 "판단 근거:" 표시는 그대로 둔다.

### 4. 관측 llm_calls·duration 표시 오차
- (a) 워크플로 run 관측의 agent `llm_calls`는 turns 길이(모델 스텝)라 LLM 도구 호출을 빼고 센다 — think run 실제 3, 관측 2였던 케이스. **Think run 출력의 `llmCalls`를 써서 정확히 센다.**
- (b) think agent 단계의 `duration_ms`가 63 ms로 나온다 — 엔진이 점유 해제(`release`) 때 단계 `started_at`을 깨움 메시지 처리 시각으로 다시 찍기 때문. **단계 실제 시간은 `workflow_agent_steps.created_at`→`updated_at`으로 계산해 표시한다.**
- 둘 다 표시만 고치고 한도 판정은 건드리지 않는다.

### 5. 조사 자식 max_steps 표시
- 자식이 4스텝째에 정리를 쓰고 끝났는데 `stop: max_steps`가 남았다(4스텝째 = 상한 4). "3스텝 안에 끝내라"는 프롬프트와 상한 4의 관계가 어긋난 것.
- 고치는 방향: 자식이 요약으로 끝낸 턴은 `stop`을 `completed`로 기록하게 한다(마지막 스텝이 상한과 같아도, 자식이 스스로 끝냈다면 max_steps가 아니다). 또는 상한을 5로 올리고 프롬프트는 3스텝 유지 — 어느 쪽이든 실제 실행으로 확인하고, 결과 파일에 선택 이유를 적는다.

### 6. 조사 중 진행 로그 정체
- 실제 턴 184초(자식 4스텝 + ask_rag 3회) 동안 화면에 "조사 하위 에이전트에 위임" 다음 줄이 3분간 안 바뀐다. 자식 진행이 부모 이벤트에 안 보인다(`eventDelivery: "terminal"`).
- 고치는 방향: 부모 턴에 자식 진행을 주기적으로 보여준다 — 자식 스텝 완료마다 부모 이벤트로 전달하거나, 최소한 15~30초 간격으로 "조사 중 (N스텝 진행)" 같은 진행 이벤트를 보낸다. 2초 폴링이 도는 동안 화면이 멈춰 보이지 않게 하는 것이 목표.

## 통과 기준

1. `npx tsc --noEmit` 오류 0 + 바뀐 `public/*.js`는 `node --check` 오류 0.
2. **하네스** (새 폴더 `files/workflow-verify/think-full/t3-fixes-harness/`, T3 하네스 패턴 재사용 — 실제 모델이 필요한 검증은 T1 방식의 원격 시험 Worker로): 고친 항목마다 실제 실행으로 확인한다.
   - 1번: llm 26 + agent 4 = 30 뒤 llm 노드 #27이 막히는지. 동기식·지연 run 회귀(지연 run이 여전히 대기 동작을 만들고 승인 뒤 실행되는지)도 함께.
   - 2번(고쳤다면): 토큰이 턴 종료 전에 SSE로 도착하는지 + 폴링 폴백이 살아 있는지.
   - 3번(고쳤다면): 실제 턴의 thinking이 한국어로 나오는지.
   - 4번: agent `llm_calls`가 Think 출력과 일치하는지(3이면 3), think 단계 duration이 실제 시간(~수십 초)으로 표시되는지.
   - 5번: 자식이 요약으로 끝낸 턴의 `stop`이 `completed`인지.
   - 6번: 조사 위임 뒤 30초 안에 진행 이벤트가 오는지.
   - **미완으로 남긴 항목은 하네스에서 "미완"으로 적고, 억지로 통과시키지 않는다.**
3. 라이브 배포 + 스모크: 배포 전후 기존 엔드포인트 응답이 의도한 변화 외에는 같아야 한다. 홈 HTML은 의도한 변화 외에는 같다. 배포 직후 약 2분은 옛 버전이 응답하니 스모크는 3분 뒤에 한다.
4. 결과 파일 `files/workflow-verify/think-full/T3-FIXES-RESULT.md` 작성: 항목별 판정 표(고침/미완), 고친 것의 증거, **미완인 항목은 이유와 필요 작업(규모·위험)을 명시**, 라이브 버전·스모크 결과, 남은 문제, 11-24 회귀 검증에 넘길 것.

## 건드리지 말 것

- **`public/approval.js`(결재함)·`public/chat.js`·`public/meet.*`·`src/meet/*`·`src/chat/*`**: 건드리지 않는다.
- **`src/ask-pipeline.ts`·평가 runner·프롬프트 v5**: 03:00 자동 평가 경로다. 건드리지 않는다.
- **P1~P3 대기 동작 코드** (`pending-actions.ts`, 큐 `workflow-action` 분기, `public/workflow.js`의 대기 동작 섹션): 1번의 엔진 수정이 이 경로를 깨지 않는지 확인만 한다.
- **마이그레이션은 되도록 만들지 않는다.** 꼭 필요하면 결과 파일에 이유를 적고 만든다.
- **동기식 승인 경로·승인 게이트·한도 숫자(30회·10스텝·20회·28분·일일 30턴)**: 바꾸지 않는다. 표시·합산만 고친다.

## 작업 방식·주의사항 (검증된 교훈 — 반드시 지킬 것)

- **커밋·태그는 하지 않는다.** Merlin이 직접 한다. `git add`도 세션에서 막히니 시도하지 않는다.
- **배포**: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 **절대 경로로 직접 실행**한다 (python3 경유·env 접두어 금지). "This command requires approval"로 막히면 우회하지 말고 Merlin에게 보고하고 멈춘다. `cd <dir> && cf-wrangler.py ...`가 승인 대기로 막히면 `--config <절대 경로>`를 넘겨 cd 없이 실행한다. 배포는 직렬로만 한다.
- **로컬 검증**: `npx wrangler dev --local`은 `--local`이 `dev` 바로 뒤에 와야 한다. 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/..."`로 한 URL씩. 셸 반복문(`for`/`until`)/포그라운드 `sleep`은 승인 대기로 막히니, 긴 대기는 `sleep N`을 백그라운드로 돌리고 깨어난 뒤 curl 1회로 확인한다. 셸 변수·`tee`·`sort`·`diff` 파이프는 막히니 값을 명령에 직접 쓴다. 예외: `S=$(cat <비밀 파일>); curl -H "x-admin-secret: $S" <URL>` 한 개는 된다. `node <스크립트>`·`git diff`·`| tee`도 승인 대기로 막힌다. 되는 것: `node --check`, `cmp`, 단독 `diff`.
- **비밀**: `X-Admin-Secret` 값은 `~/workspace/user` 안의 비밀 파일에서 읽는다 (`--add-dir /home/hatch/workspace/user`를 함께 줬다). 값을 채팅·파일·커밋에 적지 않는다.
- **복구 턴 주의**: 부작용 도구에 멱등 키, 상한·캡은 DO 누적값, submissionId 기준 연결. Think 기본 도구 7개가 섞여 들어오니 `activeTools`로 좁힌다.
- **tail JSON은 들여쓰기가 있다**: `"outcome": "ok"`처럼 콜론 뒤에 공백이 있다.
- 결과 파일에 커밋에서 뺄 파일 목록(하네스 state·dev.log·dry-run 산출물)을 적어 둔다.
