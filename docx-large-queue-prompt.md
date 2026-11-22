# 큰 덱·워크북·문서 Queue 처리 (2026-11-22, Fable 5.2)

## 배경

- 저장소: `~/workspace/goals/cloudflare-developer-day-seoul-2026-use-case-contest-entry/files/people-os` (이 디렉터리가 cwd다).
- 라이브 버전: People OS `48544fec`, 문서 편집 Worker `1dd93ed7`. 커밋 HEAD은 세션 3 커밋(`docx-ai-queue-v1` 태그) 이후다.
- 모델: Fable 5.2 (이 세션은 Fable 5.2 하나로 끝까지 — 중간에 모델 바꾸지 말 것).
- 먼저 `~/AGENTS.md`를 읽을 것 — 검증된 운용 교훈(권한 규칙, 라이브 호출 방법, 배포 주의)이 들어 있다. 특히:
  - 라이브 HTTP 검증은 `--add-dir ~/workspace/user`(시크릿 읽기)와 `Bash(curl *peopleos.site*)` 규칙이 있어야 한다.
  - `peopleos.site`에 `Cookie` 헤더를 붙인 curl은 샌드박스 프록시에서 멈춘다 — 로그인 필요한 라이브 호출은 `https://people-os.workspace-easyware.workers.dev`로 한다.
  - 배포 뒤 약 2분은 옛 버전이 응답한다 — 스모크는 3분 뒤에 할 것.
  - 배포는 직렬로 (동시 배포 금지). `cf-wrangler.py deploy`가 승인 대기로 막히면 우회하지 말고 보고만 하고 멈출 것.
  - `git add`·커밋·태그는 Merlin이 직접 한다 — 세션은 커밋하지 말 것.
  - 문서(ARCHITECTURE.md·VERIFICATION.md)는 건드리지 말 것 — Merlin이 따로 갱신한다.
- `npx tsc --noEmit` 0건, 바뀐 화면 JS는 `node --check` 통과가 매 단계의 조건이다.

## 문제 (실측)

큰 파일의 문서 작업이 지금은 HTTP 요청 안에서 동기식으로 돈다. CPU 실측:

- PPTX 편집 1회 CPU 약 0.5~1.6초 (applyOps 682~1,566ms), 덱이 크거나 슬라이드가 많으면 더 걸린다.
- XLSX 편집: 100k셀 문서 약 4.0초. 상한은 셀 200,000·시트 50·ops 200.
- DOCX 편집: 문단 5,000개 문서 편집 1회 CPU 약 4.7초 (상한 문단 5,000). DOCX 생성에 이미지 10 MiB를 넣으면 약 1~3초.
- Workers Paid CPU 한도는 요청당 30초. 지금은 한도 안에 들지만, 큰 파일 + 여러 ops + AI 지시(수십~수백 초)가 겹치면 요청이 길어지고 타임아웃·502 위험이 커진다. AI 지시 경로는 이미 세션 3에서 Queue로 옮겼다 (`docx_jobs`, 전용 Queue `people-os-docx-jobs`, 202 + 2초 폴링).

## 과제

### 범위

큰 파일의 **구조화** 문서 작업(지시 없이 정의·ops만 주는 경우)을 Queue로 옮긴다. 대상은 아래 중 실제로 느린 것부터:

1. `POST /api/docx/edit` — ops 편집 (문단 수·파일 크기가 클 때)
2. `POST /api/pptx/edit` — 편집 Worker RPC 경유 (덱 크기·슬라이드 수가 클 때)
3. `POST /api/xlsx/edit` — 편집 Worker RPC 경유 (셀 수·시트 수가 클 때)
4. `POST /api/docx/create` 구조화 입력 — 이미지가 많거나 섹션이 많을 때 (지시 경로는 이미 Queue다)
5. 덱 생성(`pptxgenjs` 경로, 슬라이드가 많을 때)이 동기식으로 오래 걸리는지도 보고, 해당하면 포함한다.

### 설계 (먼저 정한다)

- **임계값**: 어느 크기부터 Queue를 타는지 정한다. 작은 파일은 예전처럼 바로 201 (빠른 길 유지). 임계값은 실측 CPU를 근거로 정한다 (예: 예상 CPU가 몇 초를 넘으면 Queue). 임계값 판단은 요청을 받자마자 할 수 있어야 한다 (파일 크기·슬라이드 수·셀 수·문단 수 — inspect 결과를 쓰든 헤더·메타를 쓰든, AI를 부르지 않고 판단).
- **세션 3 패턴을 재사용한다**: 작업 테이블 + 전용 Queue + 202 + 작업 id + 2초 폴링 + `done`이면 기존 201 응답과 같은 모양의 `result`. `docx_jobs`를 확장할지 새 테이블을 만들지는 설계에서 판단한다 (kind가 달라지면 테이블을 나누는 게 나을 수 있다). 멱등성(작업 때 결과 id 미리 정함)·재시도 정책(계획 틀림 vs AI 호출 실패 vs 소비자 죽음의 층 분리)·15분 상한·동시 작업 상한도 세션 3과 같은 원칙으로 둔다.
- **승인 게이트는 그대로**: 워크플로 `pptx_edit`·`xlsx_edit`·`docx_edit`·`docx_create` 노드의 승인 게이트가 Queue 이동 뒤에도 그대로 동작해야 한다. 노드 자체는 이미 Queue 소비자 안에서 도니, 노드 경로를 바꾸는지는 설계에서 판단하고, 바꾸면 워크플로 로컬 검증까지 한다.
- **편집 Worker RPC**: PPTX·XLSX 편집은 편집 Worker(`DOC_EDITOR` 서비스 바인딩) 경유다. Queue 소비자가 편집 Worker를 부르는 구조가 되는지, 편집 Worker 쪽에도 Queue가 필요한지 설계에서 정한다.
- **직렬 실행 문제 (세션 3 남은 문제 1번)**: `people-os-docx-jobs`는 전용 큐로 나눈 뒤에도 작업이 한 번에 하나씩 돈다 (앞 작업 166초가 끝날 때까지 뒤 작업이 `queued`로 대기). 이번에 큰 파일 작업을 더하면 줄이 더 길어진다. 원인을 확인하고, 고칠 수 있으면 고친다. 못 고치면 이유와 우회책(예: DO 알람으로 기다리지 않는 구조)을 RESULT에 적는다. **단, 원인을 찾느라 본 과제가 멈추면 안 된다** — Queue 이동 자체를 먼저 끝내고, 직렬 문제는 별도 항목으로 남긴다.

### 검증

- 로컬: 임계값 아래는 바로 201, 위는 202 → 폴링 → done → 편집본 확인. PPTX·XLSX·DOCX 각 1종 이상. 실패 경로(못 만드는 ops)도 failed로 남는지 확인.
- 라이브: 큰 파일 1건 이상을 끝까지 돌려 편집본이 만들어지는지, 폴링이 done을 받는지, 타임아웃·502가 안 나는지 확인한다. 기존 엔드포인트 스모크 (`/api/health`·익명 `/api/auth/me` 401·기존 작은 편집 1건)가 이전과 동일한지 확인한다.
- 임시 시험 계정·문서·덱은 전부 정리하고 0건임을 재확인한다 (`doc_nodes`까지).

## 공통 규칙

- 배포는 직렬로. GitHub 푸시·커밋·태그를 하지 않는다. `ARCHITECTURE.md`·`VERIFICATION.md`를 건드리지 않는다. 이 과제 밖의 기능은 건드리지 않는다.
- `npm install`은 레포 루트에서 `--legacy-peer-deps`가 필요하다 (peer 충돌).

## 보고 (마지막에 `files/workflow-verify/docx-large-queue/RESULT.md`에 쓴다)

- 설계 (임계값 근거·Queue·테이블·폴링·멱등성·재시도 정책) + 바뀐 파일, 배포한 버전 ID, D1 마이그레이션 번호.
- 라이브 검증 결과 (엔드포인트·상태·걸린 시간·확인한 값), 임시 데이터 정리 확인.
- 남은 문제·미확인 항목이 있으면 솔직히 적는다 (특히: 직렬 실행 문제의 원인·결론, 편집 Worker RPC 구조, 임계값이 실제 CPU와 맞는지).
