# Whisper 뉴런 표시 — RESULT (2026-11-19)

상태: 코드 구현 완료, `npx tsc --noEmit` 통과. **로컬 화면 확인과 원격 마이그레이션 조회는 못 했습니다** (아래 "검증" 참조). 배포·푸시 안 함.

## 바뀐 것
| 파일 | 내용 |
|---|---|
| `migrations/0036_recording_duration.sql` (신규) | `recordings.duration_ms INTEGER` 추가. NULL = 길이 모름. **원격 미적용** |
| `src/obs/pricing.ts` | `WHISPER_PRICE`(분당 뉴런·USD·확인일), `estimateWhisperNeurons(ms)` 추가. 길이를 모르면 null |
| `src/plaud/routes.ts` | Whisper로 가는 경로(Plaud 전사 없음)에서 `get_file`의 `duration`(ms)을 `startTranscription`에 넘김 |
| `src/index.ts` | `startPlaudTranscription`이 `duration_ms`를 저장(실패해도 전사는 진행). `GET /api/recordings`가 `duration_ms`와 `whisper:{neuronsPerMin,checked}`를 반환. 0036 전이면 `duration_ms` 없이 목록 반환 |
| `public/index.html` | `loadRecordings`에서 행 아래 `Whisper 약 N 뉴런 (추정)` 표시. `pipelineSteps`는 그대로 |
| `src/obs/costs.ts` | (a) 로그에 태그가 없고 model에 `whisper`가 있으면 tag=`whisper`로 저장 (b) 토큰 없을 때 안내 문구를 정확한 권한으로 교체 |

Plaud에 전사가 **있는** 가져오기는 Whisper를 쓰지 않으므로 duration을 저장하지 않습니다(뉴런 0이 아니라 표시 없음). 직접 업로드 녹음도 길이를 모르므로 표시 없음.

## Whisper 단가
- 출처: https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-11-19 직접 확인)
- `@cf/openai/whisper-large-v3-turbo`: **$0.0005 / 오디오 분, 46.63 뉴런 / 오디오 분**. 뉴런은 $0.011 / 1,000, Workers Paid는 하루 10,000 뉴런 무료.
- 예: 58분 37초 ≈ 58.6분 × 46.63 ≈ **약 2,733 뉴런** (손계산, 실행 검증 아님).
- Plaud `duration` 단위는 ms로 가정 (기존 `fmtClock(f.duration)`·`normalizeFiles.duration_ms`가 ms로 다룸). 실제 Plaud 응답으로는 미확인.

## 표시 규칙
`duration_ms > 0` 이고 서버가 단가를 보냈을 때만 `Whisper 약 N 뉴런 (추정)` 표시. 하나라도 없으면 아무것도 그리지 않음. 진행 중에도 길이를 알면 표시.
**기존 녹음 `rec_mwn89wm4_dqgol2`는 `duration_ms`가 NULL이라 표시되지 않습니다.** 필요하면 Plaud 길이(약 3,517,000ms)로 한 번 `UPDATE`해야 합니다 (이 세션은 하지 않음).

## O4 연결 준비 상태
- 매핑: 게이트웨이 로그 → `trace_costs`. Whisper 호출은 ask 이벤트가 없어 `event_id` NULL로 저장됨(합계에는 포함). **트레이스 상세 화면(`routes-traces.ts`)은 `event_id`로 조회하므로 Whisper 행은 거기 나오지 않습니다.** 화면 노출은 별도 작업(예: 녹음별 매핑)이 필요해 이번엔 수정하지 않았습니다.
- 토큰이 없으면 `POST /api/obs/costs/sync`가 400 + 안내문을 반환 (문구 수정함).
- Whisper 로그의 `cost` 필드가 실제로 채워지는지는 토큰이 들어온 뒤에야 확인 가능. 비어 있으면 `cost_usd`는 NULL(추정 아님·0 아님)로 남습니다.
- **필요한 토큰 권한**: Cloudflare 대시보드 → My Profile → API Tokens → Create Token → Custom token, 권한 `Account › AI Gateway › Read` (이 계정 한정). 게이트웨이 로그 조회 엔드포인트 기준이며 전용 템플릿 이름은 확인하지 못했습니다. 이 권한명은 문서에서 재확인하지 못한 추정이므로 토큰 생성 시 대시보드의 실제 권한 목록과 대조하세요.
- 토큰 생성 후: `wrangler secret put AIG_LOGS_TOKEN` (값은 프롬프트에 입력, 어디에도 기록하지 말 것). `CF_ACCOUNT_ID`는 `wrangler.toml`에 이미 있음.

## 검증
- `npx tsc --noEmit`: 통과.
- **wrangler dev 화면 확인: 못 했음.** 로컬 DB(`files/workflow-verify/whisper-neurons/state`)가 `ensureSchema`로 먼저 만들어져 `owner_id` 컬럼이 없어 `GET /api/recordings`가 500, `migrations apply --local`은 알려진 0004 중복 컬럼 오류로 실패. 이 세션은 dev 서버(포트 8799, workerd pid 9477) 종료와 DB 초기화 권한이 없어 재시도 못 함. 정리: 해당 workerd를 `kill -9` 하고 `files/workflow-verify/whisper-neurons/state`를 지운 뒤, **먼저** `migrations apply --local`로 DB를 만들고 dev를 띄워 확인하세요.
- 원격 `migrations list --remote`: 승인 필요로 실행하지 못함. 로컬 파일 기준 최신은 0035이고 0036을 추가했으나, 원격에 0036 번호가 비어 있는지는 미확인.

## 배포 전 남은 것
1. 원격 `migrations list` 확인 후 0036 적용(`d1 execute --remote --file migrations/0036_recording_duration.sql -y` + `d1_migrations` 기록).
2. 로컬 화면 확인(위 정리 후), duration 있는 행/없는 행 둘 다.
3. 기존 녹음 길이 보정 여부 결정.
4. `AIG_LOGS_TOKEN` 생성·설정(대시보드 권한 필요) → `POST /api/obs/costs/sync`로 Whisper 로그 매핑 확인.
5. Plaud `duration` 단위(ms) 실데이터 확인.
