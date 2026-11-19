-- 고정 id 일정 (검증용). p1: A 개인, 자정 KST에 걸침 / t1: A 팀 / d1: A 종일(11/21 KST) / t2: A 팀 (삭제용)
INSERT INTO calendar_events(id,owner_id,visibility,title,all_day,start_at,end_at,start_date,end_date) VALUES
 ('cal_p1','u_a','private','A 개인 (23:00~01:00 KST)',0,'2026-11-20T14:00:00Z','2026-11-20T16:00:00Z',NULL,NULL),
 ('cal_t1','u_a','team','팀 회식',0,'2026-11-25T03:00:00Z','2026-11-25T05:00:00Z',NULL,NULL),
 ('cal_t2','u_a','team','삭제용 팀',0,'2026-11-26T03:00:00Z','2026-11-26T05:00:00Z',NULL,NULL),
 ('cal_d1','u_a','private','종일 11/21',1,'2026-11-20T15:00:00Z','2026-11-21T15:00:00Z','2026-11-21','2026-11-22');
