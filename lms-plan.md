# People OS 간단 LMS("강의실") 구현 계획 — 공모전용

작성: 2026-11-17 (Fable 5.2 자문). 대상 일정: 기능 동결 11-25, 데모 영상 11-26, 제출 11-27.
이 문서는 구현 세션(Sonnet 5.5 / Opus 5.5)의 지침서다. 코드·운영 리소스는 이 자문에서 건드리지 않았다.

**핵심 결론**

- 새 상품 없이 지금 있는 것만 쓴다: D1 테이블 3개 + R2 `people-os-files`의 `lms/` 접두사 + Hono 하위 앱 `/api/lms` + 프런트 `lms.js`. Free 한도 안이다.
- R2 영상은 Worker가 로그인 확인 뒤 Range 요청을 206으로 중계한다. 유튜브는 `youtube-nocookie` iframe으로 재생한다.
- 진도는 `(user_id, lesson_id)` 기본키 한 행에 UPSERT 한 문장으로 저장한다. `user_id`는 항상 세션에서만 가져온다.
- 구현은 세션 3개로 나눈다: S1(Sonnet, 백엔드 뼈대) → O1(Opus, 스트리밍·진도·플레이어) → S2(Sonnet, 화면).

**근거 표기**: [코드] = 로컬 코드에서 확인, [문서] = Cloudflare 공식 문서를 이번에 읽어 확인, [참고] = 외부 저장소에서 확인, [일반 지식] = 이번에 자료로 확인하지 못해 라이브 검증이 필요한 것.

**확인 안 됨 (자료를 읽지 못함)**

- "Build a Course Platform on Cloudflare for $0" (simpleappshipper.com): 이 세션에서 해당 도메인 접근이 거부돼 읽지 못했다.
- JustRec: GitHub 저장소 검색에서 일치하는 저장소를 찾지 못했다.
- 읽은 것은 file-spooder(`mishalshanavas/file-spooder`의 `worker.js`) 하나다. 3장의 Range 처리는 이 코드와 R2 공식 문서를 근거로 한다.

**앞선 계획과의 관계**: `groupware-approval-plan.md` 5장은 LMS를 "제출 이후 2단계"로 잡았다. 이 문서는 그중 최소 부분을 제출 전에 넣는 계획이다. 테이블 이름(`lms_*`)과 컬럼을 그 초안의 부분집합으로 맞춰, 나중에 수강 신청·결재 연동을 `ALTER TABLE ADD COLUMN`과 새 테이블로 얹을 수 있게 했다.

---

## 1. 아키텍처 개요

```
브라우저 (public/index.html + lms.js + lms-player.js)
  │  세션 쿠키 people_os_session (HttpOnly·Secure·SameSite=Strict, 같은 출처라 <video> 요청에도 실린다)
  │
  ├─ GET  /api/lms/courses, /courses/:id, /summary ──┐
  ├─ POST /api/lms/lessons/:id/progress ─────────────┤
  │                                                  ▼
  │                                   Worker (Hono) src/lms/routes.ts
  │                                     getSessionUser() → 없으면 401
  │                                          │
  │                                          ▼
  │                                   D1 people-os-db
  │                                     lms_courses / lms_lessons / lms_progress
  │
  ├─ <video src="/api/lms/lessons/:id/video">  (Range: bytes=a-b)
  │                                          │
  │                                   src/lms/stream.ts
  │                                     ① 세션 확인(401) ② D1에서 r2_key 조회(404)
  │                                     ③ Range 파싱 ④ env.FILES.get(key, {range})
  │                                          │
  │                                          ▼
  │                                   R2 people-os-files  lms/videos/<lessonId>/<파일>.mp4
  │                                     → 206 Partial Content (Content-Range, Accept-Ranges)
  │
  └─ <iframe src="https://www.youtube-nocookie.com/embed/<id>?start=&end=">
        (Worker를 거치지 않는다. 썸네일은 i.ytimg.com)
```

- R2 키는 브라우저에 내려보내지 않는다. 브라우저는 강의 id만 알고, Worker가 D1에서 키를 찾는다.
- 정적 파일(`lms.js` 등)은 기존 `[assets]` 바인딩이 서빙한다. `public/_headers`의 `Cache-Control: no-cache`가 새 파일에도 적용된다 [코드].
- People OS에는 CSP 헤더가 없다 (`src/`, `public/_headers`, `index.html`에서 `Content-Security-Policy`·`frame-src` 검색 0건) [코드]. 그래서 유튜브 iframe을 막는 설정은 없다.

---

## 2. D1 스키마

### 2.1 마이그레이션 번호와 방식

- 현재 마지막 파일은 `migrations/0022_email.sql`이다 [코드]. 새 파일은 **`migrations/0023_lms.sql`**.
- 주의: `groupware-approval-plan.md`의 결재 작업도 다음 번호를 쓸 수 있다. 그 작업은 제출 이후로 잡혀 있으므로 0023은 LMS가 쓴다.
- 스키마 누락 처리는 메일함 방식을 따른다: `ensureSchema()`에 넣지 않고, 라우트에서 `no such table`을 잡아 503 "강의실 스키마가 아직 적용되지 않았습니다 (migration 0023)"를 돌려준다 (`src/email/routes.ts`의 `isSchemaMissing`) [코드].
- 테이블 이름에 `lms_` 접두사를 붙인다. 요청서는 `courses/lessons/progress`라고 했지만, `recordings`에 이미 `progress` 컬럼이 있고 앞선 계획이 `lms_*`로 설계했기 때문이다.
- 외래키(`REFERENCES`)는 달지 않는다. 0016·0022가 같은 방침이다 ("사용자 삭제가 행에 걸리지 않게") [코드]. 강의 삭제 때는 진도 행을 같은 `DB.batch`에서 함께 지운다.

### 2.2 테이블

```sql
-- 0023_lms.sql — 강의실 (2026-11, 공모전 최소 범위)
CREATE TABLE IF NOT EXISTS lms_courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'JOB',          -- JOB | LEGAL | SAFETY | COACHING (표시용)
  thumbnail_url TEXT,                            -- NULL이면 첫 유튜브 강의의 썸네일을 쓴다
  ord INTEGER NOT NULL DEFAULT 0,                -- 목록 정렬
  status TEXT NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lms_lessons (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('youtube','r2')),
  youtube_id TEXT,                               -- source='youtube': 11자 영상 ID
  r2_key TEXT,                                   -- source='r2': lms/videos/<lessonId>/<파일>
  start_sec INTEGER,                             -- 유튜브 챕터 시작 (NULL = 처음부터)
  end_sec INTEGER,                               -- 유튜브 챕터 끝 (NULL = 끝까지)
  duration_sec INTEGER,
  content_type TEXT,                             -- r2: video/mp4 등
  size_bytes INTEGER,                            -- r2: 객체 크기 (Range 계산에 쓴다)
  curator_note TEXT,                             -- 큐레이션 한 줄 ("왜 이 영상인가")
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (course_id, ord),
  CHECK ((source = 'youtube' AND youtube_id IS NOT NULL AND r2_key IS NULL)
      OR (source = 'r2' AND r2_key IS NOT NULL AND youtube_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_lms_lessons_course ON lms_lessons(course_id, ord);

CREATE TABLE IF NOT EXISTS lms_progress (
  user_id TEXT NOT NULL,
  lesson_id TEXT NOT NULL,
  position_sec INTEGER NOT NULL DEFAULT 0,       -- 마지막 시청 위치 (이어보기, 2순위 기능)
  completed_at TEXT,                             -- NULL = 미완료
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, lesson_id)
);
CREATE INDEX IF NOT EXISTS idx_lms_progress_lesson ON lms_progress(lesson_id);
```

- `start_sec`/`end_sec`는 앞선 초안에 없던 컬럼이다. 제공된 유튜브 영상이 3시간짜리 1개라, 챕터 14개를 강의 14개로 나누려면 필요하다 (`lms-seed-content.md`).
- 수강 신청(`lms_enrollments`)·의무교육·대상 구분 컬럼은 넣지 않는다. 공모전 범위에서는 로그인 사용자 전원이 게시된 과정을 본다.

### 2.3 적용 절차

- 로컬: `npx wrangler d1 execute people-os-db --local --file migrations/0023_lms.sql`. `migrations apply --local`은 0004에서 실패한다 (AGENTS.md 기록).
- 원격: 먼저 `cf-wrangler.py d1 migrations list people-os-db --remote`로 추적 상태를 본다. 0019~0022가 추적 테이블에 기록됐는지는 **확인 안 됨**이다 (AGENTS.md는 0018까지 동기화됐다고만 적혀 있다). 밀린 것이 0023뿐이면 `migrations apply`, 아니면 `d1 execute --remote --file migrations/0023_lms.sql -y` 뒤 `INSERT INTO d1_migrations(name) VALUES('0023_lms.sql')`.

### 2.4 시드 — SQL 시드 파일을 권장

| 방법 | 장점 | 단점 |
|---|---|---|
| **SQL 시드 파일** (`seeds/lms_seed_v1.sql`) | 검토 가능, 멱등(`INSERT OR IGNORE` + 고정 id), 화면·API 없이 된다. `seeds/ds_personal_v1.sql` 선례가 있다 [코드] | 바꾸려면 파일을 고쳐 다시 실행 |
| 관리자 시드 API | 배포 뒤 curl로 추가 가능 | 만들 코드가 늘고, 영상 1개 + 링크 몇 개에는 과하다 |

권장: **SQL 시드가 기본**이다. 관리자 API는 5장의 최소 2개(과정·강의 upsert)만 만들어 "영상 올린 뒤 강의 1건 추가"에 쓴다. 과정 관리 화면은 만들지 않는다.

시드 형태 (유튜브 과정은 `lms-seed-content.md`의 실제 값, 초는 그 표의 타임스탬프를 환산한 값):

```sql
-- seeds/lms_seed_v1.sql (멱등)
INSERT OR IGNORE INTO lms_courses (id, title, description, category, ord, status) VALUES
 ('course_claude_allinone', '2026 클로드 올인원 무료강의', '해피AI 채널 — Claude 업무자동화 3시간 총정리', 'JOB', 2, 'PUBLISHED'),
 ('course_peopleos_intro',  '<<과정 이름 — 열린 질문 3>>', '<<설명>>', 'JOB', 1, 'PUBLISHED');

INSERT OR IGNORE INTO lms_lessons (id, course_id, ord, title, source, youtube_id, start_sec, end_sec) VALUES
 ('les_claude_01','course_claude_allinone', 1,'2026 클로드 올인원｜핵심 기능 20분 총정리','youtube','ZN37IV4sbQg',    0, 1142),
 ('les_claude_02','course_claude_allinone', 2,'2026 AI PPT 올인원｜일잘러의 PPT 제작법','youtube','ZN37IV4sbQg', 1142, 2211),
 ('les_claude_03','course_claude_allinone', 3,'이걸 모르고 쓰면 클로드는 버리는 겁니다','youtube','ZN37IV4sbQg', 2211, 2904),
 ('les_claude_04','course_claude_allinone', 4,'AI 잘 쓰는 90%가 클로드로 바뀐 이유','youtube','ZN37IV4sbQg', 2904, 3496),
 ('les_claude_05','course_claude_allinone', 5,'AI 초보자들이 요즘 클로드를 쓰는 이유','youtube','ZN37IV4sbQg', 3496, 3984),
 ('les_claude_06','course_claude_allinone', 6,'클로드, 절대 채팅용으로만 쓰지 마세요','youtube','ZN37IV4sbQg', 3984, 4698),
 ('les_claude_07','course_claude_allinone', 7,'이걸 모르면 뒤처집니다｜클로드 제대로 쓰는 법','youtube','ZN37IV4sbQg', 4698, 5497),
 ('les_claude_08','course_claude_allinone', 8,'클로드에게 질문만 하지 마세요｜업무자동화','youtube','ZN37IV4sbQg', 5497, 6084),
 ('les_claude_09','course_claude_allinone', 9,'AI는 이제 답변만 하지 않습니다｜일하는 AI','youtube','ZN37IV4sbQg', 6084, 6560),
 ('les_claude_10','course_claude_allinone',10,'클로드 코드 완벽 가이드｜설치부터 주요 기능','youtube','ZN37IV4sbQg', 6560, 7261),
 ('les_claude_11','course_claude_allinone',11,'클로드 코드에게 바로 코딩시키면 망합니다','youtube','ZN37IV4sbQg', 7261, 7943),
 ('les_claude_12','course_claude_allinone',12,'클로드코드 그냥 쓰면 안 됩니다｜코딩 에이전트','youtube','ZN37IV4sbQg', 7943, 8255),
 ('les_claude_13','course_claude_allinone',13,'Fable 5.1 출시｜이번엔 급이 다릅니다','youtube','ZN37IV4sbQg', 8255, 9152),
 ('les_claude_14','course_claude_allinone',14,'2026 클로드 토큰 절약법 올인원','youtube','ZN37IV4sbQg', 9152, NULL);

-- R2 영상 강의: 파일을 받은 뒤 채운다 (열린 질문 1). 영상을 R2에 올린 다음 실행한다.
-- INSERT OR IGNORE INTO lms_lessons (id, course_id, ord, title, source, r2_key, content_type, size_bytes, duration_sec) VALUES
--  ('les_intro_01','course_peopleos_intro',1,'<<강의 이름>>','r2','lms/videos/les_intro_01/<<파일>>.mp4','video/mp4',<<바이트>>,<<초>>);
```

- 유튜브 링크를 더 받으면 같은 형식으로 행을 추가한다 (`start_sec`·`end_sec`는 NULL).
- R2 강의 행은 `POST /api/lms/admin/lessons`로 넣어도 된다. 이 API는 `FILES.head`로 `size_bytes`·`content_type`을 채우므로 손으로 바이트 수를 적지 않아도 된다.

---

## 3. R2 영상 업로드·서빙 설계

### 3.1 기존 R2 사용 현황 [코드]

| 접두사 | 내용 | 위치 |
|---|---|---|
| `recordings/<id>/<파일>` | 녹음 원본 | `src/index.ts:735` |
| `documents/<id>.txt` / `.md` | 붙여넣은 텍스트·암묵지 문서 | `src/index.ts:539`, `1139` |
| `docs/<id>/source.<ext>`, `docs/<id>/extracted.md` | 업로드 원본과 추출본 | `src/index.ts:596`, `639` |
| `decks/<id>.pptx` | PPTX 초안 | `src/index.ts:1397` |
| `emails/<id>/raw.eml`, `emails/<id>/att/<attId>` | 메일 원문·첨부 | `src/email/inbound.ts:85`, `113` |
| 트레이스 원문 | 관측 | `src/obs/trace.ts` (`traceR2Key`) |

- **Range 요청을 쓰는 곳은 없다.** `FILES.get(key)`는 전부 옵션 없이 통째로 읽는다 (`src/`에서 `range` 검색 결과 R2 관련 0건).
- 새 접두사: **`lms/videos/<lessonId>/<파일명>`**. 영상을 바꿀 때는 덮어쓰지 않고 새 파일명으로 올린 뒤 `r2_key`를 바꾼다. 재생 중인 브라우저가 서로 다른 버전의 구간을 섞어 받지 않게 하기 위해서다.

### 3.2 업로드 경로 — `wrangler r2 object put` 권장

| 방법 | 한도 | 판단 |
|---|---|---|
| **`wrangler r2 object put`** | 파일당 315MB [문서] | 영상 1개에는 이것으로 충분. 코드가 필요 없다 |
| 관리자 업로드 API (Worker 경유) | 요청 본문 100MB (Free·Pro 도메인) [문서] | 기존 업로드 코드는 본문을 메모리에 다 읽는다(녹음 25MB, 문서 10MB 상한) [코드]. 영상에는 스트림 방식(`FILES.put(key, request.body)`)을 새로 짜야 한다. **공모전 범위에서 제외** |
| rclone / S3 API 멀티파트 | 5TiB [문서] | 315MB를 넘을 때만 |

절차:

1. 변환 (사용자 PC 또는 VM): `ffmpeg -i 원본 -c:v libx264 -preset medium -crf 23 -vf "scale=-2:720" -c:a aac -b:a 128k -movflags +faststart out.mp4`
   - `+faststart`는 색인(moov)을 파일 앞에 둬 재생 시작과 탐색이 빨라진다. H.264 + AAC MP4가 브라우저 호환이 가장 넓다 [일반 지식]. VM에 ffmpeg가 있는지는 확인 안 됨.
2. 업로드: `cf-wrangler.py r2 object put people-os-files/lms/videos/<lessonId>/<파일>.mp4 --file out.mp4 --content-type video/mp4 --remote`
   - `--content-type`, `--remote` 플래그 이름은 공식 문서 예시에 없었다 (예시는 `--file`만). 설치된 wrangler 3.95에서 `r2 object put --help`로 확인하고 쓴다.
3. 강의 행 등록: `POST /api/lms/admin/lessons` 또는 시드 SQL.

### 3.3 서빙 — `GET /api/lms/lessons/:id/video`

file-spooder의 흐름(크기 확인 → 단일 Range 파싱 → 범위 밖이면 416 → `get(key, {range:{offset,length}})` → 206)을 따르고 [참고], 인증과 D1 조회를 앞에 붙인다.

```
GET|HEAD /api/lms/lessons/:id/video
  viewer = getSessionUser(env, cookie)            → 없으면 401 JSON
  lesson = SELECT l.r2_key, l.content_type, l.size_bytes, c.status
           FROM lms_lessons l JOIN lms_courses c ON c.id = l.course_id
           WHERE l.id = ? AND l.source = 'r2'     → 없으면 404
  게시 안 된 과정(c.status != 'PUBLISHED')은 hr_admin만   → 아니면 404

  size = lesson.size_bytes ?? (await FILES.head(key))?.size   → 객체 없으면 404
  r = parseRange(request.headers.get('range'), size)
      · 헤더 없음, 형식 불량, 다중 범위("a-b,c-d")  → null (전체 200으로 응답)
      · "bytes=a-b" → {offset:a, length:min(b,size-1)-a+1}
      · "bytes=a-"  → {offset:a, length:size-a}
      · "bytes=-n"  → {offset:max(0,size-n), length:min(n,size)}
      · a >= size 또는 a > b                        → 416, Content-Range: bytes */<size>

  obj = await FILES.get(key, r ? { range: { offset: r.offset, length: r.length } } : undefined)
        → null이면 404
  obj.size != size 이면 (D1 값이 낡음) obj.size로 다시 계산한다

  공통 헤더:
    Content-Type: lesson.content_type || obj.httpMetadata?.contentType || 'video/mp4'
    Accept-Ranges: bytes
    ETag: obj.httpEtag
    Cache-Control: private, no-store
    X-Content-Type-Options: nosniff
  Range 있음 → 206, Content-Range: bytes <offset>-<offset+length-1>/<size>, Content-Length: <length>
  Range 없음 → 200, Content-Length: <size>
  HEAD → 같은 헤더, 본문 없음
  본문: new Response(obj.body, ...) — 스트림을 그대로 넘긴다. arrayBuffer()로 읽지 않는다.
```

구현 시 주의:

- **Safari는 첫 요청으로 `Range: bytes=0-1`을 보내고, 정확한 206·`Content-Range`가 아니면 재생하지 않는다** [일반 지식]. 8장에 curl 검증 항목을 넣었다.
- `If-Range`: R2는 `Headers`를 조건으로 넘길 때 `If-Range`만 지원하지 않는다 [문서]. 키를 바꾸지 않는 규칙(3.1)을 지키면 무시해도 안전하다. 처리한다면 `If-Range` 값이 `obj.httpEtag`와 다를 때 전체 200으로 응답한다.
- Hono가 GET 라우트로 HEAD를 처리해 주는지는 hono 4.6에서 확인 안 됨. O1에서 `curl -I`로 확인하고, 안 되면 `lmsApp.on(['GET','HEAD'], ...)`로 등록한다.
- 세션 쿠키는 `SameSite=Strict`지만 `<video>` 요청은 같은 출처라 쿠키가 실린다 [코드: `src/auth.ts` 쿠키 속성]. `<video>`에 `crossorigin` 속성을 넣지 않는다.
- `Cache-Control: private, no-store`는 기존 R2 다운로드 라우트(덱·문서·첨부)와 같다 [코드]. 로그아웃 뒤 캐시로 재생되는 것을 막는다. 되감기 때 구간을 다시 받지만 비용은 3.4처럼 무시할 수준이다.
- CPU 한도(Free 요청당 10ms)는 네트워크 대기 시간을 세지 않는다 [문서]. 스트림 중계는 세션 조회 + 강의 조회(D1 2회) + R2 1회뿐이라 여유가 있다. 응답 본문 크기 한도는 없고, 클라이언트가 붙어 있는 동안 스트림 시간 제한도 없다 [문서].

### 3.4 Free 한도 계산 (영상 1개 기준)

한도 [문서]: R2 저장 10GB-월, Class A 100만/월, Class B 1,000만/월, 전송 무료. `GetObject`·`HeadObject`는 Class B, `PutObject`·멀티파트는 Class A. Workers Free는 하루 100,000 요청.

가정(추정값 — 실제 요청 수는 8장에서 개발자 도구로 센다): 720p 20분 영상 약 200MB, 시청 1회에 Range 요청 20~50건(탐색할수록 늘고, Safari가 더 잘게 요청한다).

| 항목 | 사용량 | 한도 대비 |
|---|---|---|
| 저장 | 0.2GB | 10GB의 2% |
| 업로드 (Class A) | 1건 (멀티파트면 수십 건) | 100만의 0.01% 미만 |
| 읽기 (Class B) | 시청 500회 × 50건 = 25,000건/월 | 1,000만의 0.25% |
| Worker 요청 | 하루 시청 100회 × 50건 = 5,000건 | 100,000의 5% |
| 전송 | 500회 × 200MB = 100GB | R2 전송은 무료 |

- 심사 기간에 시청이 몰려도 병목은 R2가 아니라 Workers 하루 100,000 요청이다. 위 가정으로 하루 약 2,000회 시청까지 된다(앱의 다른 요청을 빼고).
- D1 Free 한도 수치는 이번에 문서로 확인하지 않았다. 요청당 D1 조회는 2회(행 2~3개)다.

---

## 4. 유튜브 재생 설계

저장소 4곳(talent-navigator, easy-slides, flowdesk-cloud, ileet)에서 가져올 유튜브 코드는 없다. 이번에 주요 소스 파일을 `get_file_contents`로 다시 훑었고(아래), 앞선 `groupware-approval-plan.md` 5.1의 결론과 같다.

| 저장소 | 읽은 파일 | 결과 |
|---|---|---|
| talent-navigator | `worker/` 의 index·ui·templates·candidate·competency·talent-card·export, README | `youtu`·`iframe`·`<video` 0건 |
| easy-slides | `site/public/app.js`, `pptx-export.js`, `site/app/page.tsx` | 유튜브 없음. `iframe`은 HTML 슬라이드용 `sandbox="allow-scripts"` 프레임과 가져온 HTML에서 `iframe` 제거 |
| flowdesk-cloud | `src/App.tsx`, `src/components/*.tsx` 9개, `src/core/slides.mjs`, `types.ts`, README | 0건 |
| ileet | `app/` 의 workspace·editor·framework-explorer·management·file-panel, README | 0건 |

읽지 않은 것: 각 저장소의 tests·scripts·vendor, easy-slides `library/manifest.json`(2.8MB), flowdesk-cloud `slides-presets.mjs`(524KB), ileet의 나머지 작은 화면 파일. 그래서 유튜브 재생은 새로 만든다. 가져올 것은 원칙 하나다: iframe은 사용자 입력 HTML에 섞지 않고 전용 플레이어 코드에서만, 검증된 값으로 만든다 (easy-slides·flowdesk-cloud의 방식).

### 4.1 임베드

```html
<iframe class="lms-frame"
  src="https://www.youtube-nocookie.com/embed/ZN37IV4sbQg?start=1142&end=2211&rel=0"
  title="강의 제목" loading="lazy" allowfullscreen
  referrerpolicy="strict-origin-when-cross-origin"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"></iframe>
```

- **`youtube-nocookie.com`을 쓴다.** 재생 전에는 추적 쿠키를 심지 않는 유튜브의 개인정보 보호 모드다 [일반 지식]. HR 플랫폼이라 기본값으로 맞다.
- iframe은 사용자가 강의를 눌렀을 때만 만든다. 목록 화면에서는 유튜브에 아무 요청도 보내지 않는다(썸네일 제외).
- `youtube_id`는 서버에서 `^[A-Za-z0-9_-]{11}$`로 검증해 저장하고, 프런트는 이 id와 정수 `start_sec`/`end_sec`만으로 URL을 조립한다. URL 전체를 DB에 저장해 그대로 `src`에 넣지 않는다.
- 관리자 API는 `youtube_url`도 받아 서버에서 id를 뽑는다 (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/` 형식).
- `referrerpolicy`를 명시하는 이유: 리퍼러가 없으면 유튜브 플레이어가 오류(153)를 내는 사례가 있다 [일반 지식]. 라이브 검증 항목이다.
- **해당 영상이 외부 임베드를 허용하는지는 확인 안 됨**이다. 게시자가 임베드를 막았으면 iframe에 "동영상을 재생할 수 없음"이 뜬다. S2 검증에서 실제 재생으로 확인하고, 막혀 있으면 "유튜브에서 보기" 링크로 대체한다.

### 4.2 썸네일

- `https://i.ytimg.com/vi/<youtube_id>/mqdefault.jpg` (320×180, 16:9), 큰 것이 필요하면 `hqdefault.jpg` [일반 지식].
- 과정 카드에만 쓴다 (`lms_courses.thumbnail_url`이 NULL이면 첫 유튜브 강의의 id로 만든다). 이번 과정은 14개 강의가 같은 영상이라 강의 목록에는 썸네일 대신 번호와 구간 길이를 보여준다.
- R2 영상만 있는 과정은 썸네일이 없으므로 재생 아이콘이 든 단색 카드를 쓴다.

### 4.3 완료 처리

- 1순위: 플레이어 아래 **"수강 완료" 버튼** (유튜브·R2 공통). 데모에서 결과가 확실하다.
- R2 영상: `<video>`의 `ended` 이벤트에서 자동 완료.
- 2순위(O1 선택 과제): 유튜브 IFrame Player API(`enablejsapi=1`)로 종료 상태를 받아 자동 완료 + 위치 저장. 외부 스크립트(`youtube.com/iframe_api`)를 불러와야 하므로 시간이 남을 때만 한다.

---

## 5. API 설계

`src/lms/routes.ts`에 `lmsApp`(Hono 하위 앱)을 만들고 `src/index.ts`에서 `app.route("/api/lms", lmsApp)`으로 붙인다. 위치는 메일함 mount 바로 아래, 캐치올 `app.all("*")` 앞이다 [코드: `src/index.ts:1789~1792`].

기존 스타일 [코드: `src/email/routes.ts`]:

- 응답은 `{ ok: true, ... }` / `{ ok: false, error: "한국어 메시지" }`.
- 로그인 필수 라우트는 `getSessionUser(c.env, c.req.header("cookie"))`가 null이면 401 "로그인이 필요합니다."
- 관리자 라우트는 `isAdminRequest(env, cookie, x-admin-secret)` (hr_admin 세션 또는 `X-Admin-Secret`), 아니면 403.
- 스키마 누락은 503. id는 `uid("course")`, `uid("les")` (`src/lib.ts`).
- 바인딩 타입: `type LmsEnv = { DB: D1Database; FILES: R2Bucket; ADMIN_SECRET?: string }`.

| 메서드·경로 | 권한 | 입력 | 출력 |
|---|---|---|---|
| `GET /api/lms/courses` | 로그인 | — | `{ok, courses:[{id,title,description,category,thumbnail,lesson_count,completed_count}]}`. 일반 사용자는 `PUBLISHED`만, hr_admin은 전체(+`status`) |
| `GET /api/lms/courses/:id` | 로그인 | — | `{ok, course, lessons:[{id,ord,title,source,youtube_id,start_sec,end_sec,duration_sec,curator_note,completed,completed_at,position_sec}]}`. `r2_key`는 내보내지 않는다. 미게시 과정은 hr_admin 외 404 |
| `POST /api/lms/lessons/:id/progress` | 로그인 (세션 필수 — `X-Admin-Secret`만으로는 401) | `{completed?: boolean, position_sec?: number}` | `{ok, lesson_id, completed, completed_at, position_sec, course:{lesson_count,completed_count}}`. 없는 강의는 404 |
| `GET /api/lms/lessons/:id/video` | 로그인 | `Range` 헤더 | 200 / 206 / 416 영상 바이트 (3.3). 오류는 JSON |
| `GET /api/lms/summary` | 로그인 | — | `{ok, lesson_count, completed_count, next:{course_id,course_title,lesson_id,lesson_title}|null}` — 홈 카드용. `next`는 게시 과정의 첫 미완료 강의 |
| `POST /api/lms/admin/courses` | hr_admin 또는 `X-Admin-Secret` | `{id?,title,description?,category?,ord?,status?}` | `{ok, id}` — id가 있으면 갱신(upsert) |
| `POST /api/lms/admin/lessons` | 같음 | `{id?,course_id,ord,title, youtube_url? | youtube_id? | r2_key?, start_sec?,end_sec?,duration_sec?,curator_note?}` | `{ok, id}`. r2면 `FILES.head`로 `size_bytes`·`content_type`을 채우고, 객체가 없으면 400 |
| `DELETE /api/lms/admin/lessons/:id` | 같음 | — | `{ok, id}`. 강의 행과 그 진도 행을 `DB.batch`로 함께 삭제. R2 객체는 지우지 않는다 |
| `GET /api/lms/admin/progress` (2순위) | 같음 | `?course_id=` | `{ok, users:[{user_id,name,completed_count,lesson_count,last_at}]}` — hr_admin의 수강 현황 |

격리 규칙:

- 진도의 `user_id`는 **항상 세션 사용자 id**다. 본문·쿼리로 받지 않는다. 그래서 타인의 진도를 읽거나 쓸 경로가 없다. 예외는 관리자 전용 `admin/progress` 하나다.
- 과정·강의 자체는 공용 콘텐츠다(`owner_id` 없음). 개인 RAG의 `owner_id` 격리에 해당하는 것은 `lms_progress.user_id`다.
- 진도 응답과 목록 응답은 `cache-control: no-store` (기존 `/api/tasks`와 같음) [코드].

진도 UPSERT (동시성의 핵심 — 한 문장으로 끝낸다):

```sql
INSERT INTO lms_progress (user_id, lesson_id, position_sec, completed_at, updated_at)
VALUES (?1, ?2, COALESCE(?3, 0), CASE WHEN ?4 = 1 THEN ?5 END, ?5)
ON CONFLICT(user_id, lesson_id) DO UPDATE SET
  position_sec = COALESCE(?3, lms_progress.position_sec),
  completed_at = CASE
                   WHEN ?4 = 1 THEN COALESCE(lms_progress.completed_at, excluded.completed_at)
                   WHEN ?4 = 0 THEN NULL
                   ELSE lms_progress.completed_at
                 END,
  updated_at = excluded.updated_at;
-- ?1 user_id(세션), ?2 lesson_id, ?3 position_sec 또는 NULL, ?4 completed: 1/0/NULL(미지정), ?5 현재 시각 ISO
```

- 위치만 보내는 주기 저장(`completed` 미지정)이 완료 표시를 지우지 못한다.
- 완료를 두 번 눌러도 첫 완료 시각이 유지된다(멱등). 두 탭에서 동시에 눌러도 결과가 같다.
- "읽고 → 판단하고 → 쓰기"를 코드에서 나누지 않는다. 기존 `/api/tasks/:id` PATCH는 SELECT 뒤 UPDATE라 경합 여지가 있는데 [코드], 그 방식을 따라 하지 않는다.

---

## 6. UI 설계

프런트는 메일함 선례대로 분리한다: `public/lms.js`(목록·상세·홈 카드), `public/lms-player.js`(플레이어), `public/lms.css`. `index.html` 인라인 스크립트의 전역 `$`, `api`, `esc`, `escAttr`, `currentUser`를 쓴다 [코드: `public/email.js` 첫 줄 주석].

### 6.1 메뉴 위치

현재 순서 [코드: `index.html` 81~91행, `TABS` 406행]: 홈, 메일함, 할 일, 녹음전사.문서저장, 코칭 리플렉션, 개인 업무 검색, HR 규정 검색, 라이브러리, 관측·평가, 사용자 관리, 소개.

제안: **코칭 리플렉션 바로 다음에 "강의실"** — 코칭에서 학습으로 이어지는 흐름이다 (`groupware-approval-plan.md` 6.1과 같은 위치).

`index.html` 수정 지점 (전부 S2 담당):

| 위치 | 변경 |
|---|---|
| `<head>` 11행 근처 | `<link rel="stylesheet" href="/lms.css" />` |
| 사이드바 85행(coaching 버튼) 다음 | `<button data-tab="lms">` + 아이콘(기존과 같은 24px stroke SVG, 재생 삼각형이 든 화면 모양) + "강의실" |
| `tab-coaching` 섹션 다음 | `<section id="tab-lms">` (6.2 구조) |
| 400행(`email.js`) 다음 | `<script src="/lms-player.js"></script>`, `<script src="/lms.js"></script>` |
| `TABS` 406행 | `'coaching'` 뒤에 `'lms'` |
| `COACHEE_TABS` 414행 | `'lms'` 추가 (코칭 대상도 수강한다) |
| `switchTab` 444~452행 | `if (name === 'lms') lmsOpen(); else lmsLeave();` |
| `applyRole` 747행 | 익명에게 숨기는 탭 목록에 `lms` 추가 (personal·email과 같이) |
| `loadHome` 949행 | 끝에서 `lmsHomeCard()` 호출 |

- **`lmsLeave()`가 꼭 필요하다.** 탭 전환은 섹션을 `display:none`으로만 바꾸므로 [코드: `styles.css:140`], 플레이어를 내리지 않으면 다른 탭에서도 소리가 계속 난다. `lmsLeave()`는 `<video>`를 멈추고 iframe을 DOM에서 제거한다.
- 해시 라우터는 `obs`만 하위 경로를 허용한다 (`if (name !== 'obs') sub = ''`) [코드]. 강의실은 메일함처럼 탭 안 상태로 화면을 바꾸고 라우터는 건드리지 않는다. 주소는 `#lms` 하나다.

### 6.2 강의실 탭 구조

```
[과정 목록]  (#lmsListCard)
  ┌─ 과정 카드 ──────────────┐  ┌─ 과정 카드 ──────────────┐
  │ [썸네일 16:9]            │  │ [재생 아이콘 단색]        │
  │ 2026 클로드 올인원 무료강의│  │ <<R2 과정 이름>>          │
  │ 강의 14개 · 3/14 완료     │  │ 강의 1개 · 완료           │
  │ ▓▓▓░░░░░░░ 21%           │  │ ▓▓▓▓▓▓▓▓▓▓ 100%          │
  └──────────────────────────┘  └──────────────────────────┘

[과정 상세]  (#lmsCourseCard — 카드를 누르면 목록 대신 표시)
  ← 과정 목록    2026 클로드 올인원 무료강의        3/14 완료 ▓▓▓░░░
  ┌─ 플레이어 (16:9) ───────────────┐ ┌─ 강의 목록 ─────────────────┐
  │ <iframe> 또는 <video controls>  │ │ ✓ 1. 핵심 기능 20분 총정리 19분│
  │                                 │ │ ✓ 2. AI PPT 올인원        18분│
  └─────────────────────────────────┘ │ ▶ 3. 이걸 모르고 쓰면…    12분│  ← 재생 중
  3. 이걸 모르고 쓰면 클로드는…        │   4. AI 잘 쓰는 90%가…    10분│
  [수강 완료] [다음 강의 →]            │   …                          │
                                      └──────────────────────────────┘
```

- 과정 목록: `GET /api/lms/courses`. 카드 그리드(`repeat(auto-fill, minmax(260px, 1fr))`), 진도 막대, 전부 끝낸 과정은 `badge ok` "수료".
- 과정 상세: `GET /api/lms/courses/:id`. 들어가면 첫 미완료 강의를 선택만 해 두고, 자동 재생은 하지 않는다(브라우저 자동 재생 정책과 데모 녹화를 고려).
- 강의 행: 완료 ✓(`--color-ok`), 재생 중 강조(`--color-primary-soft`), 구간 길이는 `end_sec - start_sec` 또는 `duration_sec`.
- "수강 완료"를 누르면 `POST .../progress {completed:true}` → 행에 ✓, 진도 막대 갱신, 버튼은 "완료 취소"로 바뀐다(`{completed:false}`). 데모를 다시 찍을 때 쓴다.
- 720px 이하에서는 강의 목록이 플레이어 아래로 내려간다 (메일함 반응형 기준과 같다).
- 디자인 토큰은 기존 것만 쓴다: `.card`, `.badge`, `.btnrow`, `.empty`, `--color-primary`, `--color-line`, `--space-*` [코드: `styles.css`].
- 빈 상태: 과정이 없으면 `.empty` "아직 등록된 과정이 없습니다." 스키마가 없으면(503) 서버의 안내 문구를 그대로 보여준다.
- 관리 화면(과정 추가·업로드)은 만들지 않는다. hr_admin에게는 과정 카드에 `DRAFT` 배지만 보인다.

플레이어 계약 (`lms-player.js`, O1 담당 — S2는 이 함수만 부른다):

```js
// lesson: GET /courses/:id 의 lessons[] 항목. onComplete: 자동 완료 시 호출. onPosition: 위치 저장 시 호출(선택).
lmsPlayerMount(containerEl, lesson, { onComplete, onPosition });
lmsPlayerUnmount();   // 재생 중지 + DOM 제거. 강의 전환·탭 이탈·과정 목록 복귀 때 부른다.
```

### 6.3 홈 카드 — 추가한다

- 위치: "최근 리플렉션" 카드 다음. 제목 **"이어서 듣기"**.
- 내용: `GET /api/lms/summary` → "3/15 강의 완료" + 진도 막대 + 다음 강의 제목 + 버튼 "강의실 열기 →" (`switchTab('lms')`). 전부 끝냈으면 "모든 강의를 마쳤습니다."
- 익명이거나 과정이 없으면 카드를 숨긴다.
- 상단 통계 타일(`.stats`)은 4칸 고정 그리드라 [코드: `styles.css:189`] 건드리지 않는다.
- `/api/home`은 수정하지 않는다. 홈 카드가 따로 `/api/lms/summary`를 부른다 (메일함 카드가 `/api/email/inbox`를 따로 부르는 것과 같다) [코드: `loadHome`]. `src/index.ts` 변경을 mount 한 곳으로 줄이기 위해서다.

---

## 7. 구현 작업 분할 — Sonnet 5.5 vs Opus 5.5

원칙: 세션 하나는 모델 하나, 과제 전체를 프롬프트 한 번에 준다 (AGENTS.md). 세션끼리 같은 파일을 만지지 않게 나눴다. 순서는 **S1 → O1 → S2 → 배포·라이브 검증**.

| 세션 | 모델 | 작업 | 만지는 파일 | 판단 근거 |
|---|---|---|---|---|
| **S1** | Sonnet 5.5 | 마이그레이션 0023 | `migrations/0023_lms.sql` (신규) | 2.2의 SQL을 그대로 옮긴다 |
| | | 시드 파일 | `seeds/lms_seed_v1.sql` (신규) | 2.4의 값이 정해져 있다 |
| | | API 뼈대: courses 목록·상세, summary, admin upsert·삭제, 유튜브 id 추출·검증, 503 가드 | `src/lms/routes.ts` (신규) | 메일함 라우트와 같은 모양의 조회·입력 검증이다 |
| | | mount + import | `src/index.ts` (2줄) | 위치가 정해져 있다 (5장) |
| | | 자리 표시 2개: `handleVideo()`와 `saveProgress()`가 501을 돌려주는 빈 구현 | `src/lms/stream.ts`, `src/lms/progress.ts` (신규) | O1이 채울 파일의 함수 서명만 고정한다 |
| **O1** | Opus 5.5 | Range 스트리밍 (3.3 전체: 파싱, 206/200/416, HEAD, 인증·게시 상태 게이트, 헤더) | `src/lms/stream.ts` | 경계 조건이 많고 틀리면 Safari에서 재생이 안 된다. 인증 누락은 영상 유출이다 |
| | | 진도 저장 (5장의 UPSERT, 입력 검증, 과정 집계 반환) | `src/lms/progress.ts` | 동시 요청·멱등성 의미를 지켜야 한다. SQL은 주어졌지만 검증까지 한 세션에서 한다 |
| | | 플레이어: `<video>`/iframe 생성, `ended` 자동 완료, 언마운트 시 정지, (2순위) 위치 저장·이어보기, (2순위) 유튜브 IFrame API | `public/lms-player.js` (신규) | 브라우저 이벤트 수명주기와 정리 누락(소리 계속 남)이 까다롭다 |
| | | 로컬 검증 스크립트 (curl Range 표) | `files/lms-verify/` (작업 디렉터리 안 — `/tmp` 금지) | 8.1을 실행 가능한 형태로 남긴다 |
| **S2** | Sonnet 5.5 | 강의실 화면: 과정 목록, 과정 상세, 완료 버튼, 진도 막대 | `public/lms.js`, `public/lms.css` (신규) | `email.js`와 같은 패턴의 렌더링이다 |
| | | 메뉴·섹션·스크립트 연결, `TABS`/`COACHEE_TABS`/`switchTab`/`applyRole` | `public/index.html` (6.1 표의 9곳) | 수정 지점이 줄 번호까지 정해져 있다 |
| | | 홈 카드 "이어서 듣기" | `public/index.html`, `public/lms.js` | 조회 1건 + 카드 1개 |
| | | (선택) 소개 탭·README에 강의실 한 줄 | `public/index.html`, `README.md` | 문구 추가 |
| **배포** | 사용자 승인 뒤 Merlin 또는 Opus | 원격 마이그레이션, 영상 업로드, 시드, 배포, 8.2 라이브 확인 | 운영 리소스 | 되돌리기 어려운 작업이라 사람 확인을 거친다 |

세션 사이 계약 (S1이 고정하고 O1·S2가 따른다):

```ts
// src/lms/stream.ts
export async function handleVideo(c: Context<{ Bindings: LmsEnv }>): Promise<Response>;
// src/lms/progress.ts
export async function saveProgress(env: LmsEnv, userId: string, lessonId: string,
  input: { completed?: boolean; position_sec?: number }): Promise<
  { ok: true; lesson_id: string; completed: boolean; completed_at: string | null; position_sec: number;
    course: { lesson_count: number; completed_count: number } } | { ok: false; status: 400 | 404; error: string }>;
```

- `routes.ts`는 `/lessons/:id/video`와 `/lessons/:id/progress`를 등록만 하고 위 함수를 부른다. O1은 `routes.ts`를 고치지 않는다 (HEAD 등록이 필요해질 때만 예외, 3.3).
- S2는 6.2의 `lmsPlayerMount`/`lmsPlayerUnmount`만 부른다.

세션 준비 사항 (`-p` 세션 권한, AGENTS.md 기준):

- `~/.claude/settings.json`의 `Edit(...)` 규칙이 `files/people-os/**`를 덮는지 확인한다.
- O1의 로컬 검증에는 로컬 R2에 테스트 객체를 넣는 명령이 필요하다. 현재 허용 규칙에 없으므로 세션 시작 전에 `Bash(npx wrangler r2 object put * --local)`을 추가한다. 없으면 O1이 "검증 못 함"으로 끝난다.
- 이 자문 세션에서도 `python3` 실행과 일부 도메인 접근이 승인 대기로 막혔다. 구현 세션에 필요한 명령은 미리 허용 목록에 넣는다.

일정 제안: 11-18 S1, 11-19 O1, 11-20 S2, 11-21 영상 업로드·시드·배포·라이브 확인, 11-22~24 여유, 11-25 동결.

---

## 8. 검증 체크리스트

### 8.1 로컬 (workerd)

준비:

- `npx tsc --noEmit` 통과.
- `npx wrangler dev --local --port <포트>` — 출력을 `head`로 자르지 않는다. curl은 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY curl ...` (AGENTS.md).
- `npx wrangler d1 execute people-os-db --local --file migrations/0023_lms.sql`, 이어서 시드 파일.
- 로컬 로그인: `.dev.vars`에 `PASSWORD_PEPPER`, `BOOTSTRAP_SECRET`, `ADMIN_SECRET` 항목이 있다 [코드]. `/api/bootstrap`으로 관리자를 만들고 `/api/admin/users`로 일반 사용자 2명(A, B)을 만든 뒤 `/api/auth/login` 응답의 쿠키 값을 `-H "cookie: people_os_session=..."`로 싣는다.
- 테스트 객체: 내용을 아는 작은 파일(예: 1,000바이트 텍스트)을 `lms/videos/les_test/test.bin`에 로컬 R2로 올리고 r2 강의 행을 넣는다. Range 정확성은 실제 영상 없이 바이트 비교로 확인할 수 있다.

| # | 확인 | 기대 |
|---|---|---|
| L1 | 쿠키 없이 `GET /api/lms/courses`, `/courses/:id`, `/summary`, `POST /lessons/:id/progress`, `GET /lessons/:id/video` | 전부 401 |
| L2 | 마이그레이션 적용 전 `GET /api/lms/courses` | 503 + 안내 문구 |
| L3 | A로 `GET /api/lms/courses` | 과정 2개, `lesson_count` 14와 1, `completed_count` 0 |
| L4 | `GET .../video` Range 없음 | 200, `Accept-Ranges: bytes`, `Content-Length` = 전체 크기 |
| L5 | `Range: bytes=0-1` | 206, `Content-Range: bytes 0-1/1000`, 본문 2바이트 |
| L6 | `Range: bytes=100-199` | 206, 본문이 원본의 100~199바이트와 같다 |
| L7 | `Range: bytes=900-` / `bytes=-100` | 둘 다 206, `Content-Range: bytes 900-999/1000` |
| L8 | `Range: bytes=500-5000` (끝이 크기 초과) | 206, `bytes 500-999/1000` |
| L9 | `Range: bytes=1000-` (시작이 크기 이상) | 416, `Content-Range: bytes */1000` |
| L10 | `Range: bytes=0-1,5-6` / `Range: abc` | 200 전체 (Range 무시) |
| L11 | `curl -I` (HEAD) | 200, 헤더만 |
| L12 | 없는 강의 id / 유튜브 강의 id로 `/video` | 404 |
| L13 | 응답에 `r2_key`가 없다 (`/courses/:id`) | 없음 |
| L14 | A가 `progress {completed:true}` → A의 `/courses/:id` | 해당 강의 `completed:true`, `completed_count` 1 |
| L15 | **B의 `/courses/:id`** | 같은 강의 `completed:false` (타인 진도 격리) |
| L16 | A가 같은 완료를 두 번 | `completed_at`이 첫 값 그대로 |
| L17 | A가 `{position_sec:120}`만 전송 | 위치만 바뀌고 완료는 유지 |
| L18 | A가 완료 요청 10개를 동시에 (`curl &` 병렬) | 행 1개, 오류 없음 |
| L19 | 본문에 `user_id`를 넣어 보냄 | 무시되고 세션 사용자 것으로만 저장 |
| L20 | 일반 사용자로 `POST /admin/lessons` | 403. `X-Admin-Secret`으로는 성공 |
| L21 | `X-Admin-Secret`만으로 `POST /lessons/:id/progress` | 401 |
| L22 | `POST /admin/lessons`에 `youtube_url` 여러 형식, 잘못된 id | 올바른 11자 id 저장 / 400 |

### 8.2 라이브 (peopleos.site, 배포 버전 ID를 기록)

| # | 확인 | 기대 |
|---|---|---|
| V1 | 비로그인 상태로 `curl https://peopleos.site/api/lms/courses`, `.../video` | 401 |
| V2 | 로그인 → 사이드바에 "강의실"이 코칭 리플렉션 아래에 보인다 (일반 사용자, 코칭 대상, hr_admin 각각) | 보임 |
| V3 | 과정 목록에 과정 2개, 썸네일 표시 | 표시 |
| V4 | **R2 영상 재생** (Chrome) | 재생 시작. 개발자 도구 Network에서 `/video` 요청이 206 |
| V5 | **R2 영상 탐색(seek)** — 중간·끝 근처로 이동 | 바로 이어서 재생. 새 Range 요청이 206 |
| V6 | R2 영상을 Safari(가능하면 iOS)에서 재생·탐색 | 재생됨 (`bytes=0-1` 응답 확인) |
| V7 | 시청 1회의 `/video` 요청 수를 센다 | 3.4의 가정(20~50건)과 비교해 기록 |
| V8 | **유튜브 재생** — 챕터 2 선택 | 19:02부터 시작해 구간 끝에서 멈춘다. 오류 화면(임베드 차단·153) 없음 |
| V9 | 유튜브 iframe 주소가 `youtube-nocookie.com` | 맞음 |
| V10 | **진도 저장** — "수강 완료" → 새로고침 | ✓ 유지, 진도 막대·홈 카드 숫자 일치 |
| V11 | **타인 진도 격리** — 다른 계정으로 로그인 | 그 계정은 0건 |
| V12 | 재생 중 다른 탭(메일함)으로 이동 | 소리가 멈춘다 |
| V13 | R2 영상을 끝까지 재생 | 자동으로 완료 표시 |
| V14 | 로그아웃 뒤 영상 주소를 직접 연다 | 401 |
| V15 | 홈 "이어서 듣기" 카드 → 강의실 이동 | 이동, 다음 강의가 맞다 |
| V16 | 기존 기능 회귀: 홈, 메일함, 할 일, 코칭, 검색, 관측 탭 열기 | 이상 없음 (`index.html` 수정 영향 확인) |
| V17 | 모바일 폭(720px 이하) | 강의 목록이 플레이어 아래로 |

---

## 9. 열린 질문 (사용자 결정 필요)

1. **R2 영상 파일**: 어떤 영상을 올릴지, 길이·용량·형식은? 315MB 이하 MP4면 wrangler 한 번으로 올린다. 변환(ffmpeg)을 사용자 PC에서 할지 VM에서 할지도 정해야 한다(VM의 ffmpeg 유무는 확인 안 됨). 파일이 11-21까지 없으면 People OS 데모 화면 녹화 같은 대체 영상을 쓸지.
2. **유튜브 URL 목록**: 지금 받은 것은 1개(`ZN37IV4sbQg`, 3시간)다. 요청서의 "유튜브 링크 몇 개"에 맞춰 더 줄 링크가 있는지. 없으면 챕터 14개를 강의 14개로 나누는 2.4의 시드로 간다 — 이 방식이 괜찮은지.
3. **과정·강의 이름**: R2 영상을 담을 과정 이름과 강의 제목. 유튜브 과정 이름은 원제 "2026 클로드 올인원 무료강의"를 그대로 쓸지, 사내 과정처럼 바꿀지(예: "AI 업무 활용 기초").
4. **수강 대상 범위**: 로그인한 전 직원이 모든 게시 과정을 보는 것으로 설계했다(코치·코칭 대상 구분 없음, 익명 불가). 대상 구분이나 의무교육 표시가 공모전 데모에 필요한지.
5. **제3자 유튜브 영상 사용**: 해피AI 채널 영상을 임베드로 데모 영상·제출물에 노출해도 되는지(임베드 허용 여부는 V8에서 기술적으로만 확인된다). 걸리면 자체 영상이나 Cloudflare 공식 영상으로 바꾼다.
6. **완료 기준**: "수강 완료" 버튼 + R2 영상 끝까지 재생 시 자동 완료로 충분한지, 유튜브도 자동 완료(IFrame API, 2순위)가 필요한지.
7. **hr_admin 수강 현황 화면**: `GET /api/lms/admin/progress`와 표 하나(누가 몇 강의를 끝냈나)를 넣을지. HR 플랫폼 데모로는 설득력이 있지만 2순위로 뒀다.
8. **허용 규칙 추가**: 7장의 `Bash(npx wrangler r2 object put * --local)`과 필요 시 ffmpeg 실행 규칙을 `~/.claude/settings.json`에 넣어도 되는지.
