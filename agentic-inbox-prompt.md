# Agentic Inbox — People OS 이메일 기능 구현

## 목표
People OS Worker 안에 이메일 기능을 통합한다. Cloudflare가 오픈소스로 공개한 **Agentic Inbox**(Workers 위 셀프호스팅 이메일 시스템)를 참고하되, 별도 배포가 아니라 **People OS Worker 안에 통합**한다. 이미 등록된 도메인 peopleos.site의 수신은 Cloudflare Email Routing → Worker `email()` 핸들러로 받고, 발송은 **Resend HTTP API**로 한다.

## 배경 (이미 완료된 것)
- peopleos.site가 Cloudflare 계정(44501085a1a83d8c0f838a44c1800144)에 존으로 등록됨 (존 ID 3acfeb691d95f965a1b24e700bacf387, Free).
- 가비아에서 네임서버를 elma.ns.cloudflare.com / jeff.ns.cloudflare.com으로 교체 완료. 전파 대기 중 (1~2시간, 최대 24시간).
- 전파가 끝나면 존이 Active가 되고, 그때 Email Routing 활성화 + catch-all → people-os Worker 규칙을 만들 예정이다.
- Resend 등록은 별도로 진행 중 (도메인 인증용 DNS 레코드 + API 키 발급). API 키는 Worker 시크릿 `RESEND_API_KEY`로 저장할 예정이다.

## 참고할 공식 코드베이스 — Cloudflare Agentic Inbox
- Cloudflare 공식 오픈소스 저장소: **https://github.com/cloudflare/agentic-inbox** (Apache 2.0, Workers 위 셀프호스팅 이메일 클라이언트 + AI 에이전트).
- **이 저장소를 클론해 그대로 쓰는 것이 아니라, People OS 안에 통합하는 것이 목표다.** 다만 아래 패턴은 이 저장소를 참고해서 검증된 방식으로 구현할 것:
  - **메일 파싱**: `email()` 핸들러에서 수신 메일을 파싱하는 방식 (from/to/subject/body/attachments 추출). 저장소의 `workers/` 안 메일 파싱 코드를 읽고 같은 접근법을 쓸 것.
  - **저장 구조**: 메일 본문/첨부 저장 방식 (D1에 메타데이터 + R2에 첨부/본문). 저장소의 스키마와 R2 키 구조를 참고할 것.
  - **스레딩**: 같은 제목/참조로 메일을 스레드로 묶는 방식.
  - **주의**: Agentic Inbox는 메일함마다 Durable Objects + SQLite를 쓰지만, People OS는 **공유 D1 + owner_id** 방식을 쓴다 (개인 RAG와 동일). DO-per-mailbox 패턴은 가져오지 말 것. 또 Agentic Inbox는 Cloudflare Access으로 보호하지만, People OS는 **자체 로그인 세션**(`people_os_session` 쿠키)으로 보호한다. Access는 쓰지 말 것.
- 저장소를 먼저 클론해서 읽을 것: `git clone https://github.com/cloudflare/agentic-inbox.git /tmp/agentic-inbox-ref` (읽기 전용 참고용, People OS 코드에 복사하지 말 것 — 패턴만 참고).

## People OS 현재 구조
- 작업 디렉터리: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os/`
- Worker 1개. 바인딩: DB(D1 people-os-db), CACHE(KV), FILES(R2 people-os-files), VECTOR(Vectorize), AI(Workers AI), AGENT_SESSION(DO), PIPELINE(Queue).
- wrangler.toml에 바인딩 정의 있음. `src/index.ts`가 메인 라우터. `src/ask-pipeline.ts`, `src/auth.ts` 등.
- 로그인/권한: users 테이블, role(hr_admin/user), coaching_role. 세션 쿠키 `people_os_session`. owner_id로 개인 데이터 격리 (개인 RAG와 동일 패턴).
- 모델: 답변 Qwen3-30B-A3B, 임베딩 bge-m3, 전사 Whisper-large-v3-turbo.

## 구현 범위 (Phase 1 — 코어)
1. **D1 마이그레이션** (`migrations/0022_email.sql`):
   - `emails` 테이블: id, owner_id (수신자 사용자, NULL이면 공용/미지정), from_addr, to_addr, cc, subject, body_text, body_html, received_at, message_id, thread_id, is_read, is_starred, labels, created_at.
   - `email_attachments` 테이블: id, email_id, filename, content_type, size, r2_key.
   - 인덱스: owner_id, received_at, thread_id.
   - 기존 마이그레이션 번호 확인 후 다음 번호 사용 (0021까지 있음). `d1_migrations` 기록 방식은 기존 패턴 따를 것.
2. **Worker `email()` 핸들러** (wrangler.toml에 `email` 핸들러가 없으면 추가 — Email Routing → Worker 라우팅용):
   - 수신 메일을 파싱 (from/to/subject/body/attachments).
   - 수신자 주소로 owner_id 결정: `이름@peopleos.site` 형태에서 로컬 파트를 사용자 이메일 앞자리 또는 users 테이블과 매칭. 매칭 안 되면 owner_id NULL (공용/미지정)로 저장.
   - D1 `emails`에 저장, 첨부파일은 R2 `emails/<emailId>/` 접두사에 저장.
   - 실패 시에도 메일이 소실되지 않게: 파싱 실패하면 원문이라도 저장 (raw 저장 컬럼 또는 R2).
3. **발송 — Resend HTTP API**:
   - `POST https://api.resend.com/emails` + `Authorization: Bearer <RESEND_API_KEY>` (Workers는 SMTP 25번 차단이라 HTTP API만 가능).
   - `src/email/send.ts` (또는 적당한 위치)에 `sendEmail({from, to, subject, text, html})` 함수. from은 `이름@peopleos.site` 형태.
   - API 키는 `env.RESEND_API_KEY`에서 읽음. 키가 없으면 503 + "Resend 미설정" 메시지 (fail-open이 아니라 명시적 오류).
4. **API 라우트** (로그인 필수, owner_id 격리 — 개인 메일은 본인만, hr_admin은 전체):
   - `GET /api/email/inbox` — 받은 메일 목록 (페이지네이션, 최신순, owner_id 필터).
   - `GET /api/email/:id` — 메일 상세 (본문 + 첨부 목록).
   - `GET /api/email/:id/attachment/:attId` — 첨부 다운로드 (R2에서, 소유자/hr_admin만).
   - `POST /api/email/send` — 메일 발송 (Resend 경유). body: {to, subject, text, html?}.
   - `POST /api/email/:id/read` — 읽음 표시. `POST /api/email/:id/star` — 별표 토글.
   - `GET /api/email/search?q=` — 제목/본문/발신자 검색 (D1 LIKE + 필요 시 Vectorize는 Phase 2).
5. **프론트엔드 — 메일함 메뉴**:
   - 사이드바에 "메일함" 메뉴 추가 (data-tab="email").
   - 목록 뷰: 발신자, 제목, 날짜, 읽음/안읽음 표시, 별표.
   - 상세 뷰: 본문 표시 + 첨부 다운로드 링크.
   - 작성 뷰: 받는 사람, 제목, 본문 입력 + 발송 버튼.
   - 검색 입력창.
   - 기존 디자인 시스템 유지 (Langfuse 스타일, 네이비 #123863, 테두리 #E4E4E7).
6. **검증**:
   - `npx tsc --noEmit` 0 오류.
   - wrangler deploy 후 라이브 확인: API 라우트가 401(익명)/200(로그인)으로 동작하는지.
   - 실제 수신 테스트는 존 Active + Email Routing 활성화 후에 가능하므로, 지금은 `email()` 핸들러가 배포되고 라우트가 응답하는 것까지 확인.

## 구현 범위 (Phase 2 — Agentic Inbox의 AI 부분, Phase 1이 끝나면 이어서)
- AI 답장 초안: 받은 메일 본문을 Qwen3에 보내 답장 초안 생성 (초안은 저장만, 발송은 사람 확인 필수).
- 메일 내용을 개인 RAG에 색인 (선택): 중요 메일을 개인 DB에 넣어 검색 가능하게.
- MCP 서버는 이번 범위 밖.

## 주의사항
- **절대 금지**: 기존 RAG/로그인/코칭/평가 기능을 깨뜨리지 말 것. 기존 라우트와 충돌하지 않게.
- owner_id 격리는 개인 RAG와 동일 원칙: 한 사용자의 메일은 그 사용자(와 hr_admin)만 본다. 공용 메일(owner_id NULL)은 hr_admin만 본다.
- Resend API 키를 코드나 마이그레이션에 하드코딩하지 말 것. `env.RESEND_API_KEY`로만 읽는다.
- 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 (직접 실행, python3 접두 금지). `npx wrangler`는 비대화형에서 토큰이 없어 실패한다.
- D1 마이그레이션은 원격 적용 전 `cf-wrangler.py d1 migrations list people-os-db --remote`로 확인하고, 단일 파일은 `d1 execute --remote --file migrations/<f>.sql -y`로 적용 후 `INSERT INTO d1_migrations(name)`으로 기록.
- 배포 후 버전 ID와 검증 결과를 보고할 것.
