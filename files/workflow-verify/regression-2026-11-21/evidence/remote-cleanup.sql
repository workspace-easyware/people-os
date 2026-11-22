-- 회귀 라이브 후속 2026-11-21 정리. 항목 6 테스트 대기 동작(E: wf_mwq4q0ns_h1idxs / wfrun_mwq51k7g_02syzj)은 남긴다.
DELETE FROM workflow_agent_steps WHERE run_id IN ('wfrun_mwq4qlmz_7b08w2','wfrun_mwq4qwuw_whykqy','wfrun_mwq4sklc_t2ox9p','wfrun_mwq4us9s_kc417c','wfrun_mwq4w89a_6x9i1h','wfrun_mwq4wh2d_6dplzs','wfrun_mwq50c5o_yxk9gx','wfrun_mwq55ayd_uuc8jt','wfrun_mwq54mdt_u4zjxe');
DELETE FROM workflow_pending_actions WHERE run_id IN ('wfrun_mwq50c5o_yxk9gx','wfrun_mwq55ayd_uuc8jt');
DELETE FROM notifications WHERE ref_type='workflow_run' AND ref_id IN ('wfrun_mwq4w89a_6x9i1h','wfrun_mwq4wh2d_6dplzs');
DELETE FROM email_attachments WHERE email_id IN ('em_mwq508ri_kvdgdy','em_mwq50awr_n6538m','em_mwq51htt_2lykeo','em_mwq51jo6_dqaula');
DELETE FROM emails WHERE id IN ('em_mwq508ri_kvdgdy','em_mwq50awr_n6538m','em_mwq51htt_2lykeo','em_mwq51jo6_dqaula');
