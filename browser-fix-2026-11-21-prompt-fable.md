# 브라우저 화면 회귀 버그 수정 — Fable 5.2 세션 (Opus 세션 중단 뒤 이어서)

## 인계 (먼저 읽을 것)

- 원래 수정 지시는 `browser-fix-2026-11-21-prompt.md`에 있다. **그 파일을 먼저 읽고 그대로 따른다.**
- Opus 세션이 14분간 돌다가 사용자 지시(문제 해결은 Fable 5.2로)로 중단됐다. Opus가 이미 아래 8개 파일을 수정해 둔 상태다 (커밋 안 함, 배포 안 함, RESULT.md 없음):
  - `public/agents.js`, `public/index.html`, `public/pptx-edit.js`, `public/styles.css`, `public/workflow.js`
  - `src/assistant/routes.ts`, `src/index.ts`, `src/workflow/nodes.ts`
- 네가 할 일: **먼저 `git diff`로 Opus가 뭘 바꿨는지 확인한다.** 옳은 수정은 살리고, 틀렸거나 덜 된 것은 고치고, 남은 항목(원본 프롬프트 1~8번)을 끝까지 한다. Opus의 변경을 무작정 되돌리지 않는다 — diff를 읽고 판단한다.
- 테스트 대기 동작 `wfpa_wfrun_mwq51k7g_02syzj_1_t1`은 아직 `queued`다. **API로 승인하지 말 것** — Merlin이 수정 뒤 브라우저로 직접 눌러 확인할 것이다.
- 결과 파일은 원본 프롬프트대로 `files/workflow-verify/regression-2026-11-21/browser-fix-RESULT.md`에 쓴다.
