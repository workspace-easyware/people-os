# 발표자료 구현 S-B — Sonnet 5.5 (앱 연결 + 소개 확장, index.html만)

## 너의 역할
너는 구현 세션이다. 계획 문서 `presentation-plan.md`의 6장 분할표에서 **S-B**만 구현한다. 강의실 S2와 결재 A2가 `index.html`을 이미 닫았다 (강의실·결재함 메뉴가 들어가 있다). 배포는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `presentation-plan.md` 1장(소개 섹션 확장 — 1.2 문구 초안), 6.4(`index.html` 수정 지점 — 문자열로 찾는다), 6.2(`pitch.js` 전역 함수), 6.3(함정 — 특히 2번 하위 경로, 3번 공통 히어로, 6번 스크립트 404).
- `public/index.html` (현재 상태 — 강의실·결재함 메뉴 포함). **편집 직전에 파일을 다시 읽어라.**
- O-A가 만든 `public/pitch.js` (전역 함수 `pitchOpen(mountEl, sectionKey)`, `pitchLeave()`), `public/pitch.css` (연결만 한다).

## 구현할 것 (S-B 범위 — `public/index.html`만)
1. **사이드바 "발표자료" 버튼**: `data-tab="about"` 버튼 다음에 `<button data-tab="pitch">` + 아이콘(24px stroke SVG, 발표 화면 모양) + `<span class="nav-label">발표자료</span>`. 소개 바로 다음 (사이드바 맨 아래).
2. **`tab-pitch` 섹션**: `tab-about` 섹션 다음에 `<section id="tab-pitch"><div id="pitchMount"></div></section>`.
3. **스크립트·CSS 링크**: `<link rel="stylesheet" href="/email.css" />` 다음에 `<link rel="stylesheet" href="/pitch.css" />`. `<script src="/email.js"></script>` 다음에 `<script src="/pitch.js"></script>`. (에이전트 활동 타임라인 O-C가 아직 안 끝났으면 `/agent-activity.js` 링크와 홈 카드 자리는 넣지 않는다 — 6.3 6번.)
4. **로그인 화면 링크**: 로그인 상자 `#loginBox` 맨 아래 문단 다음에 `<p class="muted"><a href="/pitch.html">로그인 없이 발표자료 보기 →</a></p>`.
5. **소개 섹션 교체**: `<section id="tab-about">` 전체를 1.2의 내용으로 교체한다. 끝에 발표자료 링크를 둔다.
6. **`TABS`/`COACHEE_TABS`**: `'about'` 뒤에 `'pitch'`를 넣는다 (두 배열 모두).
7. **`switchTab` 하위 경로**: `if (name !== 'obs') sub = '';`를 `pitch`도 하위 경로를 유지하게 고친다. `full` 계산도 `pitch/<sub>`를 처리한다. `obs`의 동작은 바꾸지 않는다.
8. **탭별 호출 묶음** (`switchTab` 끝): `if (name === 'pitch') pitchOpen($('pitchMount'), sub); else if (window.pitchLeave) pitchLeave();`
9. **공통 히어로**: 앱 안에서는 `pt-hero`가 한 단계 낮은 크기로 그려진다 (O-A가 처리). 공통 히어로를 숨기지 않는다.
10. **(A3) 답변 "처리 과정" 패널**: `details class="timings"`를 만드는 렌더 함수에서, 라우터·토픽 가드·재순위 단계에 "판단 모델" 배지와 쓰인 Cloudflare 기능 이름을 표시한다. 마이그레이션·API 변경 없음 (`timings`에 이미 단계가 있다).

## 검증 (로컬)
- `npx tsc --noEmit` 통과. `index.html` 인라인 스크립트는 `tsc --allowJs`로 문법 확인.
- `npx wrangler dev --local` 로 로그인 쿠키를 달고: 사이드바 "발표자료" 버튼이 뜨는지, 누르면 발표자료 탭이 열리고 조각이 보이는지, `#pitch/<키>` 해시로 섹션 이동이 되는지, 소개 섹션이 1.2 내용으로 바뀌었는지, 로그인 화면의 "로그인 없이 발표자료 보기" 링크가 `/pitch.html`로 가는지 확인. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 산출물은 이 작업 디렉터리(`files/people-os/` 안)에 두되 배포에 포함되지 않는 위치에 둔다. `/tmp` 금지.

## 제약
- S-B 파일만 만든다/고친다: `public/index.html`. 다른 파일은 건드리지 마라 (특히 `public/pitch-content.html`, `public/pitch.js`, `public/pitch.css`, `public/lms.js`, `public/approval.js`).
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 고친 위치 목록, 로컬 검증 결과를 적어라.
