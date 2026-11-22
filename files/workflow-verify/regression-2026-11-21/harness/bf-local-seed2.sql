-- 브라우저 회귀 수정 5번 로컬 확인: agent 단계 1개 + 지연 승인 대기 동작 (queued 2 · rejected 1) — bf-state 전용
INSERT OR IGNORE INTO workflows (id, owner_id, name, status, definition_json, created_at, updated_at) VALUES
  ('wf_bf_1', 'u_bf_admin', '[BF] 지연 승인 확인', 'draft', '{"version":1,"steps":[{"type":"agent","name":"에이전트","config":{"goal":"x"}}]}', '2026-11-21T08:00:00Z', '2026-11-21T08:00:00Z');
INSERT OR IGNORE INTO workflow_runs (id, workflow_id, owner_id, status, input_json, output_json, current_step, started_at, finished_at) VALUES
  ('wfrun_bf_1', 'wf_bf_1', 'u_bf_admin', 'succeeded', '{}', '{}', 0, '2026-11-21T08:00:01Z', '2026-11-21T08:01:00Z');
INSERT OR IGNORE INTO workflow_run_steps (run_id, step_index, node_type, node_name, status, output_json, started_at, finished_at) VALUES
  ('wfrun_bf_1', 0, 'agent', '에이전트', 'succeeded', '{"final":"메일을 승인 대기열에 넣었습니다.","turns":[{"turn":0,"action":"finish","final":"메일을 승인 대기열에 넣었습니다."}]}', '2026-11-21T08:00:02Z', '2026-11-21T08:01:00Z');
INSERT OR IGNORE INTO workflow_pending_actions (id, run_id, step_index, turn, owner_id, node_type, args_json, status, created_at) VALUES
  ('wfpa_bf_1', 'wfrun_bf_1', 0, 1, 'u_bf_admin', 'send_email', '{"to":"a@example.test","subject":"s","body":"b"}', 'queued', '2026-11-21T08:00:30Z'),
  ('wfpa_bf_2', 'wfrun_bf_1', 0, 2, 'u_bf_admin', 'send_email', '{"to":"a@example.test","subject":"s2","body":"b"}', 'queued', '2026-11-21T08:00:40Z'),
  ('wfpa_bf_3', 'wfrun_bf_1', 0, 3, 'u_bf_admin', 'send_email', '{"to":"a@example.test","subject":"s3","body":"b"}', 'rejected', '2026-11-21T08:00:50Z');
