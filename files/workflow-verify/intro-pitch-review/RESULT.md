# 소개·발표자료 20건 수정 결과 (2026-11-23, 이어하기 세션)

상태: **편집·tsc 완료, 배포 보류** (아래 "배포 보류 사유"). 라이브 스모크 미실시. 최신 라이브 버전은 여전히 `e6fed297`.

## 항목별 대조 결과 (현재 파일 기준)
| # | 상태 | 고친 문구 / 위치 |
|---|---|---|
| 1 | 완료 | "메인 Worker 하나 + 문서 편집 전용 Worker 하나" — pitch-content 히어로 H1, 키카드 1, §06 제목·lead(+`DOC_EDITOR` 서비스 바인딩 단락 추가), §09 alt·항목 2, §10 Workers 행 / index.html 소개 히어로·"무엇인가요"·"어떻게 만들었나요". `architecture.svg:102` 주석의 "Worker 하나"는 화면에 안 보이는 주석이라 둠 |
| 2 | 완료 | DO "여덟 개": §07 문장·표(ThinkAgent·AssistantAgent·DocJobRunner 행 추가), §09, §10 표(모두 8개). `wrangler.toml` class_name 8개와 일치 |
| 3 | 완료 | "19종(도구 노드 17종 + 에이전트 + 조건 분기)" + 문서 편집·Word 노드 예시 |
| 4 | 완료 | "워크플로우 화면의 '대기 동작'에서" (§04 장면 4, §08 승인 게이트, DEMO-SCRIPT 나레이션). "승인함" grep 0건 |
| 5 | 완료 | §08 한계 callout: 에이전트 노드(최대 10스텝) + 내 어시스턴트(6도구, 하루 30턴) |
| 6 | 완료 | `migrations/ (0001~0046)` — 파일 46개, 최신 0046_task_lists.sql 확인 |
| 7 | 완료 | 소개 목록에 에이전트 항목 추가 |
| 8 | 완료 | 할 일: 목록·하위 작업·반복·별표, 기한 달력 표시, 즉시 반영 |
| 9 | 완료 | 캘린더: 구글 읽고 쓰기 연동, 기한 있는 할 일 표시 |
| 10 | 완료 | 녹음전사·문서저장: Plaud 가져오기, PPTX·엑셀·Word 새로 만들기·편집 |
| 11 | 완료 | 라이브러리: 카드를 누르면 전문 전체 화면 |
| 12 | 완료 | 채팅·알림: "채팅방에서 영상 통화를 시작합니다." (단정 안 함). §12 미확인에 "화상회의 실제 통화 1회" 추가 |
| 13 | 완료 (명세서 정정) | 모듈 목록에 에이전트(어시스턴트)·화상회의·할 일 추가. **큐는 "3개"가 맞다**: `wrangler.toml`에 producers/consumers 3쌍(`people-os-pipeline`, `people-os-docx-jobs`, `people-os-doc-jobs`)과 DLQ `people-os-pipeline-dlq` 하나(셋이 공유). 명세서의 `workflow-step`은 별도 큐가 아니라 `PIPELINE` 큐의 메시지 type이다 (`src/workflow/engine.ts:66`, `src/index.ts:3087`). 그래서 "4개"가 아니라 "3개 + 공용 DLQ"로 썼다 |
| 14 | 완료 | §12: Turnstile 제거, 채팅 송수신(2개 창)·화상회의 통화 1회로 좁힘. AI Gateway·외부 메일 수신 유지 |
| 15 | 완료 | Turnstile 행: "코드 있음 · 키 설정됨, `/api/ask` 적용" |
| 16 | 완료 | architecture.svg: DocJobRunner, Queues 3개 상자(+docx-jobs·doc-jobs), DO 8종, desc·날짜, 높이 1500 (alt·img height 맞춤) |
| 17 | 완료 | §13 peopleos.site 첫 번째 + workers.dev 부기, DEMO-SCRIPT 녹화 URL 통일 |
| 18 | **미확인(그대로 둠)** | "심사용 계정 안내는 제출 폼에 적었습니다" — 문장 변경 안 함. 11-27 제출 전 폼 초안에 계정 안내가 실제로 있는지 확인 필요 |
| 19 | 완료 | "동기식이면 승인 대기에서 멈추고, 지연식이면 대기 동작에 쌓아두고 실행은 계속" (소개 카드 + 이번 세션에 워크플로우 항목에도 같은 취지 반영) |
| 20 | 완료 | DEMO-SCRIPT 체크리스트 3건 (템플릿 5개, 지연 승인 준비 완료 `[x]`, 채팅 패널 확인됨/2창 미확인) |

## 검증
- `npx tsc --noEmit`: 0건.
- 코드 대조: DO 8(class_name 8), 노드 19(명세서 근거 types.ts), 마이그레이션 0046(46개), 큐 3+DLQ.
- 금지 영역: `src/`·`migrations/`·`public/pitch.js`·메일 편집기 파일·`decisions-2026-11-22/h/` 이번 세션에서 수정 안 함.

## 배포 보류 사유
`cf-wrangler.py deploy`는 작업 트리 전체를 올린다. 지금 트리에는 다른 채팅의 **미커밋 작업**이 섞여 있다.
- 메일 서식 편집기: `public/email.css`, `email.js`, 신규 `email-rt.js`, 그리고 `public/index.html`의 편집기 툴바 마크업(내 소개 편집과 같은 파일).
- Plaud mp3: `src/index.ts`(+126행), `src/plaud/routes.ts`, 신규 `src/mp3.ts`, `public/plaud.js`.
배포하면 이 미검증 작업이 11-25 동결 전 운영에 같이 나간다. 사용자가 이미 "미커밋, 다른 채팅 작업"이라 구분해 둔 것이라 임의로 올리지 않았다. 롤백 기준 버전은 `e6fed297`.

선택지: (a) 위 작업이 끝났거나 같이 나가도 되면 그대로 배포, (b) 해당 채팅이 먼저 커밋·배포, (c) 소개 파일만 별도 작업 트리에서 배포.
배포 명령: `/home/hatch/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy` (약 3분 뒤 스모크: 소개·발표자료 200, "여덟 개"·"19종"·"대기 동작"·peopleos.site 확인).

## 커밋 대상 (Merlin이 직접)
`DEMO-SCRIPT.md`, `public/architecture.svg`, `public/pitch-content.html`, `public/index.html` — 단 index.html은 메일 편집기 hunk(툴바 + `email-rt.js` 스크립트 줄)가 섞여 있으니 `git add -p`로 소개 hunk만 담을 것.
커밋 메시지 제안: `소개·발표자료 20건 수정: Worker 둘·DO 8개·노드 19종·대기 동작·큐 3개 등 사실 정합 (항목 18 제출 폼 확인 남음)`
