# People OS 화상회의(Cloudflare Meet / Realtime) 도입 — 개발 계획 수립

사용자가 People OS에 화상회의를 넣고 싶어 한다. 참고 자료는 Cloudflare Meet(오픈소스 화상회의 코드베이스, TypeScript+React+Workers+Durable Objects)와 Cloudflare Realtime(구 Calls, WebRTC SFU 인프라)이다. 이 세션은 **계획만** 수립한다. 코드는 고치지 않는다.

## 배경 (People OS 현재 상태)

- 스택: React + TypeScript 프런트, Cloudflare Workers 백엔드, D1 + R2 + KV + Vectorize + Durable Objects + Queues + Workers AI. 단일 도메인 peopleos.site.
- 이미 있는 실시간 기능: 플로팅 채팅(1:1·그룹, Durable Objects ChatRoom), Presence(온라인 표시), 읽음·반응. 채팅은 텍스트 기반이다. 음성·영상 통화는 없다.
- 코칭이 핵심 기능이다. 코치와 코칭 대상의 1:1, 그룹 채팅이 있다. 화상 코칭 세션이 자연스러운 확장이다.
- 공모전 일정: 기능 동결 2026-11-25(수), 데모 영상·레포 공개 11-26(목), 제출 11-27(금). 오늘이 11-19(수)이다.
- 현재 진행 중인 별도 작업: XAI 4가지 기능 구현(Opus 세션, 별도 진행 중). 이 계획 세션은 그 코드와 겹치지 않게 계획 문서만 쓴다.

## 참고 자료 (사용자가 제공)

- Cloudflare Meet: github.com/cloudflare/meet. TypeScript+React, Workers+Durable Objects로 회의실 상태 관리. 화면 공유, 클라이언트 노이즈 캔슬링, 배경 흐림 내장. Rust+WASM MLS로 종단간 암호화(E2EE) 지원. OpenAI Realtime API 연동으로 AI 참여자 추가 가능. 몇 줄 명령어로 자기 Cloudflare 계정에 배포 가능.
- Cloudflare Realtime (구 Calls): 상용 WebRTC SFU. 전 세계 335개+ 도시 애니캐스트, 저지연 미디어 라우팅. RealtimeKit(UI·SDK), 대기실, 화면 녹화, 실시간 자막(Workers AI 연동), TURN 서비스 포함.

## 계획에 담을 것

1. **통합 방식**: Meet 코드베이스를 통째로 가져올 것인가, RealtimeKit SDK만 붙일 것인가, 아니면 최소 기능(1:1 영상 통화)만 직접 만들 것인가. 세 가지의 장단점과 People OS 구조에 맞는 선택을 정한다. Meet은 React+Workers+DO라 스택이 맞지만, 통째로 가져오면 규모가 크다.
2. **아키텍처**: People OS의 기존 Durable Objects(ChatRoom 등)와 Realtime이 어떻게 맞물리는지. 회의실 상태는 DO에 두는지, Realtime 세션은 어떻게 만드는지. 채팅방과 화상회의방의 연결(채팅방에서 "영상 통화 시작" 버튼) 방식을 정한다.
3. **기능 범위 (MVP)**: 공모전 전에 넣을 최소 범위와 이후로 미룰 것을 나눈다. 후보: 1:1 영상·음성 통화, 그룹 통화, 화면 공유, 녹화(Whisper 전사와 연결), AI 참여자(요약·전사), 대기실, 자막. 11-25 동결을 고려해 현실적인 범위를 정한다.
4. **비용**: Cloudflare Realtime 요금 체계(사용량 기반)를 확인하고, 예상 사용량 기준 월 비용을 추산한다. 무료枠이 있는지, People OS 규모에서 얼마가 드는지. Workers AI 자막·녹화 전사 비용도 포함한다.
5. **인증·권한**: 누가 회의를 만들고 들어갈 수 있는지. 기존 로그인(세션 쿠키)·역할(hr_admin·user·coach·coachee)과 어떻게 연결하는지. 외부 손님(계정 없는 사람) 초대는 가능한지.
6. **녹화·전사 연계**: 화상회의 녹화를 기존 Whisper 전사 파이프라인(전사 → 요약 → 색인)과 어떻게 연결할지. 녹화 파일을 R2에 저장하고 전사하는 흐름을 정한다.
7. **위험·열린 질문**: E2EE(MLS)를 쓸지 말지, 브라우저 호환성, 모바일 대응, Realtime이 공모전 요건(Workers + 다른 제품)에 어떻게 들어가는지. 결정이 필요한 항목을 목록으로 적는다.

## 산출물

- 계획 문서: `files/people-os/video-conference-plan.md`에 작성한다. 위 7가지를 모두 담고, 마지막에 "먼저 할 것 / 나중에 할 것"과 "사용자 결정이 필요한 것"을 분리해서 적는다.
- 코드는 일절 고치지 않는다. 마이그레이션·배포도 하지 않는다.
- Cloudflare Realtime 공식 가격 페이지를 직접 확인해서 비용을 적는다. 확인이 안 되면 "미확인"이라고 명시하고 추정치를 만들지 않는다.
- Meet 저장소의 README·구조를 직접 읽어보고(가능한 범위에서) 통합 방식을 정한다. 읽지 못했으면 그 범위도 명시한다.
