# Agentic Inbox 저장소 직접 참조 — People OS 이메일 비교·개선

## 배경
- 직전 두 세션에서 People OS 이메일 기능을 구현·배포하고 MIME 파서를 개선했다. 현재 라이브 버전 `1854d508-9750-45a9-ae7b-f7c704e2adf2`.
- 그 세션들은 `git clone`/WebFetch/`npm install` 권한이 없어서 Cloudflare 공식 Agentic Inbox 저장소를 직접 읽지 못했다.
- **이번에는 저장소를 VM에 직접 다운로드해뒀다: `/home/hatch/workspace/agentic-inbox-ref`** (이 세션의 `--add-dir`에 포함되어 있으니 직접 읽을 수 있다). `git clone`을 다시 할 필요는 없다. 이 디렉터리를 읽어서 참고할 것.

## 할 일
1. **저장소 읽기** (`/home/hatch/workspace/agentic-inbox-ref`, Apache 2.0):
   - `workers/index.ts` — `receiveEmail()` 수신 처리 (PostalMime 파싱, 수신자 매칭, 첨부 저장, 스레딩, AI 에이전트 트리거).
   - `workers/lib/email-helpers.ts` — 스레딩(buildReferencesChain, buildThreadingHeaders), 발신자 검증, HTML 유틸, 인용 답장 블록.
   - `workers/lib/attachments.ts` — 첨부 저장 (파일명 sanitization, R2 키 구조).
   - `workers/db/schema.ts` — emails/attachments/folders 스키마.
   - `workers/email-sender.ts` — 발송 (Cloudflare Email Service 바인딩 — People OS는 Resend를 쓰므로 발송 방식은 참고만).
   - `workers/durableObject/index.ts` — DO per-mailbox 구현 (읽기만 할 것, 가져오지 말 것).
   - `workers/routes/reply-forward.ts` — 답장/전달 처리.
   - `package.json` — 의존성 목록 (특히 `postal-mime` 버전).
2. **현재 People OS 이메일 코드와 비교** (`src/email/`):
   - `src/email/mime.ts` (직접 작성한 의존성 없는 MIME 파서) — PostalMime이 처리하는 것과 비교해, 우리 파서가 놓치고 있는 케이스가 있는지 찾아낸다. 특히: 인코딩된 단어 분할, charset 처리, multipart 경계, 첨부 파일명, Content-ID/inline 구분.
   - `src/email/inbound.ts` — 수신 처리. 저장소의 `receiveEmail()`과 비교: 크기 제한(저장소는 25MB), 수신자 매칭, 없는 메일함 처리, 날짜(저장소는 수신 시각 사용), raw_headers 저장, 스레딩 폴백(findThreadBySubject).
   - `src/email/send.ts` — 발송. 저장소는 Cloudflare Email Service를 쓰지만 People OS는 Resend를 쓴다. 발송 방식은 바꾸지 않고, 스레딩 헤더(In-Reply-To/References) 구성 방식만 비교한다.
   - `src/email/routes.ts` — API. 저장소의 폴더/스레드/검색 API와 비교해 빠진 유용한 기능이 있는지 본다.
   - 스키마 비교: 저장소 emails 테이블에는 `direction`, `parse_error`, `subject_norm`, `provider_id` 같은 컬럼이 없다. 우리가 추가한 컬럼이 과한지, 저장소 방식이 더 나은지 판단한다.
3. **개선 적용 (검증된 패턴만, 아키텍처는 유지)**
   - 절대 바꾸지 않을 것:
     - **공유 D1 + owner_id** (개인 RAG와 동일). DO-per-mailbox는 가져오지 않는다.
     - **자체 로그인 세션**(`people_os_session` 쿠키). Cloudflare Access는 쓰지 않는다.
     - **발송은 Resend HTTP API**.
   - `postal-mime` 의존성을 추가할지 판단한다. 지금은 `Bash(npm install *)` 권한이 settings.json에 추가되어 있다. 추가하는 게 우리 직접 작성 파서보다 명확히 나으면 추가하고, 아니면 직접 파서를 고치는 쪽을 택한다. 판단 근거를 보고에 적는다.
   - 기존 테스트(한글 제목/본문, EUC-KR, 한글 첨부 파일명, 스레딩, 25개 MIME 테스트)가 깨지지 않게 한다.
4. **검증 및 배포**
   - `npx tsc --noEmit` 0 오류.
   - 변경이 있으면 배포하고 버전 ID를 보고한다. 변경이 없어도 그 결론과 근거를 보고한다.
   - 익명 401, 기존 `/api/health` 200이 그대로인지 확인한다.
   - 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 (직접 실행, python3 접두 금지). D1 마이그레이션이 필요하면 기존 방식(apply 전 migrations list 확인, 단일 파일은 d1 execute --file + d1_migrations 기록)을 따른다.

## 보고할 것
- 저장소에서 읽은 파일과 참고한 패턴 목록.
- 바꾼 코드와 바꾼 이유 (또는 바꾸지 않은 이유).
- `postal-mime` 의존성 추가 여부와 판단 근거.
- 배포 버전 ID와 검증 결과.
