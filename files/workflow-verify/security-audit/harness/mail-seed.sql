-- 로컬 전용: 사용자 B에게 최근 24시간 보낸 메일 200행을 만들어 하루 발송 상한(429)을 시험한다. 실제 발송 없음.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
INSERT INTO emails (id, owner_id, direction, from_addr, to_addr, subject, body_text, received_at, thread_id, subject_norm, is_read, created_at)
SELECT 'em_sec_' || i, 'u_b', 'out', 'userb@peopleos.site', 'nobody@example.invalid', '상한 시험', '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'em_sec_' || i, '상한 시험', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM n;
