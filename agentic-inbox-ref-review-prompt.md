# Agentic Inbox 참고 저장소 재검토 — People OS 이메일 개선

## 배경
- 직전 세션에서 People OS에 이메일 기능(Phase 1 + Phase 2)을 구현해 배포했다. 라이브 버전 `6132016e-54ca-4d6c-97b0-cec5f72575b7`.
- 그 세션에서 Cloudflare 공식 Agentic Inbox 저장소를 참고하려 했으나 `git clone`, WebFetch, `npm install postal-mime`이 승인 문제로 막혀서 저장소를 읽지 못했다. 대신 의존성 없는 MIME 파서(`src/email/mime.ts`)를 새로 작성했고, 한글 테스트는 통과했지만 실제 메일의 이상한 형식에 대한 검증은 안 됐다.
- **사용자가 지금 git clone과 npm install을 명시적으로 승인했다.** 다시 저장소를 참고해서 개선할 것.

## 할 일
1. **저장소 클론 및 읽기**
   - `git clone https://github.com/cloudflare/agentic-inbox.git /tmp/agentic-inbox-ref` (읽기 전용 참고용).
   - 저장소의 `workers/` 안 메일 파싱 코드, 저장 구조(D1 스키마, R2 키 구조), 스레딩 로직을 읽는다.
   - 필요하면 `npm install postal-mime`으로 해당 라이브러리의 파싱 방식을 참고한다 (People OS 코드에 의존성을 추가할지는 아래 기준에 따라 판단).
2. **현재 People OS 이메일 코드 검토** (`src/email/`):
   - `src/email/mime.ts` (직접 작성한 MIME 파서) — 저장소의 파싱 방식과 비교해, 실제 메일에서 자주 나오는 엣지 케이스(다중 파트, 인코딩 변형, 깨진 헤더, 첨부 파일명 인코딩 등)를 놓치고 있는 부분이 있는지 찾아낸다.
   - `src/email/inbound.ts` (email() 핸들러, 수신·저장), `src/email/send.ts` (Resend 발송), `src/email/routes.ts` (API).
3. **개선 적용 (검증된 패턴만)**
   - MIME 파서 등에서 저장소의 검증된 패턴이 우리 코드보다 나으면 그 부분을 개선한다. 단, 아래 아키텍처는 절대 바꾸지 않는다:
     - **공유 D1 + owner_id** (개인 RAG와 동일). Agentic Inbox의 DO-per-mailbox 패턴은 가져오지 않는다.
     - **자체 로그인 세션**(`people_os_session` 쿠키). Cloudflare Access는 쓰지 않는다.
     - **발송은 Resend HTTP API** (Cloudflare Email Sending이 아님).
   - `postal-mime` 같은 의존성을 추가하는 것보다, 지금처럼 의존성 없는 파서를 유지하면서 저장소의 로직만 참고해 고치는 쪽을 우선한다. 의존성을 추가해야 할 합리적 이유가 있으면 그 이유를 보고에 적고 추가한다.
   - 기존 테스트(한글 제목/본문, EUC-KR, 한글 첨부 파일명, 스레딩)가 깨지지 않게 한다.
4. **검증 및 배포**
   - `npx tsc --noEmit` 0 오류.
   - 변경이 있으면 배포하고 버전 ID를 보고한다. 변경이 없어도(저장소 패턴이 이미 우리 코드와 동등하거나, 가져올 게 없다고 판단되면) 그 결론과 근거를 보고한다.
   - 익명 401, 기존 `/api/health` 200이 그대로인지 확인한다.
   - 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 (직접 실행, python3 접두 금지). D1 마이그레이션이 필요하면 기존 방식(apply 전 migrations list 확인, 단일 파일은 d1 execute --file + d1_migrations 기록)을 따른다.

## 보고할 것
- 저장소에서 참고한 파일/패턴 목록.
- 바꾼 코드와 바꾼 이유 (또는 바꾸지 않은 이유).
- 배포 버전 ID와 검증 결과.
- 테스트용 .eml 파일은 `files/email-test/`에 있다 (직전 세션에서 만들었으나 커밋 안 됨).
