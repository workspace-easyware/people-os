# Fable 5.2 자문 2단계 — Workflows·Cloudflare OS 직접 참조 + 종합 결론

## 너의 역할
너는 아키텍처 자문이다. 코드를 읽고 분석해서 **계획**을 세우는 것이 임무다. 코드를 수정하거나 배포하지 마라. 결과물은 1단계 계획 문서의 종합판이다.

## 배경
- 1단계 세션(같은 모델, 직전 세션)이 easy-ware(JAVA 그룹웨어·결재), easy-standards(공통 코드), Sites 저장소의 유튜브 큐레이션 패턴을 분석해서 계획 초안을 썼다: `files/people-os/groupware-approval-plan.md`. **먼저 그 문서를 끝까지 읽어라.** 1단계 결론이 네 출발점이다.
- 1단계에서는 Workflows·Cloudflare OS를 요약문만으로 판단했는데, 사용자가 직접 원문을 읽고 종합하라고 지시했다. **이번 단계의 임무는 Workflows와 Cloudflare OS의 원문을 직접 읽고, 1단계 분석과 합쳐서 최종 종합 결론을 내는 것이다.**
- People OS: Cloudflare Workers 위의 HR·코칭 인텔리전스 플랫폼. 스택: Workers + D1 + R2 + KV + Vectorize + Workers AI(Qwen3, Clef, bge-m3, Whisper) + Durable Objects + Queues. Free 플랜. 도메인 peopleos.site. 로컬 코드: `files/people-os/` (src/, public/, migrations/, wrangler.toml).

## 직접 읽을 원문 (WebFetch·git clone 허용됨)
### 1. Cloudflare Workflows — 공식 문서 직접 읽기
- https://developers.cloudflare.com/workflows/ (개념, 시작하기)
- https://developers.cloudflare.com/workflows/examples/wait-for-event/ (Human-in-the-Loop, waitForEvent 승인 대기 패턴 — **필수**)
- https://developers.cloudflare.com/workflows/pricing/ (Free/Paid 한도 — **필수**, 대기 인스턴스 보관 기간 확인)
- https://github.com/cloudflare/workflows-starter (공개 저장소, `git clone --depth 1` 가능 — 구조와 예제 코드 확인)
- 파악할 것: waitForEvent의 정확한 동작(승인 이벤트 전송 방법, 타임아웃, 재시도), 대기 중 인스턴스의 상태 보관 기간(Free/Paid), 스텝·CPU 한도가 결재 흐름에 미치는 영향, Workflows를 People OS의 기존 Worker·D1·Queue 구조에 붙이는 방법(바인딩, 호출 경로).

### 2. Cloudflare OS — 저장소 직접 읽기
- https://github.com/cloudflare/cloudflare-os (공개 저장소, `git clone --depth 1` 가능 — 로컬에 받거나 WebFetch으로 핵심 파일 읽기)
- 파악할 것: Gatekeeper의 deferred approval(승인 대기 큐) 동작 방식, 어떤 파일·모듈이 그 역할을 하는지, Dynamic Worker 요구사항(Workers Paid 필요 여부), 결재만 떼어 쓸 수 있는 최소 단위가 있는지, People OS에 참고할 패턴(승인 큐 스키마, 승인자 알림, 만료 처리).
- README와 아키텍처 문서부터 읽고, Gatekeeper 관련 코드로 들어간다.

## 산출물
**`files/people-os/groupware-approval-plan.md`를 직접 갱신한다** (새 파일이 아니라 1단계 문서를 종합판으로 고친다):
1. 1단계 내용을 유지하되, Workflows·Cloudflare OS 섹션을 **원문 근거로 다시 쓴다** (문서 URL·파일 경로·인용 근거 명시, 요약만으로 쓴 부분은 원문 확인 결과로 교체).
2. 결재 구현 방식 비교(Workflows waitForEvent vs D1 경량 vs OS Gatekeeper 참고)를 원문 근거로 다시 평가하고 **최종 추천안 1개를 정한다** (조건부 추천이면 조건을 명시).
3. 종합 결론 섹션을 새로 쓴다: easy-ware 결재 + easy-standards 공통 코드 + Workflows/OS + 유튜브 LMS를 묶어서, People OS에 적용할 전체 그림(아키텍처 개요, D1 스키마 방향, UI 배치, 단계별 실행 계획 — 공모전 제출 11-27 이후, 11-25 기능 동결 전제).
4. 열린 질문 목록을 갱신한다 (원문을 읽고 새로 생긴 질문이 있으면 추가).

## 제약
- 코드는 읽되 수정하지 마라. 배포하지 마라. D1/R2 등 운영 리소스에 쓰지 마라. (git clone은 /tmp가 아니라 `files/people-os/.ref/` 아래에 받는다 — 런타임 재시작 시 /tmp가 지워지기 때문. 클론한 참조 저장소는 계획 문서의 근거용이며 People OS 배포에 포함하지 않는다.)
- 추측하지 마라. 원문에서 확인한 것만 근거로 쓴다. 못 찾은 것은 "확인 안 됨"으로 명시한다.
- 계획 문서 갱신이 끝나면 최종 보고에 핵심 결론(최종 추천 결재 방식과 그 근거 한 줄, 종합 그림 한 줄)을 요약해라.
