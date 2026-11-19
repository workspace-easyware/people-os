DELETE FROM workflow_run_steps;
DELETE FROM workflow_runs;
DELETE FROM workflows;
DELETE FROM auth_sessions WHERE user_id IN ('u_a','u_b');
DELETE FROM users WHERE id IN ('u_a','u_b');
