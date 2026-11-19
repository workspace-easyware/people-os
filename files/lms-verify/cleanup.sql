-- O1 로컬 테스트 행 제거 (로컬 전용). 실행: npx wrangler d1 execute people-os-db --file files/lms-verify/cleanup.sql --local
-- S2가 로컬 화면에서 테스트 과정을 보고 싶지 않을 때 쓴다. 로컬 R2 test.bin은 남아 있어도 무해하다.
DELETE FROM lms_progress WHERE lesson_id IN ('les_test','les_test_stale','les_test_noobj','les_test_draft');
DELETE FROM lms_lessons WHERE course_id IN ('course_o1_test','course_o1_draft');
DELETE FROM lms_courses WHERE id IN ('course_o1_test','course_o1_draft');
DELETE FROM lms_progress WHERE user_id IN ('lms-s1-user-a','lms-s1-user-b');
