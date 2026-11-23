# 소개·발표자료 20건 수정 — 이어하기 프롬프트

## 상황
이전 Sonnet 세션이 런타임 재시작으로 중단됐다. 편집은 4개 파일에 상당 부분 들어갔으나 `RESULT.md`를 쓰지 못했고 **배포는 안 했다** (최신 라이브 버전은 여전히 `e6fed297`, 답변 대기 수정분). 중단된 세션의 보고서를 맹신하지 말고 파일 상태를 직접 대조해서 이어간다.

## 작업
1. `files/workflow-verify/intro-pitch-review/REVIEW.md`의 20건을 명세서로, 현재 파일 상태와 항목별로 대조한다.
   - 대상: `public/index.html` (소개 탭), `public/pitch-content.html` (발표자료), `public/architecture.svg`, `DEMO-SCRIPT.md`.
   - 이미 고쳐진 항목은 그대로 두고, 빠진·덜 고쳐진 항목만 마저 고친다. 고친 문구가 코드와 맞는지 각 항목마다 대조한다 (DO 8개, 노드 19종, 마이그레이션 0046, 큐 4개).
2. 원래 프롬프트(`intro-pitch-fix-prompt.md`)의 항목별 주의사항을 그대로 지킨다. 특히:
   - 항목 13 큐 문구는 `src/workflow/engine.ts`·`src/index.ts`를 읽어 확인 후 확정한다.
   - 항목 18 심사 계정 안내는 문장을 바꾸지 말고 미확인 항목으로 남긴다.
   - 항목 12 화상회의는 "된다"고 단정하지 말고 "채팅방에서 영상 통화를 시작합니다" 수준으로만 쓴다.
3. `npx tsc --noEmit` 0건.
4. 운영 배포 (`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행. 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 할 것).
5. 라이브 스모크: 소개 탭·발표자료 페이지 200 확인, 고친 문구("여덟 개", "19종", "대기 동작", peopleos.site 링크 등)가 라이브 페이지에 보이는지 curl로 확인한다.
6. 결과 보고: `files/workflow-verify/intro-pitch-review/RESULT.md`에 항목별 수정 결과(고친 문구)·검증 결과·배포 버전 ID·라이브 확인 결과·미확인 항목(항목 18 폼 확인)을 기록한다. 화면(브라우저) 확인은 Merlin이 별도로 한다 — 세션은 API + 정적 파일 200까지만 확인한다.
7. 끝나면 `git add`는 하지 말고 변경 파일 목록과 커밋 메시지를 보고한다 (커밋·태그는 Merlin이 직접 한다).

## 하지 말 것
- 로직·API·라우트·마이그레이션 변경 금지. `src/`·`migrations/`·`public/pitch.js`는 건드리지 않는다.
- 메일 서식 편집기 파일(`public/email.css`·`public/email.js`·`public/email-rt.js` — 다른 채팅 작업, 미커밋)은 절대 건드리지 말고 커밋에 섞지 말 것. `decisions-2026-11-22/h/` (임시 자격증명) 절대 건드리지 말 것.
- `src/ask-pipeline.ts`의 LLM 모델(qwen3.8-27b), Clef, whisper, bge-m3는 건드리지 말 것.
