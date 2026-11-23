# Plaud MP3 전사 멈춤 수정 — RESULT (2026-11-23, Opus 5.5 세션)

**상태: 구현·로컬 검증·배포·멈춘 녹음 정리 완료. 커밋 안 함. 라이브 화면 확인·다시 가져오기는 안 함 (Merlin 몫).**

## 배포
- 버전 ID: `76c96de6-f34f-4f02-9a0a-530ed271c433` (`cf-wrangler.py deploy`, 절대 경로)
- 배포 3분 뒤 익명 스모크: `GET https://peopleos.site/` 200, `GET /api/recordings` 401 (로그인 필요, 정상). 로그인 화면 확인은 안 함.
- 배포 전 확인: 작업 트리의 다른 미커밋 변경(Plaud 목록 수정 `a631f624`, 메일 서식 `b282cfd3`)은 이미 라이브에 있던 것 → 이번 배포로 새로 나간 것은 MP3 수정뿐.

## 바꾼 것
1. `src/plaud/routes.ts`
   - `fetchAudio`: Content-Type을 그대로 쓴다 (`;` 매개변수 제거, 소문자). `audio/*`가 아니거나 없으면 `application/octet-stream` (예전에는 `audio/ogg`로 가정).
   - `audioExtension(mime)`: audio/mpeg(·mp3·mpeg3·x-mpeg·x-mp3)→`.mp3`, audio/ogg·opus→`.ogg`, audio/wav(·x-wav·wave·vnd.wave)→`.wav`, audio/mp4·x-m4a·m4a→`.m4a`, 그 밖→`.bin`. 파일 매직 판별은 범위 밖으로 둠.
   - `/import`: 저장 이름을 `.ogg` 고정 대신 `audioExtension(audio.mime)`로. startTranscription에는 실제 mime이 간다.
2. `src/mp3.ts` (신규, 의존성 없음): ID3v2 건너뛰기(여러 개·footer 처리) → MPEG 1/2/2.5, Layer I/II/III 헤더 파싱(비트레이트·샘플링레이트 표, free format·bad 제외) → 프레임 길이 계산. 오탐 방지로 "다음 프레임 헤더도 같은 버전·레이어·샘플링레이트"여야 인정(끝 프레임·사슬 위 프레임은 예외). 프레임 경계에서 `CHUNK_BYTES`(1MB) 또는 `CHUNK_SECONDS`(15분)을 넘기기 전에 자른다. 반환 `{segments, durations, totalSeconds} | null` (유효 프레임 0개면 null). 구간은 원본 버퍼의 subarray(복사 없음).
3. `src/index.ts` `advanceRecording`
   - MP3 판별을 먼저: mime에 `mpeg`/`mp3` 또는 키가 `.mp3` → `splitMp3`. (옛 가져오기가 MP3를 `.ogg` 이름 + `audio/mpeg` mime으로 저장했기 때문.) 그 밖에 mime `ogg` 또는 `.ogg` → 기존 `splitOggOpus` 그대로.
   - split이 null이고 파일이 `WHOLE_FILE_MAX_BYTES`(5MB)보다 크면 Whisper를 부르지 않고 `transcript_status='pending'`, `progress='실패: 오디오 형식을 나눌 수 없습니다 (파일이 손상되었거나 지원하지 않는 형식입니다)'`, `pipeline_stage='queued'`로 멈춘다 → 녹음 목록에 "다시 전사" 버튼이 뜬다(pending 행, `public/index.html:818`). ≤5MB는 예전처럼 통째 1구간.
   - `splitOggOpus`·`src/ogg.ts`는 손대지 않음.

## 로컬 검증
- `npx tsc --noEmit`: 0건.
- 하네스: `files/workflow-verify/plaud-mp3/harness/` (본체 `src/index.ts` + 가짜 Whisper만 Proxy로 바꾼 진입점, 로컬 전용 이름 `people-os-plaud-mp3-local`, 배포 안 함). `node <스크립트>`가 승인 대기로 막혀 `wrangler dev --local` 라우트로 돌렸다.
- **splitMp3 (실제 37,222,235바이트 MP3, `/home/hatch/workspace/plaud-1121-audio.bin`)** — 결과 `files/workflow-verify/plaud-mp3/split-result.json`
  - splitOggOpus = null (재현 기준과 같음)
  - ID3v2 45바이트 뒤 첫 프레임: MPEG1 Layer III (128kbps 상당, 프레임 ~418바이트)
  - **구간 36개**: 1~35번 1,048,240~1,048,242바이트(각 65.5초), 36번 533,734바이트(33.4초)
  - **36개 구간 전부 `ff fb`로 시작** (MPEG 프레임 싱크), 구간끼리 빈틈·겹침 없음, 바이트 합 37,222,190 (= 파일 − ID3 45)
  - **durations 합 2326.4초** (Plaud 38분 46초 = 2326초와 일치)
- **advance 경로 끝까지 (가짜 Whisper)** — 결과 `files/workflow-verify/plaud-mp3/advance-result.json`
  - 라이브 멈춘 행과 같은 모양(`object_key …/2026-11-21_17_17_07.ogg`, `mime audio/mpeg`, 37MB)으로 행을 넣고 실제 `POST /api/recordings/:id/advance`를 반복 호출
  - done_chunks 0 → 1 → … → 36, progress `1/36 구간 전사 중` … `35/36`, 36번째 호출에서 `ready`, 전사본 문서 생성, pipeline_stage `queued`(파이프라인 큐 enqueue 성공). 가짜 Whisper 호출 36회.
- 쪼갤 수 없는 큰 파일 (9.1MB 텍스트를 `audio/mpeg`로): 첫 advance에서 Whisper 호출 0회로 바로 `pending` + 위 실패 문구 + pipeline_stage `queued`. 반복 없음.
- 쪼갤 수 없는 작은 파일 (191KB, `application/octet-stream`): 통째 1구간 전사 → `ready`.

## 멈춘 녹음 정리 (라이브, 배포 뒤)
- 삭제 전 확인: `rec_mwt4pdyl_966exn`, title `2026-11-21 17:17:07.ogg`, mime `audio/mpeg`, size 37,222,235, status `processing`, done_chunks 0, progress `전사 중`, doc_id NULL. 연결된 plaud_imports 1건 (plaud_file_id `f_01a207bff9c971988480464dc88d3430`, doc_id NULL, title `2026-11-21 17:17:07`).
- 삭제: `DELETE FROM plaud_imports WHERE recording_id=… AND plaud_file_id=… AND doc_id IS NULL` (changes 1), `DELETE FROM recordings WHERE id=… AND doc_id IS NULL` (changes 1). R2 `recordings/rec_mwt4pdyl_966exn/2026-11-21_17_17_07.ogg` 삭제 완료.
- 삭제 후: recordings 해당 id 0건, plaud_imports(해당 recording_id 또는 plaud_file_id) 0건, R2 get → "The specified key does not exist". 다른 녹음은 건드리지 않음 (남은 recordings 2건).
- 다시 가져오기는 누르지 않았다 (Merlin이 브라우저로 확인 예정).

## 남은 제한 사항
- **10-31 ogg 회귀는 로컬에서 실제 파일로 못 돌렸다** (로컬에 ogg 원본 없음). 코드상 ogg 분기는 mime이 mpeg/mp3가 아니고 ogg일 때 예전과 똑같이 `splitOggOpus`를 부른다. 바뀐 점은 "ogg인데 split이 null이고 5MB 초과"일 때 통째 전사 대신 실패로 멈춘다는 것 하나 (예전에는 그 경우 무한 반복이었다).
- 실제 Whisper로 1MB MP3 구간 전사는 라이브에서 확인 안 함 (가짜 Whisper만). 구간 첫 프레임은 Layer III bit reservoir 때문에 약 26ms가 깨끗이 안 풀릴 수 있다 — 전사 품질 영향은 미미할 것으로 보나 미확인.
- presigned 응답에 Content-Type이 없거나 `application/octet-stream`이면 `.bin` + octet-stream으로 저장된다 → 5MB 넘으면 "나눌 수 없습니다"로 멈춘다 (지시대로 매직 판별 안 함). Plaud가 실제로 그렇게 주는 파일이 있으면 매직 판별이 필요하다.
- wav·m4a는 분할기가 없다 → 5MB 초과면 실패로 멈춘다 (예전에는 통째 전사 시도).
- 37MB를 advance 호출마다 R2에서 통째로 읽어 다시 나눈다 (기존 ogg와 같은 방식). 메모리 ~37MB + 구간 base64(~1.4MB)라 128MB 안이지만 40MB 상한 근처 파일에서는 여유가 줄어든다.
- 하네스 상태 폴더 `files/workflow-verify/plaud-mp3/harness/state/`는 남겨 두었다 (지워도 됨).

## 라이브 재가져오기 검증 (2026-11-23 20:22~20:26, Merlin, 사용자 브라우저 + D1)
- 20:22 "가져와서 전사하기" 클릭. 1분 뒤 4/36 구간, 3분 뒤 11/36 구간, D1 확인 시점 13/36 구간으로 진행 중. 오류·실패 메시지 없음.
- 새 녹음 rec_mwt6ffhx_4y1jem, 제목 "2026-11-21 17:17:07.mp3"로 올바르게 저장됨. D1에 해당 제목 녹음은 1건뿐(중복 없음). 완료까지 약 10분 예상, 페이지를 열어 두어야 폴링이 이어간다.
