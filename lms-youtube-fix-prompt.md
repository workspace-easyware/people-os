# LMS 강의실 유튜브 임베드 잘림 수정 (Sonnet)

## 배경
사용자가 강의실 화면 스크린샷(`workspace/user/media_library/image/image-6.png`)을 보내며 유튜브 영상이 잘려서 나온다고 했다. 유튜브 연결 영상은 그냥 틀어주는 것일 뿐인데 잘려서 나온다. 이 정도 기능은 오류 없이 나와야 한다.

## 증상 (스크린샷 기준)
- 강의실 화면 "2026 클로드 올인원 무료강의" (해피AI, 1/14 완료), 유튜브 영상 `ZN37IV4sbQg` (2:53:47, 현재 37:31).
- 영상 영역이 검은색으로 넓게 잡혀 있는데, 실제 영상 내용은 위쪽 작은 직사각형에만 보이고 아래는 검은 여백이다. 재생 버튼이 영상 한가운데에 겹쳐 보인다. "동영상 더보기" 오버레이와 YouTube 로고가 보인다.
- 오른쪽에는 챕터 목록(1~13)이 정상적으로 보인다.
- 즉 iframe은 뜨는데 영상 자체가 컨테이너 안에서 잘리거나 레터박스 상태로 보인다.

## 참고 — rescene-room 레포
사용자가 workspace-easyware GitHub 레포 중 `rescene-room`에 유튜브 영상을 그냥 틀어주는 구현이 있다고 했다. 참조할 부분이 있으면 참조한다.
- 레포: `workspace-easyware/rescene-room` ("RE:SCENE ROOM — 리마인의 장면 보관함 소스 코드 백업", private, JavaScript, 2026-11-17 생성).
- 주의: 이 레포는 ChatGPT Sites 백업 성격이라 루트에 `.sites-*.tar.gz` 파일들과 `.openai/`·`worker/` 디렉터리가 있다. GitHub 코드 검색(youtube/iframe/embed)으로는 결과가 안 나왔다. `get_file_contents`로 직접 파일을 뒤져보고, 유튜브 플레이어 패턴(iframe 속성·CSS aspect-ratio·컨테이너)이 있으면 People OS 방식과 비교한다. **닿지 않거나 패턴이 없으면 억지로 찾지 말고, 유튜브 임베드 표준 방식(16:9 aspect-ratio 컨테이너 + 반응형 iframe)으로 고친다.**

## 고칠 것
1. **원인 찾기**: LMS 강의실 유튜브 임베드 코드(`public/` 강의실 화면, `src/lms/` 관련)를 읽어 잘림 원인을 찾는다. 후보: iframe 고정 width/height와 컨테이너 크기 불일치, aspect-ratio CSS 누락·잘못됨, 컨테이너 padding·overflow로 클리핑, 임베드 URL 파라미터 문제, 챕터 목록 레이아웃이 플레이어를 미는 문제.
2. **수정**: 영상이 16:9로 온전히 보이게 고친다. 반응형(화면 너비에 맞게) + 잘림 없음이 기준이다. 모바일(좁은 화면)에서도 확인한다.
3. **점검**: "이 정도 기능은 오류 없이 나와야 한다"는 사용자 지적에 맞게, 강의실 유튜브 재생 경로를 전반적으로 점검한다. 다른 유튜브 강의(해피AI 과정의 다른 챕터)도 같은 임베드 방식을 쓰는지, R2 영상(`lms/sample.mp4`) 플레이어와는 별개인지 확인한다. 찾은 다른 문제(있으면)도 같이 고친다.

## 주의
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로.
- **마이그레이션 파일은 수정하지 않는다** (0001~0032 이미 적용됨). 스키마 변경이 필요하면 새 마이그레이션(0033~)을 만든다.
- **기존 API·동작을 바꾸지 않는다.** 강의실 외 화면에 영향이 가지 않게 한다.
- **wrangler.toml의 routes 항목은 제거 상태 유지.**

## 검증
- `npx tsc --noEmit` 통과. 프런트 JS는 `node --check` 통과.
- 로컬(`wrangler dev --local`)에서 강의실 화면을 열어 유튜브 임베드가 16:9로 온전히 보이는지 확인한다 (로컬에서는 YouTube iframe이 실제로 뜨는지까지는 확인이 어려울 수 있다 — 그 경우 iframe의 width/height·CSS 계산값과 컨테이너 크기를 확인한다).
- **배포는 직렬로 한 번만.** `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록한다.
- 배포 후 라이브에서 강의실 화면의 임베드 HTML·CSS가 수정본인지 확인한다. **브라우저 실제 화면 확인은 사용자가 한다.**
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 산출물
- 검증 산출물을 `files/workflow-verify/lms-youtube/RESULT.md`에 작성할 것 (원인·고친 내용·검증 결과 + rescene-room 참조 여부 + 되돌리는 방법).
- `files/people-os/workflow-agent-builder-PROGRESS.md`에 "LMS 유튜브 임베드 잘림 수정" 항목을 추가할 것.

## 보고 형식 (최종 응답)
- 잘림 원인 한 줄.
- 고친 내용 (파일·방법).
- rescene-room 참조 여부 (참조했으면 어디를, 못 했으면 이유).
- 배포 버전 ID + 라이브 확인 결과.
- 사용자가 브라우저에서 다시 확인할 것.
- RESULT.md 경로.
