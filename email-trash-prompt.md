# 메일 삭제 + 휴지통 — Sonnet 세션 프롬프트

## 배경

사용자가 직접 보고한 문제: 메일에 삭제 기능이 없는 것 같다. 확인 결과 정말 없다.

## 현재 코드 (Merlin이 직접 확인함 — 다시 읽어 대조할 것)

- 메일 폴더는 3개뿐: 받은 메일(in)·별표(starred)·보낸 메일(out). 탭 `public/index.html:379-381`, 상태 `public/email.js:3` (`emailFolder`), 전환 `emailSetFolder` (aria-selected 목록 `['in','starred','out']`).
- API (`src/email/routes.ts`, 367행): GET /inbox?folder=, GET /search, POST /send, POST /admin/ingest, GET /:id, GET /:id/attachment/:attId, POST /:id/read, POST /:id/star, POST /:id/draft, POST /:id/index. **삭제 관련 엔드포인트가 하나도 없다.**
- 스키마 (`migrations/0022*.sql`): `emails` 테이블에 `deleted_at` 컬럼 없음. 관련 필드: `owner_id`, `direction` in/out, `is_read`, `is_starred`, `raw_r2_key` (원문 `emails/<id>/raw.eml`), `indexed_doc_id` (개인 RAG 색인 시 만든 documents.id — 메일이 개인 RAG에 색인돼 있을 수 있음). 첨부파일은 `email_attachments` 테이블 + R2 (`r2_key`).
- `GET /inbox`는 `listQuery(c, v, extra, [])`로, `extra`가 폴더 필터다 (`out` → direction='out', `starred` → is_starred=1, 그 외 → direction='in'). `GET /search`도 `listQuery`를 쓴다.
- 최신 마이그레이션은 0046. 크론은 `*/15 * * * *` 틱이 이미 있고(`scheduled()` in `src/index.ts`), 다이제스트·평가는 그 안에 얹혀 있다. **새 크론 트리거를 추가하지 말 것** (Free 플랜 Cron Trigger 계정당 5개 한도 — 캘린더 C5 때 확립한 방식: 새 크론 대신 기존 틱에 얹는다).
- 확인 다이얼로그는 네이티브 `confirm()` 금지 — `uiConfirm()`을 쓴다 (2026-11-22 결정). 토스트는 기존 메일 UI가 쓰는 방식(`ntfToast`/`uiToast` 중 해당 파일 패턴)을 따른다.

## 할 일 (Gmail식 표준 로직 — 사용자가 원한 그대로)

### 1. 마이그레이션 0047 (`migrations/0047_email_trash.sql`)
- `emails`에 `deleted_at TEXT` 컬럼 추가 + `(deleted_at)` 인덱스.
- 원격 적용 전 `migrations list --remote`로 0047 미적용을 확인할 것 (0017 out-of-band 전례). `ensureSchema()`가 emails 테이블을 만드는지 확인할 것 — 만든다면 거기에도 `deleted_at`을 추가할 것 (로컬 dev DB가 깨지지 않게).

### 2. API (`src/email/routes.ts`)
- `POST /api/email/:id/delete` — 소프트 삭제: `deleted_at = 현재 시각(UTC)`. 소유권 규칙은 기존 엔드포인트(`/:id/read` 등)가 쓰는 `viewerOf` + 스코프 규칙과 동일하게 (본인이 볼 수 있는 메일만 삭제 가능). 없거나 권한 없으면 404. 이미 삭제된 메일은 멱등하게 ok 반환.
- `POST /api/email/:id/restore` — `deleted_at` 해제 (원래 폴더로 복귀, direction 기준). 삭제된 상태가 아니면 400.
- `POST /api/email/:id/purge` — 완전 삭제 1건. `deleted_at`이 설정된 메일에만 허용 (아니면 400). 아래 3번 정리 로직을 쓴다.
- `POST /api/email/trash/empty` — 뷰어의 휴지통 전체 완전 삭제 (inbox와 같은 스코프 규칙). 아래 3번 정리 로직을 각 메일에 적용.
- `GET /inbox?folder=trash` — 삭제된 메일 목록 (`deleted_at` 내림차순). 그 외 모든 폴더(in/out/starred) + `GET /search`는 `deleted_at IS NULL` 조건을 추가해 휴지통 메일을 제외한다. 홈의 안 읽은 메일 수·최근 메일은 기본 inbox 쿼리를 쓰므로 자동으로 제외된다.
- `GET /:id` — 휴지통 메일도 상세 조회 가능하게 (소유권 동일). 상세에서 복원·완전 삭제 버튼을 보여주려면 필요하다.

### 3. 완전 삭제 정리 (공통 헬퍼로 만들 것, 예: `purgeEmail`)
- `email_attachments` 행 삭제 + 각 첨부 R2 객체 삭제.
- 원문 R2 객체(`raw_r2_key`) 삭제.
- `indexed_doc_id`가 있으면 해당 개인 RAG 문서를 purge할 것 (기존 `purgeDocument` 내부 함수를 재사용 — 벡터·청크·doc_nodes까지 지워지는지 확인할 것). HTTP 경유가 아니라 내부 함수 호출로 한다.
- 마지막으로 `emails` 행 삭제. 없는 R2 객체는 무시하고 진행 (멱등성).

### 4. 자동 완전 삭제 (7일)
- 기존 `scheduled()` `*/15` 틱 안에 얹을 것: `deleted_at`이 7일보다 오래된 휴지통 메일을 3번 정리 로직으로 완전 삭제. 매 틱마다 인덱스 탄 DELETE 한 번이면 되니 틱마다 실행해도 되고, 시간 단위로 게이트를 둬도 된다 — 세션이 정한다. 단, 새 크론 트리거 추가 금지.

### 5. UI (`public/email.js` + `public/index.html`)
- 폴더 탭에 "휴지통" 추가 (받은 메일 옆 — `emailFolder-trash`, `emailSetFolder`의 aria-selected 목록에 `'trash'` 추가).
- 휴지통 목록 행: 삭제일 + "N일 후 완전 삭제" 표시 (7일 기준 남은 일수).
- 상세 화면(`emailView`): 일반 폴더에서는 "삭제" 버튼, 휴지통에서는 "복원" + "완전 삭제" 버튼.
- 휴지통 폴더 상단에 "휴지통 비우기" 버튼 (휴지통이 비어 있지 않을 때만).
- 확인창 문구: 삭제 "휴지통으로 이동합니다. 계속할까요?", 완전 삭제 "완전히 삭제합니다. 복구할 수 없습니다. 계속할까요?"(danger), 비우기 "휴지통을 모두 비웁니다. 복구할 수 없습니다. 계속할까요?"(danger). 성공 시 토스트.
- 삭제·복원·완전 삭제·비우기 뒤에는 목록 + 홈 카운트를 새로고침한다 (기존 star/read 뒤 새로고침 방식을 따른다).
- UI 문구는 전부 한국어. 모바일 2줄 행 구조를 건드리지 않는다.
- 건드리지 말 것: `public/approval.js`, `src/meet/*`, `src/chat/*`, 이번 작업과 무관한 파일. GitHub 푸시·로컬 커밋은 하지 않는다 (Merlin이 나중에 한다).

## 검증 (반드시 수행)

1. `npx tsc --noEmit` (0건) + 수정한 JS 파일 `node --check`.
2. 로컬 `npx wrangler dev --local`로 기본 동작 확인 (마이그레이션 0047이 로컬에 적용되는지 포함).
3. 라이브 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행할 것 (python3 경유·env 접두어 금지, cd 없이 `--config` 절대 경로 사용). 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 배포 3분 뒤에 할 것.
4. 라이브 API 검증 — **실제 사용자 메일은 건드리지 않는다.** 임시 사용자 + 세션을 만들어(과거 tasks-optimistic 테스트가 쓴 방식) 그 소유자로 `POST /admin/ingest`로 테스트 메일 1~2건을 넣고, 삭제 → 휴지통 목록 확인 → 복원 → 다시 삭제 → 완전 삭제 → 휴지통 비우기 흐름을 API로 전부 확인한다. R2 원문·첨부 객체가 지워졌는지, `indexed_doc_id`가 있는 메일은 RAG 문서까지 purge되는지 확인할 것. 7일 자동 삭제는 테스트 메일의 `deleted_at`을 D1에서 8일 전으로 직접 바꾼 뒤 다음 `*/15` 틱이 지나고 사라졌는지 확인한다 (최대 15분 대기). 끝나면 임시 사용자·테스트 메일·관련 R2 객체를 전부 정리하고 개수를 대조한다.
5. 결과 보고: 라이브 배포 버전 ID, 수정한 파일·마이그레이션, 검증 결과(무엇을 어떻게 확인했는지)를 `files/workflow-verify/email-trash/RESULT.md`에 적고, 최종 응답에도 요약할 것. 브라우저 클릭 확인은 Merlin이 별도로 한다.
