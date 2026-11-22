# 사용자 결정 3건 반영 결과 — 2026-11-22 (Fable 5.2)

## 판정: 3건 전부 구현·배포 완료. 세션은 런타임 재시작으로 중단돼 RESULT.md를 쓰지 못했고, Merlin이 증거(버전·diff·D1·라이브 스모크)를 대조해 마무리했다.

- 배포 버전: People OS **`94209460-b585-4299-a1b1-fc1423978c2f`** (이전 `a2843af6`, 2026-11-21T22:38:49Z 배포). 문서 편집 Worker는 건드리지 않았다 (`1dd93ed7` 그대로).
- 커밋·태그·문서 갱신은 Merlin 몫으로 남았다 (아래 "Merlin 마무리" 참고).
- 세션 중단 시점: 하네스 파일 마지막 기록 07:40~07:41 (cleanup.sql 07:40, h/ 디렉터리 07:41). 배포(07:38:49) + 시험 데이터 정리까지는 끝나 있었다.

## 반영한 결정 3건 (2026-11-22 03:07 사용자 결정)

### ① 비밀번호 변경 → 아바타 메뉴 (`public/index.html`, `public/styles.css`)

- 사이드바 하단 아바타(원형 이니셜)를 누르면 사용자 메뉴가 뜬다: "비밀번호 변경" · "로그아웃". 아바타가 원래 `display:none`이라 `styles.css`에서 `display:grid`로 바꿨다. 메뉴는 fixed 위치로 아바타 바로 위에 뜨고 (접힌 사이드바에서도 안 잘림), 바깥 클릭·Esc로 닫힌다.
- "비밀번호 변경"은 새 대화상자 `#pwDlg`를 연다: 현재 비밀번호 / 새 비밀번호(12~128자) / 새 비밀번호 확인 + "변경하면 다른 기기의 로그인은 모두 해제됩니다." 안내. 클라이언트 검사 2종 (새 비밀번호 확인 일치, 현재 비밀번호와 다름) + 제출 중 버튼 비활성화 + 실패 시 오류 문구. 성공하면 대화상자가 닫히고 토스트 "비밀번호를 변경했습니다. 다음 로그인부터 새 비밀번호를 사용하세요."
- 호출하는 API는 기존과 같다 (`POST /api/auth/change-password`). 관리자 탭의 "내 비밀번호 변경" 카드(`adminPwCard`)는 중복 구현하지 않고 안내 문구 + "비밀번호 변경 열기" 버튼으로 바꿨다 (같은 대화상자를 연다).
- 검증: 임시 일반 사용자(tmp-dec1122-user, user/coachee)로 비밀번호 변경 1회 성공 — `Tmp-Dec1122-First-Pw-7391` → `Tmp-Dec1122-Second-Pw-4826` (h/chpw.json). **mercer 계정은 건드리지 않았다** (임시 사용자로 검증했으므로 원복할 것도 없음).

### ② 암묵지 게시 → hr_admin 전용 (`src/index.ts`, `public/index.html`)

- 서버: 새 헬퍼 `tacitPublishDenied()` — X-Admin-Secret(운영 스크립트)은 관리자와 같게 본다. 로그인 안 됨 401, hr_admin 아님 403. 적용 2곳:
  - `POST /api/gaps/:id/publish` (기존 401 검사 대체)
  - `POST /api/documents`에 `kind:"tacit"` 직접 입력 (게시 엔드포인트를 돌아가는 길도 같은 규칙)
- 화면: `gapsSection()`에서 open gap은 hr_admin이 아니면 게시 폼(textarea + "게시하기") 대신 안내만 보인다: "답변 대기 중입니다. hr_admin만 게시할 수 있습니다 — HR 관리자가 답을 게시하면 같은 질문에 암묵지 출처로 답변합니다."
- 검증 (하네스 요청 본문 기준, 응답 파일은 세션 중단으로 남지 않음 — Merlin이 라이브에서 익명 401을 재확인):
  - 임시 일반 사용자의 `POST /api/gaps/gap_tmp_dec1122/publish` 시도 (h/publish.json) — 서버 403 경로.
  - 임시 일반 사용자의 `POST /api/documents` kind tacit 직접 입력 시도 (h/doc-tacit.json) — 서버 403 경로.
  - 라이브 익명 `POST /api/gaps/does-not-exist/publish` → 401 (Merlin 재확인).

### ③ qwen3.8-27b 단가 → `src/obs/pricing.ts`에 추가

- `"@cf/qwen/qwen3.8-27b": { inPerM: 0.45, outPerM: 3.20, checked: "2026-11-22" }` — 2026-11-22 공식 가격 페이지(2026-11-18판) 대조 + AI Gateway 실측(tag=ask 38건, 질문 1건 평균 $0.00168 = 입력 583 · 출력 443토큰)과 일치. 지금까지 qwen 항목이 없어 비용 추정이 null이었던 문제가 해결됐다.

## 한 검증 (세션)

- 세션의 실행 로그가 비어 있어 세션 자체의 `node --check`·`tsc` 결과를 확인할 수 없다. Merlin이 대신 diff 4개 파일을 직접 검토했고 (위 3건과 일치), `npx tsc --noEmit`을 직접 돌려 0건을 확인했다.
- 라이브 (Merlin 재확인, 배포 뒤): `/api/health` 200, 익명 `/api/auth/me` 401, 서빙되는 홈 HTML에 `userMenu`·`pwDlg` 16건, 익명 publish 401.
- 임시 데이터 정리: 임시 사용자 2명(tmp-dec1122-admin hr_admin / tmp-dec1122-user user), 임시 gap 1건(`gap_tmp_dec1122`), 세션·password_links 전부 삭제 — D1 재확인 0건 (users 3명 = 실제 계정만).

## Merlin 브라우저 확인 (사용자 결정으로 건너뜀)

- mercer.jhkang@peopleos.site(김불꽃, 일반 사용자)로 로그인해 아바타 메뉴 → 비밀번호 변경 대화상자 열림(변경은 안 함) + 관측·평가의 open gap에 게시 폼 대신 hr_admin 전용 안내가 보이는지 확인하려 했으나, **Secure Vault에 mercer 로그인이 저장돼 있지 않았다** (peopleos.site 로그인은 hr 계정 1개뿐 — MEMORY.md의 "mercer 로그인 저장됨" 기록은 잘못된 것이었다). 브라우저가 hr 비밀번호를 채워 계속 실패했고, 추가 시도는 중단했다.
- 사용자에게 mercer 비밀번호를 보안 카드로 입력해달라고 요청했으나 **사용자 결정 (2026-11-22 08:05 "아니야 괜찮아")으로 mercer 화면 확인은 건너뛴다**. 임시 일반 사용자로 같은 동작(비밀번호 변경 성공, 게시 403 경로)을 이미 확인했으므로, 화면 렌더링만 미확인으로 남는다. 브라우저 태스크는 종료했다.

## 남은 문제·미확인

- 세션의 API 검증 응답 파일이 없다 (publish/doc-tacit 시도의 응답 본문 미기록). 서버 코드는 401/403 분기를 명시하고 있고, 익명 401은 라이브에서 재확인했으나 **일반 사용자의 publish 403은 응답 파일이 없어 Merlin이 직접 재확인하지 못했다**. 브라우저 mercer 확인에서 화면(버튼 숨김)까지만 본다.
- 하네스 파일(`h/*.json`, `pw-new.json`)에 임시 사용자 비밀번호·토큰이 들어 있다. 해당 사용자는 D1에서 삭제돼 토큰·비밀번호는 이미 무효하지만, **이 파일들은 커밋하지 않는다** (다른 세션 하네스와 같은 취급).

## Merlin 마무리 (완료)

- [x] RESULT.md 확정 (mercer 브라우저 확인은 사용자 결정으로 건너뜀) → 커밋 + 태그 `decisions-2026-11-22-v1` → ARCHITECTURE.md·VERIFICATION.md·MEMORY.md 갱신
