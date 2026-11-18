# DO-3 — DO 정밀 레이트 리미터 (token bucket + Alarms)

## 목표
질문 레이트 리밋(분당 20회)을 KV에서 Durable Object로 옮긴다. 현재 구현 `src/index.ts`의 `checkAskRateLimit()`(약 186행)은 KV get+put 슬라이딩 윈도우라 동시 호출에 레이스가 있다(코드 주석에도 "KV get+put이라 동시 호출에 완벽하지 않다"고 적혀 있다). DO는 단일 스레드로 요청을 순차 처리하므로 동시 버스트를 정확히 셀 수 있다.

## 범위 (이것만 한다)
1. `src/ratelimit/limiter.ts` — `RateLimiter` DO 클래스. 설계 원본은 Cloudflare 공식 예시 `durable-objects/examples/build-a-rate-limiter.mdx`(토큰 버킷 + Alarms API로 주기적 보충)와 `workers-chat-demo`의 IP당 RateLimiter DO 패턴이다.
   - DO 1개당 클라이언트 키 1개: `env.RATE_LIMITER.idFromName('rl:ask:' + clientKey)`로 DO를 잡는다. clientKey는 기존 `checkAskRateLimit` 호출 지점에서 쓰던 값(세션/IP 기준 키)을 그대로 쓴다.
   - 토큰 버킷: 용량 20, 보충 속도 분당 20개(3초당 1개). Alarm으로 주기 보충하되, 요청이 올 때 경과 시간만큼 토큰을 먼저 보충하는 lazy refill도 함께 둔다(알람이 늦게 울려도 제한이 느슨해지지 않게).
   - 상태는 DO storage에 저장한다(인메모리만 쓰지 않는다 — DO가 옮겨가도 버킷이 유지돼야 한다).
   - 프로토콜: `POST https://limiter/check` → `{allowed, remaining, resetInSec}`. 기존 `checkAskRateLimit`의 반환 형태와 동일하게 맞춰 호출 지점을 바꾸지 않아도 되게 한다.
2. `src/index.ts` 배선:
   - `checkAskRateLimit()`을 DO 우선으로 바꾼다: DO fetch 성공 시 그 결과를 쓰고, DO fetch가 예외를 내거나 비-2xx면 **기존 KV 구현으로 폴백**한다. 기존 KV 코드는 삭제하지 않고 폴백 경로로 유지한다. KV마저 실패하면 기존처럼 fail-open(차단하지 않음)한다.
   - 적용 대상은 기존과 동일하게 `POST /api/ask`와 `POST /api/personal/ask` 두 곳(현재 `checkAskRateLimit`이 호출되는 1001행·1054행 부근)이다. 제한 수치(분당 20회)는 바꾸지 않는다.
   - DO fetch에는 짧은 타임아웃을 둔다(예: `AbortSignal.timeout(1000)`) — 리미터가 느려져 질문 자체가 느려지면 안 된다. 타임아웃 시 KV 폴백으로 간다.
3. `wrangler.toml`에 `RATE_LIMITER` 바인딩만 추가한다. **v3 마이그레이션 태그는 추가하지 않는다**(DO-MIG에서 `[ChatRoom, NotificationHub, RateLimiter]`로 한 번에 적용한다).

## 하지 않는 것
- 로그인 레이트 리밋(D1 `login_attempts`, 15분 창 8회 실패 — `src/auth.ts`)은 건드리지 않는다. 이번 작업은 질문(`/api/ask`·`/api/personal/ask`) 제한만 바꾼다.
- Turnstile 검증은 건드리지 않는다.
- 제한 수치 변경 없음(분당 20회 유지). UI 변경 없음.
- 배포·GitHub 푸시 없음. 로컬 검증만 한다.

## 검증 (files/workflow-verify/do3/ 에 기록)
- `npx tsc --noEmit` 통과.
- 하네스(로컬 Miniflare, 실제 DO + 실제 `checkAskRateLimit` 경로). 반드시 포함할 케이스:
  1. 버스트: 같은 키로 20회 연속 허용, 21번째는 `allowed:false` + `remaining:0` + `resetInSec ≥ 1`.
  2. 동시 버스트: 30개 요청을 동시에 보내면 정확히 20개만 허용되고 10개가 막힌다(KV 레이스가 있었다면 초과 허용이 나왔을 지점 — DO 정밀성의 핵심 검증이다).
  3. 보충: 토큰이 바닥난 뒤 시간이 지나면(테스트에서는 DO storage의 보충 시각을 앞당기거나 짧은 보충 간격으로) 다시 허용된다.
  4. 키 격리: 다른 키의 버스트가 내 버킷에 영향을 주지 않는다.
  5. 폴백: DO fetch가 실패하도록(바인딩 없음·강제 예외) 만들면 기존 KV 제한이 동작하고, 질문이 막히지 않는다(허용/차단 판정이 KV 기준으로 나온다).
  6. DO 재시작 후에도 버킷이 유지된다(DO storage 사용 — 하네스에서 DO 인스턴스를 재생성해 확인).
  7. 타임아웃: DO 응답이 느리면(지연 주입) 1초 안에 KV 폴백으로 넘어간다.
- 회귀: DO-1a(41/41)·DO-1b(77/77)·DO-1c(71/71)·DO-1d(64/64)·DO-2 백엔드(32/32)·DO-2 UI(46/46)를 그대로 다시 돌려 전부 통과.
- `files/workflow-verify/do3/RESULT.md`에 결과 기록(통과 수, 실패 목록, 미검증 항목 명시).

## 산출물
- `src/ratelimit/limiter.ts`, `src/index.ts`(checkAskRateLimit 배선), `wrangler.toml`(RATE_LIMITER 바인딩만), `files/workflow-verify/do3/RESULT.md` + 하네스 파일들.
- 최종 응답에 포함할 것: 구현 요약(파일 목록), 하네스 통과 수, 회귀 통과 수, 미검증 항목(실제 Cloudflare 엣지 DO 동작·원격 DO 미적용 — DO-MIG 이후 라이브 확인 필요).
