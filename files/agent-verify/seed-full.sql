-- A1 검증 데이터 (전체 마이그레이션 0001~0024가 적용된 격리 DB용).
-- 표식: 제목·질문에 AV-A- / AV-B- / AV-NULL- / AV-EVAL- 을 넣어 응답에서 grep으로 센다.
DELETE FROM recordings WHERE id LIKE 'av-%';
DELETE FROM ask_events WHERE id LIKE 'av-%';
DELETE FROM emails WHERE id LIKE 'av-%';
DELETE FROM knowledge_gaps WHERE id LIKE 'av-%';
DELETE FROM digest_runs WHERE run_date = '2026-11-17';
DELETE FROM eval_runs WHERE id LIKE 'av-%';

INSERT INTO recordings (id, title, object_key, transcript_status, pipeline_stage, pipeline_error, owner_id, created_at) VALUES
  ('av-rec-a',    'AV-A-녹음',    'av/a',    'ready', 'done',        NULL,               'av-a', '2026-11-17 01:00:00'),
  ('av-rec-b',    'AV-B-녹음',    'av/b',    'ready', 'failed',      'summarize timeout', 'av-b', '2026-11-17 01:10:00'),
  ('av-rec-null', 'AV-NULL-녹음', 'av/null', 'processing', 'transcribing', NULL,          NULL,   '2026-11-17 01:20:00');

INSERT INTO ask_events (id, question, grounded, origin, status, feedback, user_id, created_at) VALUES
  ('av-ask-a',    'AV-A-질문 연차는 며칠?',      1, 'user', 'grounded',    'up',   'av-a', '2026-11-17 02:00:00'),
  ('av-ask-b',    'AV-B-질문 재택 규정?',        0, 'user', 'no_evidence', 'down', 'av-b', '2026-11-17 02:10:00'),
  ('av-ask-anon', 'AV-NULL-질문 익명 질문',      1, 'user', 'grounded',    NULL,   NULL,   '2026-11-17 02:20:00'),
  ('av-ask-eval', 'AV-EVAL-질문 평가 호출',      1, 'eval', 'grounded',    NULL,   NULL,   '2026-11-17 02:30:00'),
  ('av-ask-a-p',  'AV-A-개인질문 내 회의록',     1, 'personal', 'grounded', NULL,  'av-a', '2026-11-17 02:40:00');

INSERT INTO emails (id, owner_id, direction, subject, received_at, thread_id, ai_draft, ai_draft_at) VALUES
  ('av-em-a',     'av-a', 'in',  'AV-A-메일 일정 문의',  '2026-11-17T03:00:00.000Z', 'av-th-a', '초안', '2026-11-17T03:05:00.000Z'),
  ('av-em-b',     'av-b', 'in',  'AV-B-메일 휴가 문의',  '2026-11-17T03:10:00.000Z', 'av-th-b', '초안', '2026-11-17T03:15:00.000Z'),
  ('av-em-b-out', 'av-b', 'out', 'Re: AV-B-메일 휴가 문의', '2026-11-17T03:20:00.000Z', 'av-th-b', NULL, NULL),
  ('av-em-null',  NULL,   'in',  'AV-NULL-메일 공용함',  '2026-11-17T03:30:00.000Z', 'av-th-n', '초안', '2026-11-17T03:35:00.000Z'),
  ('av-em-a-nodraft', 'av-a', 'in', 'AV-A-메일 초안없음', '2026-11-17T03:40:00.000Z', 'av-th-a2', NULL, NULL);

INSERT INTO knowledge_gaps (id, question, asked_at, status, count, source, user_id) VALUES
  ('av-gap-a',    'AV-A-공백 경조사 휴가',  1763348400000, 'open',     2, 'no-evidence', 'av-a'),
  ('av-gap-b',    'AV-B-공백 재택 규정',    1763349000000, 'resolved', 1, 'downvote',    'av-b'),
  ('av-gap-null', 'AV-NULL-공백 익명',      1763349600000, 'open',     1, 'no-evidence', NULL);

INSERT INTO digest_runs (run_date, generated_at, engine, body) VALUES
  ('2026-11-17', '2026-11-16 22:00:00', 'workers-ai', 'AV-SYS 다이제스트');

INSERT INTO eval_runs (id, dataset_id, dataset_version, trigger, status, items_total, items_done, pass_rate, started_at, finished_at, created_at) VALUES
  ('av-eval-ok',   'ds', 1, 'cron',   'done',    10, 10, 0.9, '2026-11-16 18:00:00', '2026-11-16 18:05:00', '2026-11-16 18:00:00'),
  ('av-eval-fail', 'ds', 1, 'manual', 'partial', 10,  7, 0.6, '2026-11-17 04:00:00', '2026-11-17 04:05:00', '2026-11-17 04:00:00');
