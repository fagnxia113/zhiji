use super::*;

fn themed_database(path: &Path) -> Connection {
    let db=sample_database(path);
    for (id,name) in [("p","海外数据中心"),("q","本地数据中心"),("r","其他工作")] {
        workbench::dispatch_db(&db,"save_project",&json!({"id":id,"name":name})).unwrap();
    }
    for (id,name) in [("sea","出海"),("data","数据中心"),("other","其他主题")] {
        workbench::dispatch_db(&db,"save_theme",&json!({"id":id,"name":name})).unwrap();
    }
    for (id,ids) in [("p",json!(["sea","data"])),("q",json!(["data"])),("r",json!(["other"]))] {
        workbench::dispatch_db(&db,"save_project_themes",&json!({"projectId":id,"themeIds":ids})).unwrap();
    }
    for (id,project) in [("ep",Some("p")),("eq",Some("q")),("er",Some("r")),("daily",None)] {
        workbench::save_entry(&db,&json!({"id":id,"content":format!("{id} 已提交等待反馈"),"occurredOn":"2026-09-29","projectId":project,"status":"waiting"}),false).unwrap();
    }
    db.execute_batch("UPDATE meetings SET started_at='2026-09-29T09:00:00+08:00';
        INSERT INTO activities VALUES('shared','共同协调','meeting','2026-09-29','meeting','now');
        INSERT INTO activity_projects VALUES('shared','p'),('shared','q');
        INSERT INTO resources VALUES('shared-file','D:/shared.docx','d:/shared.docx','共享方案',12,'v1','now');
        INSERT INTO resources VALUES('private-file','D:/private.docx','d:/private.docx','其他项目私有资料',12,'v1','now');
        INSERT INTO resource_activities VALUES('shared-file','shared','reference');
        INSERT INTO resource_projects VALUES('private-file','q','reference');").unwrap();
    db
}

#[test]
fn projects_can_cross_themes_without_copying_work_and_failed_assignment_is_atomic() {
    let dir=TestDirectory::new(); let db=themed_database(&dir.0.join("themes.sqlite3"));
    initialize_database(&db).unwrap(); initialize_database(&db).unwrap();
    assert_eq!(themes::ids(&db,"p").unwrap(),vec!["data","sea"]);
    assert_eq!(workbench::dispatch_db(&db,"list_projects",&json!({"themeId":"data"})).unwrap().as_array().unwrap().len(),2);
    assert!(workbench::dispatch_db(&db,"save_project_themes",&json!({"projectId":"p","themeIds":["sea","missing"]})).is_err());
    assert_eq!(themes::ids(&db,"p").unwrap(),vec!["data","sea"]);
    assert!(workbench::dispatch_db(&db,"save_project_themes",&json!({"projectId":"p","themeIds":[],"expectedThemeIds":["sea"]})).is_err());
    workbench::dispatch_db(&db,"save_project",&json!({"id":"p","name":"改名","archived":true})).unwrap();
    assert_eq!(themes::ids(&db,"p").unwrap().len(),2);
    workbench::dispatch_db(&db,"save_project_themes",&json!({"projectId":"p","themeIds":["sea","sea"]})).unwrap();
    assert_eq!(themes::ids(&db,"p").unwrap(),vec!["sea"]);
    assert_eq!(text_value(&db,"SELECT content FROM work_entries WHERE id='ep'"),"ep 已提交等待反馈");
    assert!(workbench::dispatch_db(&db,"save_theme",&json!({"id":"duplicate","name":" 出海 "})).is_err());
}

#[test]
fn theme_report_material_deduplicates_shared_meetings_and_keeps_daily_work_in_full_week() {
    let dir=TestDirectory::new(); let db=themed_database(&dir.0.join("material.sqlite3"));
    let value=workbench::material_scoped(&db,"2026-09-28",None,Some("data")).unwrap();
    assert_eq!(value.sources.iter().filter(|s|s.source_type=="meeting" && s.id=="meeting").count(),1);
    assert_eq!(value.sources.iter().filter(|s|s.source_type=="entry").count(),2);
    assert!(!value.sources.iter().any(|s|s.id=="daily" || s.id=="er"));
    assert!(workbench::material(&db,"2026-09-28",None).unwrap().sources.iter().any(|s|s.id=="daily"));
    let ctx=workbench::dispatch_db(&db,"get_project_context",&json!({"themeId":"data"})).unwrap();
    assert_eq!(ctx["projectHub"]["resources"].as_array().unwrap().iter().filter(|r|r["id"]=="shared-file").count(),1);
    assert!(workbench::material_scoped(&db,"2026-09-28",None,Some("missing")).is_err());
}

#[test]
fn theme_queries_cannot_expand_an_authorized_project() {
    let dir=TestDirectory::new(); let db=themed_database(&dir.0.join("scope.sqlite3"));
    let mut args=json!({"themeId":"data","projectId":"q","weekStart":"2026-09-28"});
    local_api::apply_project_scope(&mut args,Some("p"));
    let ctx=workbench::dispatch_db(&db,"get_project_context",&args).unwrap();
    assert_eq!(ctx["projects"].as_array().unwrap().len(),1);
    assert_eq!(ctx["projects"][0]["id"],"p");
    assert_eq!(ctx["entries"].as_array().unwrap().len(),1);
    assert_eq!(ctx["projectHub"]["resources"].as_array().unwrap().len(),1);
    assert_eq!(ctx["projectHub"]["resources"][0]["id"],"shared-file");
    assert_eq!(workbench::dispatch_db(&db,"list_themes",&args).unwrap().as_array().unwrap().len(),2);
    args["themeId"]=json!("other");
    let ctx=workbench::dispatch_db(&db,"get_project_context",&args).unwrap();
    assert!(ctx["entries"].as_array().unwrap().is_empty());
    assert!(ctx["projectHub"]["resources"].as_array().unwrap().is_empty());
    assert!(workbench::dispatch_db(&db,"report_material",&args).unwrap()["sources"].as_array().unwrap().is_empty());
}

#[test]
fn recent_completed_records_cannot_hide_older_theme_followups() {
    let dir=TestDirectory::new(); let db=themed_database(&dir.0.join("followups.sqlite3"));
    for i in 0..60 {
        workbench::save_entry(&db,&json!({"id":format!("done-{i}"),"content":"已完成的新工作","occurredOn":"2026-10-01","projectId":"p","status":"done"}),false).unwrap();
    }
    let ctx=workbench::dispatch_db(&db,"get_project_context",&json!({"themeId":"data"})).unwrap();
    assert!(!ctx["entries"].as_array().unwrap().iter().any(|e|e["id"]=="ep"));
    assert!(ctx["followups"]["entries"].as_array().unwrap().iter().any(|e|e["id"]=="ep"));
    assert!(ctx["followups"]["entries"].as_array().unwrap().iter().all(|e|e["status"]=="waiting"));
}

#[test]
fn theme_backup_restores_relationships_and_report_scope_snapshot_and_accepts_old_backups() {
    let dir=TestDirectory::new(); let mut db=themed_database(&dir.0.join("backup.sqlite3"));
    db.execute_batch("INSERT INTO weekly_reports VALUES('report','2026-09-28',NULL,'周报','[]','[]','now','now'); INSERT INTO weekly_report_themes VALUES('report','data','数据中心');").unwrap();
    let snapshot=create_backup_snapshot(&db,&dir.0.join("backups")).unwrap();
    themes::save(&db,"data","基础设施").unwrap();
    themes::assign(&db,"p",&json!([])).unwrap();
    let report=workbench::dispatch_db(&db,"list_reports",&json!({})).unwrap();
    assert_eq!(report[0]["themeName"],"数据中心");
    restore_database_backup(&mut db,&dir.0.join("backups"),&snapshot.file_name).unwrap();
    assert_eq!(themes::ids(&db,"p").unwrap().len(),2);
    assert_eq!(themes::list(&db,None).unwrap().iter().find(|t|t.id=="data").unwrap().name,"数据中心");
    db.execute_batch("DROP TABLE weekly_report_themes; DROP TABLE project_themes; DROP TABLE themes;").unwrap();
    let old=create_backup_snapshot(&db,&dir.0.join("legacy")).unwrap();
    initialize_database(&db).unwrap();
    themes::save(&db,"new","新主题").unwrap();
    restore_database_backup(&mut db,&dir.0.join("legacy"),&old.file_name).unwrap();
    assert!(themes::list(&db,None).unwrap().is_empty());
    assert!(workbench::dispatch_db(&db,"list_reports",&json!({})).unwrap()[0]["themeName"].is_null());
}

#[test]
fn post_meeting_engine_works_without_a_streaming_model_or_live_script() {
    let directory = TestDirectory::new();
    let engine = directory.0.join("engine");
    let models = directory.0.join("models");
    fs::create_dir_all(engine.join("python")).unwrap();
    fs::write(speaker_python(&engine), b"runtime").unwrap();
    fs::write(speaker_script(&engine), b"script").unwrap();
    fs::write(speaker_marker(&engine), SPEAKER_ENGINE_VERSION).unwrap();
    for model in ["SeacoParaformer", "FsmnVADStreaming", "CTTransformer", "CAMPPlus"] {
        let path = models.join(model);
        fs::create_dir_all(&path).unwrap();
        fs::write(path.join("config.yaml"), format!("model: {model}\n")).unwrap();
        fs::write(path.join("model.pt"), b"weights").unwrap();
    }
    fs::write(speaker_models_marker(&models), SPEAKER_MODELS_VERSION).unwrap();
    assert!(speaker_engine_installed(&engine));
    assert!(speaker_models_ready(&models));
    assert!(!models.join("realtime-online").exists());
    let imported = directory.0.join("imported-models");
    import_funasr_models(&models, &imported).unwrap();
    assert!(speaker_models_ready(&imported));
    assert!(!imported.join("realtime-online").exists());
    assert_eq!(FUNASR_MODEL_REPOS.len(), 4);
    fs::remove_file(models.join("CAMPPlus/model.pt")).unwrap();
    assert!(!speaker_models_ready(&models));
}

#[test]
fn correcting_roles_preserves_proofread_text_timestamps_and_work_outputs() {
    let directory = TestDirectory::new();
    let db = sample_database(&directory.0.join("roles.sqlite3"));
    let segments = json!([
        {"speaker":"我","speakerId":1,"startMs":0,"endMs":1000,"text":"已校对的第一段"},
        {"speaker":"我","speakerId":1,"startMs":1200,"endMs":2200,"text":"已校对的第二段"},
        {"speaker":"我","speakerId":1,"startMs":2500,"endMs":3500,"text":"保留人工修改！"}
    ]);
    db.execute("UPDATE meetings SET speaker_segments=?1,speaker_names=?2,notes='个人笔记' WHERE id='meeting'", params![segments.to_string(), json!({"1":"旧角色"}).to_string()]).unwrap();
    let before = meeting_by_id(&db, "meeting").unwrap();
    let tasks_before = serde_json::to_value(tasks(&db).unwrap()).unwrap();
    let after = apply_speaker_roles(&db, &before, &[0, 1, 2], Some(3)).unwrap();
    let updated: Vec<SpeakerSegment> = serde_json::from_str(&after.speaker_segments).unwrap();
    let original: Vec<SpeakerSegment> = serde_json::from_str(&before.speaker_segments).unwrap();
    for (before, after) in original.iter().zip(updated.iter()) {
        assert_eq!((&before.text, before.start_ms, before.end_ms), (&after.text, after.start_ms, after.end_ms));
    }
    assert_eq!(after.minutes, before.minutes);
    assert_eq!(after.decisions, before.decisions);
    assert_eq!(after.notes, before.notes);
    assert_eq!(after.speaker_names, "{}");
    assert_eq!(tasks_before, serde_json::to_value(tasks(&db).unwrap()).unwrap());
    assert_eq!(updated.iter().map(|s| s.speaker_id).collect::<Vec<_>>(), vec![0, 1, 2]);
}

#[test]
fn failed_or_stale_role_correction_does_not_overwrite_a_record() {
    let directory = TestDirectory::new();
    let db = sample_database(&directory.0.join("stale-roles.sqlite3"));
    let segments = json!([{"speaker":"发言人 1","speakerId":0,"startMs":0,"endMs":1000,"text":"已校对"}]);
    db.execute("UPDATE meetings SET speaker_segments=?1 WHERE id='meeting'", params![segments.to_string()]).unwrap();
    let before = meeting_by_id(&db, "meeting").unwrap();
    assert!(apply_speaker_roles(&db, &before, &[], None).is_err());
    assert!(apply_speaker_roles(&db, &before, &[0], Some(3)).is_err());
    assert_eq!(meeting_by_id(&db, "meeting").unwrap().speaker_segments, before.speaker_segments);
    db.execute("UPDATE meetings SET updated_at='newer',transcript='另一处的新修改' WHERE id='meeting'", []).unwrap();
    assert!(apply_speaker_roles(&db, &before, &[0], None).is_err());
    assert_eq!(meeting_by_id(&db, "meeting").unwrap().transcript, "另一处的新修改");
}

#[test]
fn microphone_source_does_not_identify_people_without_explicit_online_owner() {
    let transcript = || SpeakerTranscript { transcript: String::new(), segments: vec![SpeakerSegment {
        speaker: "发言人 1".to_string(), speaker_id: 0, start_ms: 0, end_ms: 1000, text: "现场讲话".to_string(),
    }] };
    let unknown = remap_source_segments(transcript(), None);
    assert_eq!(unknown[0].speaker, "会议发言人 1");
    let known = remap_source_segments(transcript(), Some(("我", 0)));
    assert_eq!(known[0].speaker, "我");
}

#[test]
fn sidecar_organization_preserves_playback_and_handles_partial_moves() {
    let directory = TestDirectory::new();
    let root = directory.0.join("recordings");
    fs::create_dir_all(root.join("tracks")).unwrap();
    fs::write(root.join("meeting.wav"), b"playback").unwrap();
    fs::write(root.join("meeting-mic.wav"), b"microphone").unwrap();
    fs::write(root.join("tracks/meeting-system.wav"), b"system").unwrap();
    let (mic, system) = recorder::existing_dual_track_paths(&root, "meeting");
    assert_eq!(fs::read(mic).unwrap(), b"microphone");
    assert_eq!(fs::read(system).unwrap(), b"system");
    recorder::organize_dual_track_sidecars(&root, "meeting").unwrap();
    recorder::organize_dual_track_sidecars(&root, "meeting").unwrap();
    assert_eq!(fs::read(root.join("meeting.wav")).unwrap(), b"playback");
    assert!(!root.join("meeting-mic.wav").exists());
    let (mic, system) = recorder::dual_track_paths(&root, "meeting");
    assert_eq!(fs::read(mic).unwrap(), b"microphone");
    assert_eq!(fs::read(system).unwrap(), b"system");
    remove_recording_bundle(&root, root.join("meeting.wav").to_str().unwrap());
    assert!(!root.join("meeting.wav").exists());
    assert!(!root.join("tracks/meeting-mic.wav").exists());
    assert!(!root.join("tracks/meeting-system.wav").exists());
}

#[test]
fn sidecar_conflict_never_overwrites_a_different_recording() {
    let directory = TestDirectory::new();
    fs::create_dir_all(directory.0.join("tracks")).unwrap();
    fs::write(directory.0.join("meeting-mic.wav"), b"old microphone").unwrap();
    fs::write(directory.0.join("tracks/meeting-mic.wav"), b"another source").unwrap();
    recorder::organize_dual_track_sidecars(&directory.0, "meeting").unwrap();
    assert_eq!(fs::read(directory.0.join("meeting-mic.wav")).unwrap(), b"old microphone");
    assert_eq!(fs::read(directory.0.join("tracks/meeting-mic.wav")).unwrap(), b"another source");
    let (mic, _) = recorder::existing_dual_track_paths(&directory.0, "meeting");
    assert_eq!(fs::read(mic).unwrap(), b"old microphone");
}

fn test_wav(path: &Path, sample_rate: u32, channels: u16, sample: i16) {
    let pcm: Vec<u8> = (0..160).flat_map(|_| sample.to_le_bytes()).collect();
    let mut data = b"RIFF".to_vec();
    data.extend((36u32 + pcm.len() as u32).to_le_bytes());
    data.extend(b"WAVEfmt ");
    data.extend(16u32.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(channels.to_le_bytes());
    data.extend(sample_rate.to_le_bytes());
    data.extend((sample_rate * u32::from(channels) * 2).to_le_bytes());
    data.extend((channels * 2).to_le_bytes());
    data.extend(16u16.to_le_bytes());
    data.extend(b"data");
    data.extend((pcm.len() as u32).to_le_bytes());
    data.extend(pcm);
    fs::write(path, data).unwrap();
}

#[test]
fn wav_normalization_and_silence_checks_preserve_quiet_speech() {
    let directory = TestDirectory::new();
    let path = directory.0.join("audio.wav");
    test_wav(&path, 48000, 2, 0);
    assert!(!asr_wav_ready(&path));
    test_wav(&path, 16000, 1, 0);
    assert!(asr_wav_ready(&path));
    assert!(wav_track_below_rms(&path, 0));
    test_wav(&path, 16000, 1, 1);
    assert!(!wav_track_below_rms(&path, 0));
    assert!(wav_track_is_empty(&path));
    test_wav(&path, 16000, 1, 2);
    assert!(!wav_track_is_empty(&path));
    assert!(wav_track_is_silent(&path));
    fs::write(&path, b"broken wav").unwrap();
    assert!(!wav_track_below_rms(&path, 0));
}

#[test]
fn temporary_file_cleanup_keeps_originals_on_error() {
    let directory = TestDirectory::new();
    let original = directory.0.join("original.wav");
    let generated = directory.0.join("converted.wav");
    fs::write(&original, b"original").unwrap();
    fs::write(&generated, b"temporary").unwrap();
    let result: Result<(), &str> = (|| {
        let _input = TemporaryFile { path: original.clone(), remove: false };
        let _output = TemporaryFile { path: generated.clone(), remove: true };
        Err("cancelled")
    })();
    assert!(result.is_err());
    assert!(original.is_file());
    assert!(!generated.exists());
}

#[test]
fn microphone_only_capture_saves_one_file_and_online_capture_keeps_sources() {
    let ffmpeg = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ffmpeg/ffmpeg.exe");
    if !ffmpeg.is_file() {
        assert!(std::env::var_os("GITHUB_ACTIONS").is_none(), "CI must bundle FFmpeg before audio tests");
        return;
    }
    let directory = TestDirectory::new();
    let recordings = directory.0.join("recordings");
    fs::create_dir_all(&recordings).unwrap();
    let mic = directory.0.join("microphone.wav");
    test_wav(&mic, 16000, 1, 1000);
    for (key, sample, expect_sources) in [("room", 1i16, false), ("online", 2000i16, true)] {
        let sys = recordings.join(format!("{key}-sys.raw"));
        let pcm: Vec<u8> = (0..160).flat_map(|_| sample.to_le_bytes()).collect();
        fs::write(&sys, pcm).unwrap();
        let tracks = recorder::prepare_dual_track_audio(&ffmpeg, &recordings, key, &mic, &sys).unwrap();
        assert!(asr_wav_ready(&tracks.playback));
        assert_eq!(tracks.has_source_tracks, expect_sources);
        assert_eq!(tracks.microphone.is_file(), expect_sources);
        assert_eq!(tracks.system.is_file(), expect_sources);
        assert!(mic.is_file());
        remove_recording_bundle(&recordings, tracks.playback.to_str().unwrap());
        assert!(!tracks.playback.exists());
        assert!(!tracks.microphone.exists());
        assert!(!tracks.system.exists());
    }
}

#[test]
fn project_hub_reuses_files_scopes_context_and_preserves_originals() {
    let dir = TestDirectory::new();
    let db = sample_database(&dir.0.join("hub.sqlite3"));
    for pid in ["p", "q", "private"] {
        workbench::dispatch_db(&db,"save_project",&json!({"id":pid,"name":pid})).unwrap();
    }
    let activity=json!({"id":"a","projectId":"p","title":"成果评审","kind":"review","occurredOn":"2026-09-29"});
    workbench::dispatch_db(&db,"save_activity",&activity).unwrap();
    workbench::dispatch_db(&db,"save_activity",&activity).unwrap();
    workbench::dispatch_db(&db,"link_activity",&json!({"activityId":"a","projectId":"q"})).unwrap();
    let file=dir.0.join("报告.md"); fs::write(&file,"原始内容").unwrap();
    let args=json!({"path":file.to_string_lossy(),"activityId":"a","role":"output"});
    let first=workbench::dispatch_db(&db,"register_resource",&args).unwrap();
    assert_eq!(workbench::dispatch_db(&db,"register_resource",&args).unwrap(),first);
    assert_eq!(project_hub::load(&db,Some("q")).unwrap()["resources"].as_array().unwrap().len(),1);
    assert!(project_hub::load(&db,Some("private")).unwrap()["resources"].as_array().unwrap().is_empty());
    let entry=json!({"id":"e","content":"已提交初稿，等待评审","occurredOn":"2026-09-29","status":"waiting","projectId":"p","activityId":"a","resourceId":first["id"]});
    workbench::save_entry(&db,&entry,true).unwrap();
    workbench::save_entry(&db,&entry,true).unwrap();
    assert_eq!(db.query_row("SELECT count(*) FROM entry_history WHERE entry_id='e'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    let mut forbidden=entry.clone(); forbidden["id"]=json!("forbidden"); forbidden["projectId"]=json!("private");
    assert!(workbench::save_entry(&db,&forbidden,true).is_err());
    let material=workbench::material(&db,"2026-09-28",Some("p")).unwrap();
    assert!(material.sources.iter().any(|s|s.id=="e" && s.content.contains("报告.md") && s.content.contains("未读取正文")));
    workbench::dispatch_db(&db,"unlink_resource",&json!({"resourceId":first["id"],"activityId":"a"})).unwrap();
    assert_eq!(fs::read_to_string(file).unwrap(),"原始内容");
    assert_eq!(db.query_row("SELECT count(*) FROM resources",[],|r|r.get::<_,i64>(0)).unwrap(),1);
}

#[test]
fn project_hub_failed_registration_and_history_write_roll_back() {
    let dir=TestDirectory::new(); let db=sample_database(&dir.0.join("atomic.sqlite3"));
    let file=dir.0.join("材料.md");fs::write(&file,"正文").unwrap();
    assert!(workbench::dispatch_db(&db,"register_resource",&json!({"path":file.to_string_lossy(),"projectId":"missing"})).is_err());
    assert_eq!(db.query_row("SELECT count(*) FROM resources",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    let entry=json!({"id":"e","content":"原进展","occurredOn":"2026-09-29"});
    workbench::save_entry(&db,&entry,false).unwrap();
    db.execute_batch("CREATE TRIGGER fail_history BEFORE INSERT ON entry_history BEGIN SELECT RAISE(ABORT,'test history write failed'); END;").unwrap();
    let mut edited=entry.clone();edited["content"]=json!("无法保存的新内容");
    assert!(workbench::save_entry(&db,&edited,false).is_err());
    assert_eq!(text_value(&db,"SELECT content FROM work_entries WHERE id='e'"),"原进展");
}

#[test]
fn project_hub_backup_restores_relations_and_exact_history() {
    let dir=TestDirectory::new();let mut db=sample_database(&dir.0.join("backup-hub.sqlite3"));
    workbench::dispatch_db(&db,"save_project",&json!({"id":"p","name":"调研"})).unwrap();
    workbench::dispatch_db(&db,"save_activity",&json!({"id":"a","projectId":"p","title":"评审","kind":"review","occurredOn":"2026-09-29","meetingId":"meeting"})).unwrap();
    let entry=json!({"id":"e","content":"完成初稿","occurredOn":"2026-09-29","projectId":"p","activityId":"a"});
    workbench::save_entry(&db,&entry,false).unwrap();
    let mut edited=entry.clone();edited["content"]=json!("初稿提交，等待反馈");workbench::save_entry(&db,&edited,false).unwrap();
    let before=project_hub::dispatch(&db,"entry_history",&json!({"entryId":"e"})).unwrap();
    let backup=create_backup_snapshot(&db,&dir.0.join("backups")).unwrap();
    edited["content"]=json!("后来修改");workbench::save_entry(&db,&edited,false).unwrap();
    restore_database_backup(&mut db,&dir.0.join("backups"),&backup.file_name).unwrap();
    assert_eq!(project_hub::dispatch(&db,"entry_history",&json!({"entryId":"e"})).unwrap(),before);
    assert_eq!(project_hub::load(&db,Some("p")).unwrap()["activities"][0]["id"],"a");
    workbench::export(&db,&dir.0).unwrap();
    assert!(fs::read_to_string(dir.0.join("项目活动资料与进展历史.json")).unwrap().contains("完成初稿"));
}

#[test]
fn legacy_backup_without_hub_tables_seeds_only_known_entry_state() {
    let dir=TestDirectory::new();let legacy=sample_database(&dir.0.join("old.sqlite3"));
    workbench::save_entry(&legacy,&json!({"id":"e","content":"旧版记录","occurredOn":"2026-09-01"}),false).unwrap();
    drop_history_triggers(&legacy);
    for (table,_) in project_hub::TABLES.iter().rev() { legacy.execute_batch(&format!("DROP TABLE {table}")).unwrap(); }
    let backup=create_backup_snapshot(&legacy,&dir.0.join("backups")).unwrap();
    let mut live=sample_database(&dir.0.join("live-new.sqlite3"));
    restore_database_backup(&mut live,&dir.0.join("backups"),&backup.file_name).unwrap();
    let history=project_hub::dispatch(&live,"entry_history",&json!({"entryId":"e"})).unwrap();
    assert_eq!(history.as_array().unwrap().len(),1);
    assert_eq!(history[0]["entry"]["content"],"旧版记录");
}

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

/// 老版本的库不带这套历史触发器：它们与 tasks.owner 是同一批迁移引入的（见
/// project_hub_schema.sql），所以模拟老库时必须先摘掉。
/// 顺序不能反：SQLite 执行 ALTER TABLE DROP COLUMN 后会重新解析整个 schema，
/// 触发器里引用的 NEW.owner 已不存在，删列语句本身就会失败——
/// error in trigger task_progress_update after drop column: no such column: NEW.owner
fn drop_history_triggers(connection: &Connection) {
    connection
        .execute_batch(
            "DROP TRIGGER IF EXISTS task_progress_update;
             DROP TRIGGER IF EXISTS work_entry_history_insert;
             DROP TRIGGER IF EXISTS work_entry_history_update;",
        )
        .unwrap();
}

#[test]
fn work_capture_is_idempotent_and_validates_dates_and_projects() {
    let directory = TestDirectory::new();
    let db = sample_database(&directory.0.join("capture.sqlite3"));
    let entry = json!({"id":"external-1","content":"报价已提交，等待客户确认","occurredOn":"2026-09-22","status":"waiting"});
    let first = workbench::save_entry(&db, &entry, true).unwrap();
    assert_eq!(workbench::save_entry(&db, &entry, true).unwrap(), first);
    let mut conflict = entry.clone();
    conflict["content"] = json!("different");
    assert!(workbench::save_entry(&db, &conflict, true).is_err());
    assert!(workbench::save_entry(&db, &json!({"id":"bad","content":"x","occurredOn":"2026-02-30"}), true).is_err());
    assert!(workbench::save_entry(&db, &json!({"id":"bad","content":"x","occurredOn":"2026-09-22","projectId":"missing"}), true).is_err());
    assert_eq!(db.query_row("SELECT count(*) FROM work_entries", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
}

#[test]
fn report_uses_actual_completion_date_and_project_inheritance() {
    let directory = TestDirectory::new();
    let db = sample_database(&directory.0.join("report.sqlite3"));
    workbench::dispatch_db(&db,"save_project",&json!({"id":"project","name":"客户项目"})).unwrap();
    workbench::dispatch_db(&db,"link_project",&json!({"entityType":"meeting","entityId":"meeting","projectId":"project"})).unwrap();
    db.execute("UPDATE tasks SET completed=1 WHERE id='task'",[]).unwrap();
    db.execute("UPDATE task_activity SET completed_at='2026-09-23T10:00:00+08:00' WHERE task_id='task'",[]).unwrap();
    db.execute("UPDATE task_history SET occurred_at='2026-09-23T10:00:00+08:00' WHERE task_id='task'",[]).unwrap();
    // A later title/owner edit must not move a completed task into a different report week.
    db.execute("UPDATE tasks SET title='提交新版方案' WHERE id='task'",[]).unwrap();
    assert_eq!(text_value(&db,"SELECT completed_at FROM task_activity WHERE task_id='task'"),"2026-09-23T10:00:00+08:00");
    workbench::save_entry(&db,&json!({"id":"entry","content":"会外完成报价","occurredOn":"2026-09-22","projectId":"project","status":"done"}),true).unwrap();
    workbench::save_entry(&db,&json!({"id":"other","content":"其他项目工作","occurredOn":"2026-09-22"}),true).unwrap();
    let material=workbench::material(&db,"2026-09-21",Some("project")).unwrap();
    assert_eq!(material.sources.len(),2);
    assert!(material.sources.iter().any(|s|s.source_type=="task_event"&&s.content.contains("标记完成")));
    assert!(material.sources.iter().any(|s|s.source_type=="entry"&&s.id=="entry"));
    assert!(workbench::material(&db,"2026-09-28",Some("project")).unwrap().sources.is_empty());
    db.execute("UPDATE tasks SET completed=0 WHERE id='task'",[]).unwrap();
    db.execute("UPDATE task_history SET occurred_at='2026-09-29T10:00:00+08:00' WHERE task_id='task' AND json_extract(snapshot_json,'$.completed')=0",[]).unwrap();
    let old_week=workbench::material(&db,"2026-09-21",Some("project")).unwrap();
    assert!(old_week.sources.iter().any(|s|s.source_type=="task_event"&&s.content.contains("标记完成")));
    assert!(!old_week.sources.iter().any(|s|s.source_type=="task_event"&&s.content.contains("当时操作：重新打开")));
    assert!(db.query_row("SELECT completed_at FROM task_activity WHERE task_id='task'",[],|r|r.get::<_,Option<String>>(0)).unwrap().is_none());
}

#[test]
fn workbench_backup_and_export_preserve_entries_reports_and_source_snapshots() {
    let directory=TestDirectory::new();
    let mut db=sample_database(&directory.0.join("live.sqlite3"));
    workbench::dispatch_db(&db,"save_project",&json!({"id":"project","name":"客户项目"})).unwrap();
    workbench::save_entry(&db,&json!({"id":"entry","content":"原始工作记录","occurredOn":"2026-09-22","projectId":"project"}),true).unwrap();
    db.execute("INSERT INTO weekly_reports VALUES('report','2026-09-21','project','已编辑周报','[]','[]','created','version-1')",[]).unwrap();
    let snapshot=create_backup_snapshot(&db,&directory.0.join("backups")).unwrap();
    db.execute("UPDATE work_entries SET content='修改后的记录'",[]).unwrap();
    db.execute("DELETE FROM weekly_reports",[]).unwrap();
    restore_database_backup(&mut db,&directory.0.join("backups"),&snapshot.file_name).unwrap();
    assert_eq!(text_value(&db,"SELECT content FROM work_entries"),"原始工作记录");
    assert_eq!(text_value(&db,"SELECT content FROM weekly_reports"),"已编辑周报");
    assert!(workbench::dispatch_db(&db,"save_report",&json!({"id":"report","content":"conflict","updatedAt":"wrong"})).is_err());
    assert_eq!(workbench::export(&db,&directory.0).unwrap(),2);
    assert!(fs::read_to_string(directory.0.join("工作记录-2026-09-22-entry.md")).unwrap().contains("客户项目"));
    assert!(fs::read_to_string(directory.0.join("周报-2026-09-21-report.md")).unwrap().contains("来源快照"));
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
    drop_history_triggers(&legacy);
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
    drop_history_triggers(&connection);
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
