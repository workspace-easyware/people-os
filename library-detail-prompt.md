# 라이브러리 카드 상세 보기 (규정·성찰) — 프롬프트

## 목표
라이브러리 탭의 규정 카드(7건)와 성찰 카드(15건)를 누르면 전문이 보이게 한다.
사용자가 정한 방식: **모달 팝업이 아니라 전체 화면 전환** (관측·평가 탭의 드릴다운과 같은 패턴).
상단에 `<- 규정 목록` / `<- 성찰 목록` 뒤로가기 링크를 두고, 누르면 원래 카드 목록(같은 서브탭)으로 돌아간다.
답변 대기(knowledge gaps)는 이번 범위에서 **제외**한다. 이유: 카드에 이미 질문 전문·상태·메타가 다 보이고, hr_admin의 게시 폼도 카드 안에 있다. 상세 화면으로 옮기면 게시까지 클릭이 하나 더 늘어 손해만 있다. 숨은 본문 필드가 없어서 보여줄 추가 정보도 없다.

## 현재 상태 (확인됨)
- `public/index.html` `refreshLib()` (1644행 부근): 규정 카드는 `<div class="libcard"><h3>제목</h3><p>section</p>`만 있고 클릭 핸들러가 없다. 성찰 카드는 제목 + 첫 번째 패턴 1줄 + 메타(참여자·날짜)만 있고 클릭 핸들러가 없다.
- `src/index.ts` `GET /api/library` (2389행 부근):
  - 규정: `SELECT id, title, section FROM policies` — `body`를 안 보낸다.
  - 성찰: `SELECT r.id, r.session_id, r.patterns, r.next_questions, r.mode, r.created_at, ... FROM reflections` — `transcript`, `questions`를 안 보낸다.
- 원문은 이미 저장돼 있다 (마이그레이션·새 테이블 불필요):
  - `policies` 테이블: `id, title, section, body TEXT NOT NULL`. 본문은 평문 텍스트다 (예: 연차휴가 284자). 워드/PDF 같은 포맷 문제가 없다.
  - `reflections` 테이블: `transcript TEXT NOT NULL, questions, patterns, next_questions`. 가장 긴 전사문이 424자라 전부 짧다.
- 파일 목록 탭(문서·덱)은 건드리지 않는다. 답변 대기 탭도 건드리지 않는다.

## 구현
### 백엔드 (`src/index.ts`, `/api/library`만)
- 규정 SELECT에 `body`를 추가한다.
- 성찰 SELECT에 `transcript, questions`를 추가한다.
- 권한은 지금과 그대로: 성찰은 기존 `reflectionScope(viewer)`를 그대로 적용한다 (같은 행·같은 범위라 새 유출이 없다). 규정은 공용이라 로그인 사용자면 누구나 본문을 볼 수 있다. 익명은 기존 `loggedInOrAdmin` 401이 그대로 막는다.

### 프론트엔드 (`public/index.html`, `refreshLib` 주변만)
- 가져온 규정·성찰 목록을 JS 변수에 보관해 상세 화면을 이미 받은 데이터로 그린다 (상세 조회용 새 API 호출 불필요 — 본문이 짧다).
- 규정 카드와 성찰 카드에 클릭 동작을 단다. 마우스 호버 표시(커서 포인터 등)도 넣고, 키보드(Enter)도 가능하면 좋다.
- 클릭하면 라이브러리 탭 내용이 상세 화면으로 통째로 바뀐다 (서브탭 바와 카드 목록은 숨긴다). 관측·평가 탭(`public/obs/*`)의 드릴다운 패턴을 참고한다.
- 상세 화면 구성:
  - 맨 위: `<- 규정 목록` 또는 `<- 성찰 목록` 뒤로가기 링크(버튼).
  - 규정: 제목, 조항(section), 본문 전문(평문 — 줄바꿈을 살려 단락으로 보여준다).
  - 성찰: 제목(코칭 성찰 / 코칭 대상 자기 성찰), 참여자·날짜 메타, 패턴 전부(목록), 질문(있으면), 다음 질문 전부(목록), 전사문 전문.
  - 모든 텍스트는 기존 `esc()`로 이스케이프한다 (본문에 들어간 HTML이 실행되면 안 된다).
- 뒤로가기를 누르면 원래 카드 목록으로 돌아오고, 들어갔던 서브탭(규정/성찰)이 그대로 선택돼 있어야 한다.
- `refreshLib()`이 다시 그릴 때(게시 후 등) 상세 화면이 열려 있었다면 목록으로 돌아가도 된다. 단, 새로고침 버튼을 눌렀을 때 상세 화면이 깨지거나 빈 화면이 되면 안 된다.

## 하지 말 것
- 답변 대기 탭 변경 금지. 파일 목록 탭 변경 금지. `decisions-2026-11-22/h/` (임시 자격증명) 절대 건드리지 말 것. 메일 서식 편집기 파일(`public/email.css`·`public/email.js`·`public/email-rt.js` — 다른 채팅 작업, 미커밋)은 절대 건드리지 말고 커밋에 섞지 말 것.
- `src/ask-pipeline.ts`의 LLM 모델(qwen3.8-27b), Clef, whisper, bge-m3는 건드리지 말 것.
- 마이그레이션 추가 금지 (필요 없다).

## 검증 (반드시 수행)
1. `npx tsc --noEmit` 0건.
2. 로컬 `wrangler dev --local`로 `/api/library` 응답에 `policies[].body`, `reflections[].transcript`·`questions`가 들어오는지 확인.
3. 운영 배포 (`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행. 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 할 것).
4. 라이브 스모크: 로그인 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 할 것 (`peopleos.site`에 Cookie 붙인 curl은 샌드박스 프록시에서 멈춘다). 임시 사용자 방식이 필요하면 운영 D1 임시 사용자를 만들고 시험 뒤 전부 삭제해 개수를 대조할 것 (사용자 실데이터 무변경).
5. 결과 보고: `files/workflow-verify/library-detail/RESULT.md`에 구현 내용·검증 결과·배포 버전 ID·라이브 확인 결과를 기록한다. 화면(브라우저) 확인은 Merlin이 별도로 한다 — 세션은 API + 정적 파일 200까지만 확인한다.
6. 끝나면 `git add`는 하지 말고 변경 파일 목록과 커밋 메시지를 보고한다 (커밋·태그는 Merlin이 직접 한다).
