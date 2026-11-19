# 화상회의 V0 배포 — 마이그레이션 0038 적용 + 배포 + 프리셋 확인

V0 구현이 로컬 검증 15개 항목을 모두 통과했다 (목 RealtimeKit 서버 기준, 실제 RealtimeKit과는 아직 통신 안 함). 이제 원격에 배포하고 실제 RealtimeKit과 처음 통신한다.

## 배경

- 결과: `files/workflow-verify/video-conference-v0/RESULT.md` — 반드시 읽고 4장 "배포 전에 할 일"과 "확인 순서"를 따를 것.
- 마이그레이션: `0038_meetings.sql` (표 `meetings`). XAI 세션이 0037을 원격에 적용했는지 먼저 확인한다.
- 현재 라이브 배포: `7d0739f3` (XAI 4종). 이 배포가 다음 라이브 버전이 된다.
- RealtimeKit 앱 ID는 `wrangler.toml [vars]`에 `RTK_APP_ID`로 있음. API 토큰은 Worker 시크릿 `RTK_API_TOKEN`으로 저장됨.

## 할 일

1. **원격 D1 마이그레이션 상태 확인**: `cf-wrangler.py d1 migrations list people-os-db --remote`로 상태를 확인한다. 0037이 적용됐는지, 0038이 아직 미적용인지 확인한다. AGENTS.md의 D1 주의사항을 따른다.
2. **마이그레이션 0038 원격 적용**: `d1 execute --remote --file migrations/0038_meetings.sql -y`로 적용하고 `d1_migrations`에 기록한다.
3. **시크릿 확인**: `cf-wrangler.py secret list`로 `RTK_API_TOKEN`이 있는지 확인한다. 없으면 사용자에게 알리고 배포를 멈춘다.
4. **배포**: `cf-wrangler.py deploy`로 배포한다. 배포 버전 ID를 기록한다. `wrangler.toml`의 routes 항목은 건드리지 않는다.
5. **프리셋 확인** (API로, 로그인 없이 할 수 있는 범위에서): `GET /api/meet/presets`는 관리자 전용이라 이 세션에서는 호출이 막힐 수 있다. 호출이 되면 실제 프리셋 이름을 확인하고, 코드 기본값(`group_call_host` / `group_call_participant`)과 다르면 `wrangler.toml [vars]`에 `RTK_PRESET_HOST` / `RTK_PRESET_PARTICIPANT`를 넣고 다시 배포한다 (코드 수정 불필요).
6. **라이브 확인** (workers.dev 경유, 프록시 환경변수 해제하고 curl):
   - `GET /meet`이 200을 돌려주는지.
   - 익명으로 `POST /api/meet/rooms/<id>/start`가 401을 돌려주는지 (권한 게이트 확인).
   - 실제 RealtimeKit 통신이 되는지: 관리자 계정이 없으면 start 호출은 못 하므로, 이 항목은 브라우저 검증으로 넘긴다.
7. **결과 파일**: `files/workflow-verify/video-conference-v0/RESULT.md`에 "배포" 절을 덧붙인다. 내용: 마이그레이션 0038 적용 결과, 배포 버전 ID, 프리셋 확인 결과, 라이브 확인 결과, 브라우저 검증에 남은 것 (두 브라우저 영상 연결, 웹훅 등록).

## 주의

- 배포는 직렬로 한다. 다른 세션이 배포 중이면 기다린다.
- GitHub 푸시는 하지 않는다.
- 배포 실패 시 롤백 지점을 기록하고 사용자에게 알린다.
- 토큰 값은 어디에도 기록하지 않는다.
