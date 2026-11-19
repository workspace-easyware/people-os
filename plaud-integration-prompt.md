# People OS Plaud 연동 구현 (Sonnet)

## 배경
사용자가 People OS 안에서 Plaud 녹음 목록을 보고 싶어 한다. Muse 쪽 Plaud MCP 연결(`custom.plaud`)은 이미 완료돼서 녹음 목록·전사 확인이 된다. 이제 People OS(웹앱) 안에 Plaud 연동을 넣는다. 사용자가 hr.jhkang@peopleos.site로 로그인한 상태에서 자기 Plaud 녹음 목록을 보고, 전사문을 People OS 문서로 가져올 수 있게 한다.

## 구현할 것

### 1. Plaud OAuth 연결 (사용자별)
- People OS의 기존 구글 캘린더 OAuth(C3) 패턴을 따라 만든다. PKCE S256, state 1회용·10분, 토큰 AES-256-GCM 암호화 후 D1 저장, SameSite=Strict 우회(콜백은 HTML만 반환 → 같은 출처 fetch로 POST /complete).
- Plaud MCP OAuth 정보 (검증됨):
  - MCP 서버: `https://mcp.plaud.ai/mcp`
  - issuer: `https://mcp.plaud.ai/`
  - authorize: `https://mcp.plaud.ai/authorize`
  - token: `https://mcp.plaud.ai/token`
  - 동적 클라이언트 등록: `https://mcp.plaud.ai/register` (RFC 7591 DCR)
  - resource: `https://mcp.plaud.ai/mcp`
  - response_types: `code`, code_challenge: `S256`, grant_types: `authorization_code`, `refresh_token`
- OAuth 클라이언트 등록: 먼저 DCR(`POST https://mcp.plaud.ai/register`)로 People OS용 클라이언트를 등록해 본다. redirect URI는 `https://peopleos.site/api/plaud/callback` (workers.dev 백업 주소도 함께 등록하면 좋다). DCR이 되면 client_id/client_secret을 Worker 시크릿으로 저장한다. **DCR이 안 되면 멈추지 말고, 그 결과를 RESULT.md에 적고 수동 등록이 필요한지 사용자에게 물어볼 상태로 남긴다.** (시크릿은 브라우저 대시보드에서 직접 설정하는 방식이 선례다. 값을 채팅·파일에 적지 않는다.)
- 연결 UI: 녹음전사 탭에 "Plaud 연결" 버튼을 넣는다. 연결된 상태면 "Plaud 연결됨"과 연결 해제 버튼을 보여준다.

### 2. Plaud 녹음 목록 (Worker가 MCP 클라이언트)
- Worker가 Plaud MCP 서버의 MCP 클라이언트가 된다. Streamable HTTP로 JSON-RPC를 보낸다. 참고 구현: `~/workspace/custom-connectors/custom.plaud/bin/client.py` (Muse 쪽 동작 확인됨) — initialize → `notifications/initialized` → `tools/call` 순서, `Mcp-Session-Id` 헤더 유지, SSE 응답 파싱.
- 쓸 도구 5개 (모두 읽기 전용, 검증됨):
  - `list_files` — 녹음 목록. `page`/`page_size`(최소 10), `date_from`/`date_to`(YYYY-MM-DD), `query`(이름 부분 일치, 최신 500건만 스캔).
  - `get_file` — 녹음 상세 + 오디오 다운로드 URL(`presigned_url`), `source_list`/`note_list` 인벤토리.
  - `get_note` — 요약·액션 아이템·템플릿 탭·하이라이트.
  - `get_transcript` — 타임스탬프·화자 구분 전사. `block`은 `transaction`(기본)·`transaction_polish`·`outline`·`mark_memo`. `limit` 최대 500, `next_cursor`로 다음 페이지.
  - `get_current_user` — 계정 확인용.
- 새 API: `GET /api/plaud/files` (로그인 필수, 자기 Plaud 토큰으로 호출). 목록에는 id·이름·날짜·길이·전사 여부를 보여준다. **전사 여부는 목록 응답에 필드가 없으므로, `get_transcript`를 불러서 구간이 있는지 확인하는 방식으로 판단한다.** (목록 20건 전부에 매번 물으면 느리니, 전사 여부는 목록 화면에서 각 행마다 필요할 때 확인하거나, 가져오기 버튼을 누를 때 확인하는 방식으로 한다. 비싼 전수 확인은 하지 않는다.)
- 토큰 만료 시 refresh_token으로 갱신하고, 갱신 실패 시 연결 해제 상태로 돌린다.

### 3. 전사문 가져오기 (People OS 문서로)
- 녹음전사 탭의 Plaud 목록에서 각 행에 "가져오기" 버튼을 넣는다.
- 가져오기를 누르면 Worker가 `get_transcript`(기본 `transaction` 블록, 커서로 전 페이지)와 `get_note`(요약)를 가져와서, People OS 개인 문서로 저장한다. 기존 문서 업로드·색인 흐름(`indexDocument` 계열)을 그대로 타서 개인 RAG에 들어간다. 문서 제목은 Plaud 녹음 이름, 출처는 Plaud로 표시한다.
- 이미 가져온 녹음은 "가져옴"으로 표시하고 중복 가져오기를 막는다. (Plaud file id로 식별.)
- 전사가 없는 녹음은 "전사 없음"으로 표시하고 가져오기 버튼을 비활성화한다. (Plaud MCP는 읽기 전용이라 전사를 새로 만들 수 없다.)

### 4. UI 위치
- 녹음전사.문서저장 탭 안에 "Plaud" 섹션을 넣는다. 기존 녹음·문서 업로드 UI는 그대로 둔다.
- 목록은 최신순, 이름·날짜·길이·전사 여부·가져오기 버튼을 보여준다.

## 주의
- **절대 건드리지 말 것**: `@cf/qwen/qwen3.8-27b` 답변 모델, Clef/clef-omni, llama-4-scout, whisper-large-v3-turbo, bge-m3. reasoning_effort는 12곳 모두 `"medium"` 그대로.
- **기존 마이그레이션 파일(0001~0032)은 수정하지 않는다.** 새 테이블이 필요하면 새 마이그레이션(0033~)을 만든다.
- **기존 API·동작을 바꾸지 않는다.** 기존 녹음·문서·RAG·캘린더·결재 동작은 그대로 둔다.
- **wrangler.toml의 routes 항목은 제거 상태 유지.**
- **배포는 직렬로 한 번만.** `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록한다.
- Plaud 토큰·시크릿 값은 채팅·파일·로그에 적지 않는다.

## 검증
- `npx tsc --noEmit` 통과. 프런트 JS는 `node --check` 통과.
- 로컬(`wrangler dev --local`)에서: Plaud 연결 버튼이 보이는지, 목록 API가 동작하는지, 전사문 가져오기가 개인 RAG 문서로 저장되는지 확인한다. (실제 Plaud 토큰이 없으면 로컬에서는 연결 흐름까지만 확인하고, 라이브에서 실제 계정으로 확인한다.)
- 배포 후 라이브에서: hr.jhkang 계정으로 Plaud 연결 → 목록 표시 → 전사 있는 녹음 가져오기 → 개인 업무 검색에서 가져온 전사가 검색되는지까지 확인한다. **브라우저 실제 화면 확인은 사용자가 한다.**
- **GitHub 푸시는 이번 세션에서 하지 않는다.**

## 산출물
- 검증 산출물을 `files/workflow-verify/plaud-integration/RESULT.md`에 작성할 것 (구현 내용·OAuth 등록 결과·검증 결과 + 되돌리는 방법).
- `files/people-os/workflow-agent-builder-PROGRESS.md`에 "Plaud 연동" 항목을 추가할 것.

## 보고 형식 (최종 응답)
- 구현한 기능 목록.
- OAuth 클라이언트 등록 결과 (DCR 성공 여부, 시크릿 저장 여부).
- 배포 버전 ID + 라이브 확인 결과.
- 사용자가 브라우저에서 다시 확인할 것.
- RESULT.md 경로.
