-- LMS O1 로컬 검증 전용 (원격에 쓰지 말 것). 실행: npx wrangler d1 execute people-os-db --file files/lms-verify/test-data.sql --local
-- 전제: migrations/0023_lms.sql, seeds/lms_seed_v1.sql, files/lms-s1-verify/users.sql (사용자 A/B + 세션 쿠키 lmsS1tokenA/B).
-- test.bin(1,000바이트)을 로컬 R2 lms/videos/les_test/test.bin에 올린 뒤 쓴다.
INSERT OR IGNORE INTO lms_courses (id, title, description, category, ord, status) VALUES
 ('course_o1_test',  'O1 테스트 과정',        'Range 검증용', 'JOB', 90, 'PUBLISHED'),
 ('course_o1_draft', 'O1 미게시 테스트 과정', '게시 게이트 검증용', 'JOB', 91, 'DRAFT');
INSERT OR IGNORE INTO lms_lessons (id, course_id, ord, title, source, r2_key, content_type, size_bytes, duration_sec) VALUES
 ('les_test',       'course_o1_test',  1, 'Range 테스트 (1,000바이트)', 'r2', 'lms/videos/les_test/test.bin', 'application/octet-stream', 1000, 10),
 ('les_test_stale', 'course_o1_test',  2, 'D1 크기가 낡은 행 (실제 1,000)', 'r2', 'lms/videos/les_test/test.bin', 'application/octet-stream', 5, 10),
 ('les_test_noobj', 'course_o1_test',  3, 'R2 객체 없음', 'r2', 'lms/videos/les_test/missing.bin', 'video/mp4', 123, 10),
 ('les_test_draft', 'course_o1_draft', 1, '미게시 과정의 영상', 'r2', 'lms/videos/les_test/test.bin', 'application/octet-stream', 1000, 10);
-- 반복 실행 시 진도 초기화 (테스트 사용자 A/B만).
DELETE FROM lms_progress WHERE user_id IN ('lms-s1-user-a', 'lms-s1-user-b');
UPDATE users SET role = 'user' WHERE id IN ('lms-s1-user-a', 'lms-s1-user-b');
