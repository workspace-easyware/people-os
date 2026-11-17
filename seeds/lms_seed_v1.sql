-- seeds/lms_seed_v1.sql (멱등: INSERT OR IGNORE + 고정 id). 마이그레이션이 아님 — d1 execute --file로 적용.
-- 적용 순서: migrations/0023_lms.sql 먼저.
-- 주의: R2 강의의 r2_key는 이미 업로드된 실제 키 `lms/sample.mp4`를 그대로 쓴다.
--       lms-plan.md 3장의 `lms/videos/<lessonId>/` 키 형식은 제안일 뿐이고, 실제 업로드된 키가 우선이다.
INSERT OR IGNORE INTO lms_courses (id, title, description, category, ord, status) VALUES
 ('course_storytelling', '스토리텔링: 내 이야기 바꾸면, 사람이 움직인다', '챕터 3개 — 1. 인류의 가장 오래된 소통 / 2. 나를 정의하는 이야기 / 3. 세상과 연결되는 법', 'JOB', 1, 'PUBLISHED'),
 ('course_claude_allinone', '2026 클로드 올인원 무료강의', '해피AI 채널 — Claude 업무자동화 3시간 총정리', 'JOB', 2, 'PUBLISHED');

-- R2 영상 강의 1개 (버킷 people-os-files, 32,942,962 bytes, 270초). 챕터별 타임스탬프가 없어 분할하지 않는다.
INSERT OR IGNORE INTO lms_lessons (id, course_id, ord, title, source, r2_key, content_type, size_bytes, duration_sec) VALUES
 ('les_storytelling_01', 'course_storytelling', 1, '스토리텔링: 내 이야기 바꾸면, 사람이 움직인다', 'r2', 'lms/sample.mp4', 'video/mp4', 32942962, 270);

-- 유튜브 영상 ZN37IV4sbQg (해피AI, 약 3시간) 챕터 14개. start_sec/end_sec는 초.
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
