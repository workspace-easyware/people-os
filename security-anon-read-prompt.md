# 익명 읽기 차단 (SEC-EX-015 해소) — Fable 5.2 지시문

## 목표

보안점검 결과(`files/workflow-verify/security-audit/RESULT.md` §5 SEC-EX-015, §2 10행)의 남은 Medium 항목을 해소한다. **익명이 공용 데이터를 읽는 길을 닫고, 읽기도 로그인 필수로 바꾼다.** 사용자 결정(2026-11-22): "익명 읽기도 막아줘 (로그인 필수로)".

## 범위 — 막을 것 (읽기 전용 엔드포인트)

코드를 직접 읽어 익명에게 데이터를 돌려주는 모든 읽기 엔드포인트를 찾아 `loggedInOrAdmin`(세션 또는 X-Admin-Secret) 게이트를 단다. RESULT.md가 지목한 것은 최소 집합이다:

- `GET /api/library`, `GET /api/home`, `GET /api/tasks`, `GET /api/recordings`, `GET /api/documents/coaching`(본문 포함)
- 공용 문서·덱 내려받기 (`GET /api/documents/:id/download`, `GET /api/deck/:id` 등 — 공용이어도 로그인 필요)
- 그 밖에 코드를 읽어 발견되는 익명 읽기 경로(채팅·회의·캘린더·강의실·워크플로우·관측 등 — 이미 로그인 필수인 곳은 건드리지 않고, 익명으로 읽히는 곳만 닫는다)

## 절대 건드리지 말 것 (설계상 공개)

- **익명 `POST /api/ask`** (Turnstile 게이트, HR 규정 검색 데모 창) — 401을 내면 안 된다. Turnstile 검증·입력 검증·속도 제한은 그대로.
- `GET /api/health`, `GET /api/config`, `/api/auth/*`(로그인·부트스트랩·재설정), `/api/meet/webhook`(RSA 서명 검증), 메일 수신 웹훅.
- 의심스러운 엔드포인트는 막지 말고 RESULT.md에 열린 질문으로 남긴다.
- 화면(`public/**`)은 이미 로그인 뒤에만 열리므로 API 변경이 원칙이다. 다만 로그인 전에 이 API를 부르는 화면이 있는지 확인하고, 있으면 그 화면도 함께 고친다.

## 검증

1. `npx tsc --noEmit` 0건.
2. 로컬 `wrangler dev --local` + `files/workflow-verify/security-audit/harness/seed.sql` 시드 계정(관리자·사용자 A·B)으로 확인:
   - 익명 GET `/api/home`·`/api/library`·`/api/tasks`·`/api/recordings`·`/api/documents/coaching`·공용 문서 다운로드 → 전부 401
   - 로그인 사용자 같은 호출 → 200 (정상 흐름 유지: 홈·라이브러리·할 일·녹음·성찰·공용 문서 내려받기)
   - 익명 `/api/ask`는 401이 아님 (Turnstile 단계까지 도달하거나 정상 응답 — 로컬에서 Turnstile을 우회할 수 없으면 그 지점까지 도달했음을 로그로 확인)
   - `/api/health` 200
3. 배포: `/home/hatch/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy` (직접 실행, 절대 경로, 직렬 — 다른 배포와 겹치지 않게). 배포 뒤 **약 3분 기다린 뒤** 라이브 스모크:
   - 익명 GET `/api/home`·`/api/library`·`/api/tasks` → 401 (이전 스모크 기준 200에서 바뀜)
   - 익명 공용 문서 내려받기 → 401, 익명 `/api/ask`는 401 아님, `/api/health` 200
   - 로그인 사용자 호출은 세션 토큰 파일이 `~/workspace/user`에 없을 수 있다 — 없으면 로컬 결과만으로 두고 RESULT.md에 명시한다 (Merlin이 브라우저로 추가 확인한다).

## 산출물

- `files/workflow-verify/security-audit/RESULT.md`에 **§11 익명 읽기 차단 (2026-11-22)** 절을 추가한다: 바꾼 라우트(파일:줄), 로컬·라이브 검증표, 바뀐 스모크 기준(익명 `/api/home` 200 → 401), 의도적으로 공개로 둔 엔드포인트와 이유, 동작 변화.
- 스모크 기준을 쓰는 다른 문서(ARCHITECTURE.md·VERIFICATION.md 등)에 익명 `/api/home` 200이 남아 있으면 그 문구도 갱신한다.
- **git add/commit/tag는 하지 않는다** (Merlin 몫). 모델·프롬프트·평가 기준은 건드리지 않는다. `src/meet/*`, `src/chat/*`, `public/meet.*`, `public/chat.js`, `public/approval.js`는 결함이 있을 때만 각별히 검증하며 수정한다.
- 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 하고, 읽기 전용·테스트 계정만 쓴다. 익명 쓰기 시도는 빈 본문으로만 하고 데이터를 만들지 않는다.
