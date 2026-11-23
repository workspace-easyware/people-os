# 라이브러리 답변 대기 개수 + 해결된 답변 전문 보기 — 프롬프트

## 목표 (2건)
1. **개수 표시 고치기**: 답변 대기 탭 제목이 "답변 대기 질문 1건"인데 카드가 6장 보인다. 제목은 아직 안 열린 것(open)만 세고 목록엔 해결된 것까지 다 나오기 때문이다.
2. **해결된 답변 전문 보기**: 해결됨/답변 게시됨 상태의 카드만 누르면 전체 화면 상세로 게시한 답변 전문이 보인다 (규정·성찰 상세와 같은 패턴).

## 현재 상태 (확인됨)
- `public/index.html` `gapsSection()` (1585행 부근): 제목 `<h3>답변 대기 질문 ${openN}건</h3>` 뒤에 모든 gap 카드가 한 그리드에 나온다. open 카드에는 hr_admin용 게시 폼(답변 textarea + 게시하기)이 카드 안에 있고, 일반 사용자에게는 안내 문구만 보인다. resolved/published 카드에는 상태 배지 + `doc_title` + 안내 문구만 있고 답변 본문은 없다.
- `src/index.ts` `GET /api/gaps` (1445행 부근): `SELECT g.id, g.question, g.asked_at, g.status, g.doc_id, g.count, g.source, g.user_id, d.title AS doc_title, ...` — 답변 본문이 없다. `doc_id`는 게시된 암묵지 문서(documents, kind='tacit')를 가리킨다.
- 방금 만든 규정·성찰 상세 (`openLibDetail`/`closeLibDetail`, `#libDetail`/`#libMain`, 뒤로가기 버튼)를 재사용하거나 같은 패턴으로 확장한다.
- 같은 질문("출산 전후 재택 가능해요?")이 5개 행으로 나뉜 것(아쉬움 피드백 4건 + 근거 없음 1건)은 데이터 중복 문제라 이번에 합치지 않는다. 건드리지 말 것.

## 구현
### 1. 개수 표시 (프론트엔드만, `gapsSection`)
- 목록을 두 구역으로 나눈다:
  - **답변 대기 N건** — status='open'인 카드만. (N = open 개수)
  - **해결됨 M건** — status가 resolved 또는 published인 카드만. (M = 그 외 개수)
- 각 구역에 자기 개수 제목을 단다. 구역이 비어 있으면 그 구역은 표시하지 않는다 (예: 열린 게 없으면 "답변 대기 중인 질문이 없습니다." 문구만).
- 서브탭 버튼의 "답변 대기 (N)" 배지는 지금처럼 open 개수 그대로 둔다.
- 게시 폼·안내 문구·배지 등 카드 안의 내용은 그대로 둔다.

### 2. 해결된 답변 전문 보기
- **백엔드** (`src/index.ts`, `GET /api/gaps`만): 게시된 답변 본문을 응답에 포함한다. 먼저 게시 핸들러(`POST /api/gaps/:id/publish`, 1465행 부근)를 읽어 답변 본문이 어디에 저장되는지 확인한다 (documents.content인지 R2인지). `doc_id`가 있는 resolved/published 행에 한해 본문을 `answer` 필드로 포함한다. 본문이 없으면 `answer`는 null/빈 문자열. open 행에는 본문을 포함하지 않는다 (없으니까). 권한은 지금과 그대로 (로그인 사용자만, 익명 401).
- **프론트엔드** (`public/index.html`):
  - resolved/published 카드만 클릭 가능하게 한다 (규정·성찰 카드와 같은 `libcard-click`, `tabindex`, `role="button"`, Enter 지원, 포인터 커서·호버 표시).
  - 클릭하면 전체 화면 상세로 전환한다 (팝업 아님 — 기존 `#libDetail` 패턴 재사용). 맨 위 `<- 답변 대기 목록` 뒤로가기 버튼, 누르면 답변 대기 목록으로 돌아오고 같은 서브탭이 유지된다.
  - 상세 내용: 질문, 상태 배지, 메타(출처·질문받은 시각·질문 횟수·질문자), 게시된 문서 제목, **게시한 답변 전문**(줄바꿈 유지). 모든 텍스트는 기존 `esc()`로 이스케이프한다.
  - open 카드는 클릭 동작을 달지 않는다 (게시 폼이 카드 안에 그대로 있어야 한다).
  - `refreshLib()`이 다시 그릴 때 상세 화면이 열려 있었다면 목록으로 돌아가도 된다. 빈 화면이 되면 안 된다.

## 하지 말 것
- 게시 플로우(`POST /api/gaps/:id/publish`) 변경 금지. gap 행 합치기/삭제 금지. 규정·성찰 상세, 파일 목록 탭 변경 금지. `decisions-2026-11-22/h/` (임시 자격증명) 절대 건드리지 말 것. 메일 서식 편집기 파일(`public/email.css`·`public/email.js`·`public/email-rt.js` — 다른 채팅 작업, 미커밋)은 절대 건드리지 말고 커밋에 섞지 말 것.
- `src/ask-pipeline.ts`의 LLM 모델(qwen3.8-27b), Clef, whisper, bge-m3는 건드리지 말 것.
- 마이그레이션 추가 금지 (필요 없다).

## 검증 (반드시 수행)
1. `npx tsc --noEmit` 0건.
2. 로컬 `wrangler dev --local`로 `/api/gaps` 응답에 resolved 행의 `answer`가 들어오는지 확인.
3. 운영 배포 (`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행. 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 할 것).
4. 라이브 스모크: 로그인 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 할 것 (`peopleos.site`에 Cookie 붙인 curl은 샌드박스 프록시에서 멈춘다). 임시 사용자 방식이 필요하면 운영 D1 임시 사용자를 만들고 시험 뒤 전부 삭제해 개수를 대조할 것 (사용자 실데이터 무변경). 익명 `/api/gaps` 401 유지 확인.
5. 결과 보고: `files/workflow-verify/library-gaps/RESULT.md`에 구현 내용·검증 결과·배포 버전 ID·라이브 확인 결과를 기록한다. 화면(브라우저) 확인은 Merlin이 별도로 한다 — 세션은 API + 정적 파일 200까지만 확인한다.
6. 끝나면 `git add`는 하지 말고 변경 파일 목록과 커밋 메시지를 보고한다 (커밋·태그는 Merlin이 직접 한다).
