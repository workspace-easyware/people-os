# 발표자료 구현 S-C — Sonnet 5.5 (README·ARCHITECTURE.md 재작성)

## 너의 역할
너는 구현 세션이다. 계획 문서 `presentation-plan.md`의 6장 분할표에서 **S-C**만 구현한다. 코드 수정·배포는 하지 않는다. 문서만 쓴다.

## 읽을 것 (먼저 끝까지 읽어라)
- `presentation-plan.md` 0장(핵심 결정·사실 기준표 — 문구는 이 표에서만 가져온다), 4장(GitHub README), 5장(심사위원용 문서 — 5.1 세 문서의 담당 범위, 5.2 `ARCHITECTURE.md` 목차).
- 현재 문서: `README.md`, `ARCHITECTURE.md`, `public/architecture.svg` (O-B가 새로 그리는 중 — 링크는 `public/architecture.svg`로 쓴다).
- 코드 (사실 확인용): `src/` 구조, `wrangler.toml`, `migrations/` 목록. `ARCHITECTURE.md`에는 코드를 읽고 `파일:행`을 적는다.

## 결정된 사항 (그대로 쓴다)
- **대표 주소**: 라이브 데모 `https://people-os.workspace-easyware.workers.dev`. `peopleos.site`는 메일 도메인이다 (앱 서빙 여부는 확인 안 됨 — 그 도메인으로 앱이 열린다고 쓰지 않는다).
- **README 맨 위에 영어 요약**을 둔다 (짧게).
- **데모 계정 비밀번호를 README에 적지 않는다.** 심사위원용 데모 계정은 제출 폼에만 적는다 (공개 README에 비밀번호를 적으면 누구나 메일 발송과 AI 호출을 쓸 수 있다).
- **요금·한도 숫자를 넣지 않는다.** "월 $0"·"Free 플랜" 표현도 대시보드에서 계정 플랜을 확인한 뒤에만 쓴다 (확인 안 됐으면 쓰지 않는다).
- **쓰지 않는 Cloudflare 기능은 "쓴다"고 쓰지 않는다**: Hyperdrive, Workflows, Access, Analytics Engine, Dynamic Workers. 메일 발송은 Resend(외부 서비스)라 Cloudflare 기능으로 세지 않는다.
- **낡은 정보 갱신**: README는 LLM을 `llama-4-scout`로 적지만 코드는 `@cf/qwen/qwen3-30b-a3b-fp8`이다. 사실 기준표(0.4)의 모델 표를 쓴다. Durable Objects `AgentSession`은 "에이전트 실행기가 아니다. 대화 기억만 한다" — 그 이상으로 쓰지 않는다.

## 구현할 것 (S-C 범위)
1. **`README.md` 전면 재작성** (4장) — 5분 안에 이해·실행할 수 있게. 개요, 아키텍처, 기능 목록, 기술 스택, 실행 방법, 데모 링크. 맨 위에 짧은 영어 요약.
2. **`ARCHITECTURE.md` 전면 개정** (5.2 목차) — 심사위원용 상세 문서. 코드를 읽고 `파일:행`을 적는다.
3. **루트 `architecture.svg` 삭제**하고 링크를 `public/architecture.svg`로 바꾼다 (O-B가 새로 그린다).

## 제약
- S-C 파일만 만든다/고친다: `README.md`, `ARCHITECTURE.md`, `architecture.svg`(삭제). 코드는 건드리지 않는다. `public/pitch-content.html`은 건드리지 마라 (S-A 범위).
- 내용은 사실만 쓴다. 코드에서 확인하지 못한 기능·수치는 "확인 안 됨"으로 적거나 뺀다.
- 끝나면 최종 보고에 고친 문서 목록과 주요 변경(낡은 정보 갱신 내역)을 적어라.
