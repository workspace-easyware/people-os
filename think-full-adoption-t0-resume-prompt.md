# Think 전면 도입 T0 관문 — 재개 (런타임 재시작으로 중단됨)

T0 세션이 런타임 재시작으로 중단됐다. 처음부터 다시 하지 말고, 아래 확인된 상태에서 이어서 마무리한다.

## 확인된 상태 (2026-11-19 21:40, Merlin이 직접 확인)

- **기준점 태그 완료**: `pre-think` 태그가 HEAD(`b30b244`)에 걸려 있다. 롤백 지점 P0 확보됨. 커밋은 아직 안 함 (아래 참조).
- **wrangler 4.165.0 설치됨** (`package.json` 수정됨, `package-lock.json` 수정됨). 의존성 추가됨: `@cloudflare/think 0.23.0`, `agents 0.33.0`, `ai 7.0.177`, `zod 4.6.7`, `@cloudflare/computer 0.8.0`, `@modelcontextprotocol/client 2.4.0`.
- **게이트 Worker 배포됨**: `people-os-think-gate` (`think-gate/wrangler.toml`, `compatibility_date = "2025-07-18"`). 라이브 URL `https://people-os-think-gate.workspace-easyware.workers.dev`. 현재 배포 빌드 `BUILD = "2"`.
- **관문 통과 현황** (중단된 세션 transcript `2750a8e7-969d-4c7c-92b5-74ab9d9fcedb.jsonl` 기준):
  - 관문 2 (한 턴 완료) · 관문 3 (Qwen 도구 선택 9/10) **통과**
  - 관문 4 (스텝·시간 상한, 부작용 도구 차단) · 관문 5 (10스텝 턴 3회, CPU 오류 없음) **통과**
  - 관문 6 (킬 테스트 — 긴 턴 실행 중 재배포로 DO를 죽이고 복구 여부) **진행 중이었음**. 마지막 동작은 `GET /status?run=k1` 폴링.
  - 관문 1 (wrangler 4로 기존 People OS 빌드·배포 가능): 세션이 확인 중이었으나 완료 여부를 transcript에서 확정하지 못함. **직접 다시 확인한다** (`npx tsc --noEmit`, `cf-wrangler.py deploy --dry-run`).
- **킬 테스트 현재 상태** (Merlin이 21:40에 직접 확인): `GET /status?run=k1` 응답 — 제출 `508cef63-4bac-4a1f-b6ae-acb060c0d8fd` 상태 `running`, 스텝 0~4 완료(`count_step`, 각 12초), 스텝 5 진행 중. DO는 빌드 1에서 생성됨(`ctor build "1"`), 현재 배포 빌드는 2. 턴이 아직 끝나지 않았다.
- **결과 파일 없음**: `files/workflow-verify/think-full/` 아래에 `dryrun-gate`, `dryrun-w4`만 있고 `T0-RESULT.md`는 없다.
- **git 상태**: `M package.json`, `M package-lock.json`, 미추적 `think-gate/`, `files/workflow-verify/think-full/`, 계획·프롬프트 파일 3개. 커밋 안 됨.

## 이어서 할 일

1. **관문 1 확정**: `npx tsc --noEmit` + `cf-wrangler.py deploy --dry-run`으로 기존 People OS가 wrangler 4에서 그대로 빌드·배포 가능한지 확인한다. `compatibility_date`를 올렸으면 그 내용도 기록한다.
2. **관문 6 마무리**: 킬 테스트(`run=k1`)를 폴링해서 결론을 낸다. 턴이 복구돼 끝나는지, "중단됨"으로 정리돼 엔진에 실패가 전달되는지, 아니면 그대로 멈춰 있는지 확인한다. 필요하면 상태를 다시 조회하고, 턴이 너무 오래 끝나지 않으면 그 자체를 결과로 기록한다.
3. **결과 파일 작성**: `files/workflow-verify/think-full/T0-RESULT.md`에 관문 6항목 각각의 통과/실패와 증거(배포 버전 ID, 명령 결과, 라이브 URL, 응답)를 적는다. 계획 4장의 판정 기준대로 **T1로 가는지 6장 대안으로 가는지 판정**한다. 6번만 실패하면 "진행하되 복구는 실패로 정리까지만 약속"으로 적는다.
4. **T1에 넘길 사항**: `files/workflow-verify/video-conference-v0/RESULT.md` 9절(V1+V2)을 읽고 겹침 사항을 결과 파일에 적는다 (원래 T0 프롬프트의 요구사항).
5. **커밋은 하지 않는다**: `git add`가 이 세션에서 승인 대기로 막힐 수 있다. 커밋·태그는 Merlin이 직접 한다. 파일 작업만 마치고 보고한다.

## 제약 (원래 T0 프롬프트와 동일)

- **운영 Worker(`people-os`)에는 배포하지 않는다.** 배포 대상은 `people-os-think-gate`뿐이다.
- **배포는 직렬로.** 다른 세션과 동시 배포 금지.
- 비밀번호·토큰·시크릿은 채팅·파일에 적지 않는다. `cf-wrangler.py`는 직접 실행한다 (`python3` 경유 금지).
- `curl *peopleos.site*`는 허용 규칙에 없어 승인 카드가 뜬다. 라이브 확인은 workers.dev 경유로 한다.

## 보고

마지막에 보고할 것: 관문 6항목 최종 판정표, T1 vs 대안 판정, wrangler 4·compatibility_date 변경 내용, T1에 넘길 주의사항.
