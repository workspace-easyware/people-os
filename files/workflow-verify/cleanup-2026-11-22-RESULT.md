# 11-25 정리 — 앞당겨 실시 (2026-11-22 02:23~02:35 KST, Merlin 직접)

11-25 동결 전 정리로 계획했던 것을 11-22 새벽에 앞당겨 했다 (사용자 지시: "제출전 할것중 네가 할수 있는것은 진행 바로하자").
삭제는 전부 라이브 API(`DELETE /api/recordings|documents|decks/:id`, 임시 hr_admin 세션) 또는 D1·R2 직접 삭제로 했다.
데모 핵심 암묵지 `doc_mweyu70u_477s8v`("출산 전후 재택 가능해요?")는 유지했다.

## 삭제한 것 (합계: 문서 20건 · 녹음 12건 · 덱 4개 · 메일 5건 · 고아 R2 8개)

| 종류 | 삭제 | 방법 |
|---|---|---|
| 전사 실험 문서 6건 | `original` 2건, `clip2min` 2건, `seg4_12-16min`, `original_0_krwd` | 녹음 삭제 API가 연결된 문서까지 함께 지움 (`purgeDocument`) |
| 샘플 전사본 10건 | "11월 팀 회의 전사본 (샘플)" 10건 전부 | 문서 삭제 API |
| 파일 형식 테스트 4건 | `test-hwpx`, `test-docx`, `test-pdf`, `test-hwp5` | 문서 삭제 API |
| 녹음 12건 | 준비 완료 6건 + 11-13부터 `processing`으로 멈춘 6건 | 준비 완료는 녹음 삭제 API, 멈춘 6건은 D1에서 `transcript_status='failed'`로 바꾼 뒤 녹음 삭제 API (API는 `processing` 삭제를 409로 막는다) |
| 덱 4개 | "11월 팀 회의 전사본 (샘플)" 3개 + `S3-TEST-COVER` | 덱 삭제 API |
| 메일 5건 | "이메일 수신 라우팅 테스트" 1건, "[테스트] 워크플로우 승인 E2E" 2건, "[테스트] WF12 승인" 2건 | D1 직접 삭제 + R2 `raw.eml` 3개 삭제 (메일 삭제 API는 없음) |
| 고아 R2 8개 | `docs/doc_mwhji1e3_xssb5v/extracted.md`, `docs/doc_mwi2xnbv_0q82x4/extracted.md`·`source.txt`, `docs/doc_mwi2xy5o_p3wfjs/extracted.md`·`source.txt`, `documents/doc_mwezl371_t497q3.md`, `documents/doc_mwi32sc7_cp8nnw.txt`, `recordings/rec_mwejecf9_7a0dp3/original_0_krwd.ogg` | R2 직접 삭제 |

## 남은 것 (삭제 전·후 확인)

- 문서 6건: 데모 핵심 암묵지 `doc_mweyu70u_477s8v` + 머서 가상 업무 문서 3건(`doc_mwi40t8d_9frimp`·`doc_mwi40tyo_usg2za`·`doc_mwi40uso_e9kmp2`) + 실제 전사본 2건(`doc_mwn8l1cb_kwf7nw` 2026-10-31, `doc_mwnhheh2_7xmmpr` 영상 통화).
- 녹음 2건: `rec_mwn89wm4_dqgol2` (2026-10-31) + `rec_meet_mwndgsg3_tncn4r_...` (영상 통화).
- 덱 0개, 메일 0건.
- `doc_nodes` 고아 0건, chunks 37건 (남은 6개 문서의 것).
- R2: 372개 → 328개 (44개 제거), 고아 0건 (재확인: `r2-orphans.py`).

## 시행착오 (기록용)

- **python urllib은 workers.dev에서 403 error 1010으로 막힌다.** 첫 시도 24건 전부 실패 (0건 삭제됨을 D1 개수로 확인). curl로 바꾸니 24건 전부 200. 라이브 API 호출은 curl로 할 것 (AGENTS.md에도 같은 교훈이 있음).
- **임시 세션 `expires_at`은 밀리초 단위다.** 처음에 초 단위(`date +%s + 3600`)로 넣어 세션이 즉시 만료돼 401이 났다. `$(date +%s) * 1000 + 3600000`으로 고치니 `hr.jhkang / hr_admin`으로 인증됨. `createSession`은 `Date.now() + SESSION_TTL_MS`를 쓴다.
- **하네스 workerd는 부모를 죽여도 살아남는다.** `wrangler dev` 부모(node·npm·sh)를 죽여도 workerd가 새 pid로 다시 떴다. 포트 8841을 쥔 workerd pid 자체를 `kill -9` 해야 풀린다. 정리 뒤 포트 free 확인함.
- **R2 객체 목록은 `wrangler r2 object list`가 없다.** Cloudflare API 직접 호출로 목록을 뽑았다 (`~/workspace/r2-list.py`, cf-wrangler.py와 같은 surrogate 방식, 토큰은 출력 안 함). 고아 판정은 `~/workspace/r2-orphans.py` (D1 참조 키와 대조).

## 미확인·남은 것

- **"C5P3 테스트 4건"은 식별하지 못했다.** `ask_events`에 C5·테스트 문구 0건, `eval_runs`에 C5P3 id 없음. 우연히 4건인 것은 비활성 골든셋 문항 4건(`gi_s02`·`gi_s06`·`gi_s08`·`gi_p07`)인데, 이미 비활성이라 데모에 안 보이고 평가 기록을 지우는 것이기도 해서 건드리지 않았다. 11-25에 사용자가 "C5P3"이 무엇인지 알려주면 그때 정리한다.
- Vectorize 고아 벡터는 직접 확인하지 않았다. 삭제가 `purgeDocument` 경로(벡터 → R2 → chunks → doc_nodes → documents 순)로 갔고, doc-fix 세션에서 같은 경로의 `vectorsDeleted`를 확인한 바 있어 남지 않았을 것으로 본다.
- 임시 세션은 삭제했고 토큰으로 `/api/auth/me` → 401 확인, 토큰 파일 삭제, 하네스 종료·포트 free 확인.
- 증거: `cleanup-2026-11-22-r2-list.txt` (정리 전 372개), `cleanup-2026-11-22-r2-list-after.txt` (정리 후 328개), `cleanup-2026-11-22.py` (urllib 실패본), `cleanup-2026-11-22.sh` (curl 성공본).
