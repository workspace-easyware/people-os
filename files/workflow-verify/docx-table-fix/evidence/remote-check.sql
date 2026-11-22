SELECT
  (SELECT COUNT(*) FROM users WHERE id = 'u_docxtblfix_tmp' OR email = 'docx-tablefix-tmp@example.invalid') AS users,
  (SELECT COUNT(*) FROM auth_sessions WHERE user_id = 'u_docxtblfix_tmp') AS auth_sessions,
  (SELECT COUNT(*) FROM documents WHERE owner_id = 'u_docxtblfix_tmp' OR source_r2_key LIKE 'docs/created/%') AS documents,
  (SELECT COUNT(*) FROM doc_nodes WHERE doc_id IN ('doc_mwq1sc74_p8fcqa','doc_mwq1uzy7_k4c8gd','doc_mwq1xrm2_peaoew','doc_mwq1z5eq_s6bl41')) AS doc_nodes,
  (SELECT COUNT(*) FROM chunks WHERE doc_id IN ('doc_mwq1sc74_p8fcqa','doc_mwq1uzy7_k4c8gd','doc_mwq1xrm2_peaoew','doc_mwq1z5eq_s6bl41')) AS chunks;
