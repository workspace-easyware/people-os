# 발표자료 구현 S-A — Sonnet 5.5 (발표자료 내용 조각)

## 너의 역할
너는 구현 세션이다. 계획 문서 `presentation-plan.md`의 6장 분할표에서 **S-A**만 구현한다. O-A(Opus)가 끝났다 (발표자료 틀 `pitch.html`·`pitch.css`·`pitch.js` + 조각 계약 완료). 배포는 하지 마라 — 로컬 검증까지만 한다.

## 읽을 것 (먼저 끝까지 읽어라)
- `presentation-plan.md` 0.4(사실 기준표 — 문구는 이 표에서만 가져온다), 2장(발표자료 메뉴 — 2.3 섹션별 내용 초안 14개), 6.2(세션 사이 계약 — 조각 형식·클래스).
- O-A가 남긴 계약: `public/pitch.css` 맨 위 주석 (최종 조각 계약). `public/pitch.html`, `public/pitch.js`, `files/pitch-verify/**` (가짜 조각 `fixture.html` + `RESULTS.md` — 검증 주소와 실패 모드).

## 구현할 것 (S-A 범위)
1. **`public/pitch-content.html`** (신규) — 2.3의 초안 14개 섹션을 O-A의 조각 계약에 맞춰 HTML로 옮긴다.
   - 형식: `<article class="pt-sec" id="pt-..." data-key="..." data-nav="..." data-group="biz|tech">`. `<html>`·`<body>` 없이 조각만. **`<section>` 태그 금지** (styles.css가 모든 section을 display:none으로 한다). `<script>`·인라인 이벤트 없음.
   - 클래스: O-A의 `pitch.css` 맨 위 주석 계약 그대로 (`pt-hero`, `pt-keys` > `a.pt-keycard`, `pt-live`, `pt-sec`, `pt-sec-head`, `pt-num`, `pt-lead`, `pt-key` + `data-keyno`, `pt-grid`, `pt-card`, `pt-flow`, `pt-table-wrap` > `table.pt-table`, `pt-callout`, `pt-code`, `pt-tags` > `span.badge`, `pt-figure` > `a > img` (width·height 속성 필수 — 없으면 그림이 늦게 뜰 때 스크롤 위치가 밀린다), `pt-src`).
   - 0.4 사실 기준표와 대조한다. "확인 안 됨" 항목은 코드에서 다시 확인하거나 뺀다. 요금·한도 숫자를 넣지 않는다. "월 $0"·"Free 플랜" 표현도 쓰지 않는다 (확인 안 됨).
   - 아키텍처 그림은 `public/architecture.svg` (O-B가 새로 그림)를 참조한다. 그림 아래에 같은 내용을 텍스트로 둔다.
   - Agentic 섹션 끝에는 한계를 그대로 적는다 (파이프라인형, 에이전트가 외부 행동을 하지 않음, `AgentSession`은 대화 기억만).
   - **A2(에이전트 제안 승인 큐)는 이번에 구현하지 않는다.** 그래서 발표자료 8번 섹션에서 "승인 큐"라는 말을 에이전트 행동에 쓰지 않는다. "사람이 결정하는 지점"이라고만 쓴다. (결재함의 승인 큐는 사람 간 결재라 "승인 큐"라고 써도 된다.)
   - 데모 계정 비밀번호를 넣지 않는다. 참고 사이트 링크·출처 표기를 넣지 않는다.

## 검증 (로컬)
- `npx tsc --noEmit` 통과.
- O-A가 남긴 검증 주소로 확인한다: `npx wrangler dev --local -c files/pitch-verify/wrangler.toml --port 8791`을 띄우고 `/pitch.html#agentic`과 `/app-sim.html#pitch/data`로 8.1 체크리스트를 돌린다. 실행 주소와 실패 모드 주소는 `files/pitch-verify/RESULTS.md`에 있다. 브라우저 확인이 안 되면 그 사실을 명시한다.
- 검증 산출물은 `files/pitch-verify/` 아래에 둔다. `/tmp` 금지.

## 제약
- S-A 파일만 만든다/고친다: `public/pitch-content.html`. `public/pitch.html`·`pitch.css`·`pitch.js`는 건드리지 마라 (O-A 범위). `public/index.html`은 건드리지 마라 (S-B 범위).
- 원격 D1·R2·배포 금지. 로컬만.
- 끝나면 최종 보고에 만든 파일 목록, 사실 기준표와 대조한 결과("확인 안 됨" 항목 처리), 로컬 검증 결과를 적어라.
