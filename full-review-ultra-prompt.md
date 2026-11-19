# 전체 코드 점검·수정 + 도움되는 Cloudflare 기능 구현 (Fable 5.2, 종합)

## 배경
공모전 제출(11-27) 전 마지막 종합 점검이다. 사용자가 "클로드 토큰이 너무 많아서" 한 번의 큰 Fable 5.2 세션으로 전체를 점검·수정하고, 도움되는 Cloudflare 기능을 바로 구현하라고 지시했다. 기능 동결은 11-25(수), 제출은 11-27(금)이다. **깨뜨리지 않는 것이 최우선이다.** 새 기능보다 기존 동작을 지키는 게 중요하다.

## 작업 범위
프로젝트 루트: `files/people-os/` (Worker + 프런트 + 마이그레이션 + 문서).
현재 라이브: Worker `5a7a6aae` (채팅 presence·읽음·반응 포함, reasoning medium 추정), 정적 에셋 `38cbdd4b` (pitch·소개 탭 반영). GitHub head `5ddf3837`.

## 1단계 — 전체 코드 점검 (감사)
아래 관점으로 전체 코드를 훑고 문제 목록을 만든다. 고치기 전에 목록을 먼저 정리한다.

- **정확성**: 잘못된 로직, 엣지 케이스 누락, 오프바이원, null/undefined 처리 누락, 타입 불일치.
- **보안**: 인증·인가 우회 (특히 PATCH/DELETE 소유자 검사 누락이 알려진 gap — `PATCH/DELETE /api/tasks/:id` 소유자 검사 없음), SQL 인젝션·XSS, 시크릿 노출, rate limit 우회, SSRF.
- **일관성**: 같은 기능이 두 곳에서 다르게 동작하는 경우, 메뉴·용어·에러 문구 불일치, 한국어/영어 혼용.
- **죽은 코드·부채**: 안 쓰는 함수·라우트·마이그레이션, WF-2 복제 부채 (`summarizeDocument`·`buildDeck`·리플렉션 로직이 `src/workflow/nodes.ts`에 복제됨 — 공용 모듈 추출이 계획돼 있음), TODO·FIXME.
- **성능·비용**: 불필요한 D1·Vectorize·Workers AI 호출, N+1, 캐시 누락, 큐·DO 과다 호출 (방 목록 API가 DM 방마다 DO 호출 — 최대 200방).
- **문서·코드 어긋남**: pitch·README·DEMO-SCRIPT에 적힌 것과 코드가 다른 부분 (예: 노드 15종, DO 5개, 마이그레이션 0031 — 방금 반영했으니 재확인).

점검 결과는 `files/workflow-verify/full-review/RESULT.md`에 "문제 목록"으로 먼저 기록한다 (심각도 P0~P3, 파일·행 번호 포함).

## 2단계 — 수정
문제 목록을 P0(보안·동작 깨짐) → P1(정확성·일관성) → P2(성능·부채) 순서로 고친다. **단, 다음은 건드리지 않는다.**
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"`인 상태 그대로 둔다 (low/medium 결정은 사용자가 한다).
- **마이그레이션 파일은 수정하지 않는다** (이미 적용된 0001~0031). 스키마 변경이 필요하면 새 마이그레이션(0032~)을 만든다.
- **기존 API·동작을 바꾸지 않는다** (프런트와 문서가 의존한다). 동작을 바꿔야 하면 먼저 RESULT.md에 적고, 되돌릴 수 있게 한다.
- **wrangler.toml의 routes 항목은 제거 상태 유지** (API 토큰 권한 부족으로 배포 실패를 일으킴).

수정할 때마다 `npx tsc --noEmit`을 통과시킨다. 프런트 JS는 `node --check`를 한다.

## 3단계 — 도움되는 Cloudflare 기능 구현
아래를 평가하고, **진짜 도움되고 안전하게 넣을 수 있는 것만** 구현한다. 억지로 넣지 않는다. Workers-only 방향을 유지한다.

현재 사용 중: Workers, D1, R2, KV, Durable Objects, Workers AI, Vectorize, Queues, AI Gateway, Cron. (Turnstile은 선택·fail-open으로 미설정 상태.)

**후보 (평가해서 고를 것):**
- **Turnstile**: 로그인·초기 설정·비밀번호 변경에 봇 방지. fail-open으로 (키 없으면 통과). 심사위원에게 "봇 방지"를 보여 줄 수 있다. 단, 로그인 흐름을 깨뜨리지 않게 주의.
- **Workers Logs**: S4 관측·평가의 로그를 Workers Logs로도 남겨 디버깅을 쉽게. 기존 D1+R2 트레이스를 대체하지 않고 보완만.
- **Analytics Engine**: 사용량·API 호출 통계를 남겨 관측 탭에서 보여 준다. (D1 카운터와 겹치면 무리하지 않는다.)
- **Cloudflare Workflows 제품**: **쓰지 않는다.** pitch에 "Cloudflare Workflows가 아니라 Queues + DO로 직접 만들었다"고 적혀 있다. 이름이 겹쳐 오해한다.
- **Hyperdrive**: D1을 쓰므로 해당 없음. 쓰지 않는다.
- **Access**: 자체 로그인이 있으므로 중복이다. 쓰지 않는다.
- **기타**: R2 presigned URL, Vectorize 메타데이터 필터, D1 배치, Cache API 등 코드에서 아쉬운 부분이 있으면 제안하고, 안전한 것만 구현한다.

**판단 기준**: ① 심사위원에게 보여 줄 가치가 있는가 (Cloudflare 제품 활용), ② 11-25 동결 전에 안전하게 넣을 수 있는가, ③ 기존 동작을 깨뜨리지 않는가. 셋 중 하나라도 아니면 넣지 않고 RESULT.md에 "검토했지만 넣지 않음"으로 기록한다.

구현하는 기능마다: 마이그레이션(필요 시 0032~), 코드, 프런트(필요 시), 로컬 검증, 라이브 검증을 한다.

## 4단계 — 검증·배포
- `npx tsc --noEmit` 통과.
- 로컬 하네스로 핵심 경로를 검증한다 (전사→요약→질문→워크플로우→채팅·결재·메일). 기존 하네스를 재사용한다.
- **배포는 직렬로 한 번만.** `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록한다.
- 배포 후 라이브에서 핵심 경로를 스팟 체크한다 (health, 로그인 화면, pitch 키워드, HR 질문 1건). **브라우저 화면은 직접 보지 못하므로, 화면 확인은 사용자에게 맡긴다.**
- **GitHub 푸시는 이번 세션에서 하지 않는다.** 문서·코드 변경분은 다음 스냅샷에서 푸시한다 (푸시는 사용자가 별도로 지시한다).

## 산출물
- `files/workflow-verify/full-review/RESULT.md`: 문제 목록(P0~P3) + 고친 것 + Cloudflare 기능 평가(구현한 것 / 넣지 않은 것 + 이유) + 검증 결과 + 배포 버전 ID.
- `files/people-os/workflow-agent-builder-PROGRESS.md`에 "전체 코드 점검·수정 + Cloudflare 기능" 항목을 추가한다.

## 보고 형식 (최종 응답)
- 고친 문제 수 (P0/P1/P2별).
- 구현한 Cloudflare 기능 (있으면 이름 + 어디에 + 라이브 확인 결과).
- 넣지 않기로 한 Cloudflare 기능 (있으면 이름 + 이유 한 줄).
- 배포 버전 ID + 라이브 스팟 체크 결과.
- 남은 것 (사용자가 결정할 것, 브라우저 확인 필요 등).
- RESULT.md 경로.
