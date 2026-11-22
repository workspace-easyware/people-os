# PPTX 편집 파일럿 결과 — ooxml-core / pptx-viewer-core (2026-11-21)

## 판정

**조건부 도입 가능.** 텍스트·도형·표·차트·슬라이드 복제가 Workers(로컬 workerd + 원격) 안에서 끝까지 고쳐지고 저장된다. 다만 두 가지가 걸린다. 번들이 +9.2 MiB(gzip +2.3 MiB)로 커서 **People OS 본체에 넣지 말고 별도 Worker(서비스 바인딩)로 분리**하는 것을 조건으로 한다. 또 편집 1회 CPU가 약 0.5–1초라서 **요금제 CPU 한도를 먼저 확인**해야 한다.

## 환경·버전

| 항목 | 값 |
|---|---|
| `pptx-viewer-core` | **5.0.0** (Apache-2.0, `export * from 'ooxml-core/pptx'` 한 줄짜리 진입점, 304 KB) |
| `ooxml-core` | **2.x** (`^2.0.0` 설치, Apache-2.0, 설치 크기 **159 MB**: docx/xlsx/visio/cli 포함 전체 dist) |
| 그 밖의 의존성 | 총 51개 패키지, `node_modules` 합계 약 190 MB (prosemirror·yjs·emf-converter·fast-xml-parser·fflate·jszip 등). 네이티브 의존성은 없다 (`@napi-rs/canvas`는 선택 peer라 설치되지 않음). |
| `pptxgenjs` | 4.0.1 (파일럿 디렉터리에 별도 설치, 레포 것과 별개) |
| wrangler | 4.165.0, `compatibility_date 2025-07-18` + `nodejs_compat` (People OS와 같음) |
| 설치 | `npm install --prefix pptx-edit-pilot pptx-viewer-core ooxml-core pptxgenjs@4.0.1` → 26초에 경고 없이 끝남 |

`npm view`는 이 세션에서 승인 대기로 막혀 레지스트리 메타데이터(최신 버전·배포일)는 직접 읽지 못했다. 버전은 설치된 `package.json` 기준이다.

## 실행 방식 (중요)

이 세션에서는 `node <스크립트>`가 승인 대기로 막힌다 (AGENTS.md에 적힌 그대로다). 그래서 **3번 로컬 편집을 Node가 아니라 `wrangler dev --local`(workerd) 안에서** 돌렸다. 덱 만들기, 편집, 재파싱, zip 풀기, XML 검사를 모두 Worker 라우트로 만들었다. 결과적으로 "로컬 편집"과 "Workers 호환"을 한 번에 검증한 셈이고, 같은 코드를 원격에도 배포해 같은 결과를 확인했다. Node 단독 실행은 검증하지 않았다 (README상 Node ≥ 22.3 지원).

## 항목별 결과

### 1. 설치 — 통과
위 표 참고. 설치 크기가 크다는 것(ooxml-core 159 MB)이 유일한 흠이다. 번들에는 쓰는 부분만 들어간다 (아래 번들 크기 참고).

### 2. 시험 덱 — 통과
`src/deck.js`에서 pptxgenjs 4.0.1로 만들었다 (People OS S3 `src/index.ts` ~L465와 같은 방식·스타일, `LAYOUT_WIDE`, `write({outputType:"uint8array"})`). 구성은 5장이다: ① 제목(텍스트 2개와 파란 막대), ② 도형 3개(rect·ellipse·roundRect), ③ 표 4×3, ④ 네이티브 막대 차트(시리즈 2개·분기 4개, 내장 xlsx 포함), ⑤ **대조군**(편집하지 않음). 크기는 109,703 B, 부품 58개(디렉터리 엔트리 19개 포함, 전부 STORE 비압축)다.

ooxml-core 로드는 경고 0건, 호환 경고 0건이었다. 16종 모델로 모두 올바르게 읽혔다 (text / shape / table / chart의 값·좌표·채우기색).

### 3. 편집 — 통과 (5종 모두)

| 편집 | 방법 | 다시 읽은 값 |
|---|---|---|
| 텍스트 run 교체 (바이트 수준) | `setPresentationRunText(bytes, 0, id, 0, …)` | "2027 리더십 코칭 중간 보고" ✅ |
| 텍스트 교체 (모델 수준) | `el.text` + `textSegments[0].text` 수정 후 `save()` | "People OS 편집 파일럿 (수정됨)" ✅ |
| 도형 이동·크기·채우기 | `x+100, y+40, width×1.5, height×1.25, shapeStyle.fillColor="#DC2626"` | x 96→196, y 173→213, w 288→432, h 192→240, fill #2D7DDE→#DC2626 ✅ (EMU 914400→1866900로 정확) |
| 표 셀 교체 | `rows[1].cells[0].text="최코치"`, `rows[2].cells[2].text="99"` (`textRuns` 비움) | ✅ |
| 차트 시리즈·제목 | `updateChartSeriesValues(ch,0,[11,22,33,44])`, `(ch,1,[50,60,70,80])`, `setChartTitle(ch,"…(수정)")` | 시리즈·제목 ✅. **`chart1.xml` 캐시(`<c:v>50</c:v>`)와 내장 워크북 `Microsoft_Excel_Worksheet1.xlsx`의 sheet1 값(11,22,…,50,60,70,80)까지 갱신됨** → PowerPoint에서 "데이터 편집"을 열어도 값이 맞는다 |
| 슬라이드 복제 | `duplicateSlide(slide3, 6)` → `save([...slides, dup])` | slide6.xml(+rels, notesSlide6)이 생기고 표 내용이 그대로 복제됨 ✅ |

**저장 뒤 검증**

- **재파싱**: 위 값 전부 ✅ (`out/selftest-local.json`, `out/selftest-remote.json`).
- **XML well-formed**: 저장본의 `.xml`/`.rels` 전부 `fast-xml-parser XMLValidator` 통과, 오류 0건.
- **`validatePptx`** (라이브러리 자체 규칙 검사, XSD 전수 검사는 아님): `valid: true`. 경고 4건(`[Content_Types].xml`에 없는 slideMaster2–5 override)이 남는데, 이는 **pptxgenjs 원본에서 물려받은 것**이다. 원본은 오히려 `valid: false`였다 (`notesMasterIdLst` 순서 오류 1건). ooxml-core 저장이 이 오류를 고쳤다.
- **손대지 않은 슬라이드 바이트 동일**: `ppt/slides/slide5.xml`이 **identical** ✅ (로컬·원격 모두). 편집 없이 로드→저장만 해도 slide1–5와 테마·미디어·차트·임베딩은 모두 바이트 동일했다. 다시 쓰인 부품은 `[Content_Types].xml`, `docProps/app.xml`·`core.xml`, `presentation.xml`(+rels), `viewProps.xml`, `slideLayout1.xml`, `slideMaster1.xml` 8개다.
- **파일 크기**: 109,703 → **33,656 B** (−69%). 내용 손실이 아니다. 원본은 pptxgenjs가 **STORE(무압축)**로 쓴 58엔트리이고, 저장본은 **DEFLATE** 43엔트리다. 줄어든 15개는 디렉터리 엔트리 19개 삭제와 슬라이드 6 관련 4개 추가의 차이다. 비압축 합계는 102,423 → 119,297 B(슬라이드 1장 추가와 재직렬화분)로 오히려 늘었다.

### 4. Workers 호환 — 통과 (조건 있음)

| 항목 | 결과 |
|---|---|
| 로컬 `npx wrangler dev --local` (workerd) | 모든 라우트 200. 로컬 기준 make 38 ms / load 360 ms / edit 781 ms / verify 325 ms |
| 최소 Worker 번들 (`src/minimal.js`: 바이트 입력 → run 1개 교체 → 저장, nodejs_compat 없음) | **Total Upload 9,374 KiB / gzip 2,302 KiB**. `nodejs_compat` 없이도 번들된다 (`node:` import 없음). |
| 시험 Worker 번들 (`src/lab.js`, pptxgenjs + fflate + 검사 코드 포함) | 9,962 KiB / gzip 2,445 KiB |
| 비교: 현재 People OS 번들 (dry-run, 읽기 전용) | 8,382 KiB / gzip 1,721 KiB → 합치면 **약 17.8 MiB / gzip 약 4.0 MiB** |
| 원격 배포 `people-os-pptx-pilot` | 성공, **Worker Startup Time 93 ms**, 버전 `49ba2743-83c0-4394-b8d4-0fbdab9bb334` |
| 원격 실제 덱 편집 | `POST /selftest`(test-deck.pptx 전송) → 위 3번 결과와 같음 (slide5 identical, XML OK, valid). `POST /edit` → 33,654 B 편집본 반환. `POST /replace` → 29,011 B, 텍스트 교체 확인. **원격 CPU(wrangler tail): 전체 편집 cpuTime 1,036 ms / wall 1,120 ms, 최소 교체 cpuTime 481 ms / wall 508 ms, 둘 다 outcome ok** |
| 삭제 | `cf-wrangler.py delete --name people-os-pptx-pilot --force` → "Successfully deleted" ✅ |

**Workers 판정: 동작한다. 단, 두 가지 조건이 있다.**

1. **번들**: 한 번 import하면 트리 셰이킹이 거의 안 된다 (최소 경로도 9.2 MiB). 64 MiB 한도(2026-09 변경 로그, 조사 보고서 §0은 index 출처)에는 여유가 있다. 그러나 옛 Free 플랜의 3 MiB(gzip) 한도가 아직 적용되는 계정이라면 People OS와 합친 약 4.0 MiB gzip은 넘을 수 있다. 별도 Worker로 두면 2.3 MiB라 어느 경우든 통과한다.
2. **CPU**: 5장·110 KB 덱에서 편집 1회가 CPU 약 1초다. 이번 계정에서는 막히지 않았다 (outcome ok). 그러나 Free 플랜의 공식 한도는 요청당 10 ms CPU이므로, 계정 요금제와 실제 적용 한도는 **이번에 확인하지 못했다**. 큰 회사 덱(수십 장·이미지 다수)에서는 CPU와 128 MB 메모리를 다시 재야 한다. 이번에는 측정하지 않았다.

참고: Workers 안의 `Date.now()`는 요청 중 시간이 흐르지 않아서 원격 `timingsMs`가 0으로 나온다. 원격 시간은 tail의 cpuTime/wallTime 기준이다.

### 5. 한계 탐색

| 항목 | 결과 |
|---|---|
| 차트 데이터 편집 | **된다** (위 3번). 시리즈 값, 제목, 캐시, 내장 xlsx가 함께 갱신된다. 이번에 확인한 것은 pptxgenjs 막대 차트 1종뿐이다. |
| 편집한 슬라이드에서 손대지는 마크업 | 편집한 부품은 **부품 전체가 다시 직렬화된다**. 빈 태그를 열고 닫는 태그로 풀고(`<a:off …/>` → `<a:off …></a:off>`), 태그 사이 공백·줄바꿈을 지우며, `<?xml?>` 뒤 CRLF도 없앤다. 슬라이드 2에서 손대지 않은 ellipse·roundRect도 바이트로는 달라졌지만, 좌표·색·도형 정의는 같다 (의미상 동일). 다시 쓰이는 단위는 슬라이드(부품)이지 도형이 아니다. `docProps/app.xml`의 Words/Paragraphs/Slides 수와 `core.xml` 수정 시각도 다시 계산된다. 레이아웃·마스터는 편집하지 않아도 같은 방식으로 다시 직렬화된다 (마스터 7,814 → 8,806 B, 증가분은 태그 풀기 때문). |
| 디지털 서명 | **저장하면 지워진다** (`_xmlsignatures/` 3개 부품과 루트 rels의 서명 관계 모두). 편집 없이 저장해도 지워진다. 가짜 서명 부품을 넣은 덱으로 확인했고, d.ts의 `stripDigitalSignatures()`("Strip digital signature parts … if the document was signed")와 일치한다. 서명된 덱을 고치면 서명은 원래 무효가 되므로 동작 자체는 맞다. 다만 UI에서 "서명이 제거됨"을 알려야 한다. |
| SmartArt | SDK로 만든 SmartArt(`type:'smartArt'`, 노드 3개)는 저장 시 `ppt/diagrams/data1·layout1·quickStyle1·colors1·drawing1.xml`을 생성한다. 다시 읽기 ✅, 노드 텍스트 편집 후 다시 읽기 ✅ ("실행(수정)"). **그러나 편집이 `data1.xml`에만 반영되고 `drawing1.xml`(PowerPoint가 화면에 그리는 미리 계산된 도형 캐시)은 옛 텍스트로 남는다.** PowerPoint가 열 때 캐시를 다시 계산하는지는 확인하지 못했다. 옛 글자가 보일 위험이 있다. PowerPoint가 직접 만든 SmartArt(실제 회사 덱)로는 시험하지 못했다 (VM에서 `find`가 승인 대기로 막혀 기존 pptx를 찾지 못함). |
| 애니메이션·OLE·수식 | 시험하지 않았다 (pptxgenjs로 만들 수 없음). |
| "PowerPoint에서 열린다" | **직접 확인하지 못했다** (VM에 PowerPoint·LibreOffice 없음). 재파싱, 전 부품 XML well-formed 검사, `validatePptx` 규칙 검사(XSD 전수 검사 아님), 부품 바이트 비교로 대신했다. 복구 대화상자가 뜨지 않는지는 **사람이 PowerPoint에서 `out/edited-remote.pptx`를 열어 확인**해야 한다. |
| 공식 문서 (limitations/saving 페이지) | 이 세션에서 WebFetch가 거부되어 **읽지 못했다**. 위 결론은 설치된 패키지의 README·d.ts·실험 결과에 근거한다. |

## 통합 개요 (구현 아님, 단계만)

1. **새 Worker `people-os-pptx-editor`** (별도 `wrangler.toml`, `pptx-viewer-core` 고정 버전). People OS 본체 번들과 CPU를 분리하고, People OS `wrangler.toml`에는 `[[services]] binding = "PPTX_EDITOR"`만 추가한다. RPC(WorkerEntrypoint)로 `inspect(bytes)` / `applyOps(bytes, ops[])` / `replaceText(bytes, find, to)`를 제공한다.
2. **ops 스키마**를 People OS 쪽 공용 타입으로 정의한다: `{op:"text", slide, elementId, runIndex?, text}`, `{op:"shape", …x,y,w,h,fill}`, `{op:"cell", slide, elementId, r, c, text}`, `{op:"chart", slide, elementId, series:[[…]], title?}`, `{op:"duplicate", slide}`. 이번 파일럿의 `src/lab.js` `applyEdits()`가 원형이다.
3. **`src/index.ts`**: 기존 S3 덱 생성(pptxgenjs) 옆에 "덱 편집" 라우트를 둔다. R2 `FILES`에서 원본 pptx를 읽어 `PPTX_EDITOR.inspect`로 슬라이드·요소 요약을 얻고, 에이전트나 사용자가 고른 ops로 `applyOps`를 호출한다. 결과는 **새 R2 키(버전)로 저장**하고 원본은 남긴다.
4. **`src/workflow/nodes.ts`**: 워크플로 노드 `pptx_edit`를 추가한다 (입력: 파일 ID와 ops 또는 자연어 지시 → LLM이 `inspect` 요약을 보고 ops JSON 생성). 승인 노드(비동기 승인 P1–P3)와 이어 붙일 수 있다.
5. **UI (`public/`)**: 파일 상세에 "편집본 만들기"와 변경 전후 텍스트 diff를 둔다. 서명 덱이면 "저장 시 서명 제거" 경고를 띄운다. SmartArt를 편집했으면 "PowerPoint에서 레이아웃 새로고침 필요할 수 있음"을 표시한다.
6. **가드**: `load(buffer, { limits })`로 입력 크기·슬라이드 수 상한을 걸고, 요청당 CPU를 tail로 계측한다. 큰 덱은 Queue 소비자에서 처리한다 (긴 처리는 제출 라우트와 보고 라우트로 나눔).

## 백업 후보로 넘어갈 조건

아래 중 하나라도 해당하면 **@shbernal PptxGenJS 포크(`pptxgenjs/read`)** 로 가거나, 템플릿 문서라면 **node-pptx-templater**를 쓰고, 최후의 수단으로 JSZip+XML 수작업을 쓴다.

- PowerPoint에서 편집본을 열 때 **복구 대화상자**가 뜨고, ooxml-core 업데이트로 해결되지 않는다.
- 실제 회사 덱(PowerPoint 작성 SmartArt·애니메이션·OLE 포함)에서 **손대지 않은 부품의 내용 손실**이나 SmartArt 표시 오류가 나온다.
- 요금제 CPU 한도 때문에 별도 Worker에서도 편집 1회가 **CPU 한도를 넘는다** (예: Free 10 ms가 실제로 적용됨). 이때는 포크(차트 읽기 전용)나 JSZip 텍스트 교체처럼 가벼운 경로로 바꾼다.
- 별도 Worker로도 **번들 한도**(gzip 3 MiB 등)에 걸린다.
- 단일 저자 프로젝트의 **API 파손**: 메이저 버전이 바뀌면서 이번에 쓴 함수(`setPresentationRunText`, `updateChartSeriesValues`, `setChartTitle`, `duplicateSlide`, `PptxHandler.load/save`)가 깨진다. 그래서 버전을 고정(`5.0.0` / `2.x` 정확한 버전)해야 한다.

## 파일럿 산출물 (`files/people-os/pptx-edit-pilot/`)

- `package.json`, `package-lock.json`, `node_modules/` (파일럿 전용), `wrangler.toml`(lab, 이름 `people-os-pptx-pilot`), `wrangler.minimal.toml`(번들 기준선)
- `src/deck.js`(시험 덱), `src/lab.js`(라우트·편집·검증), `src/limits.js`(한계 탐색), `src/replace.js`, `src/minimal.js`
- `scripts/01-make-deck.mjs`: Node 실행이 막혀 **쓰지 않음** (같은 내용이 `src/deck.js`에 있음, 지워도 됨)
- `out/`: `test-deck.pptx`, `edited-local.pptx`, `edited-remote.pptx`, `replaced-*.pptx`, `selftest-local.json`, `selftest-remote.json`, `limits-local.json`, `limits-remote.json`, `dryrun-*/`
- `.wrangler-state/`: 로컬 dev 상태 (지워도 됨)

## 승인 대기로 막힌 것 (Merlin 보고)

- `npm view <pkg>`: 레지스트리 메타데이터를 읽지 못함 (설치된 버전으로 대체).
- `node <스크립트>`: Node 단독 실행 불가 (workerd에서 대체 검증).
- `find / … -name "*.pptx"`: 실제 회사 덱을 찾지 못함 (SmartArt 실물 시험 못 함).
- WebFetch (christophervr.github.io 문서 2쪽): 거부됨.
- 그 밖에 `wrangler dev --local`, `cf-wrangler.py deploy/--dry-run/tail/delete`, 로컬 curl은 모두 실행됐다.
