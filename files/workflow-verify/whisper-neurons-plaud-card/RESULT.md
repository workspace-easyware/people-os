# Plaud 카드 파이프라인 + 예상 뉴런 표시 — RESULT

## 바꾼 것
- `src/plaud/routes.ts`: `GET /api/plaud/files`가 각 파일에 `linked_recording_id`를 추가로 돌려준다 (`plaud_imports.recording_id`, doc_id 유무와 무관, 새 `linkedRecordingMap`). 기존 `recording_id`(전사 중일 때만 값, 가져옴이면 null)는 그대로라 기존 폴링 동작은 안 바뀐다. 0035 미적용이면 빈 맵(try/catch).
  - 이유: 가져오기가 끝나면 기존 `recording_id`는 null이 돼서 화면이 녹음을 찾을 방법이 없었다.
- `public/plaud.js`:
  - `plaudLoadRecs()`: `linked_recording_id`가 있는 행이 있을 때만 `GET /api/recordings`를 불러 `plaudState.recs`(id→행)와 `plaudState.whisper`에 저장.
  - `plaudPipelineHtml()`: 행 아래에 `pipelineSteps(r)`(index.html 것을 그대로 재사용, 복제 없음) + `Whisper 약 N 뉴런 (추정)`. 뉴런은 `duration_ms > 0`이고 `whisper.neuronsPerMin`이 있을 때만(녹음 목록과 같은 계산).
  - 전사 중(`st.busy` 또는 `transcript_status==='processing'`)에는 기존 "전사 중… N/M 구간" 진행 표시만 두고 파이프라인은 안 붙인다. 폴링이 ready가 되면 recs를 다시 받아 파이프라인을 붙인다.
- 녹음 목록, `pipelineSteps`, 파이프라인 서버 동작, `wrangler.toml`은 건드리지 않음.

## 표시 조건
`plaud_imports.recording_id`가 있는 Plaud 행만 표시된다 (= People OS Whisper로 전사한 녹음). Plaud 자체 전사를 가져온 행은 recordings 행이 없으므로 표시하지 않는다(억지로 만들지 않음). 연결된 녹음이 목록에 없거나 `pipelineSteps`가 없으면 아무것도 안 그린다.

## 검증
- `npx tsc --noEmit`: 통과.
- `node --check public/plaud.js`: 통과.
- 로컬 화면 확인: **못 함**. Plaud 연결(OAuth)과 plaud_imports 데이터가 로컬에 없고, ensureSchema/0004 문제도 있어 시도하지 않았다.

## 배포 전 남은 것
- 배포 안 함, 푸시 안 함.
- 배포 후 브라우저에서 Plaud 카드의 "가져옴" 행(2026-10-31 · 58분 37초)에 파이프라인과 "Whisper 약 N 뉴런 (추정)"이 보이는지 확인. 그 행의 `plaud_imports.recording_id`가 실제로 채워져 있어야 보인다 (비어 있으면 표시되지 않는 게 정상).
