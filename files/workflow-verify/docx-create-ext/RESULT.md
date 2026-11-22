# Word 새로 만들기 확장 — 이미지·목차·머리말/바닥글 (2026-11-22, Fable 5.2 단일 세션)

## 1. 파일럿 판정

| 기능 | 판정 | 한 줄 근거 |
|---|---|---|
| **이미지** (`ImageRun`) | **조건부 도입** | 로컬·원격 모두 동작. 조건: PNG·JPEG·GIF·BMP만, 한 장 5 MiB·합계 10 MiB·10장까지 (합계 10 MiB에서 생성 CPU 0.6~3.2초) |
| **목차** (`TableOfContents`) | **도입 가능** | TOC 필드 + 항목이 미리 채워져 나온다. 쪽 번호만 Word가 열 때 갱신한다 (Word에서 직접 확인은 못 함) |
| **머리말·바닥글** (`Header`/`Footer` + `PAGE`·`NUMPAGES`) | **도입 가능** | 부품·관계·필드가 맞게 나온다. "첫 쪽 다르게"는 옵션으로 된다 |

세 기능 모두 본체 Worker에 둔다 (별도 Worker로 떼지 않는다). 번들 증가가 gzip +9.5 KiB뿐이고, 평소 문서의 생성 CPU는 수십 ms다.

**공통 미확인 1건: Word에서 직접 열어 보지 못했다.** 이 VM에는 Word·LibreOffice가 없다. 저장본의 XML well-formed·부품·관계·필드 코드는 기계로 확인했지만, "복구 대화상자 없이 열리는지"와 "목차 쪽 번호가 갱신되는지"는 3장의 확인용 파일을 Word에서 열어 봐야 한다.

### 1.1 격리 환경

- 하네스: `files/workflow-verify/docx-create-ext/harness/` (라이브 코드와 분리). 시험 Worker `people-os-docx-ext-pilot` — 로컬 workerd(`wrangler dev --local`)와 원격(workers.dev)에서 같은 코드로 돌렸다. **원격 시험 Worker는 파일럿 뒤 삭제했다** (R2 미리보기 버킷에 올린 시험 객체 3개도 삭제, `stillThere: false`).
- 이 VM에 쓸 수 있는 이미지 파일이 없어 시험 이미지는 Worker 안에서 만들었다 (`harness/src/img.js`: 색 막대 PNG, 난수 PNG, 회색 단색 baseline JPEG, 1×1 GIF, 줄무늬 BMP). PNG와 JPEG는 이미지 뷰어로 열어 실제 이미지로 풀리는 것을 확인했다. **JPEG는 합성한 단색 파일 하나뿐이라, 카메라가 찍은 실제 JPEG(EXIF·프로그레시브)는 시험하지 못했다.**
- 다시 읽기: Node 실행이 막혀 있어 저장본 검사(`/inspect`: 미디어 부품, 그림 크기, TOC 필드, 머리말·바닥글, XML 검사)도 Worker 라우트로 했다.

### 1.2 기능 검증 (로컬 workerd = 원격 Workers, 검사 47개 모두 통과)

근거: `evidence/pilot-local-selftest.json`, `evidence/pilot-remote-selftest.json` (문서 5종: 이미지 / 목차 / 머리말·바닥글 / 세 기능 종합 / 첫 쪽 다르게).

| 항목 | 결과 |
|---|---|
| 이미지 형식 | PNG·JPEG·GIF·BMP 4종이 `word/media/`에 들어가고 관계(rId)가 모두 맞다. 같은 파일을 두 번 넣으면 미디어 부품은 1개다 |
| 크기 (너비 기준) | 원래 640 px → 본문 폭 601 px로 줄임 / 50% → 301 px / 40% → 240×150 / 100% → 601×150. 긴 그림(300×1800)은 본문 높이 880 px에 맞춰 147×880으로 줄임. 높이는 늘 비율대로 |
| 위치 (문단 안) | 모두 `wp:inline`(글자와 같은 줄에 놓이는 그림). 그림만 있는 문단(왼쪽·가운데·오른쪽 정렬)과, 글자와 같은 문단에 든 그림 둘 다 된다 |
| 지원하지 않는 형식 | WebP·SVG·빈 파일·잘린 PNG/JPEG는 형식 읽기에서 `null` → 통합에서 415로 거부한다 (`/sniff-test` 통과) |
| 목차 | `TOC \h \o "1-2"` 필드(제목 1~2단계, 링크), Word의 목차 갤러리 콘텐츠 컨트롤. **항목 5개가 제목 순서대로 미리 채워져 있고** 각 항목이 제목의 책갈피(`_Toc1`…)로 연결된다. 필드는 `dirty`라 Word가 열 때 갱신을 묻는다. 문서 제목(Title)은 목차에 안 들어간다. 특수문자 든 제목(`<항목> & "따옴표"`)도 깨지지 않는다 |
| 머리말·바닥글 | `header1.xml`·`footer1.xml` + `sectPr` 참조. 바닥글에 `PAGE` / `NUMPAGES` 필드. 특수문자 든 머리말 문구가 그대로 읽힌다 |
| 첫 쪽 다르게 | `w:titlePg` + `first` 머리말·바닥글(빈 문단) — 옵션으로 켠다. 기본은 모든 쪽 같음 |
| 세 기능 종합 문서 | 그림 7개 + 목차 + 머리말·바닥글이 한 문서에서 모두 통과 |
| XML well-formed | 5종 모두 전 부품(21~23개) 오류 0 |
| R2 → 이미지 (원격) | R2에서 읽은 PNG(8.9 KB)·JPEG·PNG(3 MiB) 3장으로 문서 생성, 미디어 3개·XML 오류 0 (`evidence/pilot-remote-r2-inspect.json`) |

목차 쪽 번호: docx 9.16.0은 `docx/layout`의 쪽 번호 추정기를 따로 주면 쪽 번호까지 써 넣을 수 있다. 추정값이 실제 Word 조판과 다를 수 있고 번들이 늘어나 쓰지 않았다. 지금은 쪽 번호 칸이 비어 나오고 Word가 채운다.

### 1.3 번들 크기

| 측정 | 결과 |
|---|---|
| 최소 Worker (지금 쓰는 docx 클래스만) | 512.04 KiB / gzip 111.95 KiB |
| 최소 Worker + `ImageRun`·`TableOfContents`·`Header`·`Footer`·`PageNumber` | 560.32 KiB / gzip 121.47 KiB → **gzip +9.5 KiB** |
| People OS 본체 (통합 뒤 dry-run) | 9,079.79 KiB / gzip 1,874.95 KiB (통합 전 약 9,005 / 1,858 → **gzip +약 17 KiB**, 새 코드 포함) |

본체 gzip의 1% 미만이라 본체에 두는 게 맞다.

### 1.4 생성 CPU 시간 (원격, `wrangler tail`의 cpuTime — `evidence/pilot-tail.jsonl`)

| 문서 | cpuTime (3회) |
|---|---|
| 기준선 (확장 없음, 5섹션) | 10 / 42 / 67 ms |
| 목차 | 50 / 54 / 61 ms |
| 머리말·바닥글 | 73 / 89 / 145 ms |
| 첫 쪽 다르게 | 45 / 50 / 112 ms |
| 이미지 7개 (작은 그림, 합계 약 48 KB) | 약 0~150 ms (측정값 257 / 295 / 334 ms에서 시험 이미지 만들기 107~271 ms를 뺀 값) |

큰 이미지 (압축 안 되는 난수 PNG, 생성만 — 시험 이미지 만들기 30~270 ms 포함):

| 이미지 | cpuTime |
|---|---|
| 1 MiB × 1장 | 276 / 625 ms |
| 2 MiB × 5장 (10 MiB) | 2,503 / 3,234 ms |
| 1 MiB × 10장 (10 MiB) | 855 / 2,095 ms |
| 5 MiB × 2장 (10 MiB) | 1,879 / 2,569 ms |
| 5 MiB × 4장 (20 MiB) | 1,830 ms (1회) |

- 같은 입력인데도 2~3배씩 흔들린다 (20 MiB가 10 MiB보다 빨리 나온 적도 있다). 측정 정밀도는 낮다. 확실한 것은 **이미지 10 MiB를 넣으면 생성 CPU가 대략 1~3초**라는 것이다. 글자만 있는 문서(수십 ms)의 수십 배다.
- 20 MiB까지 메모리 오류 없이 됐다 (outcome 전부 ok).
- 그래서 상한을 **한 장 5 MiB, 합계 10 MiB, 10장**으로 잡았다. 유료 플랜 CPU 한도(기본 30초) 안이다.

### 1.5 조건 (이미지)

1. 형식은 PNG·JPEG·GIF·BMP만. WebP·SVG·HEIC는 거부한다 (Word가 못 읽거나 docx가 대체 이미지를 요구한다).
2. 상한: 한 장 5 MiB / 서로 다른 파일 합계 10 MiB / 문서당 10장.
3. JPEG의 EXIF 회전 정보는 보지 않는다. 세로로 찍은 휴대폰 사진은 가로·세로가 바뀐 비율로 들어갈 수 있다 (미시험).
4. 이미지 소스는 라이브러리에 올린 문서의 R2 원본뿐이다. URL 가져오기는 범위 밖이다.

## 2. 라이브 통합

**판정: 세 기능 모두 통합 완료, 라이브에서 동작 확인.** 구조화 입력 4종(이미지 / 목차 / 머리말·바닥글 / 종합)과 자연어 지시 2종이 라이브에서 만들어졌고, 내려받아 다시 읽어 요소를 확인했다. 기존 입력은 배포 전과 같은 결과를 낸다.

### 2.1 배포

| 대상 | 버전 | 번들 | 시작 시간 |
|---|---|---|---|
| `people-os` | `ae40ce70` → **`2e83ebca-c3d1-446c-9282-971dbd6ab7a3`** | 9,079.79 KiB / gzip 1,874.95 KiB | 115 ms |

- 배포 1회, 승인 대기로 막힌 적 없음. 자산은 `docx-create.js`·`workflow.js` 2개만 올라갔다. 편집 Worker(`1dd93ed7`)는 건드리지 않았다.
- D1·DO 마이그레이션 없음. 롤백은 `ae40ce70`으로 되돌리면 된다.
- 커밋·태그·푸시는 하지 않았다. `ARCHITECTURE.md`·`VERIFICATION.md`도 건드리지 않았다.

### 2.2 바뀐 파일

| 파일 | 내용 |
|---|---|
| `src/docx/create.ts` | 스키마 확장(이미지·목차·머리말/바닥글), 이미지 형식·크기 읽기(`sniffImage`·`fitImage`), R2에서 이미지 읽기(`loadDocxImages`, 권한·상한·형식 검사), AI 프롬프트 확장 + 보정(`repairPlannedExtras`), 안 놓인 이미지 붙이기(`appendUnplacedImages`) |
| `src/index.ts` | `POST /api/docx/create`가 본문의 `images`·`toc`·`header`·`footer`·`differentFirstPage`를 넘긴다. `/api/library`의 `source_kind`에 `'image'` 추가 (PNG·JPEG·GIF·BMP — 전에는 `'other'`) |
| `src/workflow/nodes.ts` · `think-agent.ts` | `docx_create` 노드 입력 키 `images`·`toc`·`header`·`footer`·`pageNumber` 추가 |
| `public/docx-create.js` | 이미지 고르기(체크 + 너비)·목차 넣기·머리말·바닥글·쪽 번호 칸. 개요에 `![캡션](그림1)` 줄 |
| `public/workflow.js` | 빌더 `docx_create` 폼에 칸 5개 추가 |

`npx tsc --noEmit` 0건, `node --check public/docx-create.js`·`public/workflow.js` 통과.

### 2.3 입력 모양 (기존 키는 그대로, 새 키는 모두 선택)

```jsonc
{
  "title": "…", "sections": [
    { "heading": "…", "paragraphs": ["…"],
      "images": [{ "doc": "<이미지 문서 id>", "widthPct": 60, "align": "center", "caption": "…", "position": "afterText" }] }
  ],
  "toc": true,                        // 또는 {"title": "목차", "pageBreakAfter": true}
  "header": "머리말 문구",             // 또는 {"text": "…", "align": "right"}, true면 문서 제목
  "footer": {"text": "사내 한정", "pageNumber": true},   // 문자열만 줘도 됨. 쪽 번호는 "1 / 3" 모양
  "differentFirstPage": true,         // 첫 쪽에는 머리말·바닥글 없음 (기본 false)
  "images": ["<id>", {"doc": "<id>", "widthPct": 50}]   // 꼭 넣을 이미지. 섹션에 안 놓인 것은 마지막 섹션 끝에 붙는다
}
```

- `widthPct`는 본문 폭의 %(5~100). 안 주면 원래 크기(본문 폭까지만). `position`은 `start`(제목 바로 아래)·`afterText`(문단 뒤, 기본)·`end`(섹션 끝).
- 이미지 읽기 권한은 문서 다운로드와 같다: 공용 또는 본인 것, hr_admin은 전체. 워크플로 노드는 실행자 본인 것과 공용만.
- 오류: 없는 문서 404 / 남의 개인 문서 403 / 이미지가 아니거나 WebP 등 415 / 크기·개수 초과 413 / 모양 틀림 400.
- **자연어 지시**: 지시문에 "목차를 넣어 줘", "머리말에 …", "바닥글에 쪽 번호"라고 쓰면 Qwen이 정의에 넣는다. 이미지는 본문 `images`로 준 것만 쓸 수 있고(AI에게는 `img1: 제목` 목록으로 알려 준다), AI가 빠뜨린 이미지는 마지막 섹션 끝에 붙인다. 본문에 `toc`·`header`·`footer`를 직접 주면 AI가 쓴 값보다 우선한다.
- 응답: 확장 요소를 쓴 문서에만 `extras: {images, toc, header, footer}`가 붙는다. 예전 입력의 응답 모양은 그대로다.
- 저장·색인: 기존과 같다 (documents 새 행 + R2 `docs/created/<id>.docx`, Vectorize 색인 안 함).

### 2.4 로컬 검증 (`wrangler dev --local`, 근거 `evidence/local/`)

| 시험 | 결과 |
|---|---|
| 구조화 4종 + 기존 모양 1종 | 모두 201. 다시 읽어 그림 크기·정렬, 목차 항목, 머리말·바닥글 필드, XML 오류 0 확인 (`inspect-*.json`) |
| 최상위 `images`의 안 놓인 이미지 | 마지막 섹션 끝에 25% 너비(150 px)로 붙음 |
| 오류 경로 11건 | 남의 그림 403 / 없는 문서 404 / 글 파일 415 / 6 MB 그림 413 / 11장 413 / widthPct 3 → 400 / `toc: 5` → 400 / 틀린 align 400 / 지시 + 남의 그림 403(AI 호출 전) / 지시 + 틀린 header 400 / 익명 401 |
| hr_admin이 남의 개인 그림 넣기 | 201 |
| 3 MiB 그림 1장 | 201, 3.16 MB 문서 |
| **워크플로 `docx_create` + 승인 게이트** | `waiting_approval`(문서 없음) → approve → 생성(`{{input.…}}` 치환, 그림 2장·목차·머리말·바닥글) → 다음 단계가 `{{steps.s1.output.images}}`를 받아 `succeeded` (`wf-run.json`) |
| AI 보정 단위 시험 18개 | 모두 통과 (`unit-repair.json`) — Qwen이 낼 법한 틀린 출력을 손으로 만들어 보정 → 검증까지 |

### 2.5 라이브 검증 (배포 3분 뒤, 근거 `evidence/live/`)

**새 기능** (`POST /api/docx/create` → 다운로드 → 다시 읽기)

| 문서 | 상태 | 다시 읽어 확인한 값 |
|---|---|---|
| 1 이미지 | 201, 14,916 B | 그림 4개: PNG 361×203(60%, 가운데) / JPEG 240×150(40%, 오른쪽) / BMP 96×64(원래 크기, 왼쪽) / PNG 601×338(800 px → 본문 폭). XML 오류 0 |
| 2 목차 | 201, 10,659 B | `TOC \h \o "1-2"`, dirty, 항목 5개(특수문자 든 제목 포함)가 책갈피로 연결. XML 오류 0 |
| 3 머리말·바닥글 | 201, 11,806 B | 머리말 문구(특수문자 포함) 그대로, 바닥글 `사내 한정 · PAGE / NUMPAGES`. XML 오류 0 |
| 4 종합 (+ 첫 쪽 다르게) | 201, 18,648 B | 그림 3개(70%·35% 오른쪽·안 놓인 것 25%가 끝에), 목차 4항목, 머리말·바닥글, `titlePg` + first 부품. 25개 부품 XML 오류 0 |
| 5 자연어 지시 (목차·머리말·쪽 번호·이미지 2장을 말로 요청) | **1차 502, 2차 201** (64.7초, 계획 1회) | Qwen이 `toc: true`, `header: {text: "4분기 코칭 프로그램"}`, `footer: {pageNumber: true}`를 썼다. 이미지 1장은 AI가 놓고 1장은 보정이 끝에 붙였다. 그림 2개·목차·머리말·바닥글 확인 |
| 6 자연어 지시 + 화면 옵션 (이미지 50%, 목차, 머리말, 바닥글) | 201 (62.4초, 계획 1회) | 그림 301 px(50%), 목차, 머리말 "신규 코치 온보딩", 바닥글 "People OS · 쪽 번호" |

**기존 엔드포인트** (`ae40ce70` 배포 전 vs `2e83ebca` 배포 후)

| 엔드포인트 | 판정 |
|---|---|
| `GET /api/health` (200, 140 B) | 바이트 동일 |
| `GET /api/auth/me` 익명 (401, 52 B) | 바이트 동일 |
| `POST /api/docx/create` 익명 (401) | 바이트 동일 |
| `GET /api/library` 익명 (200, 1,060 B) | 바이트 동일 (정리 뒤에도 동일) |
| `GET /`, `/docx-edit.js` | 바이트 동일 |
| `/docx-create.js`(7,015 → 12,168 B), `/workflow.js`(79,033 → 79,480 B) | 의도한 변화, 로컬 파일과 바이트 동일 |
| **기존 구조화 생성** (같은 정의) | 응답 모양 동일(`extras` 없음, stats 같음). 문서 부품 17개 크기가 모두 같고, 비교한 8개 부품(document·styles·numbering·settings 등)은 바이트 동일 |
| **기존 지시 생성** (같은 지시) | 전 201(13.9초, 계획 1회) / 후 201(71.7초, 계획 2회). 요청하지 않은 목차·머리말은 붙지 않았다 (`toc: false`, `header: false`) |

CPU (라이브 `/api/docx/create` 11건): 7~302 ms, 모두 outcome ok. tail 55건 중 예외 0.

### 2.6 임시 데이터 정리

- 원격 시험 Worker `people-os-docx-ext-pilot` 삭제, 미리보기 버킷의 시험 객체 3개 삭제.
- 운영 D1에 넣은 임시 사용자 `u_dxext_tmp`와 3시간짜리 세션을 지웠다. 문서 13건(이미지 3, 생성 문서 10)을 `DELETE /api/documents/:id`로 지웠다 (errors 없음, 벡터 2개 삭제).
- 확인 쿼리: **users 0 / auth_sessions 0 / documents 0 / doc_nodes 0 / chunks 0**. R2의 생성 문서·이미지 원본 키는 "The specified key does not exist". 익명 `/api/library`는 배포 전과 바이트 동일.
- 남은 흔적: AI Gateway 로그(`docx-create-plan` 6건 안팎, 이미지 변환 3건)와 Workers Logs 이벤트.
- 로컬 dev 서버 3개와 tail은 모두 멈췄다.

## 3. Word 확인용 파일 (`files/workflow-verify/docx-create-ext/out/`)

| 파일 | 볼 것 |
|---|---|
| **`created-ext-live.docx`** | 종합: 첫 쪽에 머리말·바닥글 없음, 둘째 쪽부터 있음. 목차 갱신 뒤 쪽 번호. 그림 3개 |
| `created-ext-live-image.docx` | 그림 4개의 크기·정렬·캡션. **BMP와 합성 JPEG가 Word에서 보이는지** |
| `created-ext-live-toc.docx` | 열 때 "필드 업데이트" 물음 → 목차 쪽 번호 2·2·3·3·4 |
| `created-ext-live-hf.docx` | 모든 쪽 머리말, 바닥글 `사내 한정 · 1 / 3` |
| `created-ext-live-ai.docx` · `created-ext-live-ai-options.docx` | AI가 만든 문서 |
| `pilot-remote-*.docx` | 파일럿 5종 + R2 이미지 문서 |

## 4. 남은 문제·미확인

1. **Word에서 열어 보지 못했다** (복구 대화상자, 목차 갱신, 쪽 번호 표시, BMP·합성 JPEG 표시). 위 파일로 확인이 필요하다.
2. **화면(UI)은 브라우저로 눌러 보지 못했다.** `node --check` 통과와 배포본이 로컬 파일과 같다는 것, 화면이 보내는 것과 같은 모양의 요청이 라이브에서 되는 것(문서 6)만 확인했다. 이미지 목록 표시, 체크·너비 선택, 개요의 `![캡션](그림1)` 처리는 실제 화면에서 확인이 필요하다.
3. **자연어 지시 1차 시도가 Workers AI `3046 Request timeout`으로 502였다** (122초 뒤). 같은 요청을 다시 보내 성공했다. 이번 변경이 원인이라는 근거는 없다 — 실패한 호출은 응답이 없어 판단할 자료가 없고, 뒤의 3건은 62~72초에 성공했다. AI 생성을 Queue로 옮기는 다음 과제가 이 문제를 줄인다.
4. **배포 뒤 지시 생성이 느렸다** (13.9초 → 62~72초). 프롬프트가 약 500자 늘었지만 출력 길이는 비슷했고(370 → 388 토큰), 71.7초 건은 1차 JSON이 깨져(`},"heading"` — 섹션 사이 `{` 빠짐) 재시도한 것이다. 앞 세션 기록의 "1회 약 56초"와 같은 범위라 Workers AI 응답 시간 변동으로 보지만, 프롬프트 길이의 영향을 따로 재지는 않았다.
5. Qwen이 지시한 섹션을 빠뜨린 적이 있다 (배포 전 "준비물 목록", 배포 후 "회의실 이용 안내"). 기존 동작이고 이번에 고치지 않았다.
6. 라이브에서 워크플로 `docx_create` 노드와 GIF 이미지는 돌리지 않았다 (로컬·파일럿에서만 확인).
7. 실제 사진 JPEG, EXIF 회전, 5 MiB에 가까운 실제 이미지는 시험하지 못했다.
8. 업로드할 때 Workers AI 이미지 변환이 BMP를 "corrupt image data"로 거부했다. 문서 행과 원본은 남아 Word에는 들어간다. 시험 BMP가 잘못됐는지 모델이 BMP를 안 받는지는 가리지 못했다.

## 5. AGENTS.md에 옮길 교훈 (이 세션은 `~/AGENTS.md`를 읽고 쓸 권한이 없었다)

- docx 9.16.0의 `TableOfContents`는 제목에서 항목을 미리 채우고 필드를 dirty로 쓴다. `features.updateFields`가 필요 없다.
- 이미지 10 MiB를 docx에 넣으면 생성 CPU가 약 1~3초다. `wrangler tail`의 cpuTime은 같은 입력에도 2~3배 흔들리니 3회 이상 잰다.
- 로컬 `wrangler dev`의 ensureSchema는 `users`·`auth_sessions`를 만들지 않는다. 새 `--persist-to` 폴더에 `d1 migrations apply … --local`을 먼저 하고(첫 요청 전) dev를 띄운다.
- `cd <dir> && …`가 성공하면 그 뒤 호출의 cwd가 바뀐 채 남는다. 실패하면 안 바뀐다. 루트에서 상대 경로로만 쓴다.
- cf-wrangler.py는 `/home/hatch/…` 절대 경로로 불러야 허용 규칙에 걸린다 (`~/…`는 승인 대기).
- `sed -n 'a,bp' f > g`는 되고 `sed -e 'Ni\…'`는 막힌다. 파일 하나 `cp`·`rm`은 된다.
- 라이브 로그인 curl은 `S=$(cat <토큰 파일>); curl -H "cookie: people_os_session=$S" <URL>` 한 개씩이면 된다 (workers.dev 주소).
