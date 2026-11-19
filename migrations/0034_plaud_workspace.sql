-- Plaud 진단: get_current_user의 workspace_id를 저장 (list_files가 비는 원인 대조용, 임시 성격)
ALTER TABLE plaud_accounts ADD COLUMN workspace_id TEXT;
