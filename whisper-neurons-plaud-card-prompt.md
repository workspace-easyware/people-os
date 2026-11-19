# Plaud 카드에 파이프라인 + 예상 뉴런 표시

## 배경

- 녹음 목록("최근 음성 녹음")에는 파이프라인(전사 → 요약 → 색인 → 완료)과 "Whisper 약 N 뉴런 (추정)"이 이미 표시된다 (배포 823b190b, 마이그레이션 0036). 브라우저로 확인됨.
- 그런데 Plaud 카드의 해당 녹음 행에는 파이프라인도 뉴런도 안 보인다. "가져옴", "2026-10-31 · 58분 37초"만 보인다. 사용자가 Plaud 카드만 보고 있어서 못 본 것이다.
- Plaud 카드의 행은 `public/plaud.js`가 렌더링한다. 녹음 목록의 파이프라인 표시는 `public/index.html`의 `pipelineSteps(r)`가 한다.

## 할 일

1. `public/plaud.js`의 행 렌더링을 확인한다. Plaud 가져오기 완료 후 해당 녹음의 파이프라인 상태와 예상 뉴런을 행 아래에 표시한다.
   - 표시할 것: `pipelineSteps`와 같은 파이프라인 단계(전사 → 요약 → 색인 → 완료 + 현재 상태 라벨), 그리고 "Whisper 약 N 뉴런 (추정)" (길이를 알 때만).
   - 데이터 출처: Plaud 가져오기가 만든 recordings 행의 `pipeline_stage`, `transcript_status`, `duration_ms`를 쓴다. `GET /api/recordings`가 이미 `duration_ms`와 `whisper:{neuronsPerMin,checked}`를 반환한다. Plaud 행에 recording_id가 있으면 그걸로 recordings 목록에서 찾아서 표시한다. recording_id가 없으면 표시하지 않는다 (억지로 만들지 않는다).
   - `pipelineSteps` 함수를 재사용하거나, Plaud 카드에 맞는 형태로 같은 로직을 쓴다. 중복 구현보다 재사용을 우선한다.
   - "추정" 표기를 반드시 넣는다. 길이를 모르면 뉴런을 표시하지 않는다.
2. 진행 중인 전사("전사 중… N/M 구간")일 때는 기존 진행 표시를 유지하고, 파이프라인 단계는 전사 완료 뒤부터 표시한다. (전사 중에는 파이프라인이 'transcribing'이라 전사 단계만 진행 중으로 보이는 게 자연스럽다. 단, 행이 복잡해지면 전사 중에는 진행 표시만 두고 완료 뒤에 파이프라인을 붙이는 쪽으로 한다.)
3. 로컬 검증: `npx tsc --noEmit` 통과. 로컬 화면 확인은 이전 세션과 같은 ensureSchema/0004 문제로 어려울 수 있으니, 되면 하고 안 되면 RESULT.md에 명시한다.

## 검증·결과

- 배포는 하지 않는다. GitHub 푸시도 하지 않는다.
- 결과 파일: `files/workflow-verify/whisper-neurons-plaud-card/RESULT.md`에 작성한다. 내용: 무엇을 바꿨는지, Plaud 행에 표시되는 조건(recording_id 연결 방식), 로컬 검증 결과, 배포 전 남은 것.
- 기존 파이프라인 동작과 녹음 목록 표시는 건드리지 않는다.
- `wrangler.toml`의 routes 항목은 건드리지 않는다.
