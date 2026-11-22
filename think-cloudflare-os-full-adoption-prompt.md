# Think + Cloudflare OS 전면 도입 계획 (개정판)

사용자가 점진적 도입이 아니라 **전면적으로 개발 및 도입**하기로 결정했다. 기존 계획(`files/people-os/think-cloudflare-os-adoption-plan.md`, Fable 5.2 작성, 2026-11-19)은 (a) 동결 전 점진적 도입 + (b) 공모전 뒤 전면 수정을 전제로 했다. 그 전제를 뒤집고, **지금 전면 도입하는 계획**을 새로 쓴다.

## 배경

- Think: Agents SDK 차세대 기본 요소 세트 (파이버 내구성 실행, 하위 에이전트 Facets, 영구 세션 API, Dynamic Workers 샌드박스 코드 실행, `Think` 기본 클래스 `@cloudflare/think`).
- Cloudflare OS: Think 부품들로 만든 완성된 사내 AI 에이전트 워크스페이스 앱 (github.com/cloudflare/cloudflare-os, Apache 2.0, early access).
- People OS 현황: React+TS가 아니라 빌드 없는 순수 HTML+JS. Workers + D1 + R2 + KV + Vectorize + DO + Queues + Workers AI. 워크플로우·에이전트 빌더(WF-1~WF-12, 12개 노드, 5개 기업 템플릿) live. 채팅·결재·LMS·메일·캘린더·화상회의(V0~V2) live. 라이브 배포 `d48c8b4e`. GitHub head `96fa4c82` (백업 완료).
- 일정: 기능 동결 11-25(수), 데모 영상·레포 공개 11-26(목), 제출 11-27(금). **오늘은 11-19(목) 밤. 남은 날 6일.**
- Workers 플랜: Free (확인됨). Cron 트리거 계정당 5개 중 3개 사용 중.

## 이 계획에서 정할 것

1. **전면 도입의 범위**: Think의 어떤 요소를 People OS에 직접 넣는가 (파이버 내구성 실행, Facets 하위 에이전트, 영구 세션, Dynamic Workers 샌드박스, Think 기본 클래스). Cloudflare OS의 어떤 부분을 가져오는가 (워크스페이스 UI, 에이전트 목록, 도구 연결 방식). 무엇은 안 넣는가.
2. **기존 엔진과의 관계**: 지금 워크플로우 실행 엔진(Queues 단계마다 메시지 1개, 승인 게이트, agent 루프)을 Think 방식으로 갈아엎는가, 아니면 Think를 새 레이어로 얹는가. 갈아엎는다면 기존 5개 템플릿·12개 노드의 회귀 범위는.
3. **Dynamic Workers 문제**: Free 플랜에서 Dynamic Workers는 Paid가 필요하다 (Fable 기존 계획 확인). 전면 도입에 Dynamic Workers가 필요하면 플랜 변경이 필요하다. 필요 없는 설계인지, 아니면 Paid 전환을 권고하는지 분명히 한다.
4. **일정**: 11-20~11-25, 날짜별 단계와 통과 기준. 11-24 회귀 검증은 어떻게 하는가. 11-25 동결에 맞출 수 없으면, 어디까지가 동결 범위이고 무엇이 동결 뒤로 가는가.
5. **위험**: 전면 도입이 6일 안에 망가뜨릴 수 있는 것 (템플릿 5개, 승인 게이트, DO 레이트 리미터, 관측·평가, 화상회의 V1+V2 방금 배포됨). 롤백 지점은 어디인가.
6. **데모·제출 반영**: 전면 도입이 데모 대본·pitch·README·아키텍처 다이어그램에 어떻게 들어가는가. 공모전 요건(Workers + D1 등 + 다른 제품 1개 이상)에는 어떤 영향이 있는가.

## 제약

- **코드는 건드리지 않는다.** 계획 문서만 쓴다.
- 기존 계획 문서와 V0~V2 결과(`files/workflow-verify/video-conference-v0/RESULT.md` 9절)를 읽고, 이미 live인 것과 겹치지 않게 한다.
- Cloudflare OS 저장소를 직접 확인한다 (README, 구조, 라이선스). Think 패키지(`@cloudflare/think`)의 현재 상태(버전, preview 여부)도 확인한다.
- 결론은 분명히: 전면 도입을 6일 안에 할 수 있는지, 할 수 있다면 최소 범위는 무엇인지, 할 수 없다면 어디까지가 현실적인지.
- 결과물: `files/people-os/think-cloudflare-os-full-adoption-plan.md`.
