# PPTX 편집 파일럿 — ooxml-core 검증 (격리 환경, 라이브 코드 손대지 않음)

## 목표

기존 PPTX 파일을 열고 고쳐서 저장하는 기능을 People OS에 붙일 수 있는지, `ooxml-core`/`pptx-viewer-core`를 **라이브 코드와 분리된 격리 환경**에서 검증한다. 판정(도입 가능/불가/조건부)과 근거, 통합 개요를 결과 파일로 남긴다. **통합 구현은 이번에 하지 않는다.**

## 배경 (검증된 사실, 2026-11-19 조사)

- People OS는 지금 `pptxgenjs 4.0.1`으로 **새 덱 만들기만** 한다. 기존 PPTX를 열어 고치는 기능은 없다. 만들기 쪽은 pptxgenjs 유지가 결론.
- 편집 후보 1순위: **`ooxml-core` / `pptx-viewer-core`** (Apache-2.0, https://github.com/ChristopherVR/ooxml, npm `pptx-viewer-core`·`ooxml-core`). 2026년 3월에 나온 아주 어린 프로젝트라 파일럿 검증이 필수. README 주장: 브라우저·Node·Bun·Worker·서버리스에서 같은 라이브러리 동작, 네이티브 의존성 없음, `save()`는 `Uint8Array` 반환, 손대지 않은 부분은 바이트 그대로 보존, 16종 요소(텍스트·도형·표·차트·SmartArt·미디어…), 차트 편집 가능.
- 백업 후보: @shbernal PptxGenJS 포크(`pptxgenjs/read`, 차트는 읽기 전용), `node-pptx-templater`(템플릿 전용). 이번 파일럿은 ooxml-core만 검증하고, 안 되면 결과 파일에 백업 후보로 넘어갈 조건을 적는다.
- 상세 조사 보고서: `~/workspace/research_notes/opensource-document-libraries-workers-20261119-1214/report.md` §2 (반드시 읽을 것). ooxml 문서: https://christophervr.github.io/ooxml/pptx/ , 제한 사항: https://christophervr.github.io/ooxml/pptx/guide/limitations , 저장: https://christophervr.github.io/ooxml/pptx/core/saving

## 격리 위치 (절대 규칙)

- 파일럿 디렉터리: `files/people-os/pptx-edit-pilot/` (이 디렉터리 안에만 파일 생성 — 자체 `package.json`, 시험 Worker용 `wrangler.toml` 포함).
- **건드리지 말 것**: 레포의 `package.json`, `wrangler.toml`, `src/`, `public/`, 운영 Worker 설정. 라이브 코드는 일절 수정하지 않는다. 끝날 때 `git status`로 확인할 것 — 새로 생기는 것은 `pptx-edit-pilot/` + 결과 파일 + 이 프롬프트 파일뿐이어야 한다.
- 커밋·태그·운영 배포는 하지 않는다 (Merlin이 한다). 원격 시험 Worker만 배포하고 끝나면 삭제한다.

## 검증 항목 (전부 실제 실행으로)

1. **설치**: 현재 npm 버전 확인(`pptx-viewer-core`, `ooxml-core`), 파일럿 디렉터리에 깔끔히 설치되는지. 버전·설치 크기를 기록.
2. **시험 덱 만들기**: 파일럿 디렉터리에 `pptxgenjs 4.0.1`을 깔고(레포 것과 별개로) 시험 덱 생성 — 제목 슬라이드(텍스트), 도형 슬라이드, 표 슬라이드, 네이티브 차트 슬라이드 최소 4장. People OS의 S3 덱 생성 방식과 같은 라이브러리·버전으로 만든다.
3. **로컬 편집 (Node)**: ooxml-core로 시험 덱을 열어 아래를 고치고 저장한다.
   - 텍스트 run 내용 교체
   - 도형 이동·크기 변경·채우기 색 변경
   - 표 셀 내용 교체
   - 차트 시리즈 데이터·제목 변경
   - 슬라이드 1장 복제 (가능하면)
   저장 뒤 검증: ooxml-core로 다시 열어 바뀐 값을 읽어 확인 / zip을 풀어 XML이 well-formed인지 확인 / **손대지 않은 슬라이드의 바이트 동일 여부** / 파일 크기 변화.
4. **Workers 호환**:
   - 파일럿 디렉터리에 최소 Worker를 만든다 (바이트 입력 → 텍스트 1곳 교체 → 저장 → 반환).
   - `npx wrangler dev --local`로 로컬 스모크 (주의: `--local`은 `dev` 바로 뒤에).
   - 번들 크기: `wrangler deploy --dry-run`으로 확인하고 기록.
   - 원격 시험 Worker 배포: `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py deploy --config <파일럿 wrangler.toml 절대 경로>`로 실행한다 (직접 실행, `python3` 경유 금지, `cd ... && cf-wrangler.py` 금지). Worker 이름 `people-os-pptx-pilot`. 실제 덱을 보내 끝까지 편집·저장되는지 원격으로 확인한다.
   - 끝나면 `cf-wrangler.py delete --name people-os-pptx-pilot --force`로 삭제한다.
5. **한계 탐색**: 차트 데이터 편집이 실제로 되는지, SmartArt·서명은 어떻게 되는지, 고친 슬라이드에서 어떤 마크업이 손대지는지. VM에는 PowerPoint가 없으므로 "파워포인트에서 열린다"는 **직접 확인이 안 됨**을 명시하고, 대신 재파싱 + XML 유효성 + 구조 검사로 대체하고 그 한계를 결과 파일에 적는다.
6. **결과 파일**: `files/people-os/files/workflow-verify/pptx-edit-pilot/PILOT-RESULT.md`에 작성한다. 포함할 것: 판정(도입 가능/불가/조건부 — 한 줄), 항목별 통과·실패 + 근거(버전·번들 크기·측정값), Workers 판정, 발견된 한계, **통합 개요**(People OS의 어떤 파일을 어떻게 바꿀지, 대략 단계만 — 구현 아님), 백업 후보로 넘어갈 조건.

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- 긴 원격 호출(수 분)은 한 번의 HTTP 요청으로 기다리지 말고 제출 라우트 + 나중에 읽는 보고 라우트로 나눈다 (5분 가까이 붙잡는 요청은 본문 없이 끊긴다).
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다 (셸 변수를 URL에 쓰면 막힌다).
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·시험 Worker 삭제 여부를 짧게 요약한다.
