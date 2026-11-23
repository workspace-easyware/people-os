# People OS 보안점검 체크리스트 (2026-11-22)

합동 기준. 오픈소스 표준 + 사용자 소유 표준 + Merlin 가드레일을 People OS(Cloudflare Workers + TypeScript + D1/R2/KV/Vectorize/DO/Queues)에 맞게 정리한 것.

## 출처

| 출처 | 버전/위치 | 비고 |
|---|---|---|
| OWASP ASVS | 4.0.3 / 5.0 (개발 중) | V1~V14, 레벨 1~3. People OS 목표: 레벨 2 (민감정보 다룸) |
| OWASP Top 10 | 2021 / 2025 | 2025 기준 A01~A10 (A03 Supply Chain, A06 Insecure Design 등) |
| OWASP API Security Top 10 | 2023 | BOLA/BFLA/BOPLA, 자원 고갈, SSRF |
| OWASP Cheat Sheet Series | — | ASVS가 "무엇"이면 치트시트는 "어떻게" |
| easy-standards `00-principles/02-security-owasp.md` | Junhokang452/easy-standards | Top 10:2025 + API Top 10:2023 + NIST SSDF + ASVS 5.0 + SLSA 1.2 |
| easy-standards `00-principles/01-identity-and-data.md` | 같은 레포 | UUIDv7 PK, tenant 스코프 + RLS, 캐시 키에 tenant 포함 |
| easy-standards `00-principles/12-sso-identity.md` | 같은 레포 | BFF 세션, httpOnly 쿠키, CSRF 토큰, CORS allowlist |
| Merlin 가드레일 | 시스템 프롬프트 Security 절 | 권한 경계, 비밀 취급, fail-closed (아래 §9) |

언어가 다르다(Java/Spring 기준)는 이유로 easy-standards를 그대로 옮기지 않는다. **원칙은 가져오고, 구현은 Workers/TS에 맞게 번역**한다. 예: `findByIdAndTenantId` → People OS의 `owner_id` 스코프 조회, `@PreAuthorize` → 라우트 진입점의 역할 게이트, RLS → D1 쿼리의 `owner_id = ?` 필터.

## 등급과 처리 원칙 (easy-standards §1 준용)

- **배포 차단 (예외 불가)**: 실제 Secret 노출, 인증/인가 우회, 재현 가능한 Injection/SSRF, 개인정보 대량 노출, 산출물 변조. 발견 시 즉시 수정하고, 수정 전에는 해당 기능을 끄거나 막는다.
- **High**: 차단 항목은 아니지만 외부 노출·개인정보·권한과 직접 연결. 이번 세션에서 수정.
- **Medium/Low**: 이번 세션에서 수정하거나, 수정하지 못하면 `SEC-EX-YYYYMMDD-001` 형식의 예외 기록(등급·영향·임시 보완통제·만료일·조치계획·승인자)을 RESULT.md에 남긴다.
- 실패 시 기본값은 **fail-closed**. 권한·결제·상태 검증을 건너뛰지 않는다.
- "아마 괜찮다"는 판정 금지. 각 항목은 코드 위치(파일:줄) + 재현/검증 방법으로 근거를 남긴다.

## 1. 인증 (ASVS V2 / Top 10 A07)

- [ ] 비밀번호는 강한 KDF로 저장. 평문·MD5·SHA-1·무염 SHA-256 금지. (easy-standards: bcrypt/Argon2id)
  - People OS 현재: PBKDF2-SHA256 10만 회 + 페퍼 HMAC. **점검 포인트: OWASP Password Storage 치트시트 기준 PBKDF2-HMAC-SHA256 권장 60만 회와 비교해 10만 회의 적절성을 평가하고, 올릴 경우 기존 해시 마이그레이션 경로(점진적 재해시)를 함께 제시할 것.**
- [ ] 로그인 실패 시 계정·IP 기준 rate limit + 지수 백오프. 성공/실패 응답·타이밍이 동일해 사용자 열거가 안 될 것.
  - 현재: 이메일+IP당 15분 8회 실패 시 429. 로그인 에러 메시지의 열거 여부를 코드에서 확인할 것.
- [ ] 세션 ID는 CSPRNG 128비트 이상. 로그인 성공 시 세션 재생성(고정 방지). 로그아웃 시 서버 세션 행 삭제.
  - 현재: 쿠키 `people_os_session`, HttpOnly/Secure/SameSite=Strict, 7일. `auth_sessions.expires_at`은 밀리초 단위. **점검: 로그인 시 토큰 재생성 여부, 로그아웃이 서버 행까지 지우는지, 비밀번호 변경이 다른 세션을 회수하는지.**
- [ ] 비밀번호 변경은 로그인 상태에서만, 변경 후에는 다른 세션 회수 여부를 정책으로 정할 것.
  - 현재: 아바타 메뉴 → `#pwDlg` → `POST /api/auth/change-password`. 회수 동작을 확인할 것.
- [ ] 비밀번호 정책: 최소 길이(12자 권장), breached-password 스크리닝 여부. 강제 로테이션·복잡도 규칙은 요구하지 않는다 (NIST 800-63B).
- [ ] 비밀번호 재설정 흐름이 있으면 시간 제한 토큰 + 일회용 + 추측 불가(CSPRNG/해시 저장).
- [ ] 관리자/배치/시스템 계정은 최소 권한. 권한 변경·관리자 행위는 감사 로그.
  - 현재: hr_admin 부트스트랩 계정 `hr.jhkang@peopleos.site`는 임시 비밀번호(공모전 후 변경 예정). **점검: 임시 비밀번호의 강도·변경 강제 여부, `BOOTSTRAP_SECRET`이 없을 때의 부팅 동작(fail-fast인지).**

## 2. 세션·쿠키·CSRF (ASVS V3 / easy-standards §6-A·§12)

- [ ] 인증 토큰은 **httpOnly + Secure 쿠키만**. `localStorage`/`sessionStorage`에 Bearer 토큰 저장 금지.
  - 현재: 쿠키 방식이라 이 항목은 충족. `public/*.js`에서 토큰을 스토리지에 쓰는 곳이 없는지 grep으로 확인할 것.
- [ ] 쿠키 속성: HttpOnly + Secure + SameSite=Strict(또는 Lax + CSRF 검증). `Domain` 지정 금지, `__Host-` 접두사 권장.
- [ ] **CSRF**: 상태 변경 API(POST/PUT/DELETE)는 SameSite만으로 끝내지 말고 CSRF 토큰(Double Submit Cookie) 적용 여부를 평가할 것.
  - 현재: SameSite=Strict이 1차 방어. easy-standards §12는 BFF 구조에서 상태 변경 API에 CSRF 토큰을 요구한다. **점검: SameSite=Strict만으로 충분한지, 교차 사이트 POST가 가능한 경로(폼·fetch)가 있는지, 토큰 도입이 필요한지 판단하고 필요하면 구현할 것.**
- [ ] CORS는 allowlist. 와일드카드 + credentials 금지. `Access-Control-Allow-Origin: *`가 인증 요청에 붙지 않을 것.
- [ ] 로그아웃은 local/global 구분. 퇴사·계정 잠금 시 모든 active session revoke 경로가 있을 것.
  - 현재: 로그아웃 시 `location.reload()`. 서버 세션 무효화 + 쿠키 삭제를 확인할 것.

## 3. 접근 통제 — 인가 (ASVS V4 / Top 10 A01 / API1 BOLA·API5 BFLA·API3 BOPLA)

- [ ] **모든 API는 서버에서 인가 검증. 기본 거부.** UI 버튼 숨김·클라이언트 역할 체크는 통제가 아니다.
- [ ] **객체 단위 소유권 검증 (IDOR/BOLA)**: `:id`가 붙은 모든 라우트에서 리소스를 resolve한 뒤 호출자가 그 객체에 접근할 수 있는지 확인할 것.
  - 점검 대상: 문서·녹음·덱·메일·할 일·워크플로우·런·채팅방·캘린더 일정·결재·코칭 성찰·라이브러리 파일·전사본. 특히 `owner_id`가 있는 테이블은 **모든 조회·수정·삭제 쿼리에 `owner_id = ?` 필터가 있는지** 전수 확인할 것 (easy-standards의 `findByIdAndTenantId`에 해당).
  - **주의: R2 `user_id/` 접두사 이관은 아직 안 된 상태(계획 3단계). R2 키를 직접 아는 사용자가 타인 파일을 받는 경로(다운로드 API)가 있는지 확인할 것.**
- [ ] **기능 단위 인가 (BFLA)**: 일반 사용자가 admin 전용 API를 호출할 수 없을 것. `X-Admin-Secret` 게이트(`/api/obs/*` 등)와 hr_admin 전용 엔드포인트(사용자 관리·암묵지 게시·관측)를 전수 확인할 것.
- [ ] **필드 단위 인가 (BOPLA / Mass assignment)**: 요청 본문의 화이트리스트 외 필드는 무시할 것. 특히 사용자가 자기 `role`·`coaching_role`·`owner_id`를 바꿀 수 있는 경로가 없는지 확인할 것.
- [ ] 코칭 역할(coach/coachee)은 서버 결정. 클라이언트가 보낸 역할 값을 신뢰하지 않을 것. (현재 서버 결정 — 코드로 재확인)
- [ ] 결재선·승인 결정은 본인 것만. 타인 대기 동작의 승인/거절이 막혀 있는지 확인할 것. (P2 결정 사항 — 코드로 재확인)

## 4. 입력 검증·인젝션 (ASVS V5 / Top 10 A03·A05)

- [ ] 모든 DB 접근은 파라미터 바인딩. 문자열 연결로 만든 SQL 금지. 동적 식별자(정렬 컬럼 등)는 allowlist 대조.
  - 점검: D1 쿼리 전수 grep (`ORDER BY ${` · `LIKE '%${` · 템플릿 리터럴 SQL). Vectorize 필터·FTS 쿼리도 포함.
- [ ] 입력은 allowlist/schema 기반 검증(타입·길이·형식·범위). 거부 우선, 새니타이즈는 보조.
- [ ] 출력은 맥락별 인코딩 (HTML/속성/JS/URL/JSON). `innerHTML`에 사용자·문서·전사본·메일 본문이 들어가는 곳을 전수 확인할 것 (XSS).
  - 점검: `public/*.js`의 `innerHTML`·`insertAdjacentHTML`·`document.write` 사용처 + 마크다운 렌더링 경로.
- [ ] 파일 업로드: 확장자 + MIME + **magic number** + 크기 상한 + 압축폭탄 검사.
  - 현재: Whisper 전사 상한 40MB, docx 20MiB, 이미지 장당 5MiB·합계 10MiB. **점검: 확장자만 보는지 매직 바이트까지 보는지, R2 키에 경로 탐색(`../`)이 가능한지, 업로드된 파일이 다운로드 시 어떤 Content-Type으로 나가는지.**
- [ ] 에러 응답에 내부 구현 미노출 (stack trace·SQL·내부 IP·경로).

## 5. 암호·비밀 관리 (ASVS V6 / easy-standards §6)

- [ ] **Secret fail-fast**: 암호화 키·JWT 시크릿·DB 비밀번호 등 critical 설정이 없으면 부팅 단계에서 중단. dev 편의 fallback 금지.
  - 점검: `BOOTSTRAP_SECRET`·`PASSWORD_PEPPER`·`AIG_LOGS_TOKEN`·`RTK_API_TOKEN`·Resend 키가 없을 때 Worker의 동작. `wrangler secret` 누락 시 조용히 돌아가는 경로가 있는지 확인할 것.
- [ ] Secret은 코드·설정·IaC·CI 변수 파일에 저장 금지. Secret Manager/Vault/Worker 시크릿만 사용. **오늘 gitleaks로 확인됨: 커밋 이력 100개 + 작업 트리에서 실제 비밀 0건 (2건은 테스트 픽스처 오탐).** 감사 세션은 `/tmp/gitleaks`로 재확인하고, 새로 생긴 파일도 스캔할 것.
  - 주의: `files/workflow-verify/decisions-2026-11-22/h/`·`pw-new.json`·`sess-*.json`은 미추적 임시 자격증명 파일이다. **절대 커밋·푸시하지 말 것.** (11-22 GitHub 스냅샷에서 제외됨을 원격에서 확인 완료.)
- [ ] 노출된 Secret은 삭제만 하지 말고 폐기·재발급·접근 로그 확인.
- [ ] 비밀/토큰은 평문 저장 금지. 토큰은 해시(SHA-256)로 저장. (현재 `auth_sessions.token_hash = sha256(토큰)` — 재확인)
- [ ] UUIDv7은 생성 시각을 노출하므로 비밀/토큰/공개 URL 식별자에 쓰지 말 것. 토큰은 CSPRNG 또는 해시. (easy-standards §01)

## 6. 설정·헤더 (ASVS V14 / Top 10 A02·A05)

- [ ] 운영 debug off, 보안 헤더 적용: `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors`, `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Referrer-Policy`.
  - **점검: `src/index.ts` 응답 헤더를 확인할 것. People OS는 단일 Worker가 HTML·API를 같이 내므로 헤더 누락이 있으면 추가할 것.**
- [ ] debug·임시·시험용 엔드포인트가 운영에 노출되지 않을 것 (`/api/debug`, dryrun 라우트, 하네스 라우트 등).
- [ ] 에러 처리는 공통 경로로, stack trace 미노출, fail-closed, timeout/retry/circuit breaker.
- [ ] 의존성: lockfile 고정, `npm audit` 실행, Critical/High 취약 의존성은 배포 차단 원칙으로 평가.
  - 점검: `package-lock.json` 존재 여부 + `npm audit --omit=dev` 결과. docx/xlvane/ooxml-core 등 문서 라이브러리 포함.

## 7. SSRF·외부 호출 (Top 10 A10 / API7)

- [ ] 사용자 제공 URL을 서버가 fetch하는 곳은 allowlist + 사설/메타데이터 IP 차단 + redirect 제한.
  - 점검 대상: 워크플로우 `webhook` 노드(사용자 지정 URL), `send_email` 외 외부 fetch, Plaud 가져오기, 이미지 URL(문서 생성 시 외부 URL 허용 여부 — 현재 라이브러리 R2 원본만 허용으로 알려짐, 재확인).
- [ ] 웹훅 수신은 서명 검증 (RealtimeKit `meeting.transcript` 웹훅, Plaud 콜백이 있다면).
  - 점검: `/api/meet/webhook`이 서명·토큰 없이 누구나 호출할 수 있는지, 호출 시 전사 큐에 임의 항목을 넣을 수 있는지.
- [ ] 외부 API 응답은 schema 검증 + timeout + circuit breaker. (Resend·Plaud·Google Calendar·RealtimeKit)
- [ ] Turnstile은 HR 규정 검색(`/api/ask`)에만 게이트. 익명 경로의 남용(무료 풀 소진) 가능성을 평가할 것.

## 8. 로깅·모니터링 (ASVS V7 / Top 10 A09 / easy-standards §7)

- [ ] 로그에 비밀번호·토큰·주민번호·카드번호·세션ID·Secret 미기록. 보안 이벤트는 누가/언제/무엇/결과.
  - 현재: `src/obs/mask.ts`에 PII 마스킹 + self-test 있음. **점검: 마스킹이 실제로 모든 로그 경로(ask trace·eval·tail·R2 trace JSON)에 적용되는지, trace에 사용자 질문 원문·문서 내용이 그대로 남는지.**
- [ ] 인증 실패·권한 실패·관리자 행위·민감정보 접근을 로깅하고 알림과 연계할 것.
- [ ] 로그 인젝션: 사용자 입력이 로그에 그대로 들어가는 곳은 개행·제어문자 처리.

## 9. AI/LLM (easy-standards §8 + People OS 고유)

- [ ] 시스템 프롬프트와 사용자 입력 분리 (prompt injection 전제). 모델 출력은 후처리 검증 + 권한 검증.
- [ ] RAG 결과는 **사용자 문서 접근 권한 기준 필터링**. (현재 `owner_id` + Vectorize `user_id` 필터 — 전수 재확인. 특히 HR 공용 풀과 개인 풀의 경계, `#upload`·`#personal` 관점 선택자.)
- [ ] LLM에 Secret/개인정보/평가·보상 원본을 불필요하게 전달 금지. (프롬프트에 시크릿·내부 토큰이 들어가는지 확인할 것.)
- [ ] 자동 실행(메일 발송·결재·데이터 변경)은 사람 승인 또는 정책 게이트. (P1~P3 승인 큐 — 우회 경로가 없는지 확인할 것. `requiresApproval` + 지연 agent 저장 거부 규칙 포함.)
- [ ] 에이전트 도구 호출의 멱등성·상한(스텝·LLM 호출·시간)이 우회되지 않을 것. (Think 런타임 캡 — 코드로 재확인)

## 10. 데이터 보호·파일·테넌시 (ASVS V8·V12 / easy-standards §01)

- [ ] 식별자는 UUID. 자연키(이메일 등)를 PK로 쓰지 않을 것. (D1 스키마 확인)
- [ ] 모든 사용자 스코프 테이블에 `owner_id` NOT NULL + `owner_id` 선두 인덱스. `findAll()` 후 앱 필터 금지.
- [ ] 캐시 키에 `owner_id` 포함. KV CACHE 키가 사용자별로 분리되는지 확인할 것.
- [ ] 계정 삭제·퇴사 시 세션 회수 + 개인 데이터 처리 경로가 있을 것 (없으면 Low로 기록).
- [ ] R2 객체 키는 추측 불가 + 소유권 검증. 다운로드 API가 키만으로 타인 파일에 접근하지 않을 것.

## Merlin 가드레일 (이 점검에 직접 적용)

- 권한은 사용자의 요청 안에서만. 이 점검은 사용자가 명시 지시한 작업이다. 점검 중 발견한 외부 전송(메일 발송 등)은 하지 않는다. 라이브 호출은 읽기 전용 + 이미 승인된 테스트 계정(hr.jhkang@peopleos.site)으로만.
- 비밀 값은 채팅·파일·메모리·로그에 적지 않는다. 검증은 해시·존재 여부·길이로만.
- 라이브 검증은 `https://people-os.workspace-easyware.workers.dev`로 (peopleos.site에 Cookie 헤더 curl은 프록시에서 멈춘다). 로그인 라이브 호출은 토큰 파일에서 읽은 세션 쿠키 1개로.
- 수정은 최소·국소적으로. 동작이 검증된 기능을 고치지 않는다. 모델 선택(Clef/clef-omni/llama-4-scout/whisper/bge-m3/qwen3.8-27b)은 건드리지 않는다.
- 배포는 직렬로. 배포 후 3분 뒤 스모크. 배포 전 `npx tsc --noEmit` 통과 필수.
- 커밋·태그는 Merlin이 직접 한다. 세션은 작업 트리 + RESULT.md만 남긴다.
