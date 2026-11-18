# 소개·발표자료·데모 반영 감사 (Fable) — 무엇을 고칠지 목록만 만든다

## 요청
최근 배포된 기능들이 소개·발표자료·데모 대본에 반영됐는지 감사하고, 빠진 것을 목록화한다. **이 세션은 목록만 만든다. 파일을 고치지 않는다.** (수정은 다음 Sonnet 세션이 한다.)

## 최근 배포된 기능 (감사 대상)
아래 목록이 최신 배포에 들어간 기능이다. 각 기능이 /pitch.html, README.md, DEMO-SCRIPT.md에 반영됐는지 확인한다.

1. **워크플로우 빌더 WF-1~WF-12**: 노드 12개(ask_rag·ask_personal·transcribe·summarize·reflect·draft_pptx·email_draft·send_email·create_task·llm·create_calendar_event), 실행 엔진(Queues), 승인 게이트, 폼 빌더 UI, 에이전트 루프(ReAct, WorkflowAgent DO), 조건 분기, 스케줄+이벤트 트리거, 공유/템플릿+웹훅, 비주얼 캔버스, 관측 탭.
2. **플로팅 채팅**: 사이드바 탭 → 우하단 FAB + 오버레이 패널(380×600, 모바일 전체 화면). 어느 탭에서든 사용 가능.
3. **그룹 자동 이름 + 이름 변경**: 그룹 생성 시 이름 비워두면 멤버 이름으로 자동 지정("김불꽃, 이구름"). 머리글 연필 버튼으로 이름 변경 가능.
4. **DO 정밀 레이트 리미터 (RateLimiter DO)**: 질문 API 분당 20회 제한을 KV에서 DO 토큰 버킷으로 이동 (KV eventual consistency 구멍 메움).
5. **실시간 알림 푸시 (NotificationHub DO)**: 결재·메일·할 일 알림을 WebSocket으로 실시간 푸시.
6. **모델 교체**: 주 답변 모델 Qwen3-30B(`@cf/qwen/qwen3-30b-a3b-fp8`) → qwen3.8-27b(`@cf/qwen/qwen3.8-27b`)로 교체 (Cloudflare 11/20 폐기 대응). responseText()가 chat.completion 형식(`choices[0].message.content`)을 읽게 수정. **주의: reasoning low/medium 결정은 아직 안 났다** (low는 LLM 6.0초·avgJudge 0.83, medium은 70.2초·0.8667 — 어느 쪽을 유지할지 미결정). 그래서 pitch·README에 속도 수치를 단정적으로 적으면 안 된다.
7. **비밀번호 보기 토글**: 로그인·초기 설정·비밀번호 변경 입력란에 "보기"/"숨기기" 버튼.
8. **좁은 화면 로그아웃 동그라미**: 760px 이하 좁은 화면에서도 로그아웃이 동그라미 아바타로 표시 (미디어 쿼리 누락 수정).
9. **채팅 presence·읽음·이모지 반응** (방금 배포, 버전 `5a7a6aae`): 상대방 접속 녹색불, 보낸 메시지 옆 읽음 "1" 표시(읽으면 사라짐), 이모지 반응 6개(👍❤️😂😮😢🙏, 토글), 접힌 상태 새 메시지 배지(1:1 포함, DM 미읽음 계산 추가). D1 마이그레이션 0031 (chat_reactions).
10. **기타 (이미 반영됐을 수 있음)**: 캘린더 C1~C4 (FullCalendar·구글 OAuth·구글 실시간 읽기), LMS, 전자결재, 이메일 (peopleos.site + Resend), 조직관리, 로그인(PBKDF2), 개인 RAG, 결정 모델 4층, 관측·평가(S4).

## 감사 방법
1. **기능 목록 확정**: `workflow-agent-builder-PROGRESS.md`와 `files/workflow-verify/*/RESULT.md`들을 읽어 위 1~9번 기능이 실제로 배포됐는지, 배포 버전이 무엇인지 확인한다. (PROGRESS.md가 최신이면 그걸 기준으로 한다.)
2. **문서 읽기**: `public/pitch.html`, `README.md`, `DEMO-SCRIPT.md`를 읽는다.
3. **대조**: 각 기능(1~9번)이 세 문서에 각각 반영됐는지 확인한다. 반영 기준:
   - **pitch.html**: 기능이 소개·발표자료에 언급되는가? (심사위원이 보는 자료라 핵심 기능은 들어가야 한다.)
   - **README.md**: 기능이 README의 기능 목록·아키텍처에 언급되는가?
   - **DEMO-SCRIPT.md**: 데모 흐름에서 해당 기능을 시연하는 장면이 있는가? 데모 흐름이 바뀐 부분(예: 플로팅 채팅으로 채팅 시연 방식이 바뀜, 워크플로우 빌더 시연)이 있으면 그 부분도 확인한다.
4. **목록화**: 빠진 것을 문서별·기능별로 목록으로 만든다. 각 항목에 "어느 문서에, 무엇이 빠졌는지, 얼마나 중요한지(핵심/보조)"를 적는다.

## 산출물
- 감사 결과를 `files/workflow-verify/pitch-audit/RESULT.md`에 작성한다. 형식:
  - 배포된 기능 목록 (버전 포함, 확인된 것만).
  - 문서별 빠진 기능 목록 (pitch.html / README.md / DEMO-SCRIPT.md 각각).
  - 데모 흐름 변경이 필요한 부분 (플로팅 채팅·워크플로우 빌더 등).
  - 다음 세션(Sonnet)이 고쳐야 할 우선순위 목록.
- 파일을 고치지 않는다. `public/pitch.html`, `README.md`, `DEMO-SCRIPT.md`를 수정하지 않는다.

## 보고 형식 (최종 응답)
- 감사한 기능 수와 문서 수.
- 문서별 빠진 기능 요약 (가장 중요한 3~5개만).
- 데모 흐름 변경 필요 여부 (있으면 1~2줄).
- RESULT.md 경로.
