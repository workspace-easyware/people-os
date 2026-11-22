# 회귀 검증 라이브 후속 — 1차 세션의 미실시 7개 항목 (2026-11-21)

## 배경

1차 세션(Opus, `files/workflow-verify/regression-2026-11-21/RESULT.md`)은 로컬 검증만 통과하고 라이브 HTTP 검증이 권한 한계로 막혀 멈췄다. 원인은 `--add-dir`에 `~/workspace/user`가 없고 `curl *peopleos.site*` 규칙이 없던 것. **둘 다 지금 준비됐다**: `Bash(curl *peopleos.site*)`·`Bash(git log *)` 규칙을 settings.json에 추가했고, 이 세션은 `--add-dir`에 `~/workspace/user`를 포함해 시작한다.

## 1차 세션에서 확인된 것 (다시 하지 말 것)

- **로컬 통과**: 같은 큐 메시지 2번 → 메일 1통·외부 fetch 1회 (멱등성). P3 승인함 API — 남의 행 결정 404, 중복 승인 409·실행 1회, 거절 뒤 호출 0, GET 웹훅 지연 저장 400. legacy·think 지연 run 로컬 모의 성공 (2.2초 vs 2.7초), think 동기식 멈춤 → 승인 → 완료 후 메일 1통.
- **판단**: 10a legacy 프롬프트 지연 규칙 — 지금은 고치지 않음 (아래 5번 결과에 따라). 10b `executing` stuck 스윕 — 제출 전 불필요.
- 라이브 버전 출발점: People OS `483b32b8`, 편집 Worker `84973507`. 코드 수정·배포 없음. 라이브에 만든 것 없음 (읽기 쿼리만).
- 로컬 하네스 재사용 가능: `files/workflow-verify/regression-2026-11-21/harness/` (P3 하네스 사본 + `/h/dup`·`/h/dup-direct`·`/h/count`).

## 할 일 — 라이브 7개 항목

1. **관측 어시스턴트 목록 API**: `/api/obs/*` (X-Admin-Secret 필요)로 어시스턴트 턴 목록이 나오는지 확인한다. 시크릿은 `~/workspace/user/people-os-admin-secret.txt`에서 읽는다 — `S=$(cat <파일>); curl -H "x-admin-secret: $S" <URL>` 한 개씩 (한 명령에 curl 1개). D1에는 이미 `u_t3fx_r1`·`u_t3r` 2행, T2·T3·T3-FIXES 트레이스가 있다.
2. **실제 모델 legacy/think 3목표 비교**: 같은 워크플로우 목표 3개를 legacy와 think 런타임에서 라이브로 각각 실행해 비교한다. 기준은 `files/workflow-verify/think-full/T3-RESULT.md`(54초 vs 61초). 성공 여부·승인·발송 건수·소요 시간 + `wrangler tail` cpuTime을 기록한다.
3. **라이브 think 승인 경로 1회 (실제 발송)**: `send_email`을 고르는 목표를 think 런타임으로 라이브에서 1회 실행한다. 동기식 승인 경로(멈춤 → 결정 → 실행)가 끝까지 가고 메일이 실제로 발송되는지 확인한다. **수신자는 테스트 계정(mercer.jhkang@peopleos.site) 또는 사용자 본인(hr.jhkang@peopleos.site) 중 하나 — 외부 주소 금지.** 어느 주소를 썼는지 결과 파일에 적는다.
4. **화상회의·전사 큐 1회**: 회의 전사 파이프라인이 한 번 끝까지 가는지 확인한다. 건드리지 말 파일: `src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`.
5. **실제 Qwen 지연 문장**: Qwen이 지연 승인 상황에서 실제로 "대기열에 넣었다"는 취지의 문장을 내는지 확인한다. legacy 최종 답에 "보냈습니다"가 나오면 1차 세션의 10a 권고대로 think 규칙 (e)(`think-agent.ts:174`) 문장을 지연 모드일 때만 legacy SYSTEM_PROMPT에 덧붙이는 수정을 하고 배포·스모크한다. 안 나오면 10a는 "고치지 않음"으로 확정한다.
6. **라이브 테스트 대기 동작 run 1개**: 테스트용 지연 승인 run을 만들어 대기 동작 행을 쌓는다. **데모용 워크플로우 "지연 승인 시연 (데모용)"은 실행하지 않는다** (11-26 녹화용 초안). 테스트는 별도 워크플로우·별도 수신자로 만든다. **이 항목은 Merlin 브라우저 확인의 전제 조건이다 — 대기 동작 id·run id·상태를 결과 파일에 반드시 적는다.**
7. **T3-FIXES 라이브 확인 + Office 라우트 스모크**: LLM 캡 agent 사용량 합산·관측 llm_calls·duration·조사 자식 stop "completed"가 라이브에서 맞는지 확인한다. `/api/pptx/inspect`·`/edit`, `/api/xlsx/inspect`·`/edit`, `POST /api/docx/create` 스모크 + 기존 엔드포인트 바이트 동일 확인.

## 버그를 찾으면

작은 버그는 직접 고치고 배포까지 한다 (직렬로, 한 번에 하나씩, 배포 뒤 스모크는 3분 뒤). 고치기 어려운 버그는 결과 파일에 "미수정 + 원인 + 다음 단계"로 남긴다.

## 기록

- 같은 결과 파일에 이어 쓴다: `files/workflow-verify/regression-2026-11-21/RESULT.md` — "라이브 후속" 절을 추가하고, 항목별 통과/실패, 실패 원인, 고친 내용, 라이브 버전 전후, 남은 한계를 적는다.
- **새 증거 파일은 처음부터 `files/workflow-verify/regression-2026-11-21/evidence/` 안에 만든다. `mv`로 옮기지 말 것** (`mv`는 -p 세션에서 막힌다).
- 커밋에서 뺄 것: `harness/state/`, `harness/dev.log`, `harness/sess-*.json` (로컬 전용 세션 토큰).

## 시험 데이터·정리

- 임시 계정·세션·문서·run은 끝나면 전부 지우고, 확인 쿼리 결과를 결과 파일에 적는다. 단, **6번의 테스트 대기 동작은 지우지 않는다** — Merlin이 브라우저로 승인함 클릭 확인을 한 뒤에 정리한다 (id를 결과 파일에 적어 두면 Merlin이 확인 뒤 지운다).
- 데모 핵심 암묵지 문서 `doc_mweyu70u_477s8v`, T2·T3 시험 흔적, "지연 승인 시연 (데모용)" 초안은 건드리지 않는다.

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- `node <스크립트>`가 막히면 실험은 `wrangler dev` 라우트로 돌린다.
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다.
- 커밋·태그는 Merlin이 한다.
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·배포된 버전을 짧게 요약한다.
