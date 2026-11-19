# O-A 발표자료 틀 — 로컬 검증 기록 (2026-11-17, Opus 5.5)

## 참고 사이트 (7.2)
- `https://token-saving-guide-copy.hr-jhkang.chatgpt.site/` — **읽지 못함.** WebFetch 2회 모두 60초 시간 초과, `curl`은 "requires approval"로 막힘.
- 그래서 확인표의 "참고 사이트 실제 값" 열은 비어 있고, **기본안 그대로** 구현했다. 바꿀 값은 `public/pitch.css` §0 `.pt-root` 변수에 모여 있다.

## 이 폴더
| 파일 | 용도 |
|---|---|
| `fixture.html` | 가짜 조각. 계약의 모든 클래스, 14개 섹션(top + 13), 핵심 1·2·3, `data-tab` 링크, `#pt-` 링크, 외부 링크, 그림 |
| `fixture-hostile.html` | 계약 위반 조각 (`<script>`, `onclick`, `onerror`, `javascript:`, `<section>`, 잘못된 키) — sanitize 확인용 |
| `app-sim.html` | index.html 껍데기 축약 + S-B가 넣을 연결(6.4)의 모의 switchTab. 앱 안 모드 확인용 |
| `worker.mjs`, `wrangler.toml` | 검증 전용 Worker. `public/`을 그대로 서빙하고 `/pitch-content.html`→fixture, `/api/health`→가짜(정상/503/잘못된 JSON), `/app-sim.html`, `/__verify/unit`만 가로챈다. 배포 금지 |
| `unit.mjs`, `unit-setup.mjs` | `pitch.js` 순수 함수 단위 확인 (이 VM의 `-p` 세션은 `node` 실행이 막혀 workerd 안에서 돌린다) |

실행: `people-os/`에서 `npx wrangler dev --local -c files/pitch-verify/wrangler.toml --port 8791`
- 독립 페이지: `http://localhost:8791/pitch.html#agentic`
- 앱 안 모의: `http://localhost:8791/app-sim.html#pitch/data`
- 라이브 띠 실패: `http://localhost:8791/pitch.html?health=fail` (Referer로 503), 잘못된 응답: `?health=bad`
- 계약 위반 조각: `http://localhost:8791/pitch.html?hostile`
- 단위 확인: `curl http://localhost:8791/__verify/unit`

## 결과
| 확인 | 결과 |
|---|---|
| `npx tsc --noEmit` (프로젝트) | 통과 (출력 없음) |
| `pitch.js` 문법 | `node --check`는 승인 필요로 막힘 → `npx tsc --noEmit --allowJs pitch.js`로 파싱 통과. `--checkJs`는 `window.pitchOpen` 같은 전역 추가 경고 7건뿐 (의도된 것) |
| 단위 확인 (`/__verify/unit`, workerd) | **30 passed, 0 failed** — 전역 함수 2개, 앱/독립 해시 해석(`#pitch/<키>`, `#<키>`, `#pt-<키>`, 잘못된 키·`javascript:`·깨진 %-이스케이프 거부), href 생성, 현재 섹션 계산 |
| 검증 Worker: `/pitch.css` `/pitch.js` `/styles.css` `/pitch-content.html`(fixture) `/app-sim.html` | 모두 200 |
| `/pitch.html` | **307 → `/pitch`** (Workers Static Assets 기본 `html_handling`). `/pitch` 200. 브라우저는 리다이렉트에서 `#해시`를 유지하므로 `/pitch.html#agentic`도 동작한다 |
| 가짜 `/api/health` 정상 / `mode=fail` / `mode=bad` | 200 JSON / 503 / 200 `bindings:null` |
| **실제 프로젝트 Worker** (`npx wrangler dev --local --port 8792`) 쿠키 없이 `GET /api/health` | **200** `{"ok":true,…,"bindings":{"d1":true,"kv":true,"r2":true,"vectorize":false,"ai":true,"durable_objects":true}}` → 로그인 없이 응답한다. 로컬은 vectorize false (띠에 "Vectorize 없음" 주황 배지로 나온다) |
| 실제 Worker 쿠키 없이 `/pitch.html`(-L) `/pitch` `/pitch.css` `/pitch.js` | 모두 200 |
| 실제 Worker `/pitch-content.html` | 404 (S-A 전). 이때 pitch.js는 "발표자료를 불러오지 못했습니다 (HTTP 404). 다시 시도"를 보여 준다 (코드 경로) |
| `<section`·`chatgpt.site`·내부 경로·비밀번호 | `pitch.html`·`fixture.html` 0건. `pitch.css`·`pitch.js`는 계약 주석·경고 문구 속 낱말뿐 |

## 하지 못한 것 — 브라우저 확인
이 VM에는 브라우저가 없고(`node_modules`에 playwright/puppeteer/jsdom 없음), 시스템 바이너리 조회·`node` 실행이 승인 필요로 막혀 있다. 따라서 **아래는 눈으로 확인하지 못했다.** 코드 검토로만 확인했다:
- 렌더링 모양, 1280×800 첫 화면에 핵심 카드 3개가 들어오는지
- 칩 클릭 → 해시 변경 → 스크롤, 스크롤 위치 추적(현재 칩 강조·칩 가로 자동 이동), 읽기 진행 막대
- 뒤로 가기, 같은 칩 다시 누르기, 새로고침 시 섹션 복원
- 375×812 / 768×1024 반응형, 인쇄 미리보기, `prefers-reduced-motion`
- sanitize가 hostile 조각에서 스크립트를 실제로 막는지 (DOM 필요)

S-A 이후 또는 배포 전에 위 실행 주소로 브라우저(데스크톱 + 개발자 도구 모바일)에서 8.1 체크리스트를 한 번 돌려야 한다.
