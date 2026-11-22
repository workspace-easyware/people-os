# Think 전면 도입 T0 관문 (11-20)

사용자가 Think 전면 도입 계획(`think-cloudflare-os-full-adoption-plan.md`)대로 진행하기로 결정했다. 지금은 **T0 관문** 단계다. 계획 문서 4장의 T0(11-20)만 수행한다. T1 이후는 하지 않는다.

## 배경 (계획 문서 요약)

- 전면 도입의 범위: **"운영의 에이전트 자리 전부를 Think로, DAG 엔진은 큐 유지"**. 큐 엔진까지 갈아엎지 않는다.
- Think: `@cloudflare/think` 0.23.0 (Experimental). 파이버 내구성 실행, 하위 에이전트 Facets, 영구 세션 API, `Think` 기본 클래스.
- Cloudflare OS는 설치·포크하지 않는다. 화면 구성과 승인 개념만 참고한다.
- 현재 라이브: 배포 `d48c8b4e`, GitHub head `96fa4c82`. wrangler 3.114.17, `compatibility_date = "2025-07-18"`.

## 2026-11-19 밤에 바뀐 사실 (계획 문서 작성 이후)

- **Workers Paid 업그레이드 완료**: 사용자가 대시보드에서 직접 확인. $5/월, 카드 끝자리 6038, 구독 탭 "Workers Paid — Dec 16, 2026에 갱신". 따라서:
  - 계획 8장의 결정 3번(CPU 한도 실패 시 Paid 전환)은 이미 해결됨. Paid 전환을 전제로 진행한다.
  - CPU 한도는 이제 요청당 30초 (Free 10ms 아님). 관문 5번(10스텝 턴 CPU 한도)은 Paid 기준으로 판정한다.
  - Dynamic Workers 사용 가능해졌으나, **동결 범위에는 넣지 않는다** (계획 2.2 유지).
- **Workers AI 뉴런**: 업그레이드 직후(21:23)에도 전사 색인 재시도가 4006 무료 한도 오류로 실패. Workers AI 쪽 전파 지연으로 보임. T0에서 Workers AI를 쓸 때 같은 오류가 나오면 전파 지연을 먼저 의심하고, 몇 분 뒤 재시도한다.
- **오픈소스 문서 라이브러리 조사 완료**: `~/workspace/research_notes/opensource-document-libraries-workers-20261119-1214/report.md`. 결론: 슬라이드 생성 PptxGenJS 유지, 슬라이드 편집 ooxml-core 파일럿, 엑셀 xlvane, 워드 생성 docx. **T0에서는 문서 도구를 구현하지 않는다.** 참고만 한다. (문서 도구는 T1 이후 agent 도구로 붙일 때 검토.)

## T0에서 할 일 (계획 4장)

1. **기준점 커밋·태그**: 현재 로컬 상태를 커밋하고 태그 `pre-think`를 단다. `git add`가 세션에서 승인 대기로 막히면, 커밋은 Merlin이 직접 한다고 보고하고 파일 작업만 마친다. 태그도 마찬가지다.
2. **wrangler 4 + 의존성 설치**: wrangler 4로 올린 뒤 **기존 People OS가 그대로 빌드·배포 가능**한지 단독 검증한다 (`cf-wrangler.py deploy --dry-run`, `npx tsc --noEmit`). `compatibility_date`를 올려야 하면 그 영향을 여기서 본다. Think를 넣기 전에 도구만 올려 검증하는 것이 핵심이다 (위험 R1).
3. **별도 Worker `people-os-think-gate`에 `ThinkAgent` 배포**: 운영 Worker(`people-os`)는 건드리지 않는다. 별도 Worker에 Think 0.23.0(정확히 고정)을 넣고 한 턴이 끝나는지 확인한다.
4. **계획 1장 "확인하지 못한 것" 중 뒤 다섯 개를 여기서 확인한다**: wrangler 4 빌드 여부, Qwen 도구 호출 안정성, Think 턴 종료 방법, 승인 API 세부, CPU 한도, DO 마이그레이션 롤백 가능 여부.

## T0 관문 6항목 (계획 4장, 판정 기준)

1. wrangler 4로 올린 뒤 기존 People OS가 그대로 빌드·배포 가능하다 (`cf-wrangler.py deploy --dry-run`, `tsc`).
2. Think 0.23.0(정확히 고정)이 Worker에 배포되고 한 턴이 끝난다.
3. `qwen3.8-27b`가 도구 3개(`ask_rag`·`create_task`·`email_draft` 흉내)를 10회 중 8회 이상 올바로 고른다. 안 되면 `@cf/moonshotai/kimi-k2.6`으로 같은 시험을 한다. **agent 경로만 모델을 바꿀 수 있다** (사용자 승인됨). 질문 경로 모델은 그대로 둔다.
4. 스텝 상한·시간 상한이 훅으로 걸리고, `beforeToolCall`에서 부작용 도구를 막은 뒤 턴이 정상 종료된다.
5. 10스텝짜리 턴이 CPU 한도 오류 없이 끝난다 (3회 반복). Paid 기준(30초)으로 판정한다.
6. 실행 중 DO를 죽여도(재배포) 턴이 복구되거나, 최소한 "중단됨"으로 정리돼 엔진에 실패가 전달된다.

**판정**: 1~5 통과면 T1로 간다. 6만 실패하면 진행하되 복구는 "실패로 정리"까지만 약속한다. **1이 실패하면 그날로 중단하고 계획 6장 대안으로 간다.** 3이 두 모델 모두 실패하거나 5가 실패하면 역시 대안으로 간다.

## 제약

- **운영 Worker(`people-os`)에는 배포하지 않는다.** T0의 배포 대상은 별도 Worker `people-os-think-gate`뿐이다.
- **배포는 직렬로.** 다른 세션과 동시 배포 금지.
- 검증 결과는 `files/workflow-verify/think-full/` 아래에 `T0-RESULT.md`로 쓴다 (`/tmp` 금지).
- `files/people-os/files/workflow-verify/video-conference-v0/RESULT.md` 9절(V1+V2)을 읽고, T1에 넘길 겹침 사항을 T0 결과에 적어 둔다. (계획 세션이 못 읽었음. T1 세션에 읽기 권한을 주거나 요점을 전달해야 한다.)
- 비밀번호·토큰·시크릿은 채팅·파일에 적지 않는다. `cf-wrangler.py`는 직접 실행한다 (`python3` 경유 금지).
- `curl *peopleos.site*`는 허용 규칙에 없어 승인 카드가 뜬다. 라이브 확인은 workers.dev 경유로 한다.

## 보고

마지막에 보고할 것: 관문 6항목 각각의 통과/실패와 증거(배포 버전 ID, 명령 결과), wrangler 4·compatibility_date 변경 내용, Think 버전 고정 방법, T1으로 가는지 대안으로 가는지 판정, T1에 넘길 주의사항.
