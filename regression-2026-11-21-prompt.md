# 11-24 회귀 검증 — 앞당겨 실시 (2026-11-21, 사용자 지시 "우선 진행하자")

## 목표

공모전 제출(11-27) 전 회귀 검증을 11-24에서 오늘(11-21)로 앞당겨 실시한다. 라이브 상태를 확인하고, 나온 버그를 고치고, 결과를 기록한다. 문서 업데이트(ARCHITECTURE.md·VERIFICATION.md·다이어그램)는 회귀·수정 뒤에 Merlin이 따로 한다 — 네가 할 일이 아니다.

## 현재 라이브 상태 (출발점)

- People OS: **`483b32b8`** (워드 표 고치기 포함). 편집 Worker `people-os-pptx-editor`: **`84973507`**.
- Git HEAD: `fee589e`, 태그 `docx-table-fix-v1`.
- 오늘 라이브 확인됨: PPTX 편집(PowerPoint 열림), 엑셀 편집(Excel 열림), 워드 생성 + 표 고치기(Word 열림, 표 3건 확인).

## 할 일 — API·서버 측 회귀 (네가 할 일)

아래를 순서대로 확인하고, 실패한 항목은 원인을 찾고 고친다. 작은 버그는 직접 고치고 배포까지 한다 (직렬로, 한 번에 하나씩, 배포 뒤 스모크는 3분 뒤). 고치기 어려운 버그는 결과 파일에 "미수정 + 원인 + 다음 단계"로 남긴다.

1. **관측 "어시스턴트" 하위 탭**: `/api/obs/*` (X-Admin-Secret 필요)로 어시스턴트 턴 목록이 나오는지, T3·T3-FIXES 시험 흔적(트레이스 6건 + assistant_turns `u_t3fx_r1`, T2 흔적 `wf_asst_u_t2r_t1_1`)이 그대로 있는지 확인한다. **시험 흔적은 삭제하지 않는다** (사용자 결정 "그대로 둬").
2. **agent 노드 legacy/think 비교**: 같은 워크플로우 목표 3개를 legacy와 think 런타임에서 각각 실행해 결과를 비교한다. 기준은 `files/workflow-verify/think-full/T3-RESULT.md`의 기준선(같은 워크플로 성공, 54초 vs 61초)이다. 성공 여부·승인·발송 건수·소요 시간을 기록한다.
3. **같은 큐 메시지 2번**: workflow-step 큐에 같은 메시지를 2번 넣어 중복 실행이 안 되는지 (멱등성) 확인한다.
4. **승인 경로 라이브 think 1회**: `send_email`을 고르는 목표를 think 런타임으로 라이브에서 1회 실행한다. 동기식 승인 경로(멈춤 → 결정 → 실행)가 끝까지 가는지, 메일이 실제로 발송되는지 확인한다. 수신자는 **테스트용 주소**를 쓴다 (실제 사용자·mercer 주소 금지).
5. **화상회의 V0~V2·전사 큐 1회**: 회의 전사 파이프라인이 한 번 끝까지 가는지 확인한다 (`enable_ctx_exports` 플래그가 추가된 뒤). 건드리지 말 파일: `src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js`.
6. **P2 실제 모델 지연 문장**: Qwen이 지연 승인 상황에서 실제로 "대기열에 넣었다"는 취지의 문장을 내는지 확인한다 (지금까지 미확인). 안 되면 프롬프트·문구 중 어디가 문제인지 결과 파일에 적는다.
7. **P3 승인함 API 측**: 테스트용 지연 승인 run을 1회 만들어 대기 동작 행을 쌓는다. **데모용 워크플로우 "지연 승인 시연 (데모용)"은 실행하지 않는다** (11-26 녹화용 초안이다 — 건드리지 말 것). 테스트는 별도 워크플로우·별도 수신자로 만든다. 확인할 것: `GET /api/workflows/pending-actions` 목록, `POST .../decide` 승인 → 실제 실행(메일 발송 또는 웹훅 호출) 확인, 중복 승인 1회 실행, 남의 행 결정 거부(hr_admin은 본인 것만), 거절 뒤 행 상태, GET 웹훅 지연 저장 거부.
8. **T3-FIXES API 측**: LLM 캡 agent 사용량 합산(26+4=30 뒤 #27 막힘), 관측 llm_calls·duration 표시, 조사 자식 stop "completed"가 라이브에서 여전히 맞는지 확인한다.
9. **PPTX·엑셀·워드 API 측**: 편집·생성 라우트 스모크 — `/api/pptx/inspect`·`/edit`, `/api/xlsx/inspect`·`/edit`, `POST /api/docx/create`가 라이브에서 동작하는지, 기존 엔드포인트가 바이트 동일한지 확인한다. (화면 패널·diff 표는 Merlin이 브라우저로 따로 확인한다.)
10. **판단 2건** (고칠 게 있으면 고치고, 아니면 판단 근거를 결과 파일에 적는다):
    - legacy agent 프롬프트에 지연 규칙이 필요한가?
    - `executing` stuck 행 정리 스윕이 필요한가?

## 할 일이 아닌 것 — Merlin이 브라우저로 따로 확인

- 에이전트 화면 클릭 (메뉴 순서, 메시지→진행 기록 2초 갱신→답, 대화 지우기, 워크플로 agent 상세·승인 대기 배지→결재함 링크, 코칭 대상 계정 메뉴 표시)
- 대시보드 Observability→Traces/Agents 스팬
- P3 승인함 화면 클릭 (체크박스·전체 선택·일괄 승인/거절, run 상세 배지, 거절 행 표시, 남의 행 버튼 숨김, 편집기 승인 방식 선택)
- 에이전트 화면 답 스트리밍, 조사 중 진행 줄 간격, 알림 벨
- PPTX·엑셀·워드 편집/생성 화면 (패널·diff 표)
- 네가 7번에서 만든 테스트 대기 동작은 이 브라우저 확인의 전제 조건이 된다 — 결과 파일에 대기 동작 id·run id·상태를 적어 둔다.

## 시험 데이터·정리

- 임시 계정·세션·문서·run은 끝나면 전부 지우고, 확인 쿼리 결과를 결과 파일에 적는다 (docx 표 고치기 세션 방식: users·auth_sessions·documents·doc_nodes·chunks 0건).
- 데모 핵심 암묵지 문서 `doc_mweyu70u_477s8v`, T2·T3 시험 흔적, "지연 승인 시연 (데모용)" 초안은 건드리지 않는다.
- 샘플 문서·전사 실험 문서·C5P3 테스트·S3 덱 정리는 11-25 작업이다 — 지금 하지 않는다.

## 검증·보고

- `npx tsc --noEmit` 오류 0. 로컬은 `wrangler dev --local`로 끝까지 돌린다.
- 배포는 직렬로, 한 번에 하나씩 (People OS·편집 Worker 둘 다 해당). 배포 뒤 스모크는 **3분 뒤**.
- `wrangler tail`로 cpuTime을 재고 결과 파일에 적는다.
- 결과 파일: `files/workflow-verify/regression-2026-11-21/RESULT.md` — 항목별 통과/실패, 실패 원인, 고친 내용, 라이브 버전 전후, 남은 한계. 근거는 같은 폴더의 `evidence/`에 둔다.
- 커밋·태그는 Merlin이 한다.

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- `node <스크립트>`가 막히면 실험은 `wrangler dev` 라우트로 돌린다.
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다.
- 참고 파일: `files/workflow-verify/think-full/T3-RESULT.md`, `T3-FIXES-RESULT.md`, `files/workflow-verify/async-approval/P1-RESULT.md`, `P2-RESULT.md`, `P3-RESULT.md`, `files/workflow-verify/docx-table-fix/RESULT.md`.
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·배포된 버전을 짧게 요약한다.
