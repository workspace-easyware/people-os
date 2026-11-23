# People OS 보안점검 + 수정 프롬프트 (Fable 5.2 세션)

## 작업

People OS 코드 전체에 대해 보안점검을 하고, 발견한 개선사항을 직접 수정한다.
점검 기준은 `files/workflow-verify/security-audit/SECURITY-CHECKLIST.md` (OWASP ASVS 4.0.3/Top 10 2021·2025/API Security Top 10 2023 + easy-standards 02·01·12 + Merlin 가드레일 합동본)이다.
체크리스트의 각 항목을 코드 위치(파일:줄) + 재현/검증 방법으로 근거를 남기며 전수 점검한다.

## 대상 코드 (레포 루트: 이 디렉터리)

- `src/**` (Worker 본체, TypeScript) — 라우트·인증·인가·D1 쿼리·R2·KV·Vectorize·Queues·DO·워크플로우·에이전트·메일·캘린더·결재·채팅·화상회의 웹훅 전부
- `public/**` (프런트 JS/CSS/HTML) — `innerHTML`·토큰 저장·CSRF 관련 포함
- `wrangler.toml`, `migrations/*.sql`, `package.json`, `package-lock.json`
- `files/workflow-verify/security-audit/SECURITY-CHECKLIST.md` — 점검 기준 (이 파일 자체도 읽을 것)

먼저 `ARCHITECTURE.md`와 `VERIFICATION.md`를 읽어 구조·인증 모델·검증 이력을 파악한다.

## 알려진 사실 (재확인 대상 — 맹신 금지)

- 인증: PBKDF2-SHA256 10만 회 + 페퍼 HMAC, 쿠키 `people_os_session` HttpOnly/Secure/SameSite=Strict 7일, `auth_sessions.expires_at`은 밀리초. 로그인 실패 이메일+IP당 15분 8회 시 429. 첫 HR admin `hr.jhkang@peopleos.site` (임시 비밀번호, 공모전 후 변경 예정).
- 인가: 역할 hr_admin/user, coaching_role은 서버 결정. 개인 RAG는 D1 `owner_id` + Vectorize `user_id` 필터로 격리. 공용 벡터는 `user_id:"shared"`. 암묵지 게시는 hr_admin 전용. 승인 큐(P1~P3): `requiresApproval` + 지연 agent 저장 거부, hr_admin은 타인 결정 불가.
- 속도 제한: 개인 검색 분당 20회, DO 정밀 리미터(동시 30건 중 20 허용), 수동 평가 하루 5회, 워크플로우 동시 3·하루 20·run당 30분.
- Turnstile은 HR 규정 검색(`/api/ask`)에만 게이트. 개인 검색은 로그인 필수.
- PII 마스킹: `src/obs/mask.ts` + self-test 있음.
- 문서 처리: Whisper 40MB 상한, docx 20MiB, 이미지 장당 5MiB·합계 10MiB(라이브러리 R2 원본만).
- 오늘(2026-11-22) gitleaks 검사 완료: 커밋 이력 100개 + 작업 트리에서 실제 비밀 0건 (2건은 테스트 픽스처 오탐: `src/obs/mask.ts:101`, `src/index.ts`의 `r2_key` 변수명). `/tmp/gitleaks` 바이너리(8.28.0)가 있으니 수정 뒤 다시 스캔할 것.
- R2 `user_id/` 접두사 이관은 아직 안 됨. R2 키 소유권 검증을 특히 볼 것.
- 라이브 버전: `f578ee4d` (표현 수정). 운영 Worker `people-os`, 편집 Worker `people-os-doc-editor`.

## 건드리지 말 것

- LLM 모델 선택: `@cf/qwen/qwen3.8-27b`(주 답변), Clef/clef-omni(판정), llama-4-scout(JUDGE), whisper-large-v3-turbo, bge-m3. 모델·프롬프트 버전·평가 기준을 바꾸지 않는다.
- `src/meet/*`, `src/chat/room.ts`, `src/chat/routes.ts`, `public/meet.*`, `public/chat.js`, `public/approval.js` — 화상회의 V2·채팅 핵심 파일. 보안 결함이 여기 있으면 수정하되, 수정 전후 동작을 로컬 + 라이브로 각별히 검증한다.
- 비밀 값은 어떤 파일에도 적지 않는다. 검증은 해시·존재 여부·길이로만.
- 동작이 검증된 기능을 고치지 않는다. 수정은 최소·국소적으로.

## 방법

1. **정적 점검**: 체크리스트 항목별로 `src/**`·`public/**`를 전수 검토. 특히: 모든 `:id` 라우트의 소유권 검증, D1 쿼리의 문자열 연결, `innerHTML` 사용처, 보안 헤더, CORS, CSRF, 업로드 검증(매직 바이트), 웹훅 서명, 외부 fetch(SSRF), 비밀 fail-fast, KV 키 스코프, 에러 응답 내용.
2. **의존성**: `npm audit --omit=dev` 실행. Critical/High는 평가해서 보고한다.
3. **라이브 확인 (읽기 전용 + 테스트 계정만)**: 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다 (`peopleos.site`에 Cookie 헤더 curl은 샌드박스 프록시에서 멈춘다). 로그인 필요 시 `~/workspace/user`에 있는 토큰 파일을 읽어 `cookie: people_os_session=<토큰>` 1개로 호출한다 (`S=$(cat <토큰 파일>); curl -H "cookie: people_os_session=$S" <URL>` 형태 1개씩). **메일 발송·결재 승인·데이터 삭제 같은 부작용 호출은 하지 않는다.** IDOR 확인은 본인 계정의 리소스 ID를 바꾸는 식의 읽기 시도까지만 하고, 타인 데이터가 보이면 거기서 멈추고 기록한다.
4. **수정**: 배포 차단·High는 이번 세션에서 직접 수정. Medium/Low는 수정하거나, 못 고치면 예외 기록(SEC-EX 형식)으로 RESULT.md에 남긴다. 수정마다 `npx tsc --noEmit` 통과.
5. **로컬 검증**: 수정한 경로는 로컬 `wrangler dev --local --port <포트> --persist-to <작업 폴더>`로 재현·확인한다 (`npx wrangler dev --local` — `--local`이 `dev` 바로 뒤). 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/..."`.
6. **배포**: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행 (python3 경유·env 접두어 금지). 배포는 직렬로, 한 번에 하나. 배포 후 **3분 뒤** 스모크 (배포 뒤 약 2분은 옛 버전이 응답한다).
7. **라이브 스모크**: 배포된 버전으로 수정한 보안 항목이 실제로 동작하는지 확인 (예: 헤더 확인은 익명 curl, 인가 확인은 테스트 계정 호출). 버전 ID를 기록한다.

## 산출물

- 수정된 코드 (작업 트리에 남긴다 — **git add·commit·tag는 하지 않는다.** Merlin이 직접 커밋한다.)
- `files/workflow-verify/security-audit/RESULT.md` — 항목별 판정표(체크리스트 항목 × 판정 × 근거 파일:줄 × 수정 여부), 발견된 취약점의 심각도·재현 방법·수정 내용, 배포 버전 ID, 라이브 스모크 결과, 남은 예외(SEC-EX) 목록, gitleaks 재스캔 결과, `npm audit` 결과.
- 수정하지 않은 Medium/Low는 이유와 함께 RESULT.md에 남긴다. "아마 괜찮다"는 판정은 쓰지 않는다.

## 환경·권한 주의

- 프롬프트는 stdin으로 받았다. `--add-dir`에 있는 경로만 읽고 쓸 수 있다.
- `node <스크립트>`·`python3 -c`·`sed`·`openssl`·`unzip`·`cp -r`·`mv`·`git add`는 막힌다. 파일 편집은 Edit 도구로, 긴 대기는 백그라운드 `sleep`으로, ZIP 부품은 Worker 라우트로 확인한다.
- `wrangler d1 execute --file`은 SELECT 결과를 보여주지 않는다. 확인 쿼리는 `--command "<SQL>" --json`으로 한다.
- D1 원격 조회 도우미 `python3 ~/workspace/d1q.py "<SQL>"` (읽기 전용). D1 쓰기는 `cf-wrangler.py d1 execute people-os-db --remote --command "<SQL>" -y` (수정이 필요할 때만, 최소로).
- 런타임 재시작이 백그라운드 exec를 죽일 수 있다. 작업물은 워크스페이스 안에 두고, RESULT.md는 중간중간 저장한다.
