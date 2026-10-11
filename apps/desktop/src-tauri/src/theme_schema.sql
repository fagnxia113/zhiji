CREATE TABLE IF NOT EXISTS themes(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS themes_name ON themes(trim(name) COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS project_themes(
    project_id TEXT NOT NULL REFERENCES projects(id),
    theme_id TEXT NOT NULL REFERENCES themes(id),
    PRIMARY KEY(project_id,theme_id)
);
CREATE INDEX IF NOT EXISTS project_themes_theme ON project_themes(theme_id,project_id);
-- Report scope is a snapshot: changing project membership or a theme name does not change old reports.
CREATE TABLE IF NOT EXISTS weekly_report_themes(
    report_id TEXT PRIMARY KEY REFERENCES weekly_reports(id) ON DELETE CASCADE,
    theme_id TEXT NOT NULL, theme_name TEXT NOT NULL
);
