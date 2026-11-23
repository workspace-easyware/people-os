# 소개·발표자료 검토 결과 (2026-11-23)

검토 범위: `public/index.html` 소개 탭(539–609행), `public/pitch-content.html` 전문, `public/pitch.js`, `public/architecture.svg`, `DEMO-SCRIPT.md`. 대조 기준: 현재 코드와 최근 커밋. 파일 수정 없음.

## P0 — 사실과 다름 (심사위원이 잡을 수 있는 오류, 11-25 동결 전 필수)

### 1. "Worker 하나" — 사실이 아님
- 위치: `public/pitch-content.html:3` (히어로 H1), `:11` (키카드 1), `:117–118` (§06), `:250` (아키텍처 그림 alt), `:256` (§09) / `public/index.html:541` (소개 히어로), `:548` ("…모두 Cloudflare Worker 하나 안에 있습니다")
- 이유: 문서 편집 전용 Worker가 별도로 있다. `pptx-editor/wrangler.toml:6` — `name = "people-os-doc-editor"`. PPTX·XLSX·DOCX 편집이 이 Worker에서 돈다. "Worker 하나가 전부다"는 11-21 PPTX 편집 분리 시점부터 틀렸다. (`architecture.svg`는 이미 `people-os-doc-editor`를 2회 언급하고 있어 그림과 본문이 서로 모순이다.)
- 수정안: "Worker 하나" → "메인 Worker 하나 + 문서 편집 전용 Worker 하나"로. §06은 "진입점 4개" 설명은 유지하고, 문서 편집 경로(`DOC_EDITOR` 서비스 바인딩)가 별도 Worker로 간다는 한 줄을 추가한다. 소개 히어로의 "하나로"도 같은 취지로 바꾼다.

### 2. Durable Objects "다섯 개" — 실제는 8개
- 위치: `public/pitch-content.html:157` (§07 "Durable Objects 클래스 다섯 개"), `:258` (§09 "Durable Objects 다섯 개(…)"), §10 스택 표의 Durable Objects 행
- 이유: `wrangler.toml:64–127`에 바인딩 8개 — `AgentSession`, `WorkflowAgent`, `ChatRoom`, `NotificationHub`, `RateLimiter`, `ThinkAgent`, `AssistantAgent`, `DocJobRunner`. Think 전면 도입(T1–T3)과 큰 파일 Queue(`DocJobRunner`) 이후 늘었다.
- 수정안: "다섯 개" → "여덟 개"로 하고 표에 `ThinkAgent`(Think 에이전트 런타임), `AssistantAgent`(내 어시스턴트), `DocJobRunner`(큰 문서 작업 실행)를 추가한다. §10 스택 표도 동일하게.

### 3. 워크플로우 노드 "15종" — 실제는 19종
- 위치: `public/pitch-content.html:211` (§08 루프 ④) — "노드는 **15종**(도구 노드 13종 + 에이전트 + 조건 분기)"
- 이유: `src/workflow/types.ts:34` `NODE_TYPES`에 19개 — `ask_rag, ask_personal, transcribe, summarize, reflect_coach, reflect_coachee, draft_pptx, email_draft, send_email, create_task, llm, create_calendar_event, agent, condition, webhook, pptx_edit, xlsx_edit, docx_create, docx_edit`. 문서 편집 노드 4종이 추가된 뒤 갱신 안 됐다.
- 수정안: "19종(도구 노드 17종 + 에이전트 + 조건 분기)"으로. 같은 문장의 노드 예시 목록에 문서 편집 노드를 넣는다.

### 4. "승인함에서 한꺼번에 승인합니다" — 그런 메뉴가 없음
- 위치: `public/pitch-content.html:92` (§04 장면 4), `:214` (§08 승인 게이트)
- 이유: 지연 승인 결정 장소는 "승인함"이 아니라 워크플로우 화면의 **"대기 동작"** 섹션이다. 결재함(#approval)은 문서 결재 전용이라 워크플로우 승인이 없다(코드 주석에도 명시). 심사위원이 데모에서 "승인함"을 찾으면 없다.
- 수정안: 두 곳 모두 "승인함에서" → "워크플로우 화면의 '대기 동작'에서"로.

### 5. "도구를 골라 부르는 에이전트는 워크플로우의 에이전트 노드에만 있다" — 사실이 아님
- 위치: `public/pitch-content.html` §08 "지금의 한계" callout ("…에이전트는 워크플로우의 에이전트 노드에만 있고, 정해진 도구 목록 안에서 최대 10스텝까지 돕니다")
- 이유: 에이전트 탭의 **내 어시스턴트**(Think T2, `src/assistant/agent.ts:45`)도 도구를 골라 부른다 — 6종(`ask_rag, ask_personal, summarize, llm, email_draft, create_task`), 하루 30턴 상한(`ASSISTANT_DAILY_TURNS = 30`). 워크플로우 에이전트 노드(최대 10스텝)와 별개 제품이다.
- 수정안: "에이전트 노드에만" → "워크플로우 에이전트 노드와 에이전트 탭의 내 어시스턴트에 있다"로. "최대 10스텝"은 워크플로우 에이전트 노드 한정임을 명시하고, 어시스턴트는 하루 30턴이라고 덧붙인다.

### 6. 마이그레이션 범위 "0001~0032" — 실제는 0046까지
- 위치: `public/pitch-content.html:175` (§07 근거 줄)
- 이유: `migrations/`에 46개, 최신 `0046_task_lists.sql`. 0033 이후(Plaud, Think, 워크플로우 승인, 문서 Queue, 캘린더 C5/C6, 할 일 목록) 14개가 늘었다.
- 수정안: "(0001~0046)"으로.

## P1 — 빠져 있는 주요 기능 (소개·발표자료에 없으면 제품이 작아 보인다)

### 7. 소개 "무엇을 할 수 있나요" 목록에 에이전트 탭이 없음
- 위치: `public/index.html:571–586` (목록 블록). 메뉴 순서상 워크플로우 다음, 개인 업무 검색 앞에 있어야 할 `<li><b>에이전트</b> …</li>`가 없다.
- 이유: Think 어시스턴트(대화형, 규정·개인문서 검색·메일 초안·할 일 만들기, 하루 30턴)와 에이전트 실행 내역·대기 동작 승인/거절은 공모전 핵심(에이전트 런타임)인데 소개에서 빠졌다.
- 수정안: `<li><b>에이전트</b> — 내 어시스턴트와 채팅합니다. 규정·개인문서를 근거로 답하고, 메일 초안·할 일을 만들어 줍니다. 워크플로우에서 돌아가던 에이전트 실행 내역과 대기 동작 승인도 여기서 봅니다.</li>`를 워크플로우 항목 뒤에 추가한다.

### 8. 소개 "할 일" 항목이 구버전 설명
- 위치: `public/index.html:575` 부근 — "요약에서 나온 액션을 한 번 눌러 할 일로 옮기고 체크합니다."
- 이유: 11-23 패리티 완료 이후 목록 > 할 일 > 하위 작업, 날짜·반복·별표·메모·정렬 5종, 기한 지남 표시, 낙관적 업데이트가 있다. 지금 문장은 MVP 시절 설명이다.
- 수정안: "목록·하위 작업·반복·별표를 지원하는 할 일 목록입니다. 날짜와 기한을 달력에도 표시하고, 바꾸면 화면에 바로 반영됩니다."로.

### 9. 소개 "캘린더" 항목이 과소 서술
- 위치: `public/index.html:574` 부근 — "일정을 보고 만듭니다. 구글 �린더 연동은 선택입니다."
- 이유: 구글 캘린더 읽기+쓰기(C6) 연결 완료(11-23)됐고, 할 일 체크박스(기한 있는 할 일을 달력 알약으로 표시)도 있다.
- 수정안: "일정을 보고 만듭니다. 구글 캘린더와 읽고 쓰기를 연동할 수 있고, 기한 있는 할 일을 달력에 표시합니다."로.

### 10. 소개 "녹음전사·문서저장" 항목에 문서 편집·Plaud가 없음
- 위치: `public/index.html:576` 부근 — "음성 파일(최대 25MB)을 전사합니다… PDF, DOCX, XLSX, HWPX, 이미지 문서(최대 10MB)도 올려 색인합니다."
- 이유: 11-21~22에 추가된 기존 파일 편집(PPTX·XLSX·DOCX 편집본 만들기), Word 새로 만들기(이미지·목차), Plaud 가져오기(40MB)가 없다. 음성 25MB는 직접 업로드 기준이라 맞지만 Plaud 경로는 언급이 없다.
- 수정안: "Plaud 녹음을 가져오거나 음성 파일(최대 25MB)을 올려 전사합니다. PPTX·엑셀·Word 문서는 새로 만들거나 기존 파일을 편집할 수 있습니다."로.

### 11. 소개 "라이브러리" 항목에 카드 상세 보기가 없음
- 위치: `public/index.html:582` 부근 — "문서, 규정, 성찰, 답변 대기 질문을 모아 봅니다. 요약으로 PPTX 초안을 만들어 내려받습니다."
- 이유: 11-23에 규정·성찰·해결된 답변 대기 카드의 전체 화면 상세 보기(뒤로가기 포함)가 라이브됐다(커밋 `a3d632f`, `9f74923`).
- 수정안: "규정·성찰·답변 대기 카드를 누르면 전문을 전체 화면으로 봅니다." 한 줄을 추가한다.

### 12. 소개에 화상회의가 전혀 없음
- 위치: `public/index.html` 소개 탭 전체. 화상회의는 채팅방 [영상 통화] 버튼(RealtimeKit, 전사 옵션 포함, `src/meet/`, `public/chat.js:369` 이후)으로 동작한다.
- 이유: 실시간 화상회의+전사 파이프라인은 데모 장면(A2 승인 큐·강의실과 함께) 후보인데 소개에서 언급이 없다.
- 수정안: "무엇을 할 수 있나요" 목록의 채팅 항목에 "채팅방에서 영상 통화를 시작할 수 있고, 코칭 통화는 전사까지 이어집니다."를 추가하거나, 채팅 항목을 "채팅·화상회의"로 넓힌다. 단, 실제 통화 1회는 아직 미검증(전사 큐만 통과)이라 "된다"고 단정하지 말고 "채팅방에서 영상 통화를 시작합니다" 수준으로 쓴다.

### 13. 발표자료 §09 구조 목록에 신규 모듈·큐가 없음
- 위치: `public/pitch-content.html:256` (§09 항목 2) — 모듈 나열에 "워크플로우, 채팅, 알림, 캘린더, 조직관리"까지만 있고 에이전트/어시스턴트·화상회의·할 일이 없다. 같은 항목의 "Queues `people-os-pipeline`(+DLQ)이 전사 완료·트리·평가 항목·워크플로우 단계 메시지를…"도 불완전하다 — 큐가 4개(`people-os-pipeline`+DLQ, `workflow-step`, `people-os-docx-jobs`, `people-os-doc-jobs`; `wrangler.toml:138–170`)인데 파이프라인 하나만 적혀 있다.
- 수정안: 모듈 목록에 "에이전트(어시스턴트), 화상회의, 할 일"을 추가하고, 큐 문장을 "Queues 4개(파이프라인·워크플로우 단계·Word 작업·문서 작업)가…"로 고친다. (워크플로우 단계 메시지가 어느 큐를 타는지는 `src/workflow/engine.ts:66`·`src/index.ts:3087` 기준 `workflow-step`으로 확인되나, 바인딩이 `wrangler.toml`에 없어 최종 확인 후 문구 확정할 것.)

## P2 — 정확도·정합성 (동결 전 정리하면 좋음)

### 14. 발표자료 §12 "아직 확인하지 않은 것" 목록이 낡음
- 위치: `public/pitch-content.html` `#pt-limits` — "AI Gateway 로그 수집, 외부 메일 실제 수신, Turnstile 활성 여부, 채팅·알림의 실제 브라우저 화면"
- 이유: (a) "Turnstile 활성 여부"는 확인됨 — 사이트 키가 설정돼 있고(`wrangler.toml` `TURNSTILE_SITEKEY`), VM 브라우저에서 챌린지가 뜨고 실패(600010)하는 것 자체가 활성 증거다. (b) "채팅·알림의 실제 브라우저 화면"은 11-23에 채팅 패널을 브라우저에서 확인했다(대화 목록 표시). 다만 2개 창에서의 실제 메시지 송수신·접속 표시·읽음·반응은 미확인이다.
- 수정안: Turnstile 항목을 빼고, 채팅 항목을 "채팅 메시지 실제 송수신(2개 창, 접속·읽음·반응)"으로 좁힌다. "AI Gateway 로그 수집"·"외부 메일 실제 수신"은 여전히 미확인이라 유지한다.

### 15. 발표자료 §10 Turnstile 상태 문구가 실제와 어긋남
- 위치: `public/pitch-content.html` §10 스택 표 Turnstile 행 — "코드 있음 · 키 미설정이면 건너뜀"
- 이유: 키는 설정돼 있다(`TURNSTILE_SITEKEY = 0x4AAAAAAGIO_oaHS7s1r41w`, HR 규정 검색 `/api/ask` 적용). "미설정이면 건너뜀"은 폴백 동작 설명이지 현재 상태가 아니다.
- 수정안: "코드 있음 · 키 설정됨, `/api/ask` 적용"으로.

### 16. `architecture.svg`에 `DocJobRunner`가 없음 + 문서 작업 큐 누락
- 위치: `public/architecture.svg` — DO 7종만 언급(`AgentSession, AssistantAgent, ChatRoom, NotificationHub, RateLimiter, ThinkAgent, WorkflowAgent`, 각 2회). `DocJobRunner` 없음. 큐는 `people-os-pipeline`만 있고 `people-os-docx-jobs`·`people-os-doc-jobs` 없음. (그림은 `people-os-doc-editor` Worker는 포함하고 있어 본문보다 최신이다.)
- 수정안: 그림에 `DocJobRunner`와 문서 작업 큐 2개를 추가한다. 그림이 1446px 세로라 여유는 있다.

### 17. 발표자료 §13 데모 링크가 workers.dev만 있음
- 위치: `public/pitch-content.html` `#pt-demo` — "라이브 데모: people-os.workspace-easyware.workers.dev". `DEMO-SCRIPT.md:3`도 같은 URL을 녹화 URL로 적고 있다.
- 이유: 제출용 대표 데모 URL은 `https://peopleos.site/`이다. workers.dev도 동작하지만 심사위원에게 줄 주소는 peopleos.site가 일관된다.
- 수정안: §13에 `https://peopleos.site/`를 첫 번째로 적고 workers.dev를 부기한다. `DEMO-SCRIPT.md`의 녹화 URL도 peopleos.site로 통일한다.

### 18. 발표자료 §13 "심사용 계정 안내는 제출 폼에 적었습니다" — 제출 전 확인 필요
- 위치: `public/pitch-content.html` `#pt-demo` — "앱은 로그인이 필요합니다. 심사용 계정 안내는 제출 폼에 적었습니다."
- 이유: 제출 폼은 아직 제출 전(마감 11-27)이라 이 문장은 약속이지 사실이 아니다. 폼 초안에 심사 계정 안내가 실제로 들어갔는지 확인되지 않았다.
- 수정안: 11-27 제출 전에 폼 초안을 열어 심사 계정 안내 포함 여부를 확인하고, 없으면 폼에 추가한다. 문장 자체는 제출 후에는 사실이 된다.

### 19. 소개 "결정은 사람이 합니다" 카드 — 동기식만 서술
- 위치: `public/index.html` 소개 "결정은 사람이 합니다" 카드 — "워크플로우의 발송 단계는 승인 대기에서 멈춥니다."
- 이유: 동기식만 멈추고, 지연 승인은 대기 동작에 쌓아두고 실행이 끝까지 간다. 방금 만든 지연 승인 시연 워크플로우가 그 예다.
- 수정안: "동기식은 승인 대기에서 멈추고, 지연식은 대기 동작에 쌓아두고 실행은 계속됩니다."로.

### 20. `DEMO-SCRIPT.md` 준비 체크리스트 2건이 낡음 (발표자료 부속)
- 위치: `DEMO-SCRIPT.md:16` — "워크플로우를 녹화 전에 미리 만들어 둔다 (시드에 워크플로우 템플릿이 없다)" → 기업용 템플릿 5개가 있다(배포 `a08fdfae`). "템플릿이 없다"는 틀렸다.
- 위치: `DEMO-SCRIPT.md:17` — "지연 승인 시연용 워크플로우도 미리 만들어 둔다… 녹화 전에 한 번 실행해 대기 동작 1건을 쌓아 둔다" → 이미 완료됐다(이구름 계정 사본 `wf_mwt7uhp1_y10u75`, 11-23 21:10 1회 실행, 대기 동작 1건 쌓임, 메일 미발송). 체크 표시로 바꾸고 원본(`wf_mwpkcw9x_039u20`, 미실행)과 사본 중 하나만 실행하라고 적는다.
- 위치: `DEMO-SCRIPT.md:20` — "채팅 화면은 아직 사람이 브라우저로 확인한 적이 없다" → 11-23에 채팅 패널을 브라우저에서 확인했다(대화 목록). "2개 창 실제 송수신 미확인"으로 고친다.

## 참고 — 확인했고 문제없던 것
- 소개 "음성 파일(최대 25MB)"·"문서(최대 10MB)" 상한: 코드와 일치 (`src/index.ts:141,145`, Plaud 40MB는 `src/plaud/routes.ts:47`).
- 소개 "아침 브리핑 매일 07:00": 크론 `0 22 * * *`(UTC) = 07:00 KST와 일치.
- 소개 "메일함 — 메일을 개인 업무 검색에 넣을 수 있습니다": `indexEmailToPersonalRag`(`src/index.ts:2906`) 존재, 일치.
- 발표자료 §06 크론 3개, §10 "기능 14가지" 개수, §08 "질문 하나에 열한 단계" 11단계: 모두 코드와 일치.
- 발표자료 §10 AI Gateway·Workers Logs "확인 전", §12 "외부 메일 실제 수신": 여전히 미확인이라 현행 유지가 맞다.
- 소개·발표자료의 '해야 할 일'·'성찰' 표현: 11-22 교정(`822a9fe`) 이후라 일관된다.
