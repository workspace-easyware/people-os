# 그룹 채팅 이름 자동 지정 + 이름 변경 (Sonnet)

## 요청
그룹 채팅을 만들 때 이름을 지정하지 않아도, 멤버들의 이름이 그룹 이름으로 자동 지정되게 해줘. 이후에 그룹 이름을 고칠 수도 있게 해줘. 방은 어차피 ID로 관리되니까 이름은 표시용 라벨이다.

## 현재 상태
- 백엔드 `src/chat/routes.ts`:
  - `POST /groups` — `name`이 필수 (1~100자). 없으면 400 "방 이름은 1~100자여야 합니다." (`routes.ts:246-247`). `member_ids[]`로 멤버 지정, 생성자 포함 전원 `chat_room_members`에 추가.
  - 그룹 이름 변경 API는 없음.
  - 방 목록: 그룹은 `name: r.name` 반환. `name`이 null이면 프론트에서 '(이름 없는 그룹)' 표시.
- 프론트 `public/chat.js`:
  - 그룹 생성 폼 (215-217행): `name`이 비면 "그룹 이름을 입력해 주세요." 경고 후 중단. `POST /api/chat/groups {name, member_ids}` (222행).
  - 방 목록 (112행): 그룹은 `room.name || '(이름 없는 그룹)'`.
  - 대화방 머리글 (274-276행): `S.peerName.textContent = g.name`.

## 백엔드 변경 (`src/chat/routes.ts`)
1. **`POST /groups` — `name`을 선택으로.**
   - `name`이 비어 있거나 아예 안 오면, 멤버 이름으로 자동 생성한다. 생성자 본인 + `member_ids` 전원의 이름을 `users` 테이블에서 조회해 이어 붙인다 (예: "김불꽃, 이구름"). 순서: 생성자 먼저, 그다음 `member_ids` 순서 (중복 제거, 본인 제외하고 이미 포함된 경우 정리).
   - 자동 생성 이름이 100자를 넘으면 100자까지 자른다 (말 줄임표 없이, 깔끔하게 자름).
   - `name`이 직접 주어진 경우: 기존 검증 유지 (1~100자, trim).
   - 자동 생성된 이름도 `chat_rooms.name` 컬럼에 저장한다 (방 목록에서 그대로 보이게).
   - `member_ids` 검증·멤버 추가·DO 동기화는 기존 그대로.
2. **`PATCH /groups/:roomId` — 이름 변경 (신규).**
   - 멤버만 변경 가능 (비멤버는 404 — 기존 `requireGroupMember` 재사용). 생성자·hr_admin 제한은 두지 않는다. 이름은 표시용 라벨이고 방은 ID로 관리되므로, 멤버면 누구나 바꿀 수 있다.
   - body `{name}`: trim 후 1~100자 검증 (빈 문자열·100자 초과면 400).
   - `chat_rooms`의 `name`과 `updated_at`을 갱신하고, 갱신된 방 정보를 반환한다 (`{ok:true, room:{id, type:"group", name, updated_at}}`).
   - D1만 갱신하면 된다 (DO에는 방 이름이 저장되지 않음 — 확인하고, DO에 이름이 있으면 거기도 맞출 것).

## 프론트 변경 (`public/chat.js`, 필요하면 `public/chat.css`·`public/index.html`)
1. **그룹 생성 폼 — 이름 선택으로.**
   - 이름 입력란을 필수에서 선택으로 바꾼다. 안내 문구를 바꾼다 (예: placeholder "비워두면 멤버 이름으로 자동 지정됩니다", 기존 "그룹 이름을 입력해 주세요." 필수 경고는 제거).
   - 이름이 비면 `name`을 빈 문자열로 보내거나 아예 빼고 `POST /api/chat/groups {member_ids}`만 보낸다 (백엔드가 자동 생성).
   - 생성된 방은 서버가 반환한 `name`(자동 생성 포함)으로 목록에 추가하고 연다 (기존 227·230행 로직 유지).
2. **이름 변경 UI — 대화방 머리글에서.**
   - 그룹 대화방 머리글의 이름 옆에 작은 연필(편집) 버튼을 둔다 (Lucide `pencil` 아이콘, 16px, 기존 토큰만 사용). DM 방에는 이 버튼을 두지 않는다.
   - 버튼을 누르면 이름이 인라인 입력란으로 바뀌거나(권장), 간단한 입력 프롬프트가 뜬다. 새 이름을 입력하고 저장하면 `PATCH /api/chat/groups/:roomId {name}` 호출.
   - 저장 성공 시: 머리글 이름·방 목록의 해당 방 이름·`S.group.name`을 새 이름으로 갱신한다. 실패 시 에러를 표시한다 (기존 `setNote` 패턴).
   - 이름 변경은 1~100자 검증 (프론트에서도 길이 체크).
3. **표시**: 자동 생성된 이름과 직접 지은 이름을 구분할 필요는 없다. 둘 다 그냥 `name`으로 보인다.

## 검증
- `npx tsc --noEmit` 통과.
- `public/chat.js`는 `node --check`으로 검사. `public/index.html` 인라인 스크립트 변경분이 있으면 추출해 `node --check`으로 검사 (추출은 `sed`/`awk`/`grep`으로).
- 로컬 `wrangler dev --local`로 서빙 확인 (200, 새 코드 포함).
- 백엔드 로직은 하네스 또는 로컬 D1로 확인이 가능하면 한다 (그룹 생성 시 이름 자동 생성·이름 변경). 로그인 세션이 필요한 라이브 검증은 이 세션에서 하지 않아도 된다 — 대신 보고서에 "브라우저에서 실제 그룹 생성·이름 변경 확인 필요"라고 명시할 것.

## 배포
**배포한다.** 사용자가 직접 요청한 기능이고 범위도 명확하다. `~/workspace/custom-connectors/custom.cloudflare/bin/cf-wrangler.py` 헬퍼로 배포할 것 (plain `npx wrangler` 금지). 배포 버전 ID를 기록할 것. 배포 후 `/api/health` 200 + 바인딩 전부 true 확인.

## 산출물
- 검증 산출물을 `files/workflow-verify/group-name/RESULT.md`에 작성할 것.
- 진행 기록 `files/people-os/workflow-agent-builder-PROGRESS.md`에 "그룹 이름 자동 지정 + 변경" 항목을 추가할 것.

## 보고 형식 (최종 응답)
- 배포 버전 ID:
- 변경 요약 (백엔드 2건 + 프론트 2건).
- 자동 생성 이름 형식 (예: "김불꽃, 이구름" — 실제 구분자·순서).
- 이름 변경 권한 (누가 바꿀 수 있는지).
- 검증 결과 (tsc, node --check, 로컬 확인).
- 미검증 항목 (브라우저 실제 그룹 생성·이름 변경 — 사용자가 직접 확인할 것).
