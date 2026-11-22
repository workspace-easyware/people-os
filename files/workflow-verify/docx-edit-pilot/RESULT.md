# Word 기존 .docx 편집 — 파일럿 결과 (2026-11-22, Fable 5.2)

## 판정: 조건부 도입 가능 — ooxml-core 2.0.0의 docx 영역 (후보 ①)

기존 .docx의 글자 치환(문단·표 셀·머리글), 문단 넣기·지우기가 로컬 workerd와 원격 Workers에서 모두 동작한다. 검사 44개(Word 모양 문서 26 + docx 라이브러리 문서 18)가 로컬·원격에서 전부 통과했다.

조건 3개:

1. **편집 Worker(`people-os-doc-editor`)에 붙인다. 본체에는 넣지 않는다.** 단독 최소 경로가 gzip 473 KiB로, 본체에 넣으면 docx 생성(+118 KiB)의 4배다. 편집 Worker는 이미 ooxml-core를 싣고 있어 증가분이 더 작다 (통합 뒤 실측은 `../docx-edit/RESULT.md`).
2. **문단 5,000개 상한.** 문단 5,200개 문서의 편집 1회가 CPU 약 4.7초였다 (XLSX 셀 상한 20만 개의 약 4초와 같은 수준). 비용 대부분이 읽기라서 op 수와는 거의 무관하다.
3. **Word에서 직접 열어 보는 확인은 하지 못했다.** 이 VM에는 Word·LibreOffice가 없다. 통합 뒤 라이브 편집본 `out/edited-live.docx`를 사람이 Word에서 열어 복구 대화상자가 뜨지 않는지 봐야 한다. 근거는 지금 "다시 읽힘 + 모든 부품 XML well-formed + 손대지 않은 부분 바이트 동일"까지다.

## 후보 비교

| 후보 | 결과 |
|---|---|
| ① **ooxml-core 2.0.0 `ooxml-core/docx`** (PPTX 편집에 쓰는 그 라이브러리) | **채택.** `loadDocx` → 모델(문단·run·표) 수정 → `save`. 저장이 원본 XML을 고친 곳만 덧대는 방식이라 손대지 않은 문단·부품이 바이트 그대로다. |
| ② docx 9.16 `patchDocument` | **맞지 않음.** workerd에서 돌기는 하지만 `{{자리표시자}}`만 바꾼다 (일반 글자 치환 API 없음). 자리표시자가 하나도 없어도 부품 5개(document·comments·header·footer·app.xml)를 다시 써서 바이트가 달라진다 (`out/patcher-local.json`). |
| ③ JSZip + XML 수작업 | **불필요.** ①이 run 경계에 걸친 글자·추적·필드를 이미 모델로 다룬다. |

## 근거

### 손대지 않으면 바이트가 같다
- 읽고 아무것도 안 고친 채 저장하면 입력과 **파일 전체가 바이트 동일**하다 (두 시험 문서 모두, `/explore`).
- 제목 문단에 글자 5자를 덧붙였을 때 `word/document.xml`은 정확히 5자만 늘었고 나머지 11개 부품은 바이트 동일했다.

### 편집 검사 (로컬 = 원격, `out/selftest-*-{local,remote}.json`)
시험 문서 2종 (`src/samples.js`):
- **Word 모양 문서** (`out/test-wordlike.docx`): Word가 저장한 파일의 구조를 손으로 흉내 냈다 — run 3개로 쪼개진 이름(rsid·proofErr·서식 경계), 책갈피, 하이퍼링크, DATE 필드, 탭·줄바꿈, 변경 내용 추적(w:ins/w:del), 메모, 머리글·바닥글(PAGE 필드), 가로 병합 셀, 문단 2개인 셀.
- **docx 라이브러리 문서** (`out/test-lib.docx`): People OS "새 Word 문서 만들기"가 쓰는 docx 9.16.0으로 만들었다 (제목·굵은 run·표·글머리·머리글).

| 검사 | 결과 |
|---|---|
| run 3개에 걸친 "홍길동" → "김철수" (굵게 유지) | ✅ |
| 표 셀(병합 셀 포함)·머리글의 같은 글자도 교체 (`all: true`) / 처음 1곳만 (`all` 없음) | ✅ |
| 문단 글 전체 교체, 표 셀 교체 (글자색·정렬 유지, 셀의 둘째 문단 제거) | ✅ |
| 문단 넣기 (글머리 문단 뒤면 글머리를 물려받음, 맨 앞 넣기) · 문단 지우기 | ✅ |
| 메모 범위·책갈피·하이퍼링크·필드·탭·줄바꿈 유지 | ✅ |
| 삽입 추적(w:ins) 안 글자 교체 + w:ins 유지, 삭제 추적(w:del) 그대로 | ✅ |
| 특수문자 이스케이프 (`&` `<` `>`), XML 금지 제어문자·짝 없는 서로게이트 제거 | ✅ |
| **대조군 문단 XML 바이트 동일**, sectPr 바이트 동일, 바닥글 부품 바이트 동일 | ✅ |
| 바뀐 부품은 `word/document.xml`과 머리글뿐 (Word 모양 문서: 12개 중 10개 동일, 라이브러리 문서: 21개 중 19개 동일) | ✅ |
| 모든 부품 XML well-formed, 저장본 다시 읽힘, 원본 입력 bytes 그대로 | ✅ |

오류·상한 23종도 로컬·원격 응답이 바이트 동일하다 (`out/limits-{local,remote}.json`): 없는 문단·표·셀 not_found, 못 찾는 글자 not_found, 삭제 추적·필드 결과 안의 글자는 찾지 않음, 표 안 문단 지우기·넣기 거부, 마지막 문단 지우기 거부, ops 101개·글자 10,001자·문단 수·본문 크기·파일 크기 limit, ZIP 아님·빈 파일·docx 아닌 ZIP bad_input.

### 번들 크기 (`cf-wrangler.py deploy --dry-run`)
| 대상 | 크기 |
|---|---|
| 최소 Worker (`src/minimal.js`: loadDocx + save, nodejs_compat 없음) | **2,067 KiB / gzip 473 KiB** |
| 시험 Worker (`src/lab.js`, docx 9.16 포함) | 2,761 KiB / gzip 627 KiB |
| 편집 Worker 통합 전 (기준) | 10,014 KiB / gzip 2,463 KiB |
| 편집 Worker 통합 후 (배포 `1dd93ed7`) | 11,765 KiB / gzip 2,868 KiB (**+405 KiB**) |

### CPU (원격 `wrangler tail`, `out/tail-pilot-summary.json`)
| 요청 | cpuTime |
|---|---|
| 읽기 + 요약 (문단 17개) | 33 ms |
| **편집 1회** (문단 17개, replace 1개 — 읽기·저장·다시 읽기·검사 포함) | **133 ms** |
| ops 8개 편집 2회 + 검사 26개 | 283 ms |
| 문단 1,040개, 1,000곳 교체 | 1,235 ms |
| 문단 5,200개, 5,000곳 교체 (상한을 올려 시험) | 4,758 ms |
| 문단 5,200개, 1곳 수정 | 4,385 ms |

모두 outcome ok. 원격 배포 `people-os-docx-edit-pilot` 버전 `03c7605d`, Startup 66 ms. 시험 뒤 삭제했다 ("Successfully deleted").

## 알아 둘 동작

- **출력은 ZIP 시각만 빼고 결정적이다.** 같은 입력·ops의 두 저장본은 바뀐 부품의 ZIP 수정 시각 4바이트만 다르다 (부품 내용은 같다). xlvane과 달리 파일 전체 `cmp`는 회귀 시험에 못 쓴다 — 부품 단위로 비교한다.
- **글자를 고친 문단은 그 문단만 다시 쓴다.** 이때 run의 `w:rsidR` 속성 위치가 바뀌고, 메모 참조 표시 run의 글자 스타일(`CommentReference`)이 빠진다. 보이는 내용에는 영향이 없다.
- **중첩 표(표 안의 표)는 읽기 전용이다** (ooxml-core 모델). 문단 번호에도 들어가지 않는다.
- 삭제로 추적된 글자, 필드 결과, 그림, 수식, 각주 표시는 찾지도 고치지도 않는다.
- 서명된 문서는 고치면 서명이 없어진다 (ooxml-core 문서 기준, 시험하지 않음 — 결과에 `signatureRemoved` 경고를 싣는다).

## 미확인

- Word에서 직접 열기 (위 조건 3).
- 실제 Word가 저장한 회사 문서 (각주·목차·콘텐츠 컨트롤·SmartArt·텍스트 상자 포함). 시험 문서는 Word 구조를 손으로 흉내 낸 것이다.

## 산출물

- 하네스: `src/core.js`(편집 코어 — 통합 때 `pptx-editor/src/docx.js`로 옮김), `src/lab.js`(시험 라우트), `src/samples.js`(시험 문서), `src/minimal.js`, `wrangler.toml`, `wrangler.minimal.toml`. ooxml-core는 따로 설치하지 않고 `pptx-editor/node_modules`의 2.0.0을 alias로 가리킨다.
- 결과: `out/test-*.docx`, `out/edited-local-*.docx`, `out/edited-remote-wordlike.docx`, `out/big-{1000,5000}.docx`, `out/selftest-*.json`, `out/limits-*.json`, `out/patcher-local.json`, `out/tail-pilot.jsonl`, `out/tail-pilot-summary.json`, `out/dryrun-*/`.
- 지워도 되는 것: `state/`, `dev.log`, `out/dump-wordlike.json`, `out/edited-local-wordlike-2.docx`.
