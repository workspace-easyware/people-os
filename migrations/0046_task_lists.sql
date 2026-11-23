-- 할 일 Google Tasks 패리티 (2026-11-23): 목록(List) > 할 일(task) > 하위 작업(subtask).
-- 외래키는 두지 않는다 (기존 관례). 새 컬럼은 전부 nullable이거나 기본값이 있어, 이 컬럼을 모르는 기존 INSERT
-- (워크플로우 create_task 노드 등 — `INSERT INTO tasks (id, title, source, owner_id)`)가 그대로 동작한다.

-- 목록. 소유자별 기본 목록 1개 (is_default = 1) — id를 'tl_default_<owner_id>'로 정해 두어 PRIMARY KEY가 "소유자당 1개"를 보장한다
-- (첫 사용 시 INSERT OR IGNORE로 만든다 — 동시 요청에도 1개). 소유자 없는(미지정) 할 일의 기본 목록은 'tl_default_unassigned'.
CREATE TABLE IF NOT EXISTS task_lists (
  id TEXT PRIMARY KEY,
  owner_id TEXT,                              -- users.id. NULL = 미지정 할 일의 목록
  title TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,      -- 1 = 기본 목록 (삭제 불가)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_lists_owner ON task_lists(owner_id);

ALTER TABLE tasks ADD COLUMN list_id TEXT;                       -- task_lists.id. NULL = 아직 배정 전 (읽을 때 소유자의 기본 목록으로 채운다)
ALTER TABLE tasks ADD COLUMN details TEXT;                       -- 세부 메모
ALTER TABLE tasks ADD COLUMN due_date TEXT;                      -- YYYY-MM-DD (KST 기준)
ALTER TABLE tasks ADD COLUMN due_time TEXT;                      -- HH:MM (선택)
ALTER TABLE tasks ADD COLUMN starred INTEGER NOT NULL DEFAULT 0; -- 별표 0/1
ALTER TABLE tasks ADD COLUMN starred_at TEXT;                    -- 별표를 켠 시각 ("최근 별표" 정렬용)
ALTER TABLE tasks ADD COLUMN repeat_rule TEXT;                   -- 반복 규칙 JSON (src/tasks.ts RepeatRule). NULL = 반복 없음
ALTER TABLE tasks ADD COLUMN repeat_group TEXT;                  -- 같은 반복에서 나온 회차들을 묶는 id
ALTER TABLE tasks ADD COLUMN parent_id TEXT;                     -- 하위 작업이면 부모 할 일 id (1단계까지만)
ALTER TABLE tasks ADD COLUMN position INTEGER;                   -- 수동 순서 (작을수록 위). NULL이면 만든 시각으로 대신한다

-- 기존 할 일 이관: 소유자마다 기본 목록 "내 할 일 목록"을 만들고 그 안으로 넣는다. 미지정(owner_id NULL)은 "미지정 할 일" 목록으로.
INSERT OR IGNORE INTO task_lists (id, owner_id, title, is_default)
  SELECT DISTINCT 'tl_default_' || owner_id, owner_id, '내 할 일 목록', 1 FROM tasks WHERE owner_id IS NOT NULL;
INSERT OR IGNORE INTO task_lists (id, owner_id, title, is_default)
  SELECT 'tl_default_unassigned', NULL, '미지정 할 일', 1 WHERE EXISTS (SELECT 1 FROM tasks WHERE owner_id IS NULL);
UPDATE tasks SET list_id = 'tl_default_' || COALESCE(owner_id, 'unassigned') WHERE list_id IS NULL;
-- 수동 순서의 처음 값: 지금까지의 화면 순서(최근에 만든 것이 위)를 그대로 옮긴다. 새 할 일은 -(현재 시각 ms)를 받아 맨 위로 간다.
UPDATE tasks SET position = -CAST(strftime('%s', created_at) AS INTEGER) * 1000 WHERE position IS NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_list ON tasks(list_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_repeat_group ON tasks(repeat_group);
