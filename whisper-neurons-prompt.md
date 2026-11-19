# Whisper 뉴런 표시 — 두 가지 구현

사용자가 Whisper 전사 비용(뉴런)을 보고 싶어 한다. 두 가지를 구현한다.

## 배경 (확인된 사실)

- 전사 중인 녹음: `rec_mwn89wm4_dqgol2` (Plaud, 58분 37초, 15구간). 전사 완료, 문서 `doc_mwn8l1cb_kwf7nw` 저장됨.
- 관측·평가(src/obs/)는 Whisper를 추적하지 않는다. ask_events는 Q&A 전용.
- Whisper 호출: `env.AI.run("@cf/openai/whisper-large-v3-turbo", {audio}, aiGatewayOptions({skipCache:true, tag:"whisper"}))`. 반환값은 `{text}`뿐이라 Worker는 뉴런을 직접 알 수 없다.
- 비용 동기화 O4 (`src/obs/costs.ts`의 `syncGatewayCosts`, 엔드포인트 `POST /api/obs/costs/sync`)는 이미 구현돼 있다. AI Gateway 로그 REST를 읽어 `trace_costs`에 넣는다. 단, `AIG_LOGS_TOKEN` 시크릿이 없어서 막혀 있다. 토큰이 없으면 안내 오류만 낸다.
- 단가표 `src/obs/pricing.ts`는 토큰 기반(USD/100만 토큰)이고 Whisper가 없다. Whisper는 분당 과금이라 토큰 단가가 안 맞는다. `checked`가 null이라 기존 단가도 미검증 상태다.
- recordings 테이블에 `duration_ms` 컬럼이 없다. 청크는 `CHUNK_SECONDS=900`·`CHUNK_BYTES=1MB`로 나뉘고, 구간 수는 바이트 기준이라 길이 추산에 쓸 수 없다 (58분짜리가 15구간).
- 녹음 목록은 `public/index.html`의 `loadRecordings` + `pipelineSteps(r)`로 렌더링된다. 파이프라인 단계: 전사 → 요약 → 색인 → 완료.

## 구현 1 — 녹음 목록에 예상 뉴런 표시 (추정)

목표: 녹음 목록의 파이프라인 표시 옆에 Whisper 예상 뉴런을 보여준다. "추정"임을 명시한다.

1. D1 마이그레이션: `recordings`에 `duration_ms INTEGER` 컬럼을 추가한다. (마이그레이션 번호는 기존 최신 번호를 확인해서 다음 번호로. 적용 전 `migrations list --remote`로 확인하고, 단일 파일은 `d1 execute --remote --file`로 적용.)
2. Plaud 가져오기(전사 있는 경우 + 전사 없는 경우 Whisper 전사 둘 다)에서 Plaud가 알려주는 duration을 `recordings.duration_ms`에 저장한다. Plaud `list_files`/`get_file` 응답의 duration 필드를 확인해서 쓴다.
3. Whisper 분당 뉴런 단가를 확인한다. Cloudflare Workers AI 공식 가격 페이지(developers.cloudflare.com/workers-ai/platform/pricing/)를 직접 열어 Whisper(whisper-large-v3-turbo)의 단위를 확인한다. 분당 뉴런 수 또는 분당 USD를 찾아낸다. 가격 페이지에 접근이 안 되면 AI Gateway 로그의 실제 cost를 참고하되, 단가가 불확실하면 추정치를 만들지 말고 그 사실을 결과에 적는다.
4. `public/index.html`의 녹음 목록 행(`loadRecordings` → 각 행 + `pipelineSteps`)에 예상 뉴런을 표시한다. 규칙:
   - `duration_ms`가 있고 단가가 확인됐을 때만 표시한다. 둘 중 하나라도 없으면 표시하지 않는다 (0으로 채우지 않는다).
   - 표시 형식: `Whisper 약 N 뉴런 (추정)` — "추정" 표기를 반드시 넣는다.
   - 전사 완료 전(진행 중)에도 길이를 알면 추정치를 보여줘도 된다.
   - 기존 파이프라인 표시(전사 → 요약 → 색인 → 완료)는 건드리지 않는다.
5. 로컬 검증: `npx tsc --noEmit` 통과 + wrangler dev 로컬에서 녹음 목록이 깨지지 않고 예상 뉴런이 표시되는지 확인 (duration이 있는 행과 없는 행 둘 다).

## 구현 2 — O4 비용 동기화(AIG_LOGS_TOKEN) 연결 준비

목표: 실제 청구 뉴런이 관측·평가에 들어오게 한다. 토큰 자체는 이 세션이 만들 수 없으므로(대시보드 권한 필요) 연결 준비와 검증을 한다.

1. `src/obs/costs.ts`의 `syncGatewayCosts`와 `POST /api/obs/costs/sync` 엔드포인트를 읽고, Whisper(tag="whisper") 요청이 AI Gateway 로그에서 어떻게 들어오는지 확인한다. 로그의 model/tag/cost 필드가 `trace_costs`에 제대로 매핑되는지 본다. 매핑이 안 되는 부분이 있으면 수정한다.
2. 토큰 없이 호출했을 때의 안내 오류가 정확한지 확인한다. (현재 hint 문구가 토큰 만드는 방법과 권한을 정확히 안내하는지.)
3. AIG_LOGS_TOKEN에 필요한 정확한 권한을 문서로 정리한다. Cloudflare API 토큰에 필요한 권한(템플릿 이름이 있으면 그것도)과, 토큰을 만든 뒤 Worker에 넣는 명령(`wrangler secret put AIG_LOGS_TOKEN`)을 RESULT.md에 적는다. 이 세션은 토큰을 만들거나 시크릿을 넣지 않는다. 토큰 값은 어디에도 기록하지 않는다.
4. 관측·평가 트레이스 상세 화면(`src/obs/routes-traces.ts`의 cost 표시)이 Whisper 비용 행을 이미 보여줄 수 있는지 확인한다. 안 되면 최소한의 수정으로 보여주게 한다. (단, 실제 데이터는 토큰이 들어온 뒤에야 생긴다.)

## 검증

- `npx tsc --noEmit` 통과.
- 로컬 wrangler dev로 녹음 목록 확인.
- 배포는 하지 않는다. (배포는 별도 단계에서 Merlin이 직렬로 한다.)
- 결과 파일: `files/workflow-verify/whisper-neurons/RESULT.md`에 작성한다. 내용: 무엇을 바꿨는지(파일·마이그레이션 번호), Whisper 단가(출처 URL + 확인 날짜), 예상 뉴런 표시 규칙, O4 연결 준비 상태 + 토큰에 필요한 권한, 로컬 검증 결과, 배포 전 남은 것(토큰 설정).

## 주의

- 배포는 하지 않는다. GitHub 푸시도 하지 않는다.
- 비밀번호·토큰·시크릿 값은 절대 파일이나 결과에 적지 않는다.
- 기존 파이프라인 단계 전사 → 요약 → 색인 → 완료의 동작을 바꾸지 않는다.
- `wrangler.toml`의 routes 항목은 건드리지 않는다.
- 프록시 환경변수 때문에 localhost curl이 안 되면 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY`로 해제하고 curl한다.
