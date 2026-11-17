# LMS 구현 S2 — Sonnet 5.5 (강의실 화면·메뉴 연결·홈 카드)

## 너의 역할
너는 구현 세션이다. 계획 문서 `lms-plan.md`의 7장 분할표에서 **S2**만 구현한다. S1(Sonnet)은 끝났고 O1(Opus)도 끝났다 (Range 스트리밍·진도 UPSERT·플레이어 `public/lms-player.js` 완료, L4~L21 로컬 검증 전부 통과). 배포(원격 마이그레이션·배포)는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `lms-plan.md` 6장(UI 설계 — 6.1 메뉴 위치, 6.2 강의실 탭 구조, 6.3 홈 카드), 7장(분할표), 8장(검증 체크리스트 — 8.2 라이브 확인 항목 중 화면 관련 V4~V13).
- O1이 만든 파일: `src/lms/stream.ts`, `src/lms/progress.ts`, `public/lms-player.js`, `files/lms-verify/` (검증 스크립트·`run.sh`·`cleanup.sql`).
- 기존 패턴: `public/email.js`/`email.css` (메일함 렌더링 선례), `public/index.html`의 메뉴·`TABS`·`COACHEE_TABS`·`switchTab`·`applyRole`·홈 카드 구조.

## O1이 넘긴 것 (알아둘 것)
1. **플레이어는 브라우저에서 확인하지 못했다.** 재생, 자동 완료, 탭을 옮겼을 때 소리가 멈추는지는 네가 화면을 붙인 뒤에 확인해야 한다 (8.2 V4~V13). Safari 재생(V6)과 실제 MP4 재생도 같은 시점에 확인한다.
2. **로컬 R2 버킷 이름이 다르다.** `wrangler dev`는 R2를 `people-os-dev-preview` 버킷으로 연결한다. 테스트 객체는 거기에 있다. `people-os-files`에만 올리면 404가 난다. `files/lms-verify/run.sh` 주석에 적혀 있다.
3. **`files/lms-verify/run.sh`를 실행하려면** `Bash(bash files/lms-verify/run.sh *)` 허용 규칙이 필요하다. settings.json에 추가됐는지 확인하고, 없으면 네가 쓸 수 있는 방식(curl 개별 호출)으로 검증한다.
4. **로컬 DB에 O1 테스트 과정이 남아 있다** ("O1 테스트 과정"). 강의실 화면에서 보이는 게 싫으면 `files/lms-verify/cleanup.sql`을 실행하면 된다.
5. **R2 head 호출**: 영상 요청마다 R2 head가 1번 더 나간다 (D1 크기 값이 틀려도 Range 응답이 정확하도록). Class B 사용량은 계획서 3.4 추정의 약 2배지만 여전히 한도의 1% 미만이다.

## 구현할 것 (S2 범위)
1. **`public/lms.js`, `public/lms.css`** (신규) — 강의실 화면: 과정 목록, 과정 상세, 완료 버튼, 진도 막대. `email.js`와 같은 패턴의 렌더링. O1의 `public/lms-player.js`가 제공하는 `lmsPlayerMount`/`lmsPlayerUnmount`만 부른다 (플레이어 내부는 건드리지 마라).
2. **`public/index.html`** — 메뉴에 **강의실** 추가 (코칭 리플렉션 다음, 성장 묶음). 6.1 표의 9곳 (메뉴·섹션·스크립트 연결, `TABS`/`COACHEE_TABS`/`switchTab`/`applyRole`). **순서: `lms.js`와 `lms.css`를 먼저 만들고, `index.html`은 마지막에 편집한다. 편집 직전에 파일을 다시 읽어라.** 결재 A2 세션이 같은 파일에 결재함 메뉴를 넣고 있을 수 있다. 기존 메뉴·탭 구조를 앵커로 삼아 강의실 항목만 추가하고, 이미 있는 항목(결재함 포함)은 그대로 둔다.
3. **홈 카드 "이어서 듣기"** (`public/index.html` + `public/lms.js`) — 마지막 시청 강의 조회 1건 + 카드 1개.
4. **(선택) 소개 탭·README에 강의실 한 줄** — 문구 추가.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local` 로 로그인 쿠키를 달고: 강의실 메뉴·과정 목록·과정 상세·플레이어 재생·자동 완료·진도 막대·이어보기 카드가 동작하는지 확인. 탭을 옮겼을 때 소리가 멈추는지, Safari 재생(V6)과 실제 MP4 재생(8.2 V4~V13 중 화면 관련 항목)을 확인한다. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 스크립트나 하네스는 이 작업 디렉터리(`files/people-os/` 안)에 두되 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- S2 파일만 만든다/고친다: `public/lms.js`, `public/lms.css`, `public/index.html`(강의실 메뉴·탭·홈 카드만). 백엔드(`src/lms/**`, `src/index.ts`, `migrations/`)와 플레이어(`public/lms-player.js`)는 건드리지 마라. 결재 파일(`public/approval.js`, `public/approval.css`)은 건드리지 마라.
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, tsc 결과, 로컬 검증 결과를 적어라.
