# 할 일 낙관적 업데이트 — 이어서 마무리하기 (2026-11-23 19:00, 런타임 재시작으로 앞 세션 중단됨)

## 앞 세션이 남긴 상태 (Merlin이 직접 확인한 것 — 보고서를 맹신하지 말고 아래를 대조할 것)

- **구현은 끝났다**: `public/tasks.js` +413/-85, `public/tasks.css` +3 (작업 트리에 있음). `npx tsc --noEmit` 0건, `node --check public/tasks.js` 통과 (Merlin 확인).
- **하네스는 있다**: `files/workflow-verify/tasks-optimistic/harness/`에 `worker.mjs`·`wrangler.toml`·`dev.log`(로컬 dev가 8791로 떴었음)·`state/`가 있다.
- **안 끝난 것**: 하네스 검증 결과 없음, `RESULT.md` 없음, **배포 안 됨** (라이브 최신은 여전히 `701848f0`).
- 원본 지시: `tasks-optimistic-prompt.md` (같은 폴더). 아래는 그 요약이 아니라 이어서 할 일이다.

## 할 일

1. **구현 대조**: `git diff public/tasks.js public/tasks.css`를 읽고 원본 프롬프트의 6개 요구(필드 변경·완료 토글·삭제·추가 낙관적 반영, 반복 다음 회차, 백그라운드 새로고침이 낙관적 상태를 덮지 않게, 다시 그리는 순간의 클릭 잠금)가 코드에 들어있는지 확인한다. 빠지거나 틀린 게 있으면 고친다.
2. **하네스 검증**: 원본 프롬프트의 (a)~(e)를 하네스로 실행한다 — (a) 시간 변경 직후(서버 응답 전) 줄·상세에 새 시간 표시 (b) PATCH 실패 시 원래 값으로 복귀 + 토스트 (c) 반복 할 일 완료 시 응답 뒤 다음 회차 표시 (d) pending 변경 중 백그라운드 새로고침이 낙관적 상태를 유지 (e) 삭제·추가·별표·위/아래 이동 즉시 반영. 실패하면 고치고 다시 돌린다.
3. **배포**: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행 (python3 경유·env 접두어 금지, cwd는 이 레포 루트). 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 한다.
4. **라이브 스모크**: `https://people-os.workspace-easyware.workers.dev`로 curl (peopleos.site에 Cookie 붙인 curl은 샌드박스 프록시에서 멈춘다. 원격 curl은 `--noproxy`를 쓰면 TLS 실패 — 프록시 경유 plain curl로). 로그인 필요한 호출은 `~/workspace/user`에 세션 토큰이 없으면 운영 D1에 임시 사용자 + 1시간 세션을 넣어 시험하고 지운다 (할 일·목록·세션·사용자 행 전부 삭제, 적용 직후 개수와 대조). 실제 사용자 3명의 데이터는 건드리지 않는다.
5. **결과 기록**: `files/workflow-verify/tasks-optimistic/RESULT.md`를 쓴다 (배포 버전 ID, 검증 항목별 통과 여부, 남은 한계).
6. **커밋하지 않는다** (Merlin이 직접 커밋한다). 화면 확인은 이 세션에서 못 하므로 남긴다 (Merlin이 브라우저로 확인한다).
7. 작업 트리의 `public/email.css`·`public/email.js`·`public/index.html` 미커밋 변경은 다른 작업(메일 서식 편집기)이다. 건드리지 말고, 커밋 대상에도 넣지 않는다.
