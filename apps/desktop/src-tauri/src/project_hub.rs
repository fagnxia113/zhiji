//! Project/activity/file relationships. File registration never copies or deletes originals.
use super::*;
use rusqlite::OptionalExtension;
use serde_json::Value;

pub(super) const TABLES: &[(&str, &str)] = &[
    ("project_profiles", "project_id,goal,stage"),
    ("activities", "id,title,kind,occurred_on,meeting_id,created_at"),
    ("activity_projects", "activity_id,project_id"),
    ("resources", "id,path,path_key,title,size_bytes,modified_at,registered_at"),
    ("resource_projects", "resource_id,project_id,role"),
    ("resource_activities", "resource_id,activity_id,role"),
    ("entry_context", "entry_id,context_json"),
    ("entry_history", "sequence,entry_id,snapshot_json,recorded_at"),
    ("task_history", "sequence,task_id,occurred_at,project_id,snapshot_json"),
];

pub(super) fn migrate(db: &Connection) -> Result<(), Box<dyn Error>> {
    db.execute_batch(include_str!("project_hub_schema.sql"))?;
    Ok(())
}

fn required<'a>(a: &'a Value, key: &str) -> Result<&'a str, String> {
    a[key].as_str().filter(|s| !s.trim().is_empty()).ok_or_else(|| format!("缺少 {key}"))
}
fn optional<'a>(a: &'a Value, key: &str) -> Option<&'a str> {
    a[key].as_str().filter(|s| !s.is_empty())
}
fn exists(db: &Connection, table: &str, id: &str) -> Result<(), String> {
    let found: bool = db.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id=?1)"), [id], |r| r.get(0)).map_err(app_error)?;
    if found { Ok(()) } else { Err("关联对象不存在，请刷新后重试".into()) }
}
fn rows(db: &Connection, sql: &str, project: Option<&str>) -> Result<Vec<Value>, String> {
    let mut stmt = db.prepare(sql).map_err(app_error)?;
    let values = stmt.query_map([project], |r| r.get::<_, String>(0)).map_err(app_error)?;
    values.map(|v| serde_json::from_str(&v.map_err(app_error)?).map_err(app_error)).collect()
}
pub(super) fn atomic<T>(db: &Connection, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    db.execute_batch("SAVEPOINT hub_write").map_err(app_error)?;
    match f() {
        Ok(value) => { db.execute_batch("RELEASE hub_write").map_err(app_error)?; Ok(value) }
        Err(error) => { db.execute_batch("ROLLBACK TO hub_write; RELEASE hub_write").map_err(app_error)?; Err(error) }
    }
}

pub(super) fn load(db: &Connection, project: Option<&str>) -> Result<Value, String> {
    if let Some(pid) = project { exists(db, "projects", pid)?; }
    let activities = rows(db, "SELECT json_object('id',a.id,'title',a.title,'kind',a.kind,'occurredOn',a.occurred_on,'meetingId',a.meeting_id) FROM activities a WHERE ?1 IS NULL OR EXISTS(SELECT 1 FROM activity_projects p WHERE p.activity_id=a.id AND p.project_id=?1) ORDER BY a.occurred_on DESC,a.id", project)?;
    let resources = rows(db, "SELECT json_object('id',r.id,'title',r.title,'path',r.path,'sizeBytes',r.size_bytes,'modifiedAt',r.modified_at,'contentStatus','metadata_only') FROM resources r WHERE ?1 IS NULL OR EXISTS(SELECT 1 FROM resource_projects p WHERE p.resource_id=r.id AND p.project_id=?1) OR EXISTS(SELECT 1 FROM resource_activities x JOIN activity_projects p ON p.activity_id=x.activity_id WHERE x.resource_id=r.id AND p.project_id=?1) ORDER BY r.title,r.id", project)?;
    let activity_links = rows(db, "SELECT json_object('activityId',activity_id,'projectId',project_id) FROM activity_projects WHERE ?1 IS NULL OR project_id=?1", project)?;
    let file_links = rows(db, "SELECT json_object('resourceId',resource_id,'projectId',project_id,'role',role) FROM resource_projects WHERE ?1 IS NULL OR project_id=?1", project)?;
    let file_activities = rows(db, "SELECT json_object('resourceId',r.resource_id,'activityId',r.activity_id,'role',r.role) FROM resource_activities r WHERE ?1 IS NULL OR EXISTS(SELECT 1 FROM activity_projects p WHERE p.activity_id=r.activity_id AND p.project_id=?1)", project)?;
    let profiles = rows(db, "SELECT json_object('projectId',project_id,'goal',goal,'stage',stage) FROM project_profiles WHERE ?1 IS NULL OR project_id=?1", project)?;
    Ok(json!({"activities":activities,"resources":resources,"activityLinks":activity_links,"resourceLinks":file_links,"resourceActivities":file_activities,"profiles":profiles}))
}

pub(super) fn context(db: &Connection, entry: &str) -> Result<Value, String> {
    let value: Option<String> = db.query_row("SELECT context_json FROM entry_context WHERE entry_id=?1", [entry], |r| r.get(0)).optional().map_err(app_error)?;
    serde_json::from_str(value.as_deref().unwrap_or("{}")).map_err(app_error)
}

// Called before the entry INSERT/UPDATE within the same savepoint. The history trigger
// captures immutable context metadata together with the edited text.
pub(super) fn prepare_context(db: &Connection, a: &Value) -> Result<Value, String> {
    let previous = context(db, required(a, "id")?)?;
    if a.get("activityId").is_none() && a.get("resourceId").is_none() {
        if previous.as_object().is_none_or(|v| v.is_empty()) { return Ok(previous); }
        let old_project: Option<String> = db.query_row("SELECT project_id FROM work_entries WHERE id=?1",[required(a,"id")?],|r|r.get(0)).optional().map_err(app_error)?.flatten();
        if old_project.as_deref() != optional(a,"projectId") { return Err("该记录保留了原项目的活动或资料来源；请在新项目新增进展，避免更改历史归属".into()); }
        return Ok(previous);
    }
    let project = optional(a, "projectId");
    let hub = load(db, project)?;
    let mut result = json!({});
    if let Some(aid) = optional(a, "activityId") {
        let activity = hub["activities"].as_array().unwrap().iter().find(|v| v["id"] == aid).ok_or("活动不属于当前项目")?;
        result["activity"] = activity.clone();
    }
    if let Some(rid) = optional(a, "resourceId") {
        let resource = hub["resources"].as_array().unwrap().iter().find(|v| v["id"] == rid).ok_or("资料不属于当前项目")?;
        if let Some(aid) = optional(a, "activityId") {
            let linked: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM resource_activities WHERE resource_id=?1 AND activity_id=?2)", params![rid,aid], |r| r.get(0)).map_err(app_error)?;
            if !linked { return Err("资料未关联到所选活动".into()); }
        }
        result["resource"] = resource.clone();
    }
    Ok(result)
}

pub(super) fn write_context(db: &Connection, eid: &str, context: &Value) -> Result<(), String> {
    db.execute("INSERT INTO entry_context VALUES(?1,?2) ON CONFLICT(entry_id) DO UPDATE SET context_json=excluded.context_json", params![eid,context.to_string()]).map_err(app_error)?;
    Ok(())
}

pub(super) fn source_note(db: &Connection, eid: &str) -> Result<String, String> {
    let c = context(db, eid)?;
    let mut lines = Vec::new();
    if let Some(title) = c["activity"]["title"].as_str() { lines.push(format!("关联活动：{title}（{}）", c["activity"]["id"].as_str().unwrap_or(""))); }
    if let Some(title) = c["resource"]["title"].as_str() { lines.push(format!("关联资料：{title}（{}；登记修改标识 {}）。仅登记文件元信息，未读取正文、未保存原文件快照，不能据此推断文件内容或已交付。", c["resource"]["id"].as_str().unwrap_or(""), c["resource"]["modifiedAt"].as_str().unwrap_or(""))); }
    Ok(lines.join("\n"))
}

const FILE_TYPES: &[&str] = &["docx","doc","pdf","pptx","ppt","xlsx","xls","txt","md","rtf","csv","png","jpg","jpeg","wav","mp3","m4a","mp4"];
fn file_info(path: &str) -> Result<(PathBuf, String, i64, String), String> {
    let path = fs::canonicalize(path).map_err(|_| "文件不存在或无法读取，请重新选择文件")?;
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !FILE_TYPES.contains(&extension.as_str()) { return Err("请选择文档、图片或音视频资料，不支持执行文件或快捷方式".into()); }
    let metadata = fs::metadata(&path).map_err(app_error)?;
    if !metadata.is_file() { return Err("请选择具体文件".into()); }
    let title = path.file_name().and_then(|p| p.to_str()).ok_or("文件名无法读取")?.to_string();
    let modified = metadata.modified().map_err(app_error)?.duration_since(std::time::UNIX_EPOCH).map_err(app_error)?.as_nanos().to_string();
    // Explorer and Office expect ordinary drive/UNC paths, not canonicalize's
    // Windows extended-length prefix. Identity remains based on the resolved path.
    let display = path.to_string_lossy();
    let path = if let Some(rest) = display.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = display.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else { path.clone() };
    Ok((path, title, metadata.len().min(i64::MAX as u64) as i64, modified))
}

pub(super) fn dispatch(db: &Connection, action: &str, a: &Value) -> Result<Value, String> {
    match action {
        "load_project_hub" => load(db, optional(a, "projectId")),
        "save_project_profile" => {
            let pid = required(a,"projectId")?; exists(db,"projects",pid)?;
            let goal = a["goal"].as_str().unwrap_or("").trim();
            let stage = a["stage"].as_str().unwrap_or("").trim();
            if goal.chars().count() > 2000 || stage.chars().count() > 100 { return Err("目标最多 2000 字，阶段最多 100 字".into()); }
            db.execute("INSERT INTO project_profiles VALUES(?1,?2,?3) ON CONFLICT(project_id) DO UPDATE SET goal=excluded.goal,stage=excluded.stage", params![pid,goal,stage]).map_err(app_error)?;
            Ok(json!(true))
        }
        "save_activity" => atomic(db, || {
            let aid = required(a,"id")?;
            let title = required(a,"title")?.trim();
            if aid.len()>100 || title.chars().count()>200 { return Err("活动名称或标识过长".into()); }
            let kind = required(a,"kind")?;
            if !["meeting","research","training","review","other"].contains(&kind) { return Err("活动类型无效".into()); }
            let day = required(a,"occurredOn")?;
            let parsed = chrono::NaiveDate::parse_from_str(day,"%Y-%m-%d").map_err(|_| "活动日期无效")?;
            if parsed.format("%Y-%m-%d").to_string()!=day { return Err("活动日期无效".into()); }
            if let Some(mid) = optional(a,"meetingId") { exists(db,"meetings",mid)?; }
            let pid = required(a,"projectId")?; exists(db,"projects",pid)?;
            // Updating shared activity details requires an existing relationship. Adding
            // another relationship has its own explicit operation below.
            let existing: Option<String> = db.query_row("SELECT id FROM activities WHERE id=?1",[aid],|r|r.get(0)).optional().map_err(app_error)?;
            if existing.is_some() {
                let identical: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM activities a JOIN activity_projects p ON p.activity_id=a.id WHERE a.id=?1 AND a.title=?2 AND a.kind=?3 AND a.occurred_on=?4 AND a.meeting_id IS ?5 AND p.project_id=?6)",params![aid,title,kind,day,optional(a,"meetingId"),pid],|r|r.get(0)).map_err(app_error)?;
                if identical { return Ok(json!(true)); }
                return Err("活动已存在；请使用关联现有活动，避免覆盖原记录".into());
            }
            db.execute("INSERT INTO activities VALUES(?1,?2,?3,?4,?5,?6)",params![aid,title,kind,day,optional(a,"meetingId"),now()]).map_err(app_error)?;
            db.execute("INSERT INTO activity_projects VALUES(?1,?2)",params![aid,pid]).map_err(app_error)?;
            Ok(json!(true))
        }),
        "link_activity" => {
            let aid=required(a,"activityId")?; let pid=required(a,"projectId")?;
            exists(db,"activities",aid)?; exists(db,"projects",pid)?;
            db.execute("INSERT OR IGNORE INTO activity_projects VALUES(?1,?2)",params![aid,pid]).map_err(app_error)?;
            Ok(json!(true))
        }
        "register_resource" => atomic(db, || {
            let (path,title,size,modified)=file_info(required(a,"path")?)?;
            let path=path.to_string_lossy().into_owned();
            let key=if cfg!(windows) { path.to_lowercase() } else { path.clone() };
            let existing: Option<String>=db.query_row("SELECT id FROM resources WHERE path_key=?1",[&key],|r|r.get(0)).optional().map_err(app_error)?;
            let rid=existing.unwrap_or_else(id);
            db.execute("INSERT INTO resources VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET size_bytes=excluded.size_bytes,modified_at=excluded.modified_at",params![rid,path,key,title,size,modified,now()]).map_err(app_error)?;
            let mut link=a.clone(); link["resourceId"]=json!(rid);
            dispatch(db,"link_resource",&link)?;
            Ok(json!({"id":rid}))
        }),
        "link_resource" | "unlink_resource" => {
            let rid=required(a,"resourceId")?; exists(db,"resources",rid)?;
            let role=a["role"].as_str().unwrap_or("reference");
            if !["reference","process","output"].contains(&role) { return Err("资料用途无效".into()); }
            let (table,column,target)=if let Some(aid)=optional(a,"activityId") {
                exists(db,"activities",aid)?; ("resource_activities","activity_id",aid)
            } else { let pid=required(a,"projectId")?; exists(db,"projects",pid)?; ("resource_projects","project_id",pid) };
            if action=="unlink_resource" {
                db.execute(&format!("DELETE FROM {table} WHERE resource_id=?1 AND {column}=?2"),params![rid,target]).map_err(app_error)?;
            } else {
                db.execute(&format!("INSERT INTO {table} VALUES(?1,?2,?3) ON CONFLICT(resource_id,{column}) DO UPDATE SET role=excluded.role"),params![rid,target,role]).map_err(app_error)?;
            }
            Ok(json!(true))
        }
        "relocate_resource" => {
            let rid=required(a,"resourceId")?; exists(db,"resources",rid)?;
            let (path,title,size,modified)=file_info(required(a,"path")?)?;
            let path=path.to_string_lossy().into_owned();
            let key=if cfg!(windows) { path.to_lowercase() } else { path.clone() };
            let taken: bool=db.query_row("SELECT EXISTS(SELECT 1 FROM resources WHERE path_key=?1 AND id<>?2)",params![key,rid],|r|r.get(0)).map_err(app_error)?;
            if taken { return Err("该文件已登记为另一份资料，请直接关联现有资料".into()); }
            db.execute("UPDATE resources SET path=?1,path_key=?2,title=?3,size_bytes=?4,modified_at=?5 WHERE id=?6",params![path,key,title,size,modified,rid]).map_err(app_error)?;
            Ok(json!(true))
        }
        "open_resource" | "reveal_resource" => {
            let path: String=db.query_row("SELECT path FROM resources WHERE id=?1",[required(a,"resourceId")?],|r|r.get(0)).map_err(app_error)?;
            let (path,_,_,_)=file_info(&path)?;
            reveal_path(&path, action=="reveal_resource")?;
            Ok(json!(true))
        }
        "entry_history" => {
            let eid=required(a,"entryId")?;
            rows(db,"SELECT json_object('sequence',sequence,'recordedAt',recorded_at,'entry',json(snapshot_json)) FROM entry_history WHERE entry_id=?1 ORDER BY sequence DESC",Some(eid)).map(|v|json!(v))
        }
        _ => Err("未知的项目资料操作".into())
    }
}

pub(super) fn export(db: &Connection, dir: &Path) -> Result<(), String> {
    let mut data=load(db,None)?;
    data["entryHistory"]=json!(rows(db,"SELECT json_object('sequence',sequence,'recordedAt',recorded_at,'entry',json(snapshot_json)) FROM entry_history WHERE ?1 IS NULL ORDER BY sequence",None)?);
    data["entryContexts"]=json!(rows(db,"SELECT json_object('entryId',entry_id,'context',json(context_json)) FROM entry_context WHERE ?1 IS NULL",None)?);
    data["taskHistory"]=json!(task_history(db,None)?);
    data["filePolicy"]=json!("仅导出文件登记、关系与进展快照，不包含原文件字节；迁移时须保留原文件并重新定位失联资料。");
    fs::write(dir.join("项目活动资料与进展历史.json"),serde_json::to_string_pretty(&data).map_err(app_error)?).map_err(app_error)
}

pub(super) fn task_history(db: &Connection, project: Option<&str>) -> Result<Vec<Value>, String> {
    rows(db,"SELECT json_object('sequence',sequence,'taskId',task_id,'occurredAt',occurred_at,'projectId',project_id,'task',json(snapshot_json)) FROM task_history WHERE ?1 IS NULL OR project_id=?1 ORDER BY sequence",project)
}
