# 녹음(전사) 삭제 — RESULT

## 바꾼 것
- `src/index.ts`
  - 문서 삭제 단계를 `purgeDocument(env, id, row, errors)` 함수로 분리 (벡터 → R2 r2_key/source_r2_key → chunks → recordings.doc_id=NULL → documents 행). `DELETE /api/documents/:id`는 이 함수를 쓰도록 바꿨고 응답 형태는 그대로.
  - 새 `DELETE /api/recordings/:id`: 404(없음) → 403(canWrite 실패: 익명·타인) → 409(`transcript_status==='processing'`) → 삭제.
- `public/index.html`: `loadRecordings` 행에 "삭제" 버튼(processing 행에는 숨김), `deleteRecording(id)`(confirm 문구 지정대로 → DELETE → 성공 시 `loadRecordings()`, 실패 시 alert; 일부 단계 오류는 alert로 알림).

## 삭제 범위 (순서)
1. doc_id가 있고 문서가 실제로 있으면 `purgeDocument` (Vectorize 벡터, R2 문서 파일, D1 chunks, documents 행). 문서가 이미 없으면(orphan) 건너뜀.
2. R2 오디오 `object_key` (비어 있으면 건너뜀)
3. `plaud_imports WHERE recording_id = :id` (다시 가져오기 가능)
4. `recordings` 행
5. trace_costs / ask_events 등 관측 데이터는 건드리지 않음.
각 단계 실패는 `errors`에 모으고 계속 진행. 응답 `{ok, id, vectorsDeleted, errors}`.

## 진행 중 삭제 차단
서버 409 + 화면에서 processing 행 버튼 숨김. 한계: 차단 기준은 지정대로 `transcript_status`만이다. 전사가 끝난 뒤 요약·색인 단계(pipeline_stage summarizing/indexing)가 도는 중에 삭제하면 큐 작업이 사라진 행을 만날 수 있다. 필요하면 pipeline_stage도 차단 조건에 넣는 것을 권한다(단, failed 정체 행은 삭제 가능해야 함).

## Plaud 카드 버튼
달지 않았다. 녹음 목록(#upload 음성 탭)에서 삭제하면 plaud_imports가 지워져 Plaud 목록에서 다시 가져올 수 있게 된다. Plaud 카드는 목록 새로고침 연동이 필요해 이번 범위에서 제외.

## 로컬 검증 (wrangler dev --local, 포트 8799, 상태는 `state/`)
- `npx tsc --noEmit`: 통과(출력 없음).
- 시드(`seed.sql`): 사용자 A·B, 녹음 recR1(ready+문서+chunk+plaud_imports), recR2(processing), recR3(orphan doc_id, object_key 빈 값), recR4(B 소유).
- 익명 DELETE recR1 → 403. B가 A의 recR1 → 403. A가 recR2(processing) → 409.
- A가 recR1 → 200. DB 확인: 녹음·문서·chunks·plaud_imports 모두 0건, recR2·recR4는 남음.
- A가 recR3(orphan) → 200, vectorsDeleted=0, errors 없음.
- 한계: 로컬에는 Vectorize 바인딩이 없어 recR1 응답 errors에 `vectors: ... deleteByIds` 오류가 담겼다(오류 수집 후 계속 진행하는 동작은 확인). 실제 벡터 삭제와 R2 객체 삭제(시드에 R2 객체 없음)는 로컬에서 검증하지 못했다. UI 클릭/confirm은 브라우저로 확인하지 않았다.

## 배포 전 남은 것
- 배포 후 실제 환경에서 벡터·R2 삭제 1건 확인 (기존 문서 삭제와 같은 호출이라 위험은 낮음).
- 사용자가 지우려는 옛 녹음은 새로 전사한 rec_mwn89wm4_dqgol2를 빼고 화면에서 하나씩 삭제.
- 배포·푸시는 하지 않았다. `wrangler.toml` routes는 건드리지 않았다.
