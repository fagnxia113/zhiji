//! Themes are independent views over projects; no work records or files are copied.
use super::*;
use std::collections::BTreeSet;
use serde_json::Value;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Theme { pub id: String, pub name: String, pub created_at: String }

pub(super) fn list(db: &Connection, project: Option<&str>) -> Result<Vec<Theme>, String> {
    let mut s = db.prepare("SELECT id,name,created_at FROM themes t WHERE ?1 IS NULL OR EXISTS(SELECT 1 FROM project_themes p WHERE p.theme_id=t.id AND p.project_id=?1) ORDER BY name,id").map_err(app_error)?;
    s.query_map([project], |r| Ok(Theme { id:r.get(0)?, name:r.get(1)?, created_at:r.get(2)? })).map_err(app_error)?.collect::<Result<Vec<_>,_>>().map_err(app_error)
}
pub(super) fn ids(db: &Connection, project: &str) -> Result<Vec<String>, String> {
    let mut s = db.prepare("SELECT theme_id FROM project_themes WHERE project_id=?1 ORDER BY theme_id").map_err(app_error)?;
    s.query_map([project], |r|r.get(0)).map_err(app_error)?.collect::<Result<Vec<_>,_>>().map_err(app_error)
}
pub(super) fn save(db: &Connection, id: &str, name: &str) -> Result<Theme, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 60 { return Err("主题名称须为 1～60 字".into()); }
    if list(db, None)?.iter().any(|t| t.id != id && t.name.to_lowercase() == name.to_lowercase()) { return Err("已有同名主题，请选用已有主题".into()); }
    db.execute("INSERT INTO themes(id,name,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name", params![id,name,now()]).map_err(app_error)?;
    list(db, None)?.into_iter().find(|t|t.id == id).ok_or_else(||"主题保存失败".into())
}
pub(super) fn assign(db: &Connection, project: &str, value: &Value) -> Result<(), String> {
    let values = value.as_array().ok_or("请选择主题列表")?;
    if values.len() > 32 { return Err("一个项目最多关联 32 个主题".into()); }
    let all = list(db, None)?;
    let mut ids = BTreeSet::new();
    for item in values {
        let tid = item.as_str().ok_or("主题标识无效")?;
        if !all.iter().any(|t|t.id == tid) { return Err("主题不存在，请刷新后重新选择".into()); }
        ids.insert(tid);
    }
    project_hub::atomic(db, || {
        db.execute("DELETE FROM project_themes WHERE project_id=?1", [project]).map_err(app_error)?;
        for tid in ids { db.execute("INSERT INTO project_themes VALUES(?1,?2)",params![project,tid]).map_err(app_error)?; }
        Ok(())
    })
}
// A project restriction and a theme always intersect. A theme can never widen API access.
pub(super) fn scope(db: &Connection, project: Option<&str>, theme: Option<&str>) -> Result<Option<BTreeSet<String>>, String> {
    if let Some(tid) = theme {
        if !list(db, None)?.iter().any(|t|t.id == tid) { return Err("主题不存在，请重新选择".into()); }
        let mut s = db.prepare("SELECT project_id FROM project_themes WHERE theme_id=?1 AND (?2 IS NULL OR project_id=?2) ORDER BY project_id").map_err(app_error)?;
        let rows = s.query_map(params![tid,project], |r|r.get(0)).map_err(app_error)?.collect::<Result<BTreeSet<_>,_>>().map_err(app_error)?;
        Ok(Some(rows))
    } else { Ok(project.map(|p|BTreeSet::from([p.to_string()]))) }
}
pub(super) fn matches(scope: &Option<BTreeSet<String>>, project: Option<&str>) -> bool {
    scope.as_ref().is_none_or(|ids| project.is_some_and(|p|ids.contains(p)))
}
pub(super) fn meeting_projects(db: &Connection, meeting: &str) -> Result<Vec<String>, String> {
    let mut s = db.prepare("SELECT project_id FROM project_links WHERE entity_type='meeting' AND entity_id=?1 UNION SELECT p.project_id FROM activity_projects p JOIN activities a ON a.id=p.activity_id WHERE a.meeting_id=?1 ORDER BY project_id").map_err(app_error)?;
    s.query_map([meeting],|r|r.get(0)).map_err(app_error)?.collect::<Result<Vec<_>,_>>().map_err(app_error)
}
pub(super) fn hub(db: &Connection, scope: &Option<BTreeSet<String>>) -> Result<Value, String> {
    let mut hub = project_hub::load(db, None)?;
    if scope.is_none() { return Ok(hub); }
    for key in ["profiles","activityLinks","resourceLinks"] {
        hub[key].as_array_mut().unwrap().retain(|v| matches(scope,v["projectId"].as_str()));
    }
    let activities = hub["activityLinks"].as_array().unwrap().iter().filter_map(|v|v["activityId"].as_str().map(str::to_string)).collect::<BTreeSet<_>>();
    hub["activities"].as_array_mut().unwrap().retain(|v|v["id"].as_str().is_some_and(|id|activities.contains(id)));
    hub["resourceActivities"].as_array_mut().unwrap().retain(|v|v["activityId"].as_str().is_some_and(|id|activities.contains(id)));
    let resources = hub["resourceLinks"].as_array().unwrap().iter().chain(hub["resourceActivities"].as_array().unwrap()).filter_map(|v|v["resourceId"].as_str().map(str::to_string)).collect::<BTreeSet<_>>();
    hub["resources"].as_array_mut().unwrap().retain(|v|v["id"].as_str().is_some_and(|id|resources.contains(id)));
    Ok(hub)
}
