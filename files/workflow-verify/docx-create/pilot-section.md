## 1단계: 파일럿 (`files/people-os/docx-create-pilot/`)

### 1. 설치 — 통과
- `npm install --prefix docx-create-pilot --save-exact docx` → **docx 9.16.0** (조사 당시 9.15.3보다 새 버전, MIT). 4초, 패키지 5개(docx, fflate 0.8.3, nanoid 6, @types/node 26, undici-types), 경고 없음.
- 설치 크기: `node_modules` **24 MB** (docx 자체 20 MB — dist에 cjs/mjs/umd/iife × 10개 서브패스. 번들에 들어가는 것은 `dist/index.mjs` 1.0 MB 하나). `index.mjs`는 **import가 하나도 없는** 자체 완결 ESM이다 (fs·Buffer·node: 내장 모듈 없음).
- `npm --version`은 승인 대기로 막혔다 (아래 "승인 대기" 참고). 버전은 설치된 package.json 기준이다.

### 2. 시험 문서 — 통과
`src/core.js`의 `createDocx(def)` → `Packer.toArrayBuffer()`. 시험 정의(`src/lab.js` TEST_DEF): 제목(Title) + 부제, Heading 1 × 3, Heading 2 × 2, 굵게·기울임이 섞인 문단(`**…**`, `*…*`), 특수문자 `<태그> & "따옴표"`, 글머리 3, 번호 3, 두 번째 번호 목록 2(1부터 다시), 표(헤더 + 3행, 머리글 행 반복·음영), 2장 앞 페이지 나누기. 결과 10,741 B.

### 3. 저장 뒤 검증 — 통과 (15/15, 로컬·원격 같음)
ZIP을 풀어 `word/document.xml`·`numbering.xml`을 직접 읽는 자체 리더(`readDocx`, `numFormats`)로 확인했다.

| 검사 | 결과 |
|---|---|
| 부품: document·styles·numbering·[Content_Types]·rels (전체 17개) | ✅ |
| 제목 Title 스타일 / Heading1 3개 / Heading2 2개 (문구 일치) | ✅ (styles.xml에 Title·Heading1~6·ListParagraph 정의 있음) |
| 문단 굵게·기울임 런 (`<w:b/>`, `<w:i/>`) | ✅ |
| 특수문자 이스케이프 후 원문 그대로 | ✅ |
| 글머리 3개 numFmt bullet / 번호 3개 decimal, 같은 numId | ✅ |
| 두 번째 번호 목록은 다른 numId (1부터 다시) | ✅ |
| 표 1개, 헤더 + 3행, 셀 값 일치, `tblHeader` | ✅ |
| 페이지 나누기 (`<w:br w:type="page"/>`가 2장 제목 바로 앞) | ✅ |
| XML well-formed — 17부품 전부 | ✅ (xlsx 파일럿 검사기 + **XML 금지 제어문자 검사 추가**, 음성 시험 7종 모두 잡음) |

**발견 1건 (고침)**: 입력에 제어문자(`\u0001` 등)가 있으면 docx가 그대로 XML에 넣는다 → Word가 열지 못하는 파일이 된다. 정규화 단계에서 XML 1.0 금지 문자와 짝 없는 서로게이트를 지우게 했다 (탭·줄바꿈은 유지). 시험: `"앞\u0001뒤"` → "앞뒤", XML 검사 통과.

### 4. Workers 호환 — 통과
| 항목 | 결과 |
|---|---|
| 로컬 `npx wrangler dev --local` (포트 8791) | 모든 라우트 200 |
| 최소 Worker 번들 (`src/minimal.js`, nodejs_compat 없음) | **487.49 KiB / gzip 107.12 KiB** |
| 시험 Worker 번들 (`src/lab.js`) | 549.90 KiB / gzip 123.11 KiB |
| 원격 `people-os-docx-pilot` | 배포 성공, Startup 12 ms, 버전 `75cbe680-…` → `b67c44c9-fce2-46c2-8244-fb68bf1ded30` |
| 원격 selftest | 15/15 (`out/selftest-remote.json`), limits 출력이 로컬과 `cmp` 동일 |
| 삭제 | `cf-wrangler.py delete --name people-os-docx-pilot --force` → "Successfully deleted" ✅ |

`nodejs_compat` 없이 돈다 (docx는 Buffer 없이 `toArrayBuffer`만 쓴다).

### 5. CPU (원격 tail, `evidence/tail-pilot-summary.json`)
| 요청 | cpuTime | wall |
|---|---|---|
| 시험 문서 생성 (/make) | **44 / 58 ms** | 47 / 64 ms |
| 생성 + 다시 읽기 + XML 검사 (/selftest) | 94 (콜드) / 146 ms | 99 / 152 ms |
| 50섹션·510블록·표 셀 630 | 190–265 ms | 233–310 ms |
| **상한 가까운 문서: 1,910블록(상한 2,000), 26 KB** | **281 ms** | 327 ms |

모두 outcome ok, exceptions 0.

### 6. 배치 결정 — **People OS 본체 Worker**
- 근거: 최소 번들 gzip 107 KiB. 실제 본체에 넣고 잰 증가분은 8,428.92 → 8,965.67 KiB / gzip **1,731.04 → 1,849.27 KiB (+118 KiB)**. 엑셀 통합 때 편집 Worker 증가분(+144 KiB)보다 작고, pptxgenjs가 이미 본체에 있는 것과 같은 성격(새 문서 생성)이다.
- CPU가 상한 문서에서도 0.3초 미만이라 편집 Worker로 떼어 낼 이유(격리)가 없다. 서비스 바인딩 왕복과 RPC 직렬화도 생긴다.
- 그래서 편집 Worker(`people-os-pptx-editor`)는 이번에 손대지 않았고, 배포도 People OS 하나만 했다.
