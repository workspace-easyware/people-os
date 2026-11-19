# Plaud 행 레이아웃 깨짐 + 오디오 fetch 실패 수정 (Sonnet)

## 문제 1 — 행 레이아웃 깨짐 (사용자가 스크린샷으로 보고함)
Plaud 카드 첫 번째 행(2026-10-31 17:03:08)의 제목이 세로로 한 글자씩 쌓여 ~400px 높이로 부풀어 있다. 다른 행은 정상이다.

**원인 (확인됨)**: `public/styles.css`의 `.taskrow`는 `display:flex`인데 `flex-wrap`이 없다. 그런데 Plaud 행의 오류 메모(`st.note`)는 `<div class="small" style="flex-basis:100%">`로 들어가 있다. wrap이 없으니 flex-basis:100%짜리 메모가 다른 항목을 다 밀어내고, `.t-title{flex:1;min-width:0;overflow-wrap:break-word}`인 제목이 폭 ~0으로 쪼그라들어 공백이 없는 "2026-10-31 17:03:08"이 한 글자씩 개행된다.

**수정**: `public/styles.css`의 `.taskrow`에 `flex-wrap:wrap`을 추가한다. (메모가 자기 줄로 내려가고 첫 줄은 제목·배지·날짜·버튼이 온전한 폭을 쓴다.) `.taskrow`는 다른 탭(할 일·문서·메일 등)에서도 쓰이므로, 한 줄에 들어가는 행은 그대로 한 줄이 유지되는지 확인한다. `.t-title` 자체는 건드리지 않는다.

## 문제 2 — 오디오 fetch 실패 (AUDIO_FETCH_FAILED)
"가져와서 전사하기"를 누르면 "전사 중…"이 됐다가 ~42초 뒤 "Plaud 오디오를 받지 못했습니다. 잠시 후 다시 시도하세요."로 돌아온다. 재시도도 같은 오류다.

**확인된 사실**:
- 오디오는 정상이다. VM에서 같은 presigned_url을 직접 받으면 200, 15,010,304바이트(약 15MB, 40MB 상한 아래), 7.3초, 리디렉션 없음. `get_file`의 `presigned_url`은 최상위 필드에 있다.
- 서버가 돌려준 메시지는 `fetchAudio`의 catch 분기("Plaud 오디오를 받지 못했습니다. 잠시 후 다시 시도하세요.")다. 즉 `fetch(url)` 자체가 던졌다는 뜻이다. 타임아웃은 100초라 42초 시점의 실패는 타임아웃이 아니다.
- 유력한 원인: `fetchAudio`가 `redirect:"error"`로 fetch한다. S3 accelerate URL이 Worker의 요청에는 리디렉션을 돌려줄 수 있고, 그러면 fetch가 던진다. (VM의 curl에는 리디렉션이 없었지만 Worker의 요청은 다를 수 있다.)

**수정**:
- `src/plaud/routes.ts`의 `fetchAudio`에서 `redirect:"error"`를 `redirect:"follow"`로 바꾼다. (URL은 이미 `findPresignedUrl`에서 https + amazonaws.com/plaud.ai 호스트만 허용하도록 검증하고 있다.)
- fetch가 던졌을 때 로그에 오류의 종류/메시지만 남긴다 (URL·오디오 내용은 절대 로그에 넣지 않는다). 예: `[plaud] audio fetch failed err=<오류 이름/메시지 요약>`.
- 그 외 fetchAudio의 동작(40MB 상한, Content-Length 처리, 스트림 R2 저장)은 바꾸지 않는다.

## 주의
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로. 기존 마이그레이션(0001~0035) 수정 금지. 새 마이그레이션은 만들지 않는다. `wrangler.toml`의 routes 항목은 제거 상태 유지. Turnstile 설정은 건드리지 않는다.
- **배포는 직렬로 한 번만.** `npx tsc --noEmit` 통과 후 `cf-wrangler.py deploy` 1회. 배포 버전 ID를 기록한다.
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 검증
- `npx tsc --noEmit` 통과.
- 배포 후 라이브에서 health 200, `/plaud.js` 200, `/api/plaud/files` 로그인 없이 401을 확인한다.
- **실제 가져오기·전사는 사용자의 브라우저에서 한다.** 이 세션은 로그인 세션이 없어서 실제 가져오기를 실행할 수 없다.
- 로컬에서 `fetchAudio`의 redirect 처리와 `.taskrow` wrap이 다른 행 레이아웃을 깨지 않는지 코드로 확인한다.

## 산출물
- `files/workflow-verify/plaud-integration/RESULT.md`에 이번 수정 섹션을 추가한다 (레이아웃 원인·수정, fetch redirect 수정, 배포 버전 ID).
- `files/people-os/workflow-agent-builder-PROGRESS.md`의 "Plaud 연동" 항목에 수정 배포를 한 줄 추가한다.

## 보고 형식 (최종 응답)
- 수정 내용 2건 (CSS wrap, fetch redirect follow + 오류 로그).
- 배포 버전 ID + 라이브 확인 결과.
- 사용자가 브라우저에서 확인할 것: (1) Plaud 첫 행 제목이 한 줄로 보이는지, (2) 2026-10-31 17:03:08에서 "전사 확인" → "가져와서 전사하기"를 눌러 전사가 시작되고 "전사 중… N/M 구간"이 보이는지.
- RESULT.md 경로.
