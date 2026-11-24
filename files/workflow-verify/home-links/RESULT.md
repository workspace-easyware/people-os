# 홈 화면 링크 수정 — 결과

- 라이브 배포 버전: `107de218-3a19-4ec6-9455-eb5246bc0bbd` (2026-11-24)
- 수정 파일: `public/index.html` 하나 (커밋·푸시 안 함)

## 변경
- `renderHomeStats()`: 4개 카드에 `homeClick(...)` (cursor:pointer, tabindex=0, role=button, Enter) → 메일 `switchTab('email')`, 할 일 `'tasks'`, 문서 `'library'`, 성찰 `'coaching'`.
- 새 `homeClick(js)` 헬퍼, 새 `homeOpenLib(kind, id)`: `switchTab('library')`가 시작한 `refreshLib`를 `libRefreshP`로 받아 기다린 뒤 id로 항목을 연다 (switchTab의 library 분기만 `libRefreshP = refreshLib()`로 바꿈).
  - 최근 문서 행 → `libOpenDoc(id)` (문서 요약 화면. 문서에는 라이브러리 전체 화면 상세가 따로 없어 기존 "제목 클릭" 동작과 같은 곳으로 연다).
  - 최근 성찰 행 → 성찰 탭 + `openLibDetail('refl', idx)` (id → 인덱스 매핑, 전체 화면 상세).
- `taskRow()`: 행 전체 클릭 → `openTaskDetail(id)`. 체크박스·×는 `event.stopPropagation()`, Enter 키는 `event.target===this`일 때만.
- 모바일 `.t-meta` 구조·CSS 미변경.

## 검증
- `npx tsc --noEmit` 0건. 인라인 스크립트를 `inline.js`로 뽑아 `node --check` OK.
- 라이브: `/api/health` 200, `https://people-os.workspace-easyware.workers.dev/`의 서빙 HTML에 `homeOpenLib`·`homeClick`·`openTaskDetail&&`·`switchTab('coaching')`가 있음 (10건 매치, 배포 약 3분 뒤 확인).
- 미확인: 실제 브라우저 클릭 동작 (`-p` 세션에 브라우저 없음). 별도 브라우저 확인 필요 — 특히 성찰 행(코칭 대상 계정은 라이브러리 탭이 숨겨질 수 있음)과 문서 행.
- 로컬 `wrangler dev` 실행은 생략하고 라이브 HTML 확인으로 대신함.
