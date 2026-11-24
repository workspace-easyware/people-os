# 결재 단건 승인 확인 대화상자 + 성공 토스트 추가

## 배경

2026-11-23 밤 결재 테스트에서 사용자가 직접 관찰했다. 이구름 1차 승인(23:26)과 강준호 최종 승인(23:29) 모두 승인 버튼을 눌러도 확인 대화상자나 성공 토스트가 뜨지 않았다. 일괄 승인은 대화상자+토스트가 동작하니 단건 승인만 빠져 있는 상태다.

## 작업 위치

- 이 저장소 루트가 작업 디렉터리다 (`files/people-os/`).
- 고칠 파일은 `public/approval.js` 하나다. 마지막으로 이 파일을 건드린 커밋은 `5629f4a`다.

## 고칠 것 (최소 범위, 승인만)

`apvAct(action)` 함수(약 130행)에 다음 두 가지를 추가한다.

1. **APPROVE 실행 전 확인 대화상자**
   - 136~137행의 FORCE_REJECT·RECALL 패턴과 똑같이, `apvDoc.id` 가드(138행 `if (!apvDoc || apvDoc.id !== d.id) return;`) **앞에** 넣는다. 가드는 대화상자가 떠 있는 동안 다른 문서로 옮겨 갔을 때 중단하는 역할을 하므로 반드시 대화상자 뒤에 남아 있어야 한다.
   - `if (action === 'APPROVE' && !(await uiConfirm('승인합니다. 계속할까요?', { title: '승인', okText: '승인' }))) return;`
   - `uiConfirm`은 이미 이 파일에서 쓰고 있는 페이지 내 대화상자다. 네이티브 `confirm()`을 쓰지 말 것.

2. **성공 시 토스트**
   - `j.ok`인 경우, `apvRenderDetail`/`apvBack()` + `apvHome()` 뒤에 `ntfToast({ title: '승인했습니다' })`를 호출한다.
   - **주의: `ntfToast`는 문자열이 아니라 알림 객체를 받는다** (약 362행: `n.title`, `n.body`, `n.link`, `n.id`를 읽는다). `ntfToast('승인했습니다')`처럼 문자열을 넘기면 제목이 비어 있는 빈 토스트가 뜬다. 반드시 `{ title: '승인했습니다' }` 객체로 넘길 것.

## 건드리지 말 것

- REJECT는 의견 입력 필수라 이번 범위에서 제외한다. 손대지 말 것.
- FORCE_REJECT·RECALL의 기존 `uiConfirm` 호출은 그대로 둔다.
- 그 밖의 파일·기능은 일절 건드리지 말 것.

## 검증·배포

1. `npx tsc --noEmit`으로 타입 검사를 통과시킨다.
2. 배포는 `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 **절대 경로로 직접 실행**한다 (`python3` 경유 금지, `cd` 없이 이 저장소 루트에서 실행 — wrangler.toml의 name을 읽어야 한다). 배포는 직렬로 한 번만 한다.
3. 배포 후 약 3분을 기다렸다가 스모크 확인한다. 배포 직후 약 2분은 옛 버전이 응답하므로 바로 확인하지 말 것. 스모크는 `https://peopleos.site/api/health`와 버전 확인용 curl로 한다. 로그인 필요한 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다 (`peopleos.site`에 Cookie 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다). 원격 curl은 프록시 경유 plain curl로 한다 (`--noproxy '*'`는 TLS 실패).
4. 보고할 것: 라이브 배포 버전 ID, 바꾼 내용, 스모크 결과.

## 하지 말 것

- git 커밋·태그·GitHub 푸시는 하지 않는다. 라이브 배포까지만 한다.
- 테스트용 결재 기안은 만들지 않는다. 라이브 화면 검증은 Merlin이 별도로 브라우저에서 한다.
- 녹화용 기안 '12월 인사팀 워크숍 개최 요청'은 만들지 않는다. 녹화(11/26) 때 김불꽃이 직접 만들어 상신하기로 돼 있다.
