# Plaud 목록 전체 가져오기 수정 RESULT (2026-11-23)

## 변경
- `src/plaud/routes.ts` GET /files: Plaud `list_files`를 page_size=50으로 page 1부터 전부 가져온다. 빈 페이지, 새 id가 없는 페이지, 10페이지, 500개 중 먼저 닿는 곳에서 멈춘다. `complete`는 쓰지 않는다. id 중복 제거(처음 것 유지), start_at → created_at 내림차순 정렬 후 page/page_size로 잘라 반환한다. 응답 `{ok, files, total, page, page_size, has_more: page*page_size < total}` (`complete` 키는 뺐다). query/date_from/date_to는 매 호출에 그대로 전달. imported/transcribing/linked는 반환 슬라이스에만 적용.
- `public/plaud.js`: 목록 위에 "총 N개"를 표시한다. has_more는 서버 값을 쓴다.
- 인증/연결/가져오기/전사 라우트와 MCP 클라이언트는 건드리지 않았다.

## 검증
- `npx tsc --noEmit` 0건, `node --check public/plaud.js` 통과.
- 로컬 `wrangler dev --local` + 가짜 Plaud MCP(63개, complete 키 없음) + 로컬 D1 세션. 하네스: `files/plaud-list-fix-verify/`.

| 시나리오 | 페이지별 개수 | total | 합계/중복 | 최신순 |
|---|---|---|---|---|
| 정상 (page_size 20) | 20/20/20/3, has_more true/true/true/false | 63 | 63 / 중복 0 | 예 |
| Plaud가 짧은 페이지 반환(27/20/16) | 20/20/20/3 | 63 | 63 / 0 | 예 |
| 페이지 경계 2개씩 겹침 (page_size 25) | 25/25/13 | 63 | 63 / 0 | 예 |
| Plaud가 오름차순 반환 (page_size 50) | 50/13 | 63 | 63 / 0 | 예 |

query 값은 매 MCP 호출에 전달됨을 확인했다. 요청 한 번에 Plaud 호출은 정상 3회, 짧은 페이지 시 4회.

## 배포
- 버전 ID: `a631f624-0577-478c-86cc-f4bc209728b7`
- 라이브 스모크는 하지 않았다 (3분 대기 + 브라우저 없음).

## 남은 제한
- 500개/10페이지 상한 초과분은 보이지 않는다. 이 경우 total은 500이다.
- 요청마다 Plaud를 전부 다시 호출한다 (더 보기 포함). 느려질 수 있다.
- Plaud가 한 요청에서 일시적으로 불완전하게 줄 때(빈 페이지가 중간에 나오는 경우)는 여전히 그 시점의 결과만 보인다. 새로고침으로 다시 받는다.
- 가짜 MCP 검증이라 실제 Plaud 응답 형태 차이는 라이브에서 확인이 필요하다.

## 라이브 스모크 (2026-11-23 19:15~19:16, Merlin, 사용자 브라우저)
- "총 63개" 표시 확인. 새로고침 뒤 첫 페이지 20개, 최신 2026-11-21 17:17:07 유지, 오류 없음.
- "더 보기" 3번: 20 → 40 → 60 → 63, 마지막에 버튼 사라짐. 가장 오래된 항목 "How to use Plaud"(10-02) 일치. 날짜별 분포 Plaud와 동일.
- 커밋 안 함 (GitHub 스냅샷은 별도).
