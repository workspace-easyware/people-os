# 라이브러리 카드 상세 보기 (규정·성찰) — 결과

## 구현
- `src/index.ts` `/api/library`: 규정 SELECT에 `body`, 성찰 SELECT에 `transcript`, `questions` 추가 (권한·범위 변경 없음, 마이그레이션 없음).
- `public/index.html` `refreshLib` 주변:
  - 규정·성찰 목록을 `libPols`/`libRefls`에 보관, 카드에 클릭·Enter 동작(`openLibDetail`)과 포인터 커서·호버 표시.
  - `#libMain`(서브탭+목록)을 숨기고 `#libDetail`에 전체 화면 상세를 그림. 맨 위 `← 규정 목록` / `← 성찰 목록` 버튼(`closeLibDetail`)이 목록으로 복귀하고 `setLibTab(libTab)`으로 같은 서브탭을 유지.
  - 규정: 제목·조항·본문(`white-space:pre-wrap`). 성찰: 제목·참여자·날짜·패턴 전부·질문(있을 때)·다음 질문 전부·전사문. 모든 텍스트는 `esc()`.
  - `refreshLib()` 재그리기는 목록으로 돌아가게 됨(상세 화면이 빈 화면이 되지 않음).
- 답변 대기·파일 목록 탭, 마이그레이션, 모델 설정 변경 없음.

## 검증
1. `npx tsc --noEmit`: 0건.
2. 로컬 `wrangler dev --local` (임시 hr_admin 세션): `policies[].body` 확인. 로컬 DB에는 성찰 데이터가 없어 성찰 필드는 로컬에서 미확인 (쿼리는 오류 없이 실행됨).
3. 배포: 버전 `74632879-7081-4748-8a03-fc89174a5903`.
4. 라이브 (`people-os.workspace-easyware.workers.dev`):
   - 익명 `/api/library` → 401 유지.
   - 관리자 시크릿: 규정 `body` 7건.
   - 임시 hr_admin 세션(운영 D1 임시 사용자): 응답에 `transcript` 19회·`questions` 16회 포함 (성찰 필드 확인). 임시 users/auth_sessions 행 삭제 후 0/0 확인.
   - 정적 `index.html`에 `openLibDetail` 포함 확인.
5. 브라우저 화면 확인은 Merlin이 별도로 해야 함.
   - 1차 확인(21:39~21:41): 규정·성찰 카드 클릭이 안 됨 — 탭이 배포 전 캐시된 옛 index.html로 돌고 있었기 때문. 앱 내 새로고침 버튼은 데이터만 다시 불러와 코드가 안 바뀜.
   - 하드 새로고침 뒤 재확인(21:41~21:43): 규정 상세(연차휴가 본문 전문 + `<- 규정 목록`)·성찰 상세(패턴 3·질문 3·다음 질문 3·전사문 + `<- 성찰 목록`) 모두 정상, 뒤로가기 동작.
   - 제목 다듬기(21:45~21:48): 성찰 상세 큰 제목이 유형명("코칭 성찰")만 뜨던 것을 주제 문장(첫 패턴)으로 바꾸고 유형명은 작은 글자로 내림. 배포 `55fd997a-0861-49b5-9a61-dcc770012997`, 라이브 정적 파일 확인 + 브라우저 재확인 완료 (큰 제목 "팀장으로서의 책임감과 팀 분위기 조성에 대한 부담", 아래 "코칭 성찰", 뒤로가기 정상).

## 주의
- `cf-wrangler.py deploy`는 작업 트리 전체를 번들하므로, 다른 채팅의 미커밋 메일 서식 편집기 변경(`public/email.*`, `public/plaud.js`, `src/plaud/routes.ts` 등)도 이번 배포 버전에 포함됐다.
- `index.html`에도 다른 채팅의 미커밋 변경이 섞여 있어 커밋 시 hunk를 나눠야 한다.
