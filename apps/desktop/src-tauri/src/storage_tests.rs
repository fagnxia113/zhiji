use super::*;

// Real SQLite files, isolated from the user's app data; no Tauri IPC mock.
struct TestDirectory(PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("zhiji-storage-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        // Only the unique directory created by this test is eligible for cleanup.
        if self.0.parent() == Some(std::env::temp_dir().as_path()) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

fn sample_database(path: &Path) -> Connection {
    let connection = Connection::open(path).unwrap();
    initialize_database(&connection).unwrap();
    connection.execute_batch(
        "INSERT INTO notebooks VALUES ('book', '项目资料', '#167455', '2026-09-08');
         INSERT INTO notes VALUES ('note', 'book', '访谈笔记', '原始笔记', '[]', '2026-09-08');
         INSERT INTO meetings (id, notebook_id, title, started_at, duration_seconds, status,
           transcript, minutes, decisions, audio_path, updated_at, context, notes)
         VALUES ('meeting', 'book', '项目周会', '2026-09-08', 600, 'completed',
           '讨论原文', '会议纪要', '确认方案', 'recordings/sample.wav', '2026-09-08', '背景', '笔记');
         INSERT INTO tasks (id, title, source_type, source_id, completed, due_date, created_at, origin, owner)
         VALUES ('task', '提交方案', 'meeting', 'meeting', 0, '2026-09-10', '2026-09-08', 'manual', '小林');
         INSERT INTO qa_messages VALUES ('question', 'meeting', '确认了什么？', '确认方案', '2026-09-08');
         INSERT INTO settings VALUES ('theme', 'dark');"
    ).unwrap();
    connection
}

fn text_value(connection: &Connection, sql: &str) -> String {
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

#[test]
fn backup_restores_meetings_tasks_notes_settings_and_question_history() {
    let directory = TestDirectory::new();
    let mut connection = sample_database(&directory.0.join("live.sqlite3"));
    let backups = directory.0.join("backups");
    let snapshot = create_backup_snapshot(&connection, &backups).unwrap();
    connection.execute_batch(
        "UPDATE meetings SET title = '已修改'; UPDATE tasks SET owner = '其他人';
         UPDATE notes SET content = '已修改'; UPDATE notebooks SET name = '已修改';
         UPDATE settings SET value = 'light'; DELETE FROM qa_messages;
         INSERT INTO qa_messages VALUES ('new', 'meeting', '新问题', '新答案', '2026-09-09');"
    ).unwrap();
    let restored = restore_database_backup(&mut connection, &backups, &snapshot.file_name).unwrap();
    assert_eq!(restored.meetings[0].title, "项目周会");
    assert_eq!(restored.meetings[0].audio_path.as_deref(), Some("recordings/sample.wav"));
    assert_eq!(restored.tasks[0].owner, "小林");
    assert_eq!(text_value(&connection, "SELECT name FROM notebooks"), "项目资料");
    assert_eq!(text_value(&connection, "SELECT content FROM notes"), "原始笔记");
    assert_eq!(text_value(&connection, "SELECT value FROM settings WHERE key = 'theme'"), "dark");
    assert_eq!(text_value(&connection, "SELECT id FROM qa_messages"), "question");
    assert_eq!(text_value(&connection, "SELECT answer FROM qa_messages"), "确认方案");
    assert_eq!(text_value(&connection, "PRAGMA integrity_check"), "ok");
}

#[test]
fn failed_restore_rolls_back_every_live_table() {
    let directory = TestDirectory::new();
    let mut connection = sample_database(&directory.0.join("live.sqlite3"));
    let backups = directory.0.join("backups");
    let snapshot = create_backup_snapshot(&connection, &backups).unwrap();
    connection.execute_batch(
        "UPDATE meetings SET title = '当前资料'; UPDATE qa_messages SET answer = '当前答案';
         UPDATE notes SET content = '当前笔记';
         CREATE TRIGGER reject_restore BEFORE INSERT ON tasks BEGIN SELECT RAISE(ABORT, 'test write failure'); END;"
    ).unwrap();
    assert!(restore_database_backup(&mut connection, &backups, &snapshot.file_name).is_err());
    assert_eq!(text_value(&connection, "SELECT title FROM meetings"), "当前资料");
    assert_eq!(text_value(&connection, "SELECT answer FROM qa_messages"), "当前答案");
    assert_eq!(text_value(&connection, "SELECT content FROM notes"), "当前笔记");
    assert_eq!(text_value(&connection, "SELECT owner FROM tasks"), "小林");
}

#[test]
fn legacy_backup_without_owner_or_question_table_remains_restorable() {
    let directory = TestDirectory::new();
    let mut live = sample_database(&directory.0.join("live.sqlite3"));
    let legacy = sample_database(&directory.0.join("legacy.sqlite3"));
    legacy.execute_batch("ALTER TABLE tasks DROP COLUMN owner; DROP TABLE qa_messages;").unwrap();
    let backups = directory.0.join("backups");
    let snapshot = create_backup_snapshot(&legacy, &backups).unwrap();
    let restored = restore_database_backup(&mut live, &backups, &snapshot.file_name).unwrap();
    assert_eq!(restored.tasks.len(), 1);
    assert_eq!(restored.tasks[0].owner, "");
    let count: i64 = live.query_row("SELECT count(*) FROM qa_messages", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 0, "newer question history must not leak into an older restored database");
}

#[test]
fn corrupt_backup_and_traversal_leave_live_data_intact() {
    let directory = TestDirectory::new();
    let mut live = sample_database(&directory.0.join("live.sqlite3"));
    let backups = directory.0.join("backups");
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("zhiji-backup-corrupt.sqlite3"), b"not a database").unwrap();
    assert!(restore_database_backup(&mut live, &backups, "zhiji-backup-corrupt.sqlite3").is_err());
    assert!(safe_backup_path(&backups, "../zhiji-backup-corrupt.sqlite3").is_err());
    assert!(safe_backup_path(&backups, "..\\zhiji-backup-corrupt.sqlite3").is_err());
    assert_eq!(text_value(&live, "SELECT title FROM meetings"), "项目周会");
    assert_eq!(text_value(&live, "SELECT answer FROM qa_messages"), "确认方案");
}

#[test]
fn rapid_backups_keep_the_new_snapshot_and_bounded_history() {
    let directory = TestDirectory::new();
    let connection = sample_database(&directory.0.join("live.sqlite3"));
    let backups = directory.0.join("backups");
    let mut names = std::collections::HashSet::new();
    for _ in 0..5 {
        let snapshot = create_backup_snapshot(&connection, &backups).unwrap();
        assert!(names.insert(snapshot.file_name.clone()));
        assert!(backups.join(&snapshot.file_name).is_file());
        assert!(snapshot.is_valid);
    }
    assert_eq!(backup_infos(&backups).unwrap().len(), 2);
}

#[test]
fn repeated_migrations_preserve_existing_records() {
    let directory = TestDirectory::new();
    let connection = sample_database(&directory.0.join("live.sqlite3"));
    connection.execute_batch("ALTER TABLE tasks DROP COLUMN owner;").unwrap();
    initialize_database(&connection).unwrap();
    initialize_database(&connection).unwrap();
    assert_eq!(tasks(&connection).unwrap()[0].title, "提交方案");
    assert_eq!(tasks(&connection).unwrap()[0].owner, "");
    assert_eq!(text_value(&connection, "SELECT answer FROM qa_messages"), "确认方案");
}

#[test]
fn relocation_conflict_preserves_both_different_files() {
    let directory = TestDirectory::new();
    let source = directory.0.join("source");
    let target = directory.0.join("target");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&target).unwrap();
    // Same lengths catch checks that compare only file metadata.
    fs::write(source.join("recording.wav"), b"source").unwrap();
    fs::write(target.join("recording.wav"), b"target").unwrap();
    assert!(move_tree(&source, &target).is_err());
    assert_eq!(fs::read(source.join("recording.wav")).unwrap(), b"source");
    assert_eq!(fs::read(target.join("recording.wav")).unwrap(), b"target");
}

#[test]
fn relocation_resumes_only_after_verifying_identical_content() {
    let directory = TestDirectory::new();
    let source = directory.0.join("source");
    let target = directory.0.join("target");
    fs::create_dir_all(source.join("nested")).unwrap();
    fs::create_dir_all(target.join("nested")).unwrap();
    let content = vec![42u8; 150_000];
    fs::write(source.join("nested/recording.wav"), &content).unwrap();
    fs::write(target.join("nested/recording.wav"), &content).unwrap();
    fs::write(source.join("new.wav"), b"new recording").unwrap();
    move_tree(&source, &target).unwrap();
    assert!(!source.join("nested/recording.wav").exists());
    assert_eq!(fs::read(target.join("nested/recording.wav")).unwrap(), content);
    assert_eq!(fs::read(target.join("new.wav")).unwrap(), b"new recording");
}
