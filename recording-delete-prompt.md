# 녹음(전사) 삭제 기능 구현

## 배경

사용자가 오래된 녹음·전사본을 지우고 싶어 한다. 새로 전사한 것(2026-10-31 17:03:08, rec_mwn89wm4_dqgol2) 말고 기존 ogg 파일 등은 필요 없다고 한다. 녹음 목록에서 삭제할 수 있게 해달라는 요청이다.

## 현재 상태 (확인됨)

- 문서 삭제는 이미 있다: `DELETE /api/documents/:id` (src/index.ts:1668). 소유자 검사(canWrite) 후 Vectorize 벡터(청크 id로 deleteByIds) → R2(r2_key, source_r2_key) → D1 chunks → recordings.doc_id=NULL → documents 행 삭제. 오류는 errors 배열로 모아 반환.
- 녹음 삭제는 없다. recordings 행을 지우는 API가 없다.
- recordings 테이블: id, title, object_key(R2 오디오), transcript, transcript_status, doc_id, progress, done_chunks, pipeline_stage, owner_id, created_at, duration_ms 등. 오디오는 R2 `recordings/<id>/...`에 있다.
- 전사 완료 시 파이프라인이 문서(doc_id)를 만든다 (요약 → 색인). 문서 삭제 시 recordings.doc_id가 NULL로 풀린다.
- Plaud 가져오기는 `plaud_imports`에 plaud_file_id → recording_id → doc_id를 저장한다. 가져온 녹음을 지우면 plaud_imports 행도 지워야 다시 가져올 수 있다 (중복 차단이 plaud_imports 기준).
- 녹음 목록 UI: `public/index.html`의 `loadRecordings` (행마다 불러오기/진행 확인/다시 전사 버튼). Plaud 카드: `public/plaud.js`.

## 구현

### 1. 서버: `DELETE /api/recordings/:id`

- 소유자 검사: 문서 삭제와 같은 방식(canWrite)으로 한다. 본인 것이 아니면 403.
- 전사 진행 중(`transcript_status === 'processing'`)이면 삭제하지 않고 409를 낸다. (진행 중인 파이프라인·큐 메시지가 꼬이는 것을 막는다. 화면에서는 진행 중 행의 삭제 버튼을 안 보이게 한다.)
- 삭제 순서 (하나라도 실패하면 errors에 모으고 계속 진행, 문서 삭제와 같은 패턴):
  1. `doc_id`가 있으면 문서 삭제 로직을 재사용한다 (Vectorize 벡터 → R2 문서 파일 → D1 chunks → documents 행). 문서 삭제 엔드포인트의 로직을 함수로 빼서 재사용하거나, 같은 단계를 그대로 구현한다. 중복 구현보다 재사용을 우선한다.
  2. R2 오디오 삭제: recordings.object_key를 `c.env.FILES.delete()`로 지운다.
  3. `plaud_imports`에서 `recording_id = :id`인 행을 삭제한다 (다시 가져올 수 있게).
  4. recordings 행을 삭제한다.
  5. `trace_costs`나 ask_events 같은 관측 데이터는 건드리지 않는다 (삭제해도 비용 기록은 남는다).
- 응답: `{ok:true, id, vectorsDeleted, errors}` (문서 삭제와 같은 형태). doc이 없으면 vectorsDeleted=0.

### 2. 화면: 녹음 목록에 삭제 버튼

- `public/index.html`의 `loadRecordings` 행에 삭제 버튼을 추가한다. 전사 완료(ready) 또는 실패(pending)인 행에만 보인다. 진행 중(processing)인 행에는 보이지 않는다.
- 클릭하면 `confirm()`으로 한 번 확인한다. 문구: "이 녹음과 전사본(문서·색인 포함)을 삭제합니다. 되돌릴 수 없습니다." 확인 시 `DELETE /api/recordings/:id`를 호출한다.
- 성공하면 목록을 다시 불러온다 (`loadRecordings()`). 실패하면 오류를 alert로 보여준다.
- Plaud 카드(`public/plaud.js`)의 행에도 같은 삭제 버튼을 다는 것이 좋으면 같이 단다. 단, Plaud 카드 행은 Plaud 목록 기준이라 삭제 후 Plaud 목록 새로고침이 필요하다. 녹음 목록만으로 충분하면 Plaud 카드는 건드리지 않아도 된다. 판단해서 RESULT.md에 적는다.

### 3. 주의

- 삭제는 되돌릴 수 없다. 확인 단계를 반드시 넣는다.
- 본인 소유가 아닌 녹음은 삭제할 수 없게 한다 (서버에서 검사).
- R2 오디오 키(object_key)가 비어 있으면 R2 삭제는 건너뛴다.
- doc_id가 가리키는 문서가 이미 지워진 경우(orphan)에는 문서 삭제 단계를 건너뛰고 나머지를 진행한다.

## 검증

- `npx tsc --noEmit` 통과.
- 로컬 wrangler dev로 삭제 동작을 확인한다 (가능한 범위에서). 최소한: 삭제 API가 403/409/200을 올바르게 내는지, R2·문서·plaud_imports가 함께 지워지는지.
- 배포는 하지 않는다. GitHub 푸시도 하지 않는다.
- 결과 파일: `files/workflow-verify/recording-delete/RESULT.md`에 작성한다. 내용: 무엇을 바꿨는지(파일·엔드포인트), 삭제 범위(R2·문서·벡터·plaud_imports), 진행 중 삭제 차단 여부, Plaud 카드 버튼 여부와 이유, 로컬 검증 결과, 배포 전 남은 것.
- `wrangler.toml`의 routes 항목은 건드리지 않는다.
