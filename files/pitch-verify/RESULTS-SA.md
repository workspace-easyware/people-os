# S-A 발표자료 내용 조각 — 로컬 검증 기록 (2026-11-17, Sonnet 5.5)

만든 파일: `public/pitch-content.html` (신규, 13개 article + 히어로 + 핵심 카드 3 + 라이브 띠). 다른 파일은 건드리지 않았다.

## 확인한 것
| 확인 | 결과 |
|---|---|
| `npx tsc --noEmit` | 통과 |
| 금지어 grep (`<section`, `<script`, `onclick`, `onerror`, `javascript:`, `chatgpt`, `/home/`, `~/workspace`, `승인 큐`, `Free 플랜`, `월 $`) | 0건. ("비밀번호"는 11번 섹션의 "설정이 없으면 거부" 설명 속 낱말 1건이며 계정 값이 아님) |
| 구조 | article 13개(열고 닫음 일치), data-key·data-group 계약대로, 핵심 1·2·3 = serverless·data·agentic, id는 `pt-`+key |
| 그림 | `img`에 width=760 height=1446 (`architecture.svg` viewBox와 같음), 그림 아래 같은 내용을 글로 적음 |
| 실제 Worker (`npx wrangler dev --local --port 8792`) | `/pitch-content.html` 200 (307 → `/pitch-content` 후, 35,129바이트), `/pitch.html` 200, `/architecture.svg` 200, `/api/health` 200 |

## 하지 못한 것
- **브라우저 확인 불가** (이 VM에 브라우저 없음). 8.1 체크리스트의 렌더링·칩 이동·반응형·인쇄·앱 안 `#pitch/data` 동작은 눈으로 확인하지 못했다. O-A의 `files/pitch-verify/RESULTS.md` "하지 못한 것" 목록이 그대로 남는다.
- `curl`은 `localhost`만 허용되어 `/pitch.html#agentic` 같은 해시 이동은 실행하지 못했다. 검증 Worker(8791)는 `/pitch-content.html`을 fixture로 가로채므로 실제 조각 확인에는 쓰지 않았다.
- 인용한 코드 위치의 줄 번호는 근거 표기에서 뺐다(코드가 계속 바뀌는 중이라). 파일 경로만 적었다.
