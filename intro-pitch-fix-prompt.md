# 소개·발표자료 20건 수정 — 프롬프트

## 목표
`files/workflow-verify/intro-pitch-review/REVIEW.md`에 적힌 20건(P0 6건 + P1 7건 + P2 7건)을 전부 고친다. **REVIEW.md가 명세서다.** 각 항목의 위치(파일:행)·이유·수정안을 그대로 따르고, 수정안대로 고치되 코드와 대조해 사실이 어긋나면 REVIEW.md보다 코드를 우선한다.

## 대상 파일 (이 파일들만)
- `public/index.html` — 소개 탭 (항목 7~12, 19)
- `public/pitch-content.html` — 발표자료 (항목 1~6, 13~15, 17~18)
- `public/architecture.svg` — 아키텍처 그림 (항목 16)
- `DEMO-SCRIPT.md` — 녹화 대본 체크리스트 (항목 17, 20)

## 주의 (항목별)
- **항목 13 (큐 문구)**: 워크플로우 단계 메시지가 타는 큐가 `workflow-step`인지 `src/workflow/engine.ts`와 `src/index.ts`를 읽어 확인한 뒤 문구를 확정한다. 바인딩이 `wrangler.toml`에 없으면 그 사실도 결과에 적는다.
- **항목 18 (심사 계정 안내)**: 제출 폼(구글 폼)은 아직 제출 전이라 폼 내용을 코드로 확인할 수 없다. 발표자료 문장("심사용 계정 안내는 제출 폼에 적었습니다")은 바꾸지 말고, 결과 보고서에 "11-27 제출 전 폼 초안에서 심사 계정 안내 포함 여부를 확인해야 한다"는 미확인 항목으로 남긴다.
- **항목 12 (화상회의)**: 실제 통화 1회는 아직 미검증(전사 큐만 통과)이다. "된다"고 단정하지 말고 "채팅방에서 영상 통화를 시작합니다" 수준으로만 쓴다.
- **항목 1 (Worker 하나)**: "메인 Worker 하나 + 문서 편집 전용 Worker 하나" 취지로 고친다. `people-os-doc-editor` 이름은 그림과 본문에서 일관되게 쓴다.
- **항목 16 (architecture.svg)**: SVG XML의 텍스트 요소만 고친다. 레이아웃을 크게 바꾸지 말고 `DocJobRunner`와 문서 작업 큐 2개(`people-os-docx-jobs`, `people-os-doc-jobs`)를 추가한다. 그림이 깨지지 않는지 렌더 전후를 눈으로 확인하기 어렵다면 파일 크기·XML 파싱(`node --check`는 JS용이라 안 되니 `python3 -c` 대신 텍스트로 구조 확인)으로 최소한 잘림이 없는지 본다.
- **항목 17**: 발표자료 §13 데모 링크는 `https://peopleos.site/`를 첫 번째로, workers.dev를 부기로. `DEMO-SCRIPT.md` 녹화 URL도 peopleos.site로 통일한다.
- "해야 할 일"·"성찰" 표현은 11-22 교정 이후라 그대로 둔다. "Worker"·"Durable Objects" 같은 고유명사는 영어 그대로 쓴다.

## 하지 말 것
- 로직·API·라우트·마이그레이션 변경 금지. `src/`·`migrations/`는 건드리지 않는다. `public/index.html`의 소개 탭 외 부분, `public/pitch.js`는 건드리지 않는다 (문구만 바꾸는 거라 JS 변경은 필요 없다).
- 메일 서식 편집기 파일(`public/email.css`·`public/email.js`·`public/email-rt.js` — 다른 채팅 작업, 미커밋)은 절대 건드리지 말고 커밋에 섞지 말 것. `decisions-2026-11-22/h/` (임시 자격증명) 절대 건드리지 말 것.
- `src/ask-pipeline.ts`의 LLM 모델(qwen3.8-27b), Clef, whisper, bge-m3는 건드리지 말 것 (이번 작업과 무관).

## 검증 (반드시 수행)
1. 고친 문구가 코드와 맞는지 각 항목마다 대조해 결과에 적는다 (특히 DO 8개, 노드 19종, 마이그레이션 0046, 큐 4개).
2. `npx tsc --noEmit` 0건 (HTML/SVG/MD만 바꿨으니 영향은 없어야 한다).
3. 운영 배포 (`~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy`를 절대 경로로 직접 실행. 배포 뒤 약 2분은 옛 버전이 응답하므로 스모크는 3분 뒤에 할 것).
4. 라이브 스모크: 소개 탭·발표자료 페이지가 200으로 뜨는지, 고친 문구(예: "여덟 개", "19종", "대기 동작", peopleos.site 링크)가 라이브 페이지에 보이는지 curl로 확인한다.
5. 결과 보고: `files/workflow-verify/intro-pitch-review/RESULT.md`에 항목별 수정 결과(고친 문구)·검증 결과·배포 버전 ID·라이브 확인 결과·미확인 항목(항목 18 폼 확인)을 기록한다. 화면(브라우저) 확인은 Merlin이 별도로 한다 — 세션은 API + 정적 파일 200까지만 확인한다.
6. 끝나면 `git add`는 하지 말고 변경 파일 목록과 커밋 메시지를 보고한다 (커밋·태그는 Merlin이 직접 한다).
