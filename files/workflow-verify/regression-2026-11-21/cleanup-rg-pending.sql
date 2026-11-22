-- 회귀 테스트 대기 동작 정리 (브라우저 일괄 승인 확인 뒤, 2026-11-21 18:13)
DELETE FROM workflow_pending_actions WHERE run_id='wfrun_mwq51k7g_02syzj';
DELETE FROM workflow_agent_steps WHERE run_id='wfrun_mwq51k7g_02syzj';
DELETE FROM workflow_run_steps WHERE run_id='wfrun_mwq51k7g_02syzj';
DELETE FROM workflow_runs WHERE id='wfrun_mwq51k7g_02syzj';
DELETE FROM workflows WHERE id='wf_mwq4q0ns_h1idxs';
DELETE FROM emails WHERE id IN ('em_mwq6v487_nqf8xe','em_mwq6v2ka_3kg07z');
