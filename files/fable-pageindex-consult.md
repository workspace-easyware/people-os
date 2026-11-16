# Fable 5.2 자문 요청 — People OS 개인 RAG: PageIndex(트리) vs Vector DB

너는 Fable 5.2, 문제 해결 전용 자문 모델이다. 아래 맥락을 충분히 읽고, 끝에 있는 5개 질문에 답하라. 코드는 읽어도 되지만 수정하지 마라. 결론은 각 질문마다 "권장 / 비권장 / 조건부"로 명확히 하고, 이유와 근거(파일명·수치)를 함께 적어라.

## 1. 프로젝트 개요

- **People OS**: Cloudflare Workers(Hono) 기반 HR·코칭 인텔리전스 플랫폼. 제출 마감 2026-11-27, 기능 동결 2026-11-25. React+TS 프론트, Worker 백엔드, D1 + R2 + KV + Vectorize + Queues + Workers AI. **AI는 Workers AI만 사용한다** (외부 LLM API 호출 금지 — 사용자 원칙). 현재 LLM은 Qwen3-30b-a3b-fp8, 임베딩 bge-m3, 판단 모델 Clef(27B) + clef-omni.
- **RAG 구조**: 공용 풀(HR 규정·회사 문서·사내 암묵지)과 개인 풀(회의·강의 전사본, 개인 업로드 파일)로 나뉜다. Vectorize `user_id` 메타데이터 필터 + D1 `owner_id` 스코핑으로 개인별 격리 구현 완료 (2026-11-15, 라이브 검증됨). 문서 저장: 원본 R2, 텍스트 D1, 청크 D1 chunks, 임베딩 Vectorize.
- **사용자 라우팅 원칙**: 질문은 공용 풀이냐 개인 풀이냐 하나로 정해지고, 두 풀을 섞어 검색하면 안 된다.
- **방금 결정된 UI 분리**: HR 규정 검색창은 공용 풀만 검색 (개인 전사·업로드 내용 절대 안 나옴). 메뉴에 **개인 업무 검색**을 새로 넣고, 거기에 개인 RAG를 둔다. HR인지 아닌지 이진 판별은 판단 모델(Clef-omni) 라우터가 한다.
- **LLM Wiki 자문 결론 (2026-11-15, Fable 5.2)**: 풀 패턴(Raw→Wiki→Schema) 지금 도입 안 함. 공모전 이후 전사본에 한해 얇게(1건당 구조화 요약 1개), 원본 RAG의 보완재로만. HR 규정에는 도입 안 함 (요약하면 "30일 이내"·"단 ~의 경우 제외"가 뭉개짐). 요약은 기존 Vectorize 인덱스에 kind=digest 메타데이터로, 구조화 필드는 D1에.

## 2. PageIndex (VectifyAI) — 사용자가 제시한 대안

GitHub https://github.com/VectifyAI/PageIndex (README 2026-11-15 기준, 40k+ stars, MIT).
핵심 주장:
- **Vectorless, Reasoning-based RAG**: 벡터 DB·청킹 없이, 문서마다 **계층 트리 인덱스**를 만들고 LLM이 트리를 추론하며 찾아간다 ("사람이 긴 보고서의 올바른 절을 펼쳐 읽는 방식"). 유사도 ≠ 관련성이라, 관련성은 추론이 필요하다는 것이 전제.
- **인덱싱**: 트리 구조 자체는 문서 레이아웃에서 추출하고, 인덱스 모델은 요약·정제만 해서 기본 모델로 충분. 비용 약 $0.001/페이지, 1000페이지 교과서 ~$1·수 분, 1회성.
- **검색**: 채팅 모델이 트리를 탐색해 답한다. FinanceBench 98.7% 정확도(SOTA), 벡터 RAG보다 월등.
- **제약**: 오픈소스 버전은 **문서 1개당 트리 1개** (단일 문서용). 말뭉치 전체(수백~수천 문서)를 아우르는 **PageIndex File System**(파일 수준 트리)은 **Cloud 전용** 기능이다. 로컬 모드는 텍스트 기반 PDF만, Cloud는 스캔·이미지·OCR·관리 스토리지·메타데이터·폴더·MCP 지원. SDK는 Python. Cloud 이용은 PageIndex API 키 필요.

## 3. 우리 스택의 제약

- **Workers는 JS/WASM 런타임**: Python SDK(PageIndex)를 Worker 안에서 직접 돌릴 수 없다. Queues 소비자도 Worker다.
- **Workers AI만 사용**: PageIndex Cloud API를 쓰면 외부 서비스 호출 + API 키 + 데이터가 Cloudflare 밖으로 나간다. 사용자 원칙과 충돌한다.
- **저장소**: D1(관계형, 구조화 데이터) + R2(원본 파일·추출 텍스트). Vectorize는 이미 있고 개인별 격리가 동작한다.
- **개인 문서의 성격**: 회의·강의 전사본(대화체, 구조가 느슨함), 개인 업로드 파일(PDF/HWPX/DOCX 등, 형식이 다양함). HR 규정처럼 조문 단위로 깔끔하게 나뉘는 문서가 아니다. 전사본은 1건이 길고, 주제가 여러 개 섞여 있다.
- **규모**: 현재 전사본 16건 수준. 공모전 이후에도 수백 건 규모를 가정한다 (수천~수만 건이 아니다).

## 4. 질문 (5개)

1. **개인 RAG에서 트리 인덱스가 Vector DB를 대체할 수 있는가?** 전사본·업로드 파일 같은 느슨한 구조의 개인 문서에 PageIndex식 트리가 유효한가, 아니면 트리는 조문·보고서처럼 구조가 뚜렷한 문서에만 맞는가? Vector DB를 "꼭" 써야 하는지, 아니면 트리만으로 충분한지 판단하라.
2. **우리 스택에서 PageIndex를 실현하는 방법이 있는가?** (a) PageIndex Cloud API 호출, (b) PageIndex SDK를 Worker 밖(예: 별도 빌드/인덱싱 잡)에서 돌려 D1/R2에 트리를 저장, (c) PageIndex에서 영감을 받은 경량 트리를 Worker 네이티브(JS)로 직접 구현 (문서 구조 파싱 → D1에 트리 저장 → Workers AI LLM이 트리를 탐색). 각 방법의 가능 여부와 비용·리스크를 따져라. 특히 (c)가 현실적인지.
3. **트리를 D1/R2에 저장한다면 스키마와 갱신 흐름은 어떻게 설계해야 하는가?** 문서가 들어올 때마다 트리를 만드는 worker(Queue 소비자)의 역할, 트리 노드의 저장 형태(D1 테이블 vs R2 JSON), 문서 수정·삭제 시 트리 갱신, 사용자별 격리(owner_id)와의 정합을 구체적으로 설계하라.
4. **LLM Wiki(전사본당 구조화 요약 1개)와 트리 인덱스는 양립하는가, 충돌하는가?** 요약이 트리의 노드가 될 수 있는지, 아니면 요약은 별개 계층으로 두어야 하는지. 둘을 함께 쓸 때의 최적 조합을 제시하라.
5. **최종 권장 아키텍처와 단계별 계획을 제시하라.** 공모전 전(11/25 동결까지)과 공모전 후로 나누어, 개인 RAG를 어떻게 구성할지 (Vectorize 유지 / 트리 도입 / 하이브리드) 결론을 내리고, 각 단계의 구체적인 작업과 검증 방법을 적어라. "지금 당장 바꿀 것"과 "나중에 검토할 것"을 구분하라.

## 참고 파일 (읽어보면 좋다)

- `src/ask-pipeline.ts`: runAsk, LLM_MODEL(Qwen3), Vectorize 검색, 키워드 게이트, resolveSources.
- `src/lib.ts`: poolForDoc, owner_id, localSearchChunks, 문서 종류→풀 매핑.
- `src/index.ts`: /api/ask, /api/coaching/reflect, 문서 업로드·전사 경로.
- `src/obs/verdict.ts`, `src/obs/topic-guard.ts`: 판단 모델(Clef) 사용법.
- `seed/seed-data.json`: 시드 정책·전사본 샘플 (전사본의 실제 형태 확인용).
- `files/S4-OBSERVABILITY-EVAL-PLAN.md`: 평가 구조 (골든셋 6개, judge=Scout, verdict=Clef).

답은 한국어로, 각 질문에 번호를 달아 작성하라. 추측은 추측이라 밝히고, 확신하는 부분과 불확실한 부분을 구분하라.
