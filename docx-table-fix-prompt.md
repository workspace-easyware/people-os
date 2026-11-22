# 워드 표 고치기 — 열 너비 버그 + AI 자리표시자 내용 (파일럿·라이브)

## 목표

사용자가 Word에서 확인한 워드 생성본의 표 문제 2건을 고친다. 둘 다 실제 결함이다 (Merlin이 `.docx` XML을 직접 뜯어 확인함).

## 진단 (확인된 사실 — 검증할 것, 그대로 믿지 말 것)

### 1. 열 너비 버그 — `src/docx/create.ts`와 파일럿 `docx-create-pilot/src/core.js` 공통
- 표의 각 열에 `width: { size: 5000, type: WidthType.PERCENTAGE }`를 준다. docx에서 PERCENTAGE size는 1%의 1/50 단위라 **5000 = 열 하나당 100%**다.
- 생성된 파일에서 확인된 결과: `tblW pct 250000`(=5000%), gridCol 너비 7518658(3열)·11282500(2열), **모든 열이 같은 너비**. Word가 클램프해서 열리긴 하지만, 좁은 열(요일, 한 글자)과 긴 텍스트 열(할 일)이 같은 너비로 나와 어색하게 보인다. 3열짜리 첫 파일 표는 열 길이가 비슷해서 티가 안 났고, 2열짜리 AI 파일에서 티가 났다.
- 고칠 방향: **내용에 맞는 열 너비** — 각 열의 최대 셀 텍스트 길이(헤더 + 셀)를 재서 열 너비를 비례 배분하고, 전체가 표 너비 100%가 되게 한다 (최소·최대 클램프 포함). 또는 열 너비를 아예 주지 않고 Word 자동 맞춤(tblLayout autofit)에 맡기는 방법도 있다. **두 방법 중 파일럿에서 렌더링이 더 나은 쪽을 골라라.** 검증은 XML로 한다: `tblW pct 5000`, gridCol이 내용 비례, 터무니없는 값 없음. 파일럿 `core.js`와 라이브 `src/docx/create.ts` 둘 다 고치고, 파일럿 selftest 15/15를 다시 통과시킬 것.

### 2. AI 자리표시자 내용 — `docx-create-pilot/out/created-live-ai-2.docx`
- 표 4행 × 3열이 전부 **"(작성 필요)"**이다. Qwen이 내용을 안 쓰고 자리표시자로 채웠다. 계획 프롬프트가 자리표시자를 금지하지 않았고, 검증도 잡지 못했다.
- 고칠 방향 2가지, 둘 다 한다:
  a. **계획 프롬프트**: "(작성 필요)", "TBD", "작성 필요", "추후 작성", "예시" 같은 자리표시자 문구를 쓰지 말고 구체적인 값을 쓰라고 명시한다. 지시에 데이터가 없으면 표 셀을 자리표시자로 채우지 말고, 그 내용을 문단 텍스트로 풀어 쓰거나(예: "코치별 세션 수는 지시에 없어 표에 넣지 않았습니다") 해당 표를 빼라고 시킨다.
  b. **검증 (`planDocxDef`)**: 표 셀의 절반 이상이 자리표시자 패턴이거나 헤더 셀이 자리표시자면 계획 실패로 보고, 기존 1회 재시도를 쓴다. 재시도까지 자리표시자면 자리표시자로 채운 문서를 만들지 말고 한국어 오류를 반환한다 ("AI가 표 내용을 채우지 못했습니다. 지시에 구체적인 값을 넣어 다시 시도해 주세요" 취지).

## 작업 범위

1. 위 1·2를 고친다. 범위 밖: 이미지·목차·차트·머리말/바닥글, 기존 .docx 편집, 생성본 Vectorize 색인.
2. **재생성**: 고친 뒤 같은 지시로 다시 만든다 — 구조화 정의(`evidence/def-live.json`과 같은 정의), AI 지시 2건(온보딩, 분기 보고서 — 라이브 스모크 때 쓴 지시와 같은 것). 새 파일은 **`docx-create-pilot/out/created-live-fixed.docx`(구조화), `created-live-ai-fixed.docx`, `created-live-ai-2-fixed.docx`**로 남긴다 (사용자가 Word에서 열어 비교용). 파일럿 `/verify` 리더 + XML 검사로 확인한다: 표 너비·gridCol 비례·자리표시자 셀 0개.
3. 결과 파일: `files/workflow-verify/docx-table-fix/RESULT.md` — 고친 내용, 전후 비교(XML 수치 포함), 검증 결과, 남은 한계. 근거는 `files/workflow-verify/docx-table-fix/evidence/`에 둔다.

## 검증 (docx 생성 통합과 같은 기준)

- `npx tsc --noEmit` 오류 0 + 바뀐 `public/*.js` `node --check` 0 (public을 안 건드리면 해당 없음).
- 로컬: `wrangler dev --local`로 끝까지 돌린다 (생성 → 다운로드 → 다시 열어 구조 확인).
- 원격: 배포는 직렬로, 한 번에 하나씩 (People OS만 — 편집 Worker는 건드리지 않는다). 배포 뒤 스모크는 **3분 뒤**에 한다 (배포 직후 약 2분은 옛 버전이 응답한다).
- 라이브 스모크: 기존 엔드포인트가 의도한 변화 외에는 바이트 동일인지 확인한다 (docx 생성 통합 스모크 방식).
- `wrangler tail`로 생성 1회의 cpuTime을 재고 결과 파일에 적는다.
- 라이브 스모크에 임시 계정이 필요하면 docx 생성 통합 방식(임시 사용자 + 1시간 세션, 끝나면 사용자·세션·시험 파일 전부 삭제하고 확인 쿼리 결과를 결과 파일에 적는다)을 따른다.

## 작업 규칙 (이 VM 세션의 승인 한계)

- 명령이 "This command requires approval"로 막히면 우회하지 말고 그 자리에서 멈추고 결과 파일 + 최종 보고에 적는다 (Merlin에게 보고).
- `node <스크립트>`가 막히면 실험은 `wrangler dev` 라우트로 돌린다 (PPTX·엑셀·워드 파일럿 선례).
- 로컬 curl은 `curl -s --noproxy '*' "http://localhost:<port>/…"` 형태, URL은 매번 직접 쓴다.
- 커밋·태그는 Merlin이 한다.
- 참고 파일: `files/workflow-verify/docx-create/RESULT.md` (생성 통합 전체 기록), `files/people-os/docx-create-pilot/src/core.js` (파일럿 생성 코드), `src/docx/create.ts` (라이브 생성 코드).
- 끝나면 마지막에 판정·핵심 숫자·바뀐 파일·배포된 버전을 짧게 요약한다.
