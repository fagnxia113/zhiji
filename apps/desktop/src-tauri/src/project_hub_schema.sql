SAVEPOINT project_hub_migration;
CREATE TABLE IF NOT EXISTS project_profiles (
  project_id TEXT PRIMARY KEY REFERENCES projects(id), goal TEXT NOT NULL, stage TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, occurred_on TEXT NOT NULL,
  meeting_id TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_projects (
  activity_id TEXT NOT NULL REFERENCES activities(id), project_id TEXT NOT NULL REFERENCES projects(id),
  PRIMARY KEY(activity_id, project_id)
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  size_bytes INTEGER NOT NULL, modified_at TEXT NOT NULL, registered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resource_projects (
  resource_id TEXT NOT NULL REFERENCES resources(id), project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL, PRIMARY KEY(resource_id, project_id)
);
CREATE TABLE IF NOT EXISTS resource_activities (
  resource_id TEXT NOT NULL REFERENCES resources(id), activity_id TEXT NOT NULL REFERENCES activities(id),
  role TEXT NOT NULL, PRIMARY KEY(resource_id, activity_id)
);
CREATE TABLE IF NOT EXISTS entry_context (
  entry_id TEXT PRIMARY KEY, context_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entry_history (
  sequence INTEGER PRIMARY KEY, entry_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_history (
  sequence INTEGER PRIMARY KEY, task_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  project_id TEXT, snapshot_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_history_time ON task_history(occurred_at, project_id);
-- 本触发器引用 tasks.owner。SQLite 在执行 ALTER TABLE 后会重新解析整个 schema，
-- 所以任何删掉 tasks 列（含 owner）的迁移都必须先 DROP 本触发器，否则那条 ALTER
-- 会以「error in trigger task_progress_update after drop column: no such column: NEW.owner」
-- 失败。当前的迁移只 ADD COLUMN 且先补列再建触发器，所以线上不受影响。
CREATE TRIGGER IF NOT EXISTS task_progress_update AFTER UPDATE OF completed ON tasks
WHEN OLD.completed <> NEW.completed BEGIN
  INSERT INTO task_history(task_id,occurred_at,project_id,snapshot_json)
  VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT project_id FROM project_links WHERE entity_type='task' AND entity_id=NEW.id),
      (SELECT project_id FROM project_links WHERE entity_type='meeting' AND NEW.source_type='meeting' AND entity_id=NEW.source_id)),
    json_object('title',NEW.title,'completed',NEW.completed,'owner',NEW.owner,'dueDate',NEW.due_date));
END;
CREATE INDEX IF NOT EXISTS entry_history_entry ON entry_history(entry_id, sequence);
CREATE INDEX IF NOT EXISTS activity_projects_project ON activity_projects(project_id);
CREATE INDEX IF NOT EXISTS resource_projects_project ON resource_projects(project_id);
CREATE TRIGGER IF NOT EXISTS work_entry_history_insert AFTER INSERT ON work_entries BEGIN
  INSERT INTO entry_history(entry_id,snapshot_json,recorded_at)
  VALUES(NEW.id,json_object('id',NEW.id,'content',NEW.content,'kind',NEW.kind,'status',NEW.status,
    'occurredOn',NEW.occurred_on,'projectId',NEW.project_id,'sourceLabel',NEW.source_label,
    'context',json(COALESCE((SELECT context_json FROM entry_context WHERE entry_id=NEW.id),'{}'))),
    strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER IF NOT EXISTS work_entry_history_update AFTER UPDATE ON work_entries BEGIN
  INSERT INTO entry_history(entry_id,snapshot_json,recorded_at)
  VALUES(NEW.id,json_object('id',NEW.id,'content',NEW.content,'kind',NEW.kind,'status',NEW.status,
    'occurredOn',NEW.occurred_on,'projectId',NEW.project_id,'sourceLabel',NEW.source_label,
    'context',json(COALESCE((SELECT context_json FROM entry_context WHERE entry_id=NEW.id),'{}'))),
    strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
-- Seed only known current values, never invent earlier progress or completion dates.
INSERT INTO entry_history(entry_id,snapshot_json,recorded_at)
SELECT e.id,json_object('id',e.id,'content',e.content,'kind',e.kind,'status',e.status,
  'occurredOn',e.occurred_on,'projectId',e.project_id,'sourceLabel',e.source_label,'context',json('{}')),
  strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM work_entries e
WHERE NOT EXISTS(SELECT 1 FROM entry_history h WHERE h.entry_id=e.id);
INSERT OR IGNORE INTO workbench_migrations VALUES(2);
RELEASE project_hub_migration;
