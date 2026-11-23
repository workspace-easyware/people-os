# 라이브러리 답변 대기 개수 + 해결된 답변 전문 보기 — 결과 (2026-11-23)

## 구현
- `src/index.ts` `GET /api/gaps`: `documents.content`(게시 답변 전문, 작성자·원 질문 머리말 포함)를 LEFT JOIN으로 가져와 status가 open이 아니고 doc_id가 있는 행에만 `answer`로 싣는다. open 행은 `answer: null`. 권한 그대로 (익명 401). 게시 핸들러·마이그레이션 변경 없음.
- `public/index.html`:
  - `gapsSection`: "답변 대기 N건"(open만) / "해결됨 M건"(resolved·published·answered) 두 구역. 빈 구역은 숨김, open이 없으면 "답변 대기 중인 질문이 없습니다." 문구. 서브탭 배지는 open 개수 그대로.
  - 해결된 카드만 `libcard-click`(tabindex, role=button, Enter) → `openLibDetail('gap', i)`. 상세: 뒤로가기 `← 답변 대기 목록`, 질문, 상태 배지, 메타, 게시된 문서 제목, 답변 전문(`lib-detail-body`, 줄바꿈 유지, `esc()`). open 카드는 클릭 동작 없음.
  - `refreshLib()`이 다시 그리면 `#libDetail`이 숨김 상태로 새로 만들어져 목록이 보인다 (빈 화면 없음).
- 건드리지 않음: 게시 플로우, gap 행, 규정·성찰 상세, 파일 탭, 메일 편집기 파일, h/ 폴더.

## 검증
1. `npx tsc --noEmit`: 0건.
2. 로컬 `wrangler dev --local` (시드: open 1 / resolved 1 / published 1): resolved·published 행에 `answer` 전문(줄바꿈 포함), open 행 `answer: null`. 익명 401.
3. 배포: 버전 `e6fed297-e68c-462e-abe8-a2f128184c0d`.
4. 라이브 스모크 (workers.dev, 배포 약 3분 뒤): 익명 `/api/gaps` 401 유지 / 관리자 시크릿 GET 200 — open 1건 `answer:null`, resolved 5건 모두 `answer` 본문 포함 / `/` 200. 읽기 전용이라 임시 사용자·DB 변경 없음 (응답 파일은 확인 뒤 삭제).
5. 브라우저 화면 확인은 Merlin이 한다.
