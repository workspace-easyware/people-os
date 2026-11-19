# 화상회의 V1+V2 — 채팅 연동 + 전사 파이프라인 (끝까지)

V0가 통과했다 (두 브라우저 영상 연결, 타일 표시 확인됨, 배포 `9a538542`). 이제 V1(채팅 연동)과 V2(전사 연계)를 끝까지 구현한다. 사용자가 "지금 바로 진행해. 끝까지 진행해서 서비스 붙여보자"고 지시했다.

## 배경 문서 (반드시 읽을 것)

- 계획: `files/people-os/video-conference-plan.md` (2장 아키텍처, 3장 일정, 5장 인증·권한, 6장 녹화·전사 연계, 9장 결정 항목).
- V0 결과: `files/workflow-verify/video-conference-v0/RESULT.md` (7장 배포, 8절 타일 수정 1차·2차까지).
- 현재 라이브 배포: `9a538542`. 롤백 지점 `4b1877d5`.

## 현재 상태 (V0에서 이미 있는 것)

- `src/meet/rtk.ts` (REST 호출·서명 검증), `src/meet/routes.ts` (`/api/meet/*`: start·active·get·join·end·webhook·presets·webhooks).
- 마이그레이션 0038 `meetings` 표 (부분 고유 인덱스 `(room_id) WHERE status='active'`).
- `public/meet.html`·`meet.js`·`meet.css` (SDK 2.1.0 고정, `mode="fill"`, `__meetDiag()` 진단 헬퍼, `watchStageLayout()` 안전망).
- 회의 생성 시 `transcribe_on_end: true` + `ai_config.transcription.language: "ko"`가 이미 들어 있다.
- **웹훅 등록은 아직 안 됐다.** RealtimeKit 대시보드에 `https://peopleos.site/api/meet/webhook`을 `meeting.started`·`meeting.ended`·`meeting.transcript` 이벤트로 등록해야 한다. 이건 별도 브라우저 작업으로 진행 중이다. 웹훅이 없어도 V2 코드는 완성할 수 있다 (웹훅 핸들러 + 15분 크론 폴백).
- **커밋 안 된 파일이 많다** (31개 규모). 이 세션 시작 전에 `git add -A` + `git commit`으로 기준점을 만든다. 커밋 메시지는 "video-conference V0 + tile fix"로 한다. **GitHub 푸시는 하지 않는다.**

## V1 — 채팅 연동 (계획 2장·3장)

목표: 채팅방에서 시작해 상대가 카드로 참여하고, 종료 후 카드가 닫힌다.

1. **채팅방 헤더 버튼**: `public/chat.js` 방 헤더에 [영상 통화] 버튼 1개. 클릭하면 `POST /api/meet/rooms/:roomId/start` → 진행 중 회의가 있으면 그 회의 반환, 없으면 생성. 성공하면 `/meet?m=<id>`를 새 탭으로 연다.
2. **통화 중 카드**: `ChatRoom` DO의 기존 `/event` 브로드캐스트에 `meeting_started`·`meeting_ended` 이벤트 종류를 추가한다 (`src/chat/room.ts`). 방 안에 "영상 통화 진행 중 · 참여" 카드를 그린다. 참여 클릭 시 `/meet?m=<id>` 새 탭.
3. **알림**: 방을 열지 않은 멤버에게는 기존 `NotificationHub` DO의 `pushNotification()`으로 알린다. (계획 2장 참조.)
4. **종료 흐름**: 회의 종료(`POST /api/meet/:id/end`) 후 `meeting_ended` 브로드캐스트로 카드가 닫힌다. 종료 버튼은 회의 시작자 또는 coach만 (V0 라우트 규칙 그대로).
5. **오래된 회의 정리 (V0 RESULT.md 8절 하네스 관찰)**: DB에는 `active`인데 RealtimeKit 쪽에 회의가 없어 join이 502가 되는 경우. V1에서 막는다: (a) `start`가 기존 active 회의를 돌려줄 때 RealtimeKit에 실제 존재하는지 확인하고, 없으면 그 행을 `ended`로 바꾸고 새로 만든다. (b) 15분 크론에 정리 작업을 추가한다 (ended된 지 오래된 active 행을 RealtimeKit 조회 후 정리). 둘 중 하나라도 구현한다. 둘 다 하면 더 좋다.
6. **전사 안내 문구**: 입장 화면(`meet.html` 설정 화면)에 "이 회의는 전사됩니다" 표시를 넣는다 (계획 9장 결정 7번, 권장: 넣는다).
7. **전사 on/off**: 사용자 결정은 "코칭 1:1 방은 자동, 나머지는 시작할 때 선택"이다. `start`에 `transcribe` 옵션을 받는다. 코칭 DM(`is_coaching=1`)이면 항상 `transcribe_on_end: true`. 그 외 방이면 시작할 때 선택할 수 있게 `meet.html` 입장 전 화면 또는 채팅 버튼 옆에 선택지를 둔다. 기본값은 켜짐으로 한다.

## V2 — 전사 연계 (계획 6장)

목표: 한국어 통화 5분이 녹음전사 목록에 화자 이름과 함께 뜨고 검색된다.

1. **웹훅 `meeting.transcript` 처리** (`src/meet/routes.ts`의 `POST /webhook`): 서명 검증은 V0 그대로. `transcriptDownloadUrl`에서 JSON을 내려받는다.
2. **화자 이름 변환**: 전사 JSON의 화자 id(`custom_participant_id` = People OS 사용자 id)를 사용자 이름으로 바꿔 "이름: 발화" 형태의 전사본을 만든다.
3. **recordings 행 생성**: `transcript_status = 'ready'`, `provider = 'realtimekit'`로 넣는다. 원본 JSON은 R2 `meetings/<id>/transcript.json`에 둔다. 소유자(`owner_id`)는 회의를 시작한 사람으로 한다 (계획 6장 권장. 코칭이면 코치).
4. **기존 파이프라인 연결**: 기존 완료 분기와 같은 함수로 문서를 만들고 `PIPELINE` 큐에 넣는다. 이후 요약·색인·코칭 리플렉션은 지금 코드 그대로다. `meetings.recording_id`를 채운다.
5. **채팅방 알림**: 전사본이 준비되면 채팅방에 "전사본이 준비됐습니다" 메시지를 남긴다.
6. **웹훅 누락 대비 (15분 크론)**: 종료됐는데 전사가 안 붙은 회의를 크론이 RealtimeKit REST로 다시 조회해 가져온다. 전사본은 회의 종료 후 7일만 보관되므로 크론 주기는 15분이면 충분하다.
7. **코칭 표시**: 코칭 DM 회의면 전사 문서에도 `is_coaching` 플래그를 넘긴다 (기존 0020 코칭 플래그와 같은 의미).

## 로컬 검증 (V0 하네스 재사용)

- `files/workflow-verify/video-conference-v0/`의 mock-rtk-worker.js·mock-rtk.toml·seed.sql·state/를 재사용한다. 목 서버에 전사 웹훅(`meeting.transcript`) 흉내를 추가한다.
- `npx tsc --noEmit` 통과.
- 로컬 wrangler dev로 확인한다:
  - V1: 채팅 버튼 클릭 → start 201 → 카드 표시 → 다른 계정으로 참여 → end → 카드 닫힘. (브라우저가 없으므로 chat.js 로직은 코드 리뷰 + API 호출로 확인하고, 화면 확인은 브라우저 검증 단계에 적는다.)
  - V1: 오래된 회의 502 재현 → start가 새로 만드는지 확인.
  - V2: `meeting.transcript` 웹훅 → recordings 행 생성 → 문서 생성 → 큐 진입 → 요약·색인까지 이어지는지 확인. 화자 이름이 제대로 바뀌는지 확인.
  - V2: 크론 폴백이 웹훅 없이 전사를 가져오는지 확인.
- 헤드리스 브라우저가 없어 실제 화면·타일 렌더링은 로컬에서 못 본다 — 그 한계를 RESULT.md에 적는다.

## 결과물

- `files/workflow-verify/video-conference-v0/RESULT.md`에 9절 "V1+V2"를 추가한다. 내용: 구현한 것, 바꾼 파일, 로컬 검증 결과(통과/미확인 구분), 배포 후 브라우저 확인 절차 (V1: 채팅방 시작→카드→참여→종료→카드 닫힘, V2: 5분 통화 후 전사본이 녹음전사 목록에 화자 이름과 함께 뜨고 검색되는지).
- **배포하지 않는다. GitHub 푸시하지 않는다.**
- `wrangler.toml`의 routes 항목은 건드리지 않는다. 토큰 값은 어디에도 기록하지 않는다.
- **주의: XAI 세션과 `src/index.ts`가 겹칠 수 있다.** `src/index.ts`를 고칠 때는 XAI 관련 코드를 건드리지 않는다. `meetings` 마이그레이션 번호는 다음 빈 번호를 쓴다 (0038이 마지막).
