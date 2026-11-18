# DO-2 — 실시간 알림 푸시 (NotificationHub DO)

## 목표
알림이 생기면 브라우저에 즉시 푸시한다. 현재는 폴링만 있다(`public/approval.js`의 `apvHome()`이 `${APV}/notifications?limit=15`를 조회하고, `public/workflow.js:201,481`이 `/api/approval/notifications?unread=1`을 조회한다). 채팅 WebSocket 인프라(DO-1)를 재사용하되, 알림은 별도 DO(`NotificationHub`, 사용자 1명당 1개)로 분리한다.

## 범위 (이것만 한다)
1. `src/notifications/hub.ts` — NotificationHub DO 클래스. 사용자 1명당 1개 DO(`NOTIFICATION_HUB` 바인딩, id는 userId에서 유도). WebSocket Hibernation API 사용. 연결 시 해당 사용자의 세션만 허용(세션 쿠키 또는 토큰 검증 — `src/chat/room.ts`의 인증 방식을 그대로 따른다). 메시지 프로토콜: 서버→클라이언트 `{type:'notify', notification:{id,type,title,body,link,created_at}}` 1종. DO는 알림을 저장하지 않는다(저장은 D1 `notifications` 테이블이 이미 한다). 연결이 없을 때 푸시는 그냥 버린다(다음 폴링이 보여준다 — 폴백이 이미 존재한다).
2. `src/notifications/push.ts` — 푸시 헬퍼 `pushNotification(env, userId, notification)` 1개. `env.NOTIFICATION_HUB.get(env.NOTIFICATION_HUB.idFromName('user:'+userId)).fetch(new Request('https://hub/push', {method:'POST', body: JSON.stringify(notification)}))` 형태. 실패(예외·비-2xx)는 조용히 무시하고 호출자에게 에러를 전파하지 않는다 — 푸시 실패가 알림 저장 자체를 막으면 안 된다.
3. 알림 생성 지점에 푸시 호출을 연결한다. 현재 확인된 생성 지점:
   - `src/approval/machine.ts:202` — `notificationStmt()`로 만든 알림들(결재 요청/승인/반려). `machine.ts`에서 INSERT 문 실행 후, 각 알림의 `user_id`로 `pushNotification()` 호출.
   - `src/workflow/approvals.ts:23` — 워크플로우 승인 알림 INSERT 직후 동일하게 호출.
   - 먼저 `grep -rn "INSERT INTO notifications" src/` 로 다른 생성 지점이 있는지 확인하고, 있으면 같은 방식으로 연결한다. 없으면 위 2곳만 한다.
   - **주의**: 푸시 호출은 D1 INSERT가 성공한 뒤에만 한다. 트랜잭션(batch) 안에 넣지 않는다 — DO fetch는 D1 batch 밖에서, INSERT 성공 확인 후에 호출한다.
4. `wrangler.toml`에 `NOTIFICATION_HUB` Durable Object 바인딩을 추가한다. **v3 마이그레이션 태그는 추가하지 않는다** (DO-MIG 세션에서 `[ChatRoom, NotificationHub, RateLimiter]`로 한 번에 적용한다. wrangler는 태그를 한 번만 적용하므로 지금 넣으면 DO-MIG 때 적용되지 않는다).
5. UI (`public/approval.js` 확장, 새 파일 만들지 않는다):
   - 로그인 후 NotificationHub에 WebSocket 1개 연결(`wss` 경로 — `src/chat/routes.ts`의 채팅 WebSocket 라우트 방식을 참고해 `/api/notifications/ws` 라우트를 `src/index.ts`에 추가한다).
   - 푸시 수신 시: (a) 알림 토스트 표시(화면 우상단, 제목+본문, 클릭하면 `notification.link`로 이동, 5초 후 자동 사라짐, textContent만 사용 — innerHTML 금지), (b) `ntfPaintCount()`로 미읽음 수 +1 반영, (c) 결재함 탭이 열려 있으면 목록 재조회.
   - WebSocket 끊기면 5초 후 재연결(최대 5회 시도 후 중단 — 그 뒤는 기존 폴링이 커버한다).
   - 기존 폴링 코드는 그대로 둔다(푸시의 폴백이다). 폴링 주기를 바꾸지 않는다.

## 하지 않는 것
- D1 `notifications` 스키마 변경 없음(마이그레이션 없음).
- 이메일 발송 변경 없음(`deliverEmails`는 건드리지 않는다).
- 채팅 코드(`src/chat/`, `public/chat.js`) 변경 없음.
- 푸시 알림(모바일 OS 알림)·Service Worker·Web Push API는 하지 않는다 — 브라우저 탭 내 WebSocket 푸시만 한다.
- 배포·GitHub 푸시 없음. 로컬 검증만 한다.

## 검증 (files/workflow-verify/do2/ 에 기록)
- `npx tsc --noEmit` 통과.
- 하네스: DO-1b/DO-1c와 같은 방식(`wrangler dev --local` Worker + 가짜 DOM/WebSocket/mock API) 또는 `node` 직접 실행 중 허용 규칙 안에서 되는 쪽으로. 반드시 포함할 케이스:
  1. 알림 생성 → 해당 사용자의 Hub에 연결된 클라이언트가 `notify` 메시지를 받는다.
  2. Hub에 연결이 없는 사용자에게 푸시하면 조용히 무시되고(에러 없음), D1 알림 행은 그대로 있다.
  3. 다른 사용자의 Hub 연결로는 내 알림이 가지 않는다(격리).
  4. 푸시 실패(Hub fetch 예외)가 알림 INSERT를 막지 않는다.
  5. UI: 푸시 수신 시 토스트 표시 + 미읽음 수 +1 + 결재함 목록 재조회(열려 있을 때).
  6. WebSocket 재연결(끊김 → 5초 후 재시도, 5회 후 중단).
- 회귀: DO-1a(41/41)·DO-1b(77/77)·DO-1c(71/71)·DO-1d(64/64) 하네스를 그대로 다시 돌려 전부 통과.
- `files/workflow-verify/do2/RESULT.md`에 결과 기록(통과 수, 실패 목록, 미검증 항목 명시).

## 산출물
- `src/notifications/hub.ts`, `src/notifications/push.ts`, `src/index.ts`(라우트), `src/approval/machine.ts`·`src/workflow/approvals.ts`(푸시 호출), `wrangler.toml`(바인딩만), `public/approval.js`(WebSocket+토스트), `files/workflow-verify/do2/RESULT.md` + 하네스 파일들.
- 최종 응답에 포함할 것: 구현 요약(파일 목록), 하네스 통과 수, 회귀 통과 수, 미검증 항목(실제 Cloudflare WebSocket·원격 DO 미적용·브라우저 실확인 — DO-MIG 이후 라이브 확인 필요).
