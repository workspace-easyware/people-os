# People OS 보안점검 결과 (2026-11-22, Fable 5.2 세션)

기준: `SECURITY-CHECKLIST.md`. 대상: `src/**`, `public/**`, `wrangler.toml`, `migrations/`, `package.json`.

## 0. 요약

- **High 4건 발견 → 4건 모두 수정·배포** (H1 익명 쓰기는 "인증 없이 공용 지식 변조"라 체크리스트의 배포 차단 정의에 닿는다 — 고쳐서 배포했다). Medium은 본문 6건 중 4건 수정·2건 예외, 그 밖에 예외로만 적은 Medium 3건(SEC-EX-001·004·015). Low는 12건 수정, 나머지는 예외 기록.
- 배포: People OS **`a7dfdcac-268f-461c-90d7-53bd5aaa5750`** (이전 `f578ee4d`). 편집 Worker·D1 마이그레이션·wrangler.toml 무접촉.
- `npx tsc --noEmit` 0건. 로컬 `wrangler dev` 검증 통과 (3장). 라이브 스모크는 6장.
- **하지 못한 것 (권한 차단)**: `npm audit --omit=dev`와 `/tmp/gitleaks`는 이 세션에서 "requires approval"로 막혀 **실행하지 못했다**. 대신 한 일과 한계는 7장.
- **하지 못한 것 (토큰 없음)**: `~/workspace/user`에는 세션 토큰 파일이 없다 (admin-secret·bootstrap-secret·pepper 3개뿐). 로그인 사용자 기준 라이브 IDOR 시도는 못 했고, 같은 시험을 로컬 시드 계정 3개(관리자·사용자 A·B)로 했다.
- 점검 방식: 본체(`src/index.ts`·`auth*.ts`·`lib.ts`·`ask-pipeline.ts` 격리 부분)는 직접 읽음. 모듈(`workflow`·`assistant`·`agent`·`chat`·`meet`·`email`·`approval`·`lms`·`calendar`·`plaud`·`obs`·`docx/pptx/xlsx`)과 `public/**`는 하위 에이전트 4개가 전수 읽고, 고친 항목은 내가 코드를 다시 확인했다. `pptx-editor/`(편집 Worker)는 상한 값만 grep. `public/`의 `chat.js`·`workflow.js`·`workflow-canvas.js`·`docx-*.js`·`xlsx-edit.js`·`ui-dialog.js`는 싱크 grep + DOM 헬퍼 확인이고 줄 단위 정독은 아니다.

## 1. 발견 사항과 수정

줄 번호는 수정 뒤 기준.

### High

| # | 내용 | 재현 | 수정 |
|---|---|---|---|
| H1 | **익명 쓰기 → 공용 RAG 오염·무제한 AI/R2 사용.** `POST /api/documents`(텍스트·파일)·`/api/transcribe`·`/api/coaching/reflect`·`/api/deck`·`/api/tasks`(생성·완료·삭제)·`/api/documents/:id/summarize`·`/api/recordings/:id/{advance,retry,pipeline-retry}`가 로그인 없이 됐다. 익명 문서는 `owner_id NULL`(공용)이 되어 HR 규정 검색 근거로 잡힌다. 익명 성찰은 참여자 없는 행이라 모두에게 보였다. | 익명 `curl -X POST /api/documents -d '{"content":"…","kind":"file"}'` → 201 (수정 전 코드 기준, 라이브에는 쓰지 않음) | 전부 `loggedInOrAdmin`(세션 또는 X-Admin-Secret) 401. `src/index.ts:643, 843, 856, 943, 970, 997, 1465, 1631, 1649, 1662, 1675` |
| H2 | **일반 사용자의 공용 풀 쓰기.** `kind:"file"` + `personal` 생략이면 일반 사용자 문서가 공용이 됐다 — "암묵지 게시는 hr_admin 전용"(2026-11-22 결정)을 돌아가는 길. | 사용자 세션으로 `{"kind":"file","content":"…"}` → 공용 문서 | 공용 쓰기는 hr_admin·X-Admin-Secret만 (`sharedPoolWriter`, `src/index.ts:632, 669, 727`). 일반 사용자 문서는 항상 본인 소유. 화면은 원래 일반 사용자에게 `personal:true`만 보낸다 (`public/index.html` 업로드 대상 로직). `kind`는 transcript/file/tacit만 (`:651`). |
| H3 | **저장형 XSS (라이브러리 제목).** `data-title="${esc(x.title)}"`인데 `esc()`가 따옴표를 안 바꿨다. 제목 `x" autofocus onfocus="…`로 올리면 hr_admin(전체 파일을 봄)이 라이브러리를 열 때 관리자 세션에서 스크립트가 돈다 → 권한 상승(`PATCH /api/admin/users/:id`). | 제목에 `"`가 든 덱·업로드 문서 생성 후 관리자 라이브러리 열람 | `esc()`가 `"`·`'`도 이스케이프 (`public/index.html:1310`, `public/obs/common.js:30`), 해당 속성은 `escAttr` (`index.html` 라이브러리 편집 버튼). `plaud.js`의 `data-…="${esc(f.id)}"`도 같이 닫힘. |
| H4 | **보안 헤더 누락.** API 응답에 헤더 0개, HSTS·CSP는 정적 파일에도 없었다 (수정 전 라이브 `curl -D -` 확인). | `curl -sD - -o /dev/null <라이브>/api/config` | `withSecurityHeaders` (`src/index.ts:2524`) + `public/_headers`. HSTS 1년, nosniff, XFO, Referrer-Policy, CSP(JSON은 `default-src 'none'`, 그 밖은 `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'`). WebSocket 101은 건드리지 않음. `script-src`는 SEC-EX-001. |

(H4는 체크리스트 §6이 "누락이 있으면 추가"로 지정한 항목이라 High로 다뤘다. 공격 재현이 있는 High는 H1~H3.)

### Medium

| # | 내용 | 처리 |
|---|---|---|
| M1 | 속도 제한 키 충돌: 익명이 `sessionId:"user:<남의 id>"`를 보내 남의 질문 버킷을 소진 (피해자 429) | 수정 — 익명 키 `sess:` 접두 (`src/index.ts:1166`), sessionId 200자 상한 (`:1134`) |
| M2 | 메일 발송 상한 없음 (메일함 + 워크플로우 send_email, 자기 승인이라 승인 게이트가 양을 막지 못함) | 수정 — 사용자당 24시간 200통, 세는 쿼리 실패 시 발송 안 함 (`src/email/send.ts:51`, `routes.ts:197`, `workflow/nodes.ts:416`) |
| M3 | 관리자 시크릿을 sessionStorage + 입력란 value에 보관 (XSS 1건이면 탈취) | 수정 — 메모리 변수만, 예전 저장값 삭제 (`public/obs/datasets.js:38`) |
| M4 | Word AI 지시 로그에 모델이 쓴 문서 내용 앞뒤 200자 + 오류 주변 160자 | 수정 — 구조 문자만 남긴 "모양"과 오류 종류·위치만 (`src/docx/create.ts:490 부근, 769`) |
| M5 | 승인 화면이 본문 200~300자만 보여 주고 전체 인자로 실행 (프롬프트 주입된 에이전트가 뒤쪽에 내용을 실을 수 있음) | **SEC-EX-002** |
| M6 | 발신 주소가 이메일 앞자리만으로 정해짐 (앞자리가 같은 두 계정은 같은 `@peopleos.site` 주소) | **SEC-EX-003** |

### Low — 수정한 것

- 질문 길이 상한 2000자, 타입 검사 (`src/index.ts:1134`). 문서 본문 10MB·제목 200자, 성찰 전사본 500,000자, 할 일 source 300자.
- 피드백: 로그인 사용자의 질문에는 본인·hr_admin만 (`:1291`). 익명 질문은 기존대로.
- `BOOTSTRAP_SECRET` 비교를 상수 시간으로 (`src/auth-routes.ts:94`).
- 메일 제목 CR/LF 제거 (`src/email/routes.ts:189`).
- 웹훅 SSRF 차단 대역 추가: 100.64/10, 192.0.0/24, 198.18/15, 224/4, 240/4, fec0::/10, ff00::/8, 2002::/16 안쪽 IPv4 (`src/workflow/nodes.ts:568`).
- ThinkAgent가 실행 직전 `job.tools`를 다시 확인 (`src/workflow/think-agent.ts:397`).
- 워크플로우 삭제 시 미결정 대기 동작(queued) 삭제 (`src/workflow/store.ts:104`).
- 강의 `r2_key` 차단 목록에 `meetings/` 추가, `..`·`//`·선행 `/` 거절 (`src/lms/routes.ts:289`).
- 이미지 문서 존재 여부 노출(403 vs 404) → 둘 다 404 (`src/docx/create.ts:816`).
- 메일 본문 iframe에서 `<meta>`·`<base>` 제거 (`public/email.js:128`).
- `.gitignore`에 임시 자격증명·세션 파일 경로 추가. `/api/obs/*` 미들웨어 주석 정정 (`src/index.ts:2347`).

## 2. 항목별 판정표

판정: 충족 / 수정(이번에 고침) / 예외(SEC-EX) / 해당 없음.

| § | 항목 | 판정 | 근거 |
|---|---|---|---|
| 1 | 강한 KDF | 예외 | PBKDF2-SHA256 10만 회 + 페퍼 HMAC `src/auth.ts:73-86`. OWASP 권장 60만 회 미달 → SEC-EX-004 |
| 1 | 로그인 rate limit·열거 방지 | 충족 | 이메일+IP 15분 8회 `auth.ts:159-179`; 없는 계정도 같은 KDF를 돌리고 같은 문구 `auth-routes.ts:128-139`. 지수 백오프는 없음(고정 창) |
| 1 | 세션 ID·재생성·로그아웃 | 충족 | 256비트 CSPRNG `auth.ts:40`; 로그인마다 새 토큰 `:130`; 로그아웃이 서버 행 삭제 `auth-routes.ts:148-155` |
| 1 | 비밀번호 변경 시 타 세션 회수 | 충족 | 현재 비밀번호 확인 + 전체 세션 삭제 후 새 세션 `auth-routes.ts:222-261` |
| 1 | 비밀번호 정책 | 예외 | 12~128자 `auth.ts:88`. 유출 비밀번호 대조 없음 → SEC-EX-005 |
| 1 | 재설정 토큰 | 충족 | 24시간·1회용·해시 저장·원자적 소진 `auth.ts:186-199`, `auth-routes.ts:165-204` |
| 1 | 관리자 계정·부트스트랩 | 충족/예외 | `BOOTSTRAP_SECRET` 없으면 거부, 사용자 0명일 때만 `auth-routes.ts:94-99`. 임시 비밀번호 변경 강제 없음, 관리자 행위 감사 로그 없음 → SEC-EX-006 |
| 2 | 토큰은 httpOnly 쿠키만 | 수정 | 세션 토큰 스토리지 저장 0건. 관리자 시크릿 sessionStorage → M3 |
| 2 | 쿠키 속성 | 충족 | HttpOnly·Secure·SameSite=Strict, Domain 없음 `auth.ts:92-94`. `__Host-` 접두사 없음 (이름을 바꾸면 전원 로그아웃 — Low, SEC-EX-007) |
| 2 | CSRF | 충족/예외 | SameSite=Strict + 인증·채팅·회의·결재·워크플로우는 Origin 검사. 메일·강의실·본체 라우트는 Origin 검사 없음 (Strict 쿠키라 현재 악용 불가). 교차 사이트 폼 0건. 토큰 도입은 불필요로 판단 → SEC-EX-007 |
| 2 | CORS | 충족 | CORS 헤더를 내는 코드 0건 (`grep -i access-control src` 0건) → 교차 출처 읽기 불가 |
| 2 | 세션 전체 회수 경로 | 충족 | 비활성화 시 `revokeSessions` `auth-routes.ts:344`. 열린 WebSocket은 남음 → SEC-EX-008 |
| 3 | 서버 인가·기본 거부 | 수정 | H1. 그 밖 라우트 표는 4장 |
| 3 | IDOR | 충족 | 문서·녹음·덱·할 일·메일·결재·채팅·회의·캘린더·워크플로우·작업 전부 소유·멤버 검사 확인. 로컬 시험 3장. R2 키는 서버 생성, 내려받기는 D1 `owner_id` 확인 뒤 `src/index.ts` `/api/documents/:id/download`·`/api/deck/:id` |
| 3 | BFLA | 충족 | `/api/obs/*` 미들웨어, `requireAdmin`(계정·부서·강의), 로컬에서 일반 사용자 403/401 확인 |
| 3 | Mass assignment | 수정 | 역할·상태는 관리자 PATCH에서만 allowlist `auth-routes.ts:314-346`. 문서 `kind` allowlist 추가, 공용 소유 지정 차단(H2) |
| 3 | 코칭 역할 서버 결정 | 충족 | 본문의 mode·coach_id 미사용, `viewer.coaching_role`만 `src/index.ts` `/api/coaching/reflect` |
| 3 | 승인 결정은 본인만 | 충족 | `workflow/pending-actions.ts:99,104`, `engine.ts:402,416` |
| 4 | SQL 바인딩 | 충족 | `${}`가 든 SQL은 전부 상수 조각·`?` 목록 (하위 점검 3건이 위치별로 확인). LIKE는 이스케이프 |
| 4 | 입력 검증 | 수정 | Low 수정 목록 |
| 4 | 출력 인코딩 | 수정 | H3. 인라인 `onclick="fn('${id}')"`는 id가 서버 생성이라 현재 악용 불가 → SEC-EX-001에 포함 |
| 4 | 파일 업로드 | 충족 | 매직 바이트 판별 `src/parse.ts`, 10MB/25MB, R2 키는 서버 id + 정리된 확장자, 내려받기는 `attachment` + nosniff. 음성은 확장자·MIME만 봄(전사 실패로 끝남) |
| 4 | 에러 응답 | 예외 | 스택 미노출. 내부 오류 문구(`indexError`, AI·Resend·RTK 오류 본문)가 본인에게 보임 → SEC-EX-009 |
| 5 | Secret fail-fast | 충족 | 페퍼·부트스트랩·ADMIN_SECRET·Resend·GCAL 키 없으면 해당 기능 거부(503/401). Workers에는 부팅 단계가 없어 요청 시점 fail-closed. Turnstile만 fail-open(설계) → SEC-EX-010 |
| 5 | Secret 저장 위치 | 충족(부분) | 코드·설정에 값 없음 (grep 패턴 검사 0건, 7장). gitleaks 재실행은 못 함 |
| 5 | 토큰 해시 저장 | 충족 | 세션·설정 링크·OAuth state 모두 SHA-256 |
| 5 | 식별자에 시간 노출 | 예외 | `uid()`는 시각+`Math.random` 6자 `src/lib.ts:89`. 토큰에는 안 씀 → SEC-EX-011 |
| 6 | 보안 헤더 | 수정 | H4 |
| 6 | debug 엔드포인트 | 충족 | `/api/debug-ai`·`/api/seed-vectors`는 X-Admin-Secret. `/api/seed`는 샘플 문구만. 하네스 라우트는 `src`에 없음 |
| 6 | 의존성 | 미실시 | lockfile 2개 있음. `npm audit` 실행 못 함 (7장) |
| 7 | SSRF | 수정 | 웹훅: 스킴·내부 이름·IP 대역·`redirect:"manual"`·10초·256KB. DNS로 사설 IP에 닿는 경우는 Workers에서 못 막음(코드 주석). Plaud 오디오는 `redirect:"follow"` → SEC-EX-012 |
| 7 | 웹훅 서명 | 충족 | `/api/meet/webhook`은 본문 처리 전 RSA 서명 검증 `src/meet/routes.ts:119-129`. 서명 없으면 DB·큐·AI 접근 없음 |
| 7 | 외부 응답 검증 | 충족(부분) | 크기·시간 상한 있음. Resend·AI Gateway 로그 fetch는 타임아웃 없음(Low) |
| 7 | Turnstile·익명 남용 | 충족 | `/api/ask`만 익명 + Turnstile + 세션·IP 버킷. 익명 쓰기는 H1로 닫음 |
| 8 | 로그에 비밀·PII | 수정 | M4. 토큰·쿠키 로그 0건. `email/inbound.ts:168`가 실패 시 발신 주소를 남김(Low) |
| 8 | PII 마스킹 | 예외 | 트레이스 목록·상세는 `mask.ts`. 공백·평가 상세·워크플로우 run은 원문(관리자 전용), `?unmask=1` 감사 없음 → SEC-EX-013 |
| 8 | 보안 이벤트 로깅·알림 | 예외 | 로그인 실패·권한 거부 구조화 로그 없음 → SEC-EX-006 |
| 9 | 프롬프트 분리·주입 | 충족 | system/user 분리, 메일 초안에 지시문 무시 문구, 프롬프트에 env·시크릿 0건 |
| 9 | RAG 권한 필터 | 충족 | `vectorPoolFilter`·`docOwnerClauseForPool` `src/lib.ts:155-178`, 캐시 키에 풀·viewer `ask-pipeline.ts:676`. 로컬에서 B가 A 문서 403 |
| 9 | 자동 실행 승인 | 충족 | `needsApproval`은 저장값과 무관하게 send_email·webhook에 강제, 실행 시점 재검증 |
| 9 | 도구 상한 | 수정/예외 | ThinkAgent 도구 재확인 추가. instruction 달린 문서 노드가 LLM 캡에 안 잡힘 → SEC-EX-014 |
| 10 | UUID 식별자 | 예외 | 사용자는 UUID, 그 밖은 `uid()` → SEC-EX-011 |
| 10 | owner_id NOT NULL | 예외 | `owner_id NULL = 공용` 설계. 익명이 공용 문서·미지정 할 일·참여자 없는 성찰을 읽을 수 있음 → SEC-EX-015 |
| 10 | 캐시 키 격리 | 충족 | `ask:<pool>:<viewer>:<session>:<질문>:<epoch>` |
| 10 | 계정 삭제 처리 | 예외 | 비활성화 + 세션 회수만, 개인 데이터 삭제 경로 없음 → SEC-EX-016 |
| 10 | R2 키 소유권 | 충족 | 클라이언트가 키를 주는 곳은 관리자 전용 강의 `r2_key`뿐 (차단 목록 보강) |

## 3. 로컬 검증 (`wrangler dev --local`, 시드 `harness/seed.sql`)

| 시험 | 결과 |
|---|---|
| 익명 POST documents / tasks / deck / reflect / transcribe, PATCH tasks | 전부 401 |
| 익명 GET `/api/home` | 200 (기존 스모크 기준 유지) |
| 사용자 A `kind:"file"`(personal 없음) | 201, 이후 익명·사용자 B 내려받기 403, A 본인 200 → 개인 소유 |
| 사용자 A `kind:"policy"` | 400 |
| 관리자·X-Admin-Secret `kind:"file"` | 201, 익명 내려받기 200 → 공용 유지 |
| 사용자 A multipart 업로드(personal 없음) | 201, B 내려받기 403 |
| 익명 공용 문서 summarize / B가 A 문서 summarize | 401 / 403 |
| B·익명이 A 질문에 피드백 / A 본인 | 404·404 / 200 |
| 2000자 초과 질문 | 400 |
| 사용자 B(보낸 메일 200행 시드) 메일 발송 | 429 (Resend 호출 전) |
| 일반 사용자 `/api/obs/traces` / `/api/admin/users` / 자기 승격 PATCH | 403 / 401 / 401 |
| 틀린 부트스트랩 시크릿 | 403 |
| 헤더: `/api/health`, `/` | HSTS·CSP·nosniff·XFO·Referrer-Policy 확인 |
| WebSocket `/api/notifications/ws` | 101 (헤더 래퍼가 업그레이드를 깨지 않음) |
| 로그인 사용자 task·deck·reflect 생성 | 201·201·200 (정상 흐름 유지) |

로컬에서 확인하지 못한 것: 메일 상한 미만 발송(가짜 키로 외부 호출이 생겨 생략), ThinkAgent 도구 차단·SSRF 새 대역·대기 동작 삭제·docx 로그 모양(코드 검토 + tsc만), 브라우저에서의 XSS 실제 차단(서빙된 HTML에 `escAttr(x.title)` 1건 확인까지).

## 4. 라우트 인가 표

모듈별 전체 표(메서드·경로·검사 줄)는 하위 점검에서 만들었고 요지는: 워크플로우·에이전트 24개, 채팅 16개, 회의 7개, 메일 10개, 결재 11개, 강의실 6개, 캘린더 13개, Plaud 8개, 문서 편집 10개, 관측 전체 — **IDOR·익명 접근·권한 상승 0건**. 본체 라우트는 1장의 H1·H2 수정 뒤 쓰기 전부 로그인 필요.

## 5. 예외 기록 (SEC-EX)

공통: 승인자 — Merlin/사용자 확인 필요. 만료일 2026-12-31 (공모전 제출 뒤 재검토).

| ID | 등급 | 내용·영향 | 임시 보완 | 조치 계획 |
|---|---|---|---|---|
| SEC-EX-20261122-001 | Medium | `script-src` CSP 없음. 인라인 스크립트 1,480줄·인라인 핸들러 150여 곳이라 넣으면 화면이 깨진다. XSS가 나면 막을 2차 방어가 없다 | `esc()` 강화, 나머지 CSP 지시문, HttpOnly 쿠키 | 핸들러를 `data-*` + 위임 리스너로 옮긴 뒤 nonce CSP. RealtimeKit SDK를 `/vendor`로 옮김(지금은 jsdelivr, SRI 없음) |
| 002 | Medium | 승인 미리보기가 본문 200~300자·웹훅 헤더 미표시 | 승인자=소유자 본인, 수신자·제목·URL은 표시됨 | 대기 동작 상세에 전체 인자(헤더 값 가림) 표시 |
| 003 | Medium | 발신 주소 앞자리 충돌 | 계정은 hr_admin만 만든다 (현재 계정 수 적음) | 계정 생성 시 앞자리 중복 거절 또는 전용 열 |
| 004 | Medium | PBKDF2 10만 회 (권장 60만). 영향: DB와 페퍼가 함께 유출되면 오프라인 추측이 6배 빠름 | 페퍼 HMAC(Worker 시크릿 — DB만 유출되면 추측 불가), 12자 이상 | Workers WebCrypto의 PBKDF2는 10만 회가 상한이라고 기억한다 (**이번 세션에서 확인하지 못함**). 맞다면 10만 회 × 6번 연쇄로 올리고, `users`에 `kdf_version` 열을 둬 로그인 성공 시 새 방식으로 다시 해시(점진적 재해시) |
| 005 | Low | 유출 비밀번호 대조 없음 | 12자 하한, 로그인 시도 제한 | HIBP k-익명 API 대조 |
| 006 | Low | 관리자 행위·로그인 실패·권한 거부 감사 로그 없음, 첫 관리자 임시 비밀번호 변경 강제 없음 | 결재는 감사 테이블 있음, Workers Logs에 요청 기록 | `logEvent("auth.*")` 추가, `must_change_password` 열. **공모전 뒤 관리자 비밀번호 교체** |
| 007 | Low | 메일·강의실·본체 변경 라우트에 Origin 검사 없음, `__Host-` 접두사 없음 | SameSite=Strict | 공통 미들웨어로 Origin 검사 |
| 008 | Low | 세션 회수 뒤에도 열린 WebSocket이 유지됨 | 그룹에서 빼면 소켓 종료됨 | 비활성화 시 DO에 강제 종료 호출 |
| 009 | Low | 내부 오류 문구가 본인 응답에 실림 (`indexError`, `AI 호출 실패: …`, Resend·RTK 오류, 큐 오류) | 스택·SQL 구조는 안 나감, 로그인 사용자 본인에게만 | 일반 문구로 바꾸고 상세는 로그. `src/meet/routes.ts:40`은 검증된 파일이라 이번에 손대지 않음 |
| 010 | Low | Turnstile·속도 제한이 장애 시 fail-open | 익명 쓰기 차단으로 익명이 쓸 수 있는 것은 `/api/ask`뿐 | 익명 요청만 fail-closed |
| 011 | Low | `uid()`가 `Math.random` + 시각 | 인가는 소유 검사로 함, 토큰은 CSPRNG | `crypto.randomUUID()` 기반으로 교체 |
| 012 | Low | Plaud 오디오 받기: 넓은 호스트 허용(`amazonaws.com`)·리다이렉트 따라감·길이 미선언 시 전체 읽음 | URL은 Plaud MCP 응답에서만 옴 | `redirect:"manual"`, 스트림 바이트 계수 |
| 013 | Low | 관측 일부 응답 비마스킹, `unmask=1` 감사 없음, KV 오류 시 평가 일일 상한 무력 | 전부 hr_admin 전용 | `maskDeep` 적용, `obs.unmask` 로그 |
| 014 | Low | instruction 달린 문서 노드 4종이 LLM 캡에 안 잡힘, legacy 에이전트는 run 캡 미전달, 워크플로우 개수 상한 없음, 실행 상한 fail-open | 하루 20 run·동시 3·단계 50 | 캡 목록에 4종 추가 (동작이 바뀌므로 회귀 뒤) |
| 015 | Medium | 익명이 `owner_id NULL` 데이터를 읽음: `/api/library`·`/api/home`·`/api/tasks`·`/api/recordings`·`/api/documents/coaching`(본문 포함)·공용 문서·덱 내려받기. 문서화된 설계("익명은 공용만")이고 스모크가 익명 `/api/home` 200을 기준으로 쓴다 | H1로 익명이 공용 데이터를 **만들지** 못함 → 공용은 관리자가 올린 것 + 과거 행뿐 | 화면이 이미 로그인 뒤에만 열리므로 읽기도 로그인 필수로 바꾸는 것을 권한다 (스모크 기준 갱신 필요 — 사용자 결정) |
| 016 | Low | 계정 삭제·퇴사 시 개인 데이터 처리 경로 없음 | 비활성화 + 세션 회수 | 삭제 절차 설계 |
| 017 | Low | 결재선을 기안자가 바꿀 수 있음(설계), hr_admin이 그룹 채팅에 자신을 넣어 읽을 수 있음, 팀 일정·결재 상신·채팅에 속도 제한 없음, 다이제스트가 전체 건수를 모두에게 보임, 공유 워크플로우의 웹훅 URL 쿼리가 보임 | 내부 사용자 한정 | 양식별 결재선 잠금, 관리자 자기 초대 금지 등 |
| 018 | Low | RealtimeKit 웹훅: 계정 결합·재전송 창 없음, 검증 전 본문 크기 무제한 | 서명 검증, 모르는 회의 id는 버림 | 본문 상한·다운로드 호스트 allowlist (검증된 파일이라 이번에 손대지 않음) |

## 6. 라이브 스모크

버전 `a7dfdcac-268f-461c-90d7-53bd5aaa5750` (`versions list` 맨 끝, 생성 05:28:41Z). 새 버전이 응답하는 것을 헤더로 먼저 확인한 뒤(05:30:55Z) 나머지를 호출했다. 익명 쓰기 시도는 빈 본문 `{}`으로만 했다 (게이트가 먼저 401을 내므로 만들어진 데이터 없음).

| 확인 | 결과 |
|---|---|
| `/api/config` 헤더 (workers.dev) | HSTS·CSP `default-src 'none'; frame-ancestors 'none'`·nosniff·XFO·Referrer-Policy 있음 (배포 전에는 전부 없었다) |
| `https://peopleos.site/` 헤더 | HSTS·CSP `frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'` 추가 확인 |
| `/api/health` · 익명 `/api/auth/me` · `/api/home` | 200 · 401 · 200 (이전 스모크 기준과 같음) |
| 익명 POST `/api/documents` · `/api/tasks` · `/api/deck` · `/api/coaching/reflect` · `/api/transcribe` | 전부 401 |
| 익명 `/api/obs/traces` · `/api/workflows/templates` | 401 · 401 |
| 2000자 초과 질문 `/api/ask` | 400 (Turnstile·AI 호출 전) |
| 서빙된 홈에 `escAttr(x.title)` | 1건 |
| X-Admin-Secret으로 `/api/obs/summary` (읽기) | 200 (운영 경로 유지) |

라이브에서 하지 않은 것: 로그인 사용자 호출(세션 토큰 파일 없음 — 공용 풀 쓰기 차단·피드백 소유권·메일 상한은 로컬 결과만 있다), 브라우저 확인(로그인 뒤 라이브러리·메일 본문·관측 데이터셋 화면이 그대로 그려지는지, `/meet` 통화, 구글·Plaud OAuth 콜백 화면이 새 헤더와 함께 동작하는지). **브라우저에서 한 번 보는 것을 권한다** — 특히 `esc()`가 따옴표를 바꾸게 된 뒤 화면에 `&quot;`·`&#39;`가 글자로 보이는 곳이 없는지.

## 7. 의존성·비밀 스캔

- **`npm audit --omit=dev`: 실행하지 못함.** 이 세션의 권한 규칙에 없어 "This command requires approval"로 막혔다 (`--json`도 같음). Critical/High 평가는 **하지 못했다**. 확인한 것은 lockfile 존재(`package-lock.json`, `pptx-editor/package-lock.json`)와 `package.json`의 버전 고정(대부분 정확한 버전, `fflate`·`hono`·`pptxgenjs`만 `^`)뿐이다. → Merlin이 `npm audit --omit=dev`를 직접 돌려야 한다.
- **gitleaks 재스캔: 실행하지 못함.** `/tmp/gitleaks`는 작업 폴더 밖이라 실행·목록 조회가 모두 막혔다. 대신 `grep`으로 `src`·`public`·`migrations`·`wrangler.toml`·`pptx-editor/src`·루트 `*.md`에서 흔한 키 모양(sk-·re_·AKIA·PRIVATE KEY·xox·ghp_·AIza·JWT)과 `secret|token|password|api_key|pepper = "<16자 이상>"` 대입을 찾았다 → 1건, `src/obs/mask.ts:99` 시험 픽스처(기존 오탐과 같은 것). 이것은 gitleaks를 대신하지 못한다 (엔트로피 검사·커밋 이력 없음). → Merlin이 `/tmp/gitleaks`를 다시 돌려야 한다.
- 미추적 임시 자격증명 파일(`decisions-2026-11-22/h/`, `pw-new.json`, `sess-*.json`, `bf-seed.txt`)은 `.gitignore`에 넣었다. 내용은 열지 않았다.

## 8. 남긴 것

- 수정 파일 (커밋 안 함): `src/index.ts`, `src/auth-routes.ts`, `src/email/send.ts`, `src/email/routes.ts`, `src/workflow/nodes.ts`, `src/workflow/think-agent.ts`, `src/workflow/store.ts`, `src/lms/routes.ts`, `src/docx/create.ts`, `public/index.html`, `public/email.js`, `public/obs/datasets.js`, `public/obs/common.js`, `public/_headers`, `.gitignore`.
- 건드리지 않은 것: 모델·프롬프트·평가 기준, `src/meet/*`, `src/chat/*`, `public/meet.*`, `public/chat.js`, `public/approval.js`, wrangler.toml, 마이그레이션, 편집 Worker.
- 로컬 검증 자료: `files/workflow-verify/security-audit/harness/` (시드 SQL·요청 본문), `state/` (로컬 D1 — 지워도 됨).
- **동작이 바뀐 것 (알아야 할 것)**: ① 익명은 문서·녹음·성찰·덱·할 일을 만들 수 없다 (운영 스크립트는 X-Admin-Secret을 붙여야 한다) ② 일반 사용자가 API로 직접 올린 문서는 `personal` 값과 무관하게 개인 소유 ③ 문서 `kind`는 3종만 ④ 질문 2000자 ⑤ 메일 하루 200통 ⑥ obs 데이터셋 화면의 시크릿은 새로고침하면 다시 입력.

## 9. Merlin 재검증 (2026-11-22, 세션 종료 뒤)

- **배포 버전 대조**: `versions list`에서 `a7dfdcac-268f-461c-90d7-53bd5aaa5750` (2026-11-22T05:28:41Z) 확인. 라이브 스모크 직접 재실시: `/api/health` 200 + HSTS·CSP(`default-src 'none'`)·nosniff·XFO·Referrer-Policy, 익명 POST `/api/documents`·`/api/tasks`·`/api/deck`·`/api/coaching/reflect`·`/api/transcribe` 전부 401, 익명 `/api/auth/me` 401·`/api/home` 200. 세션 보고와 일치.
- **소스 깨짐 확인**: `git diff` 출력에 `���`로 보인 `src/index.ts:970`의 문자열은 출력 렌더링 문제였다. 파일은 유효한 UTF-8(대체 문자 0개), grep으로 14곳의 "로그인이 필요합니다." 전부 정상 확인.
- **diff 전수 검토**: 15개 파일 206줄. H1/H2 게이트·kind allowlist·질문 상한·속도 제한 키·메일 상한·SSRF 대역·로그 마스킹·헤더·esc() 변경 모두 코드로 확인. `escAttr`는 `public/index.html:1520`에 정의되어 있어 편집 버튼 호출이 안전하다.
- **gitleaks 재스캔 (직접 실행)**: `/tmp`가 런타임 재시작으로 지워져 `~/workspace/tools/gitleaks`(8.28.0)로 다시 받아 보관. `git` 스캔 100커밋 2건(기존 오탐 2건과 동일), `dir` 스캔 58건 중 추적 파일은 같은 2건만. 실제 비밀 0건.
- **의존성 검사 (`npm audit` 대체)**: `npm audit`은 VM 샌드박스 정책이 감사 엔드포인트 POST를 403으로 막아 실행 불가. 대신 OSV API(`api.osv.dev/v1/querybatch`)로 lockfile 전수 검사. 직접 의존성 14개(설치 버전 기준) 0건, 전체 트리 395개 패키지 중 **image-size 1.2.1만 2건(GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr, CVSS 7.5, JXL/HEIF/ICNS 파서 무한루프 DoS, 수정 버전 2.0.3)**. 도달 가능성: pptxgenjs 4.0.1의 전이 의존성이나 People OS 코드에 `addImage` 호출이 없어(덱 생성은 텍스트·도형만, docx 이미지는 자체 `sniffImage`로 PNG/JPG/GIF/BMP만 처리) 취약 파서에 사용자 이미지가 닿지 않는다. Workers CPU 30초 상한도 blast radius를 1요청으로 묶는다. pptxgenjs 최신도 4.0.1이라 업그레이드 경로 없음. **판정: Low, SEC-EX-20261122-019로 기록. 조치: pptxgenjs가 image-size 2.x를 쓰게 되면 그때 올린다.**
- **PBKDF2 10만 회 (SEC-EX-004) 해소**: Workers WebCrypto는 호출당 10만 회가 하드 상한이다 (`Pbkdf2 failed: iteration counts above 100000 are not supported`). 독립 출처 3건 이상(ResolveHQ 감사, Mailda 실측 100,000 OK/100,001 실패, Cloudflare 커뮤니티)이 일치하고, 로컬 workerd는 상한을 강제하지 않아 로컬 시험만으로는 확인이 안 된다. 즉 현재 10만 회는 "선택"이 아니라 플랫폼 최대치 + 페퍼 HMAC이다. 60만 회 상당으로 올리려면 10만 회×6회 연쇄(합성 구조, 표준 PBKDF2 아님) + `kdf_version` 열 + 로그인 시 점진적 재해시가 필요하다. 공모전 동결(11-25)을 앞두고 로그인 경로를 바꾸는 것은 위험하므로 **공모전 뒤로 미루는 것을 권한다.**
- **브라우저 확인 (완료, 2026-11-22 14:42~14:43)**: hr.jhkang으로 로그인해 홈·라이브러리(파일·규정·성찰·답변 대기 탭)·메일함 확인. `&quot;`·`&#39;` 등 엔티티가 글자로 보이는 곳 없음. 인용 부호 있는 텍스트(성찰의 작은따옴표, 에이전트 활동의 큰따옴표) 정상 렌더링. 레이아웃 깨짐 없음. 메일함은 비어 있는 정상 상태.

## 10. 예외 추가 (Merlin)

| ID | 등급 | 내용·영향 | 임시 보완 | 조치 계획 |
|---|---|---|---|---|
| SEC-EX-20261122-019 | Low | image-size 1.2.1 DoS 2건 (CVSS 7.5, 가용성만). pptxgenjs 전이 의존성. People OS에서 취약 파서에 닿는 경로 없음 | Workers CPU 30초 상한, 이미지 경로는 자체 스니퍼 + PNG/JPG/GIF/BMP만 | pptxgenjs가 image-size 2.x를 쓰게 되면 업그레이드 |

예외는 총 19건(SEC-EX-001~018 + 019).

## 11. 익명 읽기 차단 (2026-11-22, SEC-EX-015 해소)

사용자 결정(2026-11-22 16:58): "익명 읽기도 막아줘 (로그인 필수로)". Fable 5.2 세션이 코드·배포까지 마쳤으나 런타임 재시작으로 RESULT 기록 전에 끊겨, Merlin이 마저 검증·기록·커밋했다.

### 바꾼 것 (`src/index.ts`, `LOGIN_REQUIRED` 상수)

| 라우트 | 줄 | 비고 |
|---|---|---|
| `GET /api/home` | 1555 | 스모크 기준 변경: 익명 200 → 401 |
| `GET /api/library` | 1962 | |
| `GET /api/tasks` | 1621 | |
| `GET /api/recordings` | 902 | |
| `GET /api/recordings/:id` | 920 | 공용 녹음 전사본도 로그인 뒤에만 |
| `GET /api/documents/coaching` | 2009 | 전사본 본문 포함 |
| `GET /api/documents/:id/download` | 2051 | 공용 문서도 로그인 뒤에만 |
| `GET /api/deck/:id` | 1712 | 공용 덱도 로그인 뒤에만 |
| `GET /api/seed` | 2188 | 규정 7건 전문 + 샘플 전사본 |

모두 `loggedInOrAdmin`(세션 또는 X-Admin-Secret) 게이트, 익명은 401. 문서도 갱신: `ARCHITECTURE.md` 3곳(익명 접근 설명·소유자 격리 표·공개 읽기 경로 + 스모크 기준), `DEMO-SCRIPT.md` 시드 항목(로그인 필요 명시).

### 남긴 공개 경로 (설계상)

익명에게 남는 것: `POST /api/ask`(+그 답의 whatif·피드백)·`/api/health`·`/api/config`·`/api/seed-status`·`/api/auth/*`·웹훅뿐. `GET /api/ask/:eventId/whatif`은 익명 질문의 답에만 닿고, 익명 이벤트는 본인 `sessionId` 상수 시간 비교로만 연다(로그인 사용자 이벤트는 소유자만). 그 밖의 읽기는 이미 로그인 필수였음을 라우트 전수 대조로 확인: `/api/gaps`(11-18 P1)·`/api/digest`(11-18 P0)·`/api/doc-jobs/:id`·`/api/pptx/versions`·`/api/xlsx/versions`·`/api/docx/jobs/:id`·`/api/docx/versions`(`pptxCaller`)·`/api/users/coaching`(세션)·`/api/debug-ai`·`/api/seed-vectors`(X-Admin-Secret).

### 검증

- `npx tsc --noEmit` 0건 (Merlin 직접).
- 라이브 버전 **`206c90da-0932-42f1-af22-feea4ba21847`** (2026-11-22T08:03:31Z). 익명 스모크 직접 확인: `/api/home`·`/api/library`·`/api/tasks`·`/api/recordings`·`/api/documents/coaching`·`/api/seed`·`/api/deck/fake123`·`/api/documents/fake123/download`·`/api/recordings/fake123` 전부 401, `/api/health` 200, 익명 `POST /api/ask`(빈 본문) 400 — 401이 아니라 입력 검증에서 걸림 (익명 질문 경로 유지).
- 로그인 사용자 라이브 확인 (완료, 2026-11-22 17:09~17:10): hr.jhkang으로 로그인해 홈(메일 0·할 일 3·문서 6·성찰 16)·라이브러리(파일 6·규정 7·성찰 16·답변 대기 1)·할 일(미완료 3·완료 1)·녹음전사(녹음 2·Plaud 연결) 모두 실제 데이터와 함께 정상 로드. 오류·로그인 반복·빈 화면 없음.
- SEC-EX-015는 해소되어 예외 목록에서 제외한다 (남은 예외 18건).
