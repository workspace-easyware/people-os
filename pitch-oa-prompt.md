# 발표자료 구현 O-A — Opus 5.5 (발표자료 틀: 디자인·내비게이션·반응형)

## 너의 역할
너는 구현 세션이다. 계획 문서 `presentation-plan.md`의 6장 분할표에서 **O-A**만 구현한다. S-A(Sonnet, 내용)는 네가 끝난 뒤에 온다 (네 조각 계약을 따른다). 배포는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `presentation-plan.md` 0장(핵심 결정·사실 기준표), 2장(발표자료 메뉴 — 2.1 형태, 2.2 섹션 목록, 2.3 섹션별 내용 초안), 6.2(세션 사이 계약 — 조각 형식·클래스·`pitch.js` 전역 함수), 6.3(함정), 7장(Look & Feel — 7.2 참고 사이트 확인표, 7.3 디자인 시스템, 7.4 레이아웃·반응형), 8장(검증 체크리스트).
- 기존 디자인: `public/index.html`, `public/styles.css` (네이비 #123863, 아웃라인 카드, Langfuse 스타일).

## 먼저 할 것 — 참고 사이트 확인 (7.2)
- 참고 사이트 https://token-saving-guide-copy.hr-jhkang.chatgpt.site/ 를 WebFetch로 직접 읽어라 (허용 규칙이 settings.json에 추가돼 있다). 7.2의 확인표를 채우고, 기본안과 다르면 참고 사이트 쪽으로 맞춘다. **읽지 못하면 기본안으로 만들고 그 사실을 최종 보고에 적는다.** 참고 사이트 링크·출처 표기는 어디에도 넣지 않는다 (PEOPLE-OS-PLAN.md C3 결정).

## 구현할 것 (O-A 범위)
1. **`public/pitch.html`** (신규) — 독립 페이지 껍데기. 로그인 없이 열린다 (심사위원이 계정 없이 읽어야 한다). 조각(`pitch-content.html`)을 불러와 넣는다.
2. **`public/pitch.css`** (신규) — 디자인 시스템 (`pt-*` 컴포넌트). 색·글꼴·내비게이션 모양은 `pitch.css` 상단 변수로 모은다 (참고 사이트를 본 뒤 바꿀 수 있게). 반응형 (모바일 칩 가로 스크롤, 표 가로 스크롤), 인쇄 스타일, 움직임 줄이기 대응.
3. **`public/pitch.js`** (신규) — 조각 로더, 붙는 섹션 내비게이션과 스크롤 위치 추적, 앱 안/독립 두 환경의 해시 처리 (`#pitch/<키>`와 `#<키>`), `/api/health` 라이브 상태 띠 (`pt-live`, `data-live="health"`). 전역 함수 `pitchOpen(mountEl, sectionKey)`, `pitchLeave()` (6.2 계약 그대로). `pitch.js`는 `index.html`의 전역(`$`, `api`, `esc`)에 기대지 않는다 (독립 페이지에는 없다).
4. **검증용 `files/pitch-verify/**`** — 가짜 조각 `fixture.html` 포함.

## 계약 (6.2 — S-A가 따를 최종 계약을 `pitch.css` 맨 위 주석에 적는다)
- 조각 형식: `<article class="pt-sec" id="pt-..." data-key="..." data-nav="..." data-group="biz|tech">`, `<section>` 태그 금지 (styles.css가 모든 section을 display:none으로 한다). `<script>`·인라인 이벤트 없음.
- 클래스: `pt-hero`, `pt-keys` > `a.pt-keycard`, `pt-live`, `pt-sec`, `pt-sec-head`, `pt-num`, `pt-lead`, `pt-key` + `data-keyno`, `pt-grid` (`data-cols`), `pt-card`, `pt-flow`, `pt-table-wrap` > `table.pt-table`, `pt-callout` (`data-tone`), `pt-code`, `pt-tags` > `span.badge`, `pt-figure`, `pt-src`, `a[data-tab="..."]`.
- 앱 안에서 칩을 누르면 `location.hash = 'pitch/' + key`만 바꾼다. 독립 페이지에서는 `#key`를 직접 처리한다.

## 함정 (6.3)
- `section` 태그 금지. `switchTab`은 `obs` 말고는 하위 경로를 지운다 — `pitch`도 하위 경로를 살리게 하는 것은 S-B 범위이므로, 네가 `pitch.js`에서 해시 처리를 할 때 이 동작을 전제로 한다.
- 앱의 모든 탭 위에는 공통 `.hero`("일잇 People OS")가 있다. 발표자료 히어로와 겹치므로, 앱 안에서는 `pt-hero`를 한 단계 낮은 크기로 그린다 (권장).
- 정적 자산은 로그인 없이 열린다. `/pitch.html`, `/pitch-content.html`에는 계정 정보·내부 경로·시크릿 이름 외의 운영 정보를 넣지 않는다. 데모 계정 비밀번호를 넣지 않는다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과 (JS는 `node --check`로 문법 확인).
- `npx wrangler dev --local` 로 가짜 조각(`fixture.html`)을 붙여서: 독립 페이지(`/pitch.html`) 렌더링, 내비게이션·스크롤 추적, 해시 처리, 반응형(모바일 너비), 인쇄 스타일, 라이브 상태 띠가 동작하는지 확인. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 산출물은 `files/pitch-verify/` 아래에 둔다. `/tmp` 금지.

## 제약
- O-A 파일만 만든다/고친다: `public/pitch.html`, `public/pitch.css`, `public/pitch.js`, `files/pitch-verify/**`. `public/pitch-content.html`은 건드리지 마라 (S-A 범위). `public/index.html`은 건드리지 마라 (S-B 범위). `public/architecture.svg`는 건드리지 마라 (O-B 범위).
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, 참고 사이트 확인표 결과(읽었는지·기본안인지), `pitch.css` 맨 위 주석의 최종 조각 계약, 로컬 검증 결과를 적어라.
