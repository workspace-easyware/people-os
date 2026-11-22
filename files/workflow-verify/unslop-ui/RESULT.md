# unslop UI 검토·수정 결과 (2026-11-22, Fable 5.2)

- **배포 버전 ID: `859de054-ad9b-4d5f-8030-e71d96d52ca9`** (이 세션 배포 1회)
- 판정: **가벼운 slop → 다듬기 모드.** 화면은 이미 Langfuse 기준으로 정리돼 있었다. 팔레트·서체·사이드바·레이아웃 뼈대는 그대로 두고 감사에서 나온 것만 고쳤다.
- 브라우저가 없어 눈으로 본 검증은 없다. 코드·정적 검사, 로컬 `wrangler dev`, 라이브 스모크만 했다. **화면을 한 번 열어 보고 확인해야 할 곳은 맨 아래 "눈으로 확인할 곳"에 있다.**
- 스킬의 참고 파일(`references/signs.md`, `tokens.md`)은 이 세션 권한으로 읽을 수 없었다. 스킬 본문(패스 9개와 체크리스트)만 기준으로 삼았다.
- 커밋·태그·문서 갱신은 하지 않았다.

## 1. 감사 목록 (징후 · 위치)

### 색·효과
| 징후 | 위치 |
|---|---|
| 색 번짐(radial) + 색조 그라데이션 + 큰 그림자 | `styles.css` `.hero` (모든 탭 위 남색 띠) |
| 남색→파랑 그라데이션 + 큰 그림자 | `styles.css` `.about-hero`, `pitch.css` `--pt-hero-bg` / `.pt-hero` |
| 그라데이션 버튼 + 색 그림자 | `styles.css` `#docResult .card .primary`, `#deckResult .btn` |
| 흰 글자 대비 부족 (약 4.0:1) | `styles.css` `a.btn` (#2d7dde 면) |
| 브라우저 기본 링크 색 (파랑·방문 보라) | 클래스 없는 `a` 전부 — 로그인 화면, 소개 탭, 홈 카드의 "전체 보기" 링크 |
| 남색 면 위 남색 버튼 + 스타일 없는 기본 버튼 | `index.html` 소개 탭 히어로의 버튼 2개 |
| 팔레트 밖 색 직접 입력 | `org.css` 경고 상자(#fef3c7 등), `approval.css`·`index.html`의 #b91c1c·#166534, `meet.css` 버튼 #4f7cff |
| `.muted` 클래스에 규칙이 없음 (설명 문단이 본문 색으로 나옴) | `index.html`·`calendar.js`·`org.js`의 `class="muted"` 30여 곳 |

### 아이콘·이모지
| 징후 | 위치 |
|---|---|
| 🔔 | `index.html` 알림 종 버튼 |
| 👍 👎 | `index.html` 답변 피드백 버튼·지식 공백 배지, `obs/traces.js` 4곳, `obs/gaps.js` 2곳 |
| 📎 ★ ☆ | `email.js` 메일 목록 |
| ⚙ ✓ ▶ | `lms.js` 설정 버튼, 강의 목록 표시 |
| 🔴 | `meet.js` 전사 안내 |
| ✉ ☑ ▤ ◍ (통계 카드 구석 장식) | `styles.css` `.stat::after` |
| ⬇ | `styles.css` 덱 다운로드 버튼 |
| ✓ … → (단계 표시 글자), ● (안 읽음) | `index.html` `pipelineSteps`, 홈 메일 카드 |
| 버튼마다 붙은 `→` | `index.html` 홈 카드 버튼 8개, 소개 히어로 버튼 2개 |

### 간격·서체·디테일·모션
| 징후 | 위치 |
|---|---|
| 4px 격자 밖 값 (9·10·14·18px 등) | `index.html` 인라인 스타일(로그인 상자, 사용자 메뉴, 관리 표), `styles.css`(#turnstileBox, .xai-decision, .ol-section, .ol-row), `approval.css`(.apv-line, .ntf-item, .apv-route-edit), `meet.css`, `pitch.css` `.pt-hero` |
| 굵기 700 | `--weight-brand`(로고·히어로 제목), `approval.css` `.apv-urgent`, `email.css` 2곳, `lms.css` 2곳 |
| 기울임 강조 | `agents.css` `.ag-think` |
| 대문자 + 자간 라벨 | `obs/obs.css` `.obs-msg-role` |
| 모든 카드 제목 앞 남색 막대 | `styles.css` `.card h2::before` (홈은 이미 뺐고 나머지 탭에 남아 있었음) |
| 전부 알약 모양 배지 | `styles.css` `.badge`, `agents.css` `.ag-badge` |
| hover 때 떠오름 + 큰 그림자 | `styles.css` `.libcard:hover` |
| 사이드바 hover와 활성 상태가 같은 색 | `styles.css` `.sidebar nav button:hover` |
| 같은 폭 카드 12장이 한 줄로 쌓임 | `index.html` 홈 탭 |
| 로그인 화면에 제품 표시가 글자 한 줄뿐 | `index.html` `#authOverlay` |
| 개발 용어 문구 `health 확인 중…` / `health OK` | `index.html` 히어로 배지 |
| 제목 끝 마침표 | `index.html` 소개 히어로 제목 |

### 문제없다고 본 것 (그대로 둠)
- 깜빡임 3곳(`.steps .now`, `.ag-dot`, `.chat-call-live`)은 실제 진행 중·통화 중일 때만 돈다. `prefers-reduced-motion` 처리도 있다.
- 캘린더 구글 상태 칩의 `●`·`▲`는 색만으로 구분하지 않으려고 넣은 기호다 (주석에 적혀 있음).
- 채팅 반응 이모지 6개는 기능의 내용물이다.
- 느낌표, 인사말 제목, 과장 문구, 확인할 수 없는 수치 주장은 없었다.

## 2. 방향

- **제품**: HR 담당자·코치·구성원이 회의 녹음, 규정, 메일, 코칭 기록을 한곳에 모아 다음 일로 잇는 업무 공간.
- **성격**: 차분하다 · 정확하다 · 근거를 댄다.
- **세계**: 인사 기록실 — 결재 서류, 조문 번호, 회의록. 흰 종이 위 남색 잉크. 면·테두리·글자는 지금의 중립 회색(zinc)을 유지한다.
- **색을 쓰는 순간** (2곳):
  1. 남색 한 면 — 화면 위 띠와 소개·발표자료 히어로. 그라데이션과 번짐 없이 한 색.
  2. 규정 검색 답변 카드 — 남색 윗선과 번호가 붙은 근거 목록.
- **시그니처: "잇는 선"** — 제품 이름 '일잇'(일을 잇다)에서 가져왔다. 일이 다음 단계로 넘어가는 곳을 한 줄 위의 점으로 그린다. 결재선(`.apv-line`)과 에이전트 이벤트(`.ag-ev`)에 이미 있던 표현을 파이프라인 단계(`.steps`)와 소개 탭 "하루" 흐름에도 맞췄다.

## 3. 패스별 수정

### 간격
- `index.html` 인라인 스타일: 로그인 상자 안쪽 24→32, 버튼 높이 34→36·위 여백 18→16, 문단 여백 14→16, 사용자 칩 10→12, 사용자 메뉴 9→8, 비밀번호 대화상자 라벨 10→12, 관리 표 칸 `8px 6px`→`8px`, 줄 버튼 `3px 7px`→`2px 8px`.
- `styles.css`: `.hero` 안쪽 24→`20px 24px`, `#turnstileBox` 10→12, `.xai-decision` `6px 10px`→`8px 12px`, `.ol-section` 10→12, `.ol-row` 6→8, 근거 목록 항목 10→8.
- `approval.css`: `.apv-line li` `14px/18px`→`16px/20px`, `.ntf-item` 9→8, `.apv-route-edit button` `1px 7px`→`0 8px`, 종 버튼 위치 14→16.
- `meet.css`: 상단 10→12, 버튼 `10px 18px`→`8px 16px`, 안내 상자 `10px 12px`→`12px`.
- `pitch.css`: `.pt-hero` `44px 36px`→`40px 32px`.

### 색
- `styles.css` `.hero`, `.about-hero`, `pitch.css` `--pt-hero-bg`: 그라데이션·번짐·큰 그림자 제거 → 남색 한 면.
- 덱 다운로드 버튼 2종: 그라데이션·색 그림자 제거 → 보통 버튼 색.
- `a.btn`: 면을 `--color-accent-700`으로 (대비 약 5.3:1), hover는 남색.
- 클래스 없는 `a`: `--color-accent-700`, hover 남색 (`a:where(:not([class]))` — 클래스가 있는 링크는 건드리지 않는다).
- `.muted` 규칙 추가 (`--color-muted`).
- 소개 히어로 버튼: 주 버튼 흰 면 + 남색 글자, 보조 버튼 흰 테두리.
- 직접 입력한 색 → 토큰: `org.css` 경고·메시지, `approval.css` 4곳, `index.html` 로그인 오류·성공 문구.
- `meet.css` 버튼 #4f7cff → #1f6bc4 (앱의 accent-700), hover·focus 상태 추가.
- 히어로 상태 배지: 남색 면 위에서 읽히게 반투명 흰 면 + 흰 글자 (`.hero #health`).

### 아이콘
- 🔔 → Lucide bell (인라인 SVG). 종 버튼은 원형에서 반경 8px 사각으로.
- 👍 👎 버튼 → Lucide thumbs-up / thumbs-down + 기존 문구. 배지·표·선택 상자의 👍 👎는 글자로 ("도움 됨" / "아쉬움", "아쉬움 피드백").
- 📎 → Lucide paperclip. ★ ☆ → Lucide star (켜짐은 `.on` 클래스가 채움으로 표시).
- 강의 목록 ✓ ▶ → Lucide check / play. `⚙ 설정` → `강의실 설정`.
- 🔴 → CSS 붉은 점 (`.meet-rec::before`). 홈 메일 카드의 `●` → 기존 `.email-dot`.
- ⬇ → Lucide download (CSS 마스크). 통계 카드 구석 기호 4개 삭제.

### 문구
- 히어로 배지: `health 확인 중…` → `상태 확인 중…`, `health OK · …` → `정상 · …`, `health 실패` → `상태 확인 실패`.
- 홈 카드 버튼 8개와 소개 히어로 버튼 2개에서 `→` 삭제 (글 안의 링크에 붙은 `→`는 그대로).
- 소개 히어로 제목 끝 마침표 삭제. 로그인 안내 한 줄 마침표 삭제.
- 로그인 상자 제목: `일잇 People OS` → 로고 + `로그인`.
- `해결됨 ✓` → `해결됨`.

### 서체
- `--weight-brand` 700 → 600 (로고, 히어로 제목, 발표자료 제목). `approval.css`·`email.css`·`lms.css`의 700 → 600. 로그인·관리 폼 버튼 600 → 500.
- `.ag-think` 기울임 제거 → 왼쪽 가는 선으로 구분.
- `.obs-msg-role` 대문자·자간 제거 → 모노 서체.
- 숫자 자리 맞춤(`tabular-nums`): 배지, 사이드바 개수, 알림 개수, 목록의 날짜.
- 히어로 제목 30px → 24px (모든 탭 위에 놓이는 띠라 낮췄다), 홈 카드 제목 20px → 16px.

### 레이아웃
- 홈 탭: 2열 격자 (`#tab-home.active`). 통계 줄, 이어서 듣기, 에이전트 활동, 아침 브리핑, 사용자별은 전체 폭(`.home-wide` 클래스 추가). 760px 이하는 1열. 카드 순서(DOM)는 그대로다.
- 로그인·비밀번호 설정 상자: 로고(남색 '일' 타일 + 이름)를 위에 두고 반경 12px.

### 디테일
- `.card h2::before` 남색 막대 삭제 (전 탭).
- `.badge`, `.ag-badge`: 알약 → 반경 4px 라벨. 개수 표시(`.nav-count`, `.ntf-count`, `.sim`)는 알약 유지.
- 사이드바 hover는 중립 회색, 활성만 남색 옅은 면 + 왼쪽 선.
- **잇는 선**: `.steps`를 알약 + 화살표 글자에서 점·선으로. 끝난 단계는 남색 점과 남색 선, 지금 단계는 파란 점, 남은 단계는 빈 점. 상태 문구는 오른쪽 끝(`.steps-label`). 소개 탭 `.pt-flow`는 결재선과 같은 세로 선(`#tab-about .pt-flow`) — 발표자료의 `.pt-flow`는 그대로다.
- 그림자 정리: 로고 타일, `.outline`, `.ol-section`, 근거 목록 항목의 그림자 삭제. 답변 카드 그림자 `--shadow-lg` → `--shadow`.
- 종 버튼·별표·`/meet` 버튼·관리 표 줄 버튼에 hover / focus 상태 추가.

### 비주얼
- 새 이미지 없음. 앱 화면이라 생성 이미지가 필요 없다고 판단했다 (연결된 이미지 서비스도 없음).

### 모션
- `.libcard:hover`의 떠오름·큰 그림자 제거 → 테두리 색만 바뀐다.
- 진행 중 표시 3곳의 깜빡임은 유지.

### 손댄 파일
`public/index.html`, `public/styles.css`, `public/approval.css`, `public/email.css`, `public/email.js`, `public/lms.css`, `public/lms.js`, `public/meet.css`, `public/meet.js`, `public/agents.css`, `public/org.css`, `public/pitch.css`, `public/obs/obs.css`, `public/obs/traces.js`, `public/obs/gaps.js`. `src/`, `wrangler.toml`, 마이그레이션은 건드리지 않았다.

JS에서 바꾼 것은 화면에 그리는 문자열뿐이다. 예외 1곳: `email.js` `emailStar`가 별표 글자를 바꾸던 줄을 `aria-pressed` 갱신으로 바꿨다 (`.on` 클래스 토글은 그대로).

## 4. 검증

### 정적
- `node --check`: `email.js`, `lms.js`, `meet.js`, `obs/gaps.js`, `obs/traces.js`, `index.html` 인라인 스크립트(613~2068행 추출본) — 모두 통과.
- `npx tsc --noEmit` — 0건.
- `styles.css` 중괄호 220 / 220.

### 로컬 (`wrangler dev --local`, 새 D1 상태 + 마이그레이션 45개 적용)
- 200: `/`, `/styles.css`, `/approval.css`, `/email.css`, `/email.js`, `/lms.js`, `/meet`, `/meet.css`, `/pitch.html`, `/pitch.css`, `/obs/obs.css`, `/obs/traces.js`.
- 익명 `/api/auth/me` 401.
- 임시 사용자(`tmp-unslop-1@example.com`, 로컬 D1에만 만듦) 세션으로 `/api/auth/me` 200, `/api/home` 200.
- 서빙된 `/`와 `/styles.css`가 고친 파일과 바이트 동일 (`cmp`).

### 라이브
배포 뒤 3분 넘게 기다린 다음 `https://peopleos.site`에서 확인했다. 배포 전 응답은 `before/`, 배포 뒤 응답은 `after/`에 있다.

| 항목 | 결과 |
|---|---|
| `/api/health` | 200, 배포 전과 바이트 동일 |
| 익명 `/api/auth/me` | 401, 배포 전과 바이트 동일 |
| `/` (index.html) | 200, 고친 `public/index.html`과 바이트 동일 |
| `/styles.css` | 200, 고친 `public/styles.css`와 바이트 동일 |
| 바뀐 나머지 자산 | 200 — `approval.css`, `email.css`, `email.js`(새 `aria-pressed` 문자열 확인), `lms.js`, `meet.css`, `meet.js`, `pitch.css`, `obs/obs.css`, `obs/traces.js`, `obs/gaps.js`, `/pitch.html` |
| 안 바꾼 자산 `/chat.js`, `/pitch-content.html` | 200, 배포 전과 바이트 동일 |

로그인이 필요한 라이브 호출은 하지 않았다 (바뀐 것이 정적 자산뿐이고, 운영 D1에 임시 사용자를 만들지 않으려고). 로그인 뒤 API는 로컬에서만 확인했다.

### 임시 데이터
- 임시 사용자는 로컬 D1(`files/workflow-verify/unslop-ui/state/`)에만 만들었다. **운영 D1에는 아무것도 쓰지 않았다** (로그인이 필요한 라이브 호출을 하지 않았다). 실데이터(문서 6·녹음 2·사용자 3명)는 건드리지 않았다.

## 5. 고치지 않은 것 · 남은 것

- **눈으로 확인할 곳** (브라우저 검증을 못 했다):
  1. 홈 2열 격자 — 카드 높이가 짝끼리 맞는지, 반쪽 카드 수가 홀수일 때 마지막 줄 오른쪽이 비는지 (워크플로우 카드가 숨겨지는 경우).
  2. 파이프라인 단계의 점·선 — 녹음 목록에서 줄바꿈될 때 모양.
  3. 소개 탭 "하루" 흐름의 세로 선과 점 위치.
  4. 덱 다운로드 버튼의 마스크 아이콘, 메일 별표 채움, 종 아이콘.
  5. 로그인 화면 로고 배치.
- 아이콘 선 굵기는 2 그대로다 (스킬 기준은 1.5). "Lucide 16px"로 정해진 값이라 두었다.
- 그림자의 남색 틴트(`--shadow*`)는 그대로다 (스킬은 중립 그림자를 권한다). 기존 주석에 "남색 틴트는 유지"라고 적혀 있어 두었다.
- 버튼에 박힌 `margin-top:8px`(`button.primary`·`.secondary`·`a.btn`)와 그걸 지우는 `margin-top:0` 덮어쓰기 여러 곳 — 정렬이 어긋나는 원인이지만 영향 범위가 넓어 두었다.
- 화면별 JS의 인라인 스타일과 `10px 12px` 같은 목록 줄 여백(`.email-row`, `.apv-row`, `.lms-lesson`)은 그대로다.
- 사이드바 메뉴 18개가 구분 없이 한 줄로 이어진다. 묶음 라벨(업무 / 기록 / AI / 관리)을 두면 읽기 쉽지만 구조 변경이라 제안으로만 남긴다.
- 히어로 부제 "HR·코칭 인텔리전스 플랫폼"은 어느 제품에나 붙을 수 있는 말이다. 정해진 소개 문구로 보여 두었다. 바꾼다면 "회의 녹음·규정·메일·코칭 기록을 한곳에서 잇는 업무 공간" 정도를 제안한다.
- 히어로 제목은 모든 탭에서 "일잇 People OS"다 (사이드바 로고와 겹친다). 탭 이름을 보여 주면 더 낫지만 JS 동작 변경이라 하지 않았다.
- 아침 브리핑은 홈에서 가장 제품다운 내용인데 맨 아래에 있다. 위로 올리는 것은 순서 변경이라 제안으로만 남긴다.
- 발표자료(`pitch-content.html`) 본문과 `.pt-flow` 알약, `obs/evals.css`, `workflow*.css`, `calendar.css`, `chat.css`는 징후가 없거나 작아 손대지 않았다.
- 스토리 영상은 만들지 않았다 (지시대로).
