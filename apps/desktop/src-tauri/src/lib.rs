use std::{collections::HashMap, error::Error, fs, io::{self, Read, Write}, path::{Path, PathBuf}, process::{Child, Command}, sync::{Arc, Mutex}, sync::atomic::{AtomicBool, Ordering}};

use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Local;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

mod recorder;
mod live_session;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const SENSEVOICE_MODEL_NAME: &str = "sensevoice-small-q8.gguf";
const FSMN_VAD_MODEL_NAME: &str = "fsmn-vad.gguf";
const SENSEVOICE_MODEL_URLS: &[&str] = &[
    "https://modelscope.cn/models/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/master/sensevoice-small-q8.gguf",
    "https://hf-mirror.com/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/main/sensevoice-small-q8.gguf",
];
const FSMN_VAD_MODEL_URLS: &[&str] = &[
    "https://modelscope.cn/models/FunAudioLLM/fsmn-vad-GGUF/resolve/master/fsmn-vad.gguf",
    "https://hf-mirror.com/FunAudioLLM/fsmn-vad-GGUF/resolve/main/fsmn-vad.gguf",
];
const SENSEVOICE_EXECUTABLE: &str = "llama-funasr-sensevoice.exe";
const FFMPEG_EXECUTABLE: &str = "ffmpeg.exe";
const MODEL_DOWNLOAD_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Zhiji/1.0";
const ALIYUN_PYPI_INDEX: &str = "https://mirrors.aliyun.com/pypi/simple/";
const OFFICIAL_PYPI_INDEX: &str = "https://pypi.org/simple";
const PYTORCH_CPU_INDEX: &str = "https://download.pytorch.org/whl/cpu";
const TORCH_CPU_VERSION: &str = "torch==2.11.0+cpu";
const TORCHAUDIO_CPU_VERSION: &str = "torchaudio==2.11.0+cpu";
const SPEAKER_ENGINE_VERSION: &str = "9";
const SPEAKER_MODELS_VERSION: &str = "quality-2pass-v1";
const VC_RUNTIME_DLLS: &[&str] = &[
    "concrt140.dll", "msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll",
    "msvcp140_atomic_wait.dll", "msvcp140_codecvt_ids.dll", "vcomp140.dll",
    "vcruntime140.dll", "vcruntime140_1.dll",
];
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PYTHON_EMBED_URL: &str = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip";
const GET_PIP_URL: &str = "https://bootstrap.pypa.io/get-pip.py";
// 数据位置引导配置存放在系统默认配置目录（位置固定，不随个人数据迁移）：
const DATA_LOCATION_FILE: &str = "data-location.json";
const RELOCATION_PENDING_FILE: &str = "data-relocation-pending.json";
const RELOCATION_ERROR_FILE: &str = "data-relocation-error.txt";

/// 录音期间阻止系统睡眠的电源请求守卫。
///
/// Windows 上通过 PowerCreateRequest + PowerSetRequest(PowerRequestSystemRequired)
/// 持有电源请求，Drop 时自动撤销并关闭句柄；请求一旦创建会一直生效到进程结束，
/// 所以必须显式管理生命周期（录音开始创建、结束/中止/保存时释放）。
/// 非 Windows 平台为空实现，acquire 直接返回 None。
struct SleepGuard {
    #[cfg(windows)]
    handle: *mut core::ffi::c_void,
}

#[cfg(windows)]
impl SleepGuard {
    fn acquire() -> Option<SleepGuard> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Power::{
            PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
        };
        use windows_sys::Win32::System::Threading::REASON_CONTEXT;
        // 未提供理由字符串（SimpleReasonString 留空），仅在 powercfg /requests 中显示为空原因，
        // 避免在守卫内长期持有宽字符串的生命周期。
        let mut context: REASON_CONTEXT = unsafe { std::mem::zeroed() };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            eprintln!("创建防睡眠电源请求失败");
            return None;
        }
        let active = unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) } != 0;
        if !active {
            eprintln!("设置防睡眠电源请求失败");
            unsafe { CloseHandle(handle) };
            return None;
        }
        eprintln!("录音防睡眠电源请求已生效");
        Some(SleepGuard { handle })
    }
}

#[cfg(windows)]
impl Drop for SleepGuard {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Power::{PowerClearRequest, PowerRequestSystemRequired};
        unsafe {
            PowerClearRequest(self.handle, PowerRequestSystemRequired);
            CloseHandle(self.handle);
        }
        eprintln!("录音防睡眠电源请求已撤销");
    }
}

#[cfg(not(windows))]
impl SleepGuard {
    fn acquire() -> Option<SleepGuard> {
        None
    }
}

#[cfg(not(windows))]
impl Drop for SleepGuard {
    fn drop(&mut self) {}
}

// 句柄只在本应用内被串行持有（录音期间创建、结束/中止时释放），跨线程传递安全。
#[cfg(windows)]
unsafe impl Send for SleepGuard {}
#[cfg(windows)]
unsafe impl Sync for SleepGuard {}

struct AppState {
    connection: Mutex<Connection>,
    data_dir: PathBuf,
    /// 系统默认数据目录：语音模型/说话人引擎固定放这里；也是自定义数据位置为空时的数据根目录。
    default_data_dir: PathBuf,
    /// 系统默认配置目录：数据位置引导文件（data-location.json 等）固定放这里，不随个人数据迁移。
    config_dir: PathBuf,
    backups_dir: PathBuf,
    models_dir: PathBuf,
    recordings_dir: PathBuf,
    runtime_dir: PathBuf,
    ffmpeg_dir: PathBuf,
    vcrt_dir: PathBuf,
    speaker_engine_dir: PathBuf,
    speaker_models_dir: PathBuf,
    cancel_flag: Arc<AtomicBool>,
    cancel_child: Arc<Mutex<Option<Child>>>,
    active_recording: Mutex<Option<String>>,
    recorders: Mutex<HashMap<String, recorder::SystemCaptureHandle>>,
    live_sessions: Mutex<HashMap<String, live_session::LiveSession>>,
    sleep_prevention: Mutex<Option<SleepGuard>>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Meeting {
    id: String,
    notebook_id: Option<String>,
    title: String,
    started_at: String,
    duration_seconds: i64,
    status: String,
    transcript: String,
    minutes: String,
    decisions: String,
    speaker_segments: String,
    #[serde(default)]
    speaker_names: String,
    audio_path: Option<String>,
    updated_at: String,
    #[serde(default)]
    context: String,
    #[serde(default)]
    notes: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingFinalizeResult {
    meeting: Meeting,
    system_audio_captured: bool,
    warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BeginRecordingResult {
    live_enabled: bool,
    live_source: String,
    warning: Option<String>,
}

fn default_task_origin() -> String { "manual".to_string() }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    title: String,
    source_type: Option<String>,
    source_id: Option<String>,
    completed: bool,
    due_date: Option<String>,
    created_at: String,
    #[serde(default = "default_task_origin")]
    origin: String,
    // 负责人：结构化存储，替代过去从标题「XX：」前缀正则反推（改标题不再丢负责人）。默认空串。
    #[serde(default)]
    owner: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Workspace { meetings: Vec<Meeting>, tasks: Vec<Task> }

// 会议问答消息：一问一答持久化在 qa_messages 表，按会议隔离
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QaMessage {
    id: String,
    meeting_id: String,
    question: String,
    answer: String,
    created_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiSettings { base_url: String, analysis_model: String, is_configured: bool }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiSettingsInput { base_url: String, analysis_model: String, api_key: Option<String> }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AsrEngineSettings {
    provider: String,
    cloud_base_url: String,
    cloud_model: String,
    cloud_key_saved: bool,
    local_hotwords: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsrEngineSettingsInput {
    provider: String,
    cloud_base_url: String,
    cloud_model: String,
    api_key: Option<String>,
    #[serde(default)]
    local_hotwords: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisResponse {
    #[serde(default, deserialize_with = "string_or_seq_to_string")]
    theme: String,
    #[serde(default, deserialize_with = "string_or_seq_to_string")]
    minutes: String,
    #[serde(default, deserialize_with = "string_or_seq_to_string")]
    decisions: String,
    #[serde(default)]
    action_items: Vec<AnalysisActionItem>,
    #[serde(default)]
    source_highlights: Vec<AnalysisSourceHighlight>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisActionItem {
    #[serde(default, deserialize_with = "string_or_seq_to_string")]
    title: String,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    assignee: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisSourceHighlight {
    #[serde(default)]
    label: String,
    #[serde(default)]
    time_ms: i64,
    #[serde(default)]
    quote: String,
}

fn string_or_seq_to_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(String::new()),
        Some(serde_json::Value::String(s)) => Ok(s),
        Some(serde_json::Value::Array(arr)) => {
            let items: Vec<String> = arr
                .into_iter()
                .filter_map(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => v.as_str().map(|s| s.to_string()),
                })
                .collect();
            Ok(items.join("\n"))
        }
        Some(other) => Ok(other.to_string()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisResult { meeting: Meeting, tasks: Vec<Task> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAsrStatus { installed: bool, runtime_available: bool, model_size_mb: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeakerEngineStatus { installed: bool, models_ready: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    file_name: String,
    created_at: String,
    size_mb: f64,
    is_valid: bool,
    meeting_count: i64,
    task_count: i64,
    note_count: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeakerTranscript { transcript: String, segments: Vec<SpeakerSegment> }

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SpeakerSegment { speaker: String, #[serde(default)] speaker_id: i64, start_ms: i64, end_ms: i64, text: String }

fn now() -> String { Local::now().to_rfc3339() }
fn id() -> String { Uuid::new_v4().to_string() }
fn app_error(error: impl std::fmt::Display) -> String { error.to_string() }

/// 从 RFC3339 时间串取会议日期前缀 YYYYMMDD；解析失败退回当天
fn meeting_date_prefix(started_at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(started_at)
        .map(|value| value.format("%Y%m%d").to_string())
        .unwrap_or_else(|_| Local::now().format("%Y%m%d").to_string())
}

/// 清洗 AI 返回的会议主题：去空白/换行/书名号/引号，去掉首尾标点，限长 24 字
fn sanitize_theme(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|ch| !matches!(ch, '\n' | '\r' | '\t' | '《' | '》' | '"' | '\u{201C}' | '\u{201D}' | '\'' | '\u{2018}' | '\u{2019}'))
        .collect();
    let trimmed = cleaned.trim().trim_matches(|ch: char| ch == '。' || ch == '，' || ch == '、' || ch == ' ');
    trimmed.chars().take(24).collect()
}

/// 生成规范会议名：YYYYMMDD-主题（日期取开会当天，主题为空时返回 None 不改名）
fn auto_meeting_title(started_at: &str, theme: &str) -> Option<String> {
    let theme = sanitize_theme(theme);
    if theme.is_empty() { return None; }
    Some(format!("{}-{}", meeting_date_prefix(started_at), theme))
}

fn resource_folder(resource_dir: &Path, name: &str, executable: &str) -> PathBuf {
    [resource_dir.join(name), resource_dir.join("resources").join(name)]
        .into_iter()
        .find(|path| path.join(executable).is_file())
        .unwrap_or_else(|| resource_dir.join(name))
}

/// 自定义数据位置引导配置（JSON 存在系统默认配置目录，位置固定，不随数据迁移）。
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataLocationFile {
    data_dir: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelocationPendingFile {
    target: String,
}

fn config_path(config_dir: &Path, name: &str) -> PathBuf {
    config_dir.join(name)
}

fn read_data_location(config_dir: &Path) -> Option<PathBuf> {
    let path = config_path(config_dir, DATA_LOCATION_FILE);
    let Ok(raw) = fs::read_to_string(&path) else { return None; };
    let parsed: DataLocationFile = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            // 配置损坏不应阻断启动：忽略并退回系统默认位置（不删除原文件，便于排查）
            eprintln!("读取数据位置配置失败，使用系统默认位置：{error}");
            return None;
        }
    };
    let value = parsed.data_dir?;
    if value.trim().is_empty() { return None; }
    Some(PathBuf::from(value))
}

fn write_data_location(config_dir: &Path, dir: &Path) -> Result<(), Box<dyn Error>> {
    let path = config_path(config_dir, DATA_LOCATION_FILE);
    let content = serde_json::to_string_pretty(&DataLocationFile {
        data_dir: Some(dir.to_string_lossy().to_string()),
    })?;
    fs::write(path, content)?;
    Ok(())
}

fn relocation_pending_target(config_dir: &Path) -> Option<PathBuf> {
    let path = config_path(config_dir, RELOCATION_PENDING_FILE);
    let raw = fs::read_to_string(&path).ok()?;
    let parsed: RelocationPendingFile = serde_json::from_str(&raw).ok()?;
    Some(PathBuf::from(parsed.target))
}

fn write_relocation_pending(config_dir: &Path, target: &Path) -> Result<(), String> {
    let path = config_path(config_dir, RELOCATION_PENDING_FILE);
    let content = serde_json::to_string_pretty(&RelocationPendingFile {
        target: target.to_string_lossy().to_string(),
    }).map_err(app_error)?;
    fs::write(path, content).map_err(app_error)
}

fn clear_relocation_pending(config_dir: &Path) {
    let _ = fs::remove_file(config_path(config_dir, RELOCATION_PENDING_FILE));
}

fn read_relocation_error(config_dir: &Path) -> Option<String> {
    let path = config_path(config_dir, RELOCATION_ERROR_FILE);
    let raw = fs::read_to_string(&path).ok()?;
    let value = raw.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn write_relocation_error(config_dir: &Path, message: &str) {
    let _ = fs::write(config_path(config_dir, RELOCATION_ERROR_FILE), message);
}

fn clear_relocation_error(config_dir: &Path) {
    let _ = fs::remove_file(config_path(config_dir, RELOCATION_ERROR_FILE));
}

/// 启动时解析数据位置：读取自定义配置，并执行上次安排的目录迁移。
/// 迁移必须在数据库连接打开之前完成，因此放在 open_state 最前。
fn resolve_data_location(config_dir: &Path, default_data_dir: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let mut data_dir = read_data_location(config_dir).unwrap_or_else(|| default_data_dir.to_path_buf());
    if relocation_pending_target(config_dir).is_some() {
        match apply_pending_relocation(config_dir, &data_dir) {
            Ok(moved_to) => {
                data_dir = moved_to;
                if let Err(error) = write_data_location(config_dir, &data_dir) {
                    eprintln!("写入数据位置配置失败：{error}");
                }
            }
            Err(error) => {
                eprintln!("数据目录迁移失败，本次仍使用原目录：{error}");
                write_relocation_error(config_dir, &error);
            }
        }
        clear_relocation_pending(config_dir);
    }
    Ok(data_dir)
}

/// 执行一次数据目录迁移：把数据库 / recordings / backups 从当前目录迁往待定目标。
/// 成功返回新数据目录；失败返回错误（本次启动继续用原目录）。
fn apply_pending_relocation(config_dir: &Path, current: &Path) -> Result<PathBuf, String> {
    let Some(target) = relocation_pending_target(config_dir) else { return Ok(current.to_path_buf()); };
    if !target.is_dir() {
        return Err(format!("目标目录不存在或不可访问：{}", target.display()));
    }
    let target = target.canonicalize().map_err(|error| format!("无法访问目标目录 {}：{error}", target.display()))?;
    let current = current.canonicalize().map_err(|error| format!("无法访问当前数据目录 {}：{error}", current.display()))?;
    if target == current { return Ok(current.to_path_buf()); }
    if path_within(&target, &current) || path_within(&current, &target) {
        return Err("目标目录不能位于当前数据目录之内（或反向包含），请选择其他文件夹".to_string());
    }
    let target_db = target.join("zhiji.sqlite3");
    let current_db = current.join("zhiji.sqlite3");
    // 目标已含数据库（用户指向既有数据目录），或源数据库已不在（上次迁移到一半中断后重启）：
    // 直接切换使用目标目录，不再搬动任何文件。
    if target_db.is_file() || !current_db.is_file() {
        if !target_db.is_file() {
            return Err("当前数据目录的数据库已不存在，且目标目录也没有数据库，无法完成迁移".to_string());
        }
        eprintln!("目标目录已存在知记数据，直接切换使用：{}", target.display());
        return Ok(target.to_path_buf());
    }
    eprintln!("开始迁移个人数据到：{}", target.display());
    // 1) 先改写录音绝对路径前缀（源数据库尚未移动，此步失败时没有任何文件变动）
    rewrite_audio_path_prefix(&current_db, &current, &target)?;
    // 2) 迁移 recordings / backups 子目录（跨盘自动降级为复制+删除；目标已有同名文件则跳过，保证中断后能续迁）
    for sub in ["recordings", "backups"] {
        let source = current.join(sub);
        let destination = target.join(sub);
        fs::create_dir_all(&destination).map_err(|error| format!("创建 {} 失败：{error}", destination.display()))?;
        if source.is_dir() { move_tree(&source, &destination)?; }
    }
    // 3) 移动数据库文件（含 -wal/-shm 残留）
    move_db_file(&current_db, &target_db)?;
    eprintln!("数据目录迁移完成：{}", target.display());
    Ok(target.to_path_buf())
}

/// 迁移前把数据库里指向旧数据目录的录音绝对路径改写为新前缀。
/// SQLite 的 substr/length 按字符（UTF-8）计，与 Rust 侧字符长度一致。
fn rewrite_audio_path_prefix(database: &Path, from_dir: &Path, to_dir: &Path) -> Result<(), String> {
    let from_prefix = from_dir.to_string_lossy().to_string();
    let to_prefix = to_dir.to_string_lossy().to_string();
    let prefix_len = from_prefix.chars().count() as i64;
    let connection = Connection::open(database).map_err(|error| format!("无法打开数据库进行路径改写：{error}"))?;
    let changed = connection.execute(
        "UPDATE meetings SET audio_path = ?1 || substr(audio_path, ?2) WHERE substr(audio_path, 1, ?3) = ?4",
        params![to_prefix, prefix_len + 1, prefix_len, from_prefix],
    ).map_err(|error| format!("改写录音路径失败：{error}"))?;
    if changed > 0 { eprintln!("已改写 {changed} 条录音的绝对路径前缀"); }
    Ok(())
}

fn move_db_file(source: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err(format!("目标位置已存在数据库：{}", destination.display()));
    }
    move_entry(source, destination)?;
    for suffix in ["-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{}", source.display(), suffix));
        if from.is_file() {
            let to = PathBuf::from(format!("{}{}", destination.display(), suffix));
            let _ = fs::remove_file(&to);
            move_entry(&from, &to)?;
        }
    }
    Ok(())
}

/// 移动单个文件：先尝试原子改名，失败（如跨盘 EXDEV）时降级为复制后删除源。
fn move_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if fs::rename(source, destination).is_ok() { return Ok(()); }
    fs::copy(source, destination).map_err(|error| format!("移动 {} 失败：{error}", source.display()))?;
    fs::remove_file(source).map_err(|error| format!("清理 {} 失败：{error}", source.display()))?;
    Ok(())
}

/// 把 src 目录树下的文件递归迁到 dst（保持相对结构）。目标已有同名文件则跳过并清理源副本，
/// 保证「迁移到一半中断、下次启动续迁」时不会重复搬移。
fn move_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(source.to_path_buf(), destination.to_path_buf())];
    while let Some((from, to)) = stack.pop() {
        let entries = fs::read_dir(&from).map_err(|error| format!("读取 {} 失败：{error}", from.display()))?;
        for entry in entries.flatten() {
            let child_from = entry.path();
            let child_to = to.join(entry.file_name());
            if child_from.is_dir() {
                fs::create_dir_all(&child_to).map_err(|error| format!("创建 {} 失败：{error}", child_to.display()))?;
                stack.push((child_from, child_to));
            } else if child_from.is_file() {
                if child_to.exists() {
                    let _ = fs::remove_file(&child_from);
                } else {
                    move_entry(&child_from, &child_to)?;
                }
            }
        }
    }
    Ok(())
}

/// child 是否位于 parent 目录内（含等于）。Windows 上忽略大小写与斜杠方向。
#[cfg(windows)]
fn path_within(child: &Path, parent: &Path) -> bool {
    let child = child.to_string_lossy().replace('/', "\\").to_lowercase();
    let parent = parent.to_string_lossy().replace('/', "\\").to_lowercase();
    child == parent || child.starts_with(&format!("{parent}\\"))
}

#[cfg(not(windows))]
fn path_within(child: &Path, parent: &Path) -> bool {
    let child = child.to_string_lossy().to_string();
    let parent = parent.to_string_lossy().to_string();
    child == parent || child.starts_with(&format!("{parent}/"))
}

fn open_state(app: &AppHandle) -> Result<AppState, Box<dyn Error>> {
    let default_data_dir = app.path().app_data_dir()?;
    let config_dir = app.path().app_config_dir()?;
    // 数据位置：默认在系统数据目录；用户自定义后，数据库/录音/备份放在所选目录。
    // 若有上次安排的迁移，会在这里（打开数据库前）执行。
    let data_dir = resolve_data_location(&config_dir, &default_data_dir)?;
    let recordings_dir = data_dir.join("recordings");
    let backups_dir = data_dir.join("backups");
    // 语音模型与说话人引擎体积大、可重新下载，固定放系统默认目录，不随个人数据一起迁移。
    let models_dir = default_data_dir.join("models");
    let speaker_engine_dir = default_data_dir.join("speaker-engine");
    let speaker_models_dir = models_dir.join("funasr-meeting");
    fs::create_dir_all(&recordings_dir)?;
    fs::create_dir_all(&models_dir)?;
    fs::create_dir_all(&speaker_engine_dir)?;
    fs::create_dir_all(&backups_dir)?;
    // 自定义数据位置后录音目录不在默认 $APPDATA 下，需要动态放行 asset 协议的访问范围。
    let _ = app.asset_protocol_scope().allow_directory(&recordings_dir, true);
    // 应用升级后直接刷新内置脚本和协议版本。Python、依赖与模型仍沿用用户
    // 已经安装的内容，不需要再次下载数 GB 的运行组件。
    if let Err(error) = refresh_speaker_engine_scripts(&speaker_engine_dir, &speaker_models_dir) {
        eprintln!("刷新实时会议引擎脚本失败：{error}");
    }
    let resource_dir = app.path().resource_dir()?;
    let runtime_dir = resource_folder(&resource_dir, "funasr-runtime", SENSEVOICE_EXECUTABLE);
    let ffmpeg_dir = resource_folder(&resource_dir, "ffmpeg", FFMPEG_EXECUTABLE);
    let vcrt_dir = resource_folder(&resource_dir, "vcrt", "vcruntime140.dll");
    let database_path = data_dir.join("zhiji.sqlite3");
    let connection = Connection::open(&database_path)?;
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS notebooks (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY, notebook_id TEXT, title TEXT NOT NULL, content TEXT NOT NULL,
          tags TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meetings (
          id TEXT PRIMARY KEY, notebook_id TEXT, title TEXT NOT NULL, started_at TEXT NOT NULL,
          duration_seconds INTEGER NOT NULL, status TEXT NOT NULL, transcript TEXT NOT NULL,
          minutes TEXT NOT NULL, decisions TEXT NOT NULL, speaker_segments TEXT NOT NULL DEFAULT '[]',
          audio_path TEXT, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, source_type TEXT, source_id TEXT,
          completed INTEGER NOT NULL, due_date TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS qa_messages (
          id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, question TEXT NOT NULL,
          answer TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_meetings_started_at ON meetings(started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tasks_completed ON tasks(completed);
        CREATE INDEX IF NOT EXISTS idx_qa_meeting ON qa_messages(meeting_id, created_at);
        ",
    )?;
    ensure_column(&connection, "meetings", "speaker_segments", "TEXT NOT NULL DEFAULT '[]'")?;
    ensure_column(&connection, "meetings", "speaker_names", "TEXT NOT NULL DEFAULT '{}'")?;
    ensure_column(&connection, "meetings", "context", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&connection, "meetings", "notes", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&connection, "tasks", "origin", "TEXT NOT NULL DEFAULT 'manual'")?;
    ensure_column(&connection, "tasks", "owner", "TEXT NOT NULL DEFAULT ''")?;
    clean_stored_transcripts(&connection)?;
    if setting(&connection, "asr_provider", "local").is_ok_and(|provider| provider == "local") {
        live_session::warm_engine(speaker_engine_dir.clone(), speaker_models_dir.clone());
    }
    if let Err(error) = create_daily_backup(&connection, &backups_dir) {
        eprintln!("自动备份失败：{error}");
    }
    Ok(AppState { connection: Mutex::new(connection), data_dir, default_data_dir, config_dir, backups_dir, models_dir, recordings_dir, runtime_dir, ffmpeg_dir, vcrt_dir, speaker_engine_dir, speaker_models_dir, cancel_flag: Arc::new(AtomicBool::new(false)), cancel_child: Arc::new(Mutex::new(None)), active_recording: Mutex::new(None), recorders: Mutex::new(HashMap::new()), live_sessions: Mutex::new(HashMap::new()), sleep_prevention: Mutex::new(None) })
}

fn ensure_column(connection: &Connection, table: &str, column: &str, definition: &str) -> Result<(), Box<dyn Error>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let exists = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<Result<Vec<_>, _>>()?.iter().any(|name| name == column);
    if !exists { connection.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?; }
    Ok(())
}

/// 只读判断某表是否有某列（不改动数据库）。用于兼容缺少新列的旧备份。
fn table_has_column(connection: &Connection, table: &str, column: &str) -> bool {
    let names: Vec<String> = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .and_then(|mut statement| {
            // query_map 返回的迭代器借用 statement，必须在闭包内立即 collect，
            // 否则迭代器逃逸出闭包会导致 E0515（借用 statement 的值被返回）。
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        })
        .unwrap_or_default();
    names.iter().any(|name| name == column)
}

fn setting(connection: &Connection, key: &str, default: &str) -> Result<String, String> {
    connection.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |row| row.get(0))
        .or_else(|error| match error { rusqlite::Error::QueryReturnedNoRows => Ok(default.to_string()), other => Err(other) })
        .map_err(app_error)
}

fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(app_error)?;
    Ok(())
}

fn backup_infos(backups_dir: &Path) -> Result<Vec<BackupInfo>, String> {
    let mut backups = fs::read_dir(backups_dir)
        .map_err(app_error)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let file_name = path.file_name()?.to_str()?.to_string();
            if !file_name.starts_with("zhiji-backup-") || !file_name.ends_with(".sqlite3") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            let created_at = metadata
                .modified()
                .ok()
                .map(chrono::DateTime::<Local>::from)
                .map(|value| value.to_rfc3339())
                .unwrap_or_default();
            let (is_valid, meeting_count, task_count, note_count) = match Connection::open(&path) {
                Ok(connection) => {
                    let integrity = connection
                        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
                        .unwrap_or_default();
                    let count = |table: &str| {
                        connection
                            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get::<_, i64>(0))
                            .unwrap_or_default()
                    };
                    (integrity == "ok", count("meetings"), count("tasks"), count("notes"))
                }
                Err(_) => (false, 0, 0, 0),
            };
            Some(BackupInfo {
                file_name,
                created_at,
                size_mb: metadata.len() as f64 / 1024.0 / 1024.0,
                is_valid,
                meeting_count,
                task_count,
                note_count,
            })
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.file_name.cmp(&left.file_name));
    Ok(backups)
}

fn create_backup_snapshot(connection: &Connection, backups_dir: &Path) -> Result<BackupInfo, String> {
    fs::create_dir_all(backups_dir).map_err(app_error)?;
    let file_name = format!("zhiji-backup-{}.sqlite3", Local::now().format("%Y%m%d-%H%M%S-%3f"));
    let path = backups_dir.join(&file_name);
    let escaped_path = path.to_string_lossy().replace('\'', "''");
    connection.execute_batch(&format!("VACUUM INTO '{escaped_path}'")).map_err(app_error)?;

    let backups = backup_infos(backups_dir)?;
    for backup in backups.iter().skip(2) {
        let stale = backups_dir.join(&backup.file_name);
        if stale.parent() == Some(backups_dir) {
            let _ = fs::remove_file(stale);
        }
    }
    backup_infos(backups_dir)?
        .into_iter()
        .find(|backup| backup.file_name == file_name)
        .ok_or_else(|| "备份已经创建，但无法读取备份信息".to_string())
}

fn create_daily_backup(connection: &Connection, backups_dir: &Path) -> Result<(), String> {
    let today_prefix = format!("zhiji-backup-{}", Local::now().format("%Y%m%d"));
    if backup_infos(backups_dir)?
        .iter()
        .any(|backup| backup.file_name.starts_with(&today_prefix))
    {
        return Ok(());
    }
    create_backup_snapshot(connection, backups_dir).map(|_| ())
}

fn safe_backup_path(backups_dir: &Path, file_name: &str) -> Result<PathBuf, String> {
    if file_name.contains('/')
        || file_name.contains('\\')
        || !file_name.starts_with("zhiji-backup-")
        || !file_name.ends_with(".sqlite3")
    {
        return Err("备份文件名无效".to_string());
    }
    let path = backups_dir.join(file_name);
    if !path.is_file() {
        return Err("找不到所选备份".to_string());
    }
    Ok(path)
}

fn markdown_export(meeting: &Meeting, tasks: &[Task]) -> String {
    let mut output = format!(
        "# {}\n\n- 时间：{}\n- 时长：{} 分钟\n- 状态：{}\n",
        meeting.title,
        meeting.started_at,
        meeting.duration_seconds / 60,
        meeting.status,
    );
    if !meeting.context.trim().is_empty() {
        output.push_str(&format!("\n## 会前背景\n\n{}\n", meeting.context.trim()));
    }
    if !meeting.minutes.trim().is_empty() {
        output.push_str(&format!("\n## 智能纪要\n\n{}\n", meeting.minutes.trim()));
    }
    if !meeting.decisions.trim().is_empty() {
        output.push_str(&format!("\n## 决策与共识\n\n{}\n", meeting.decisions.trim()));
    }
    if !tasks.is_empty() {
        output.push_str("\n## 待办事项\n\n");
        for task in tasks {
            let due = task.due_date.as_deref().map(|date| format!("（截止 {}）", date)).unwrap_or_default();
            output.push_str(&format!("- [{}] {}{}\n", if task.completed { "x" } else { " " }, task.title, due));
        }
    }
    if !meeting.notes.trim().is_empty() {
        output.push_str(&format!("\n## 我的笔记\n\n{}\n", meeting.notes.trim()));
    }
    if !meeting.transcript.trim().is_empty() {
        output.push_str(&format!("\n## 原文转写\n\n{}\n", meeting.transcript.trim()));
    }
    output
}

fn reveal_path(path: &Path, select_file: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        if select_file { command.arg("/select,"); }
        command.arg(path);
        command.creation_flags(CREATE_NO_WINDOW);
        command.spawn().map_err(app_error)?;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        if select_file { command.arg("-R"); }
        command.arg(path).spawn().map_err(app_error)?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let target = if select_file { path.parent().unwrap_or(path) } else { path };
        Command::new("xdg-open").arg(target).spawn().map_err(app_error)?;
    }
    Ok(())
}

fn ai_key() -> Result<keyring::Entry, String> { keyring::Entry::new("com.zhiji.meetnote", "ai-api-key").map_err(app_error) }
fn cloud_asr_key() -> Result<keyring::Entry, String> { keyring::Entry::new("com.zhiji.meetnote", "cloud-asr-api-key").map_err(app_error) }

fn has_ai_key() -> bool {
    match ai_key().and_then(|entry| entry.get_password().map_err(app_error)) { Ok(value) => !value.trim().is_empty(), Err(_) => false }
}

fn has_cloud_asr_key() -> bool {
    match cloud_asr_key().and_then(|entry| entry.get_password().map_err(app_error)) { Ok(value) => !value.trim().is_empty(), Err(_) => false }
}

fn ai_settings(connection: &Connection) -> Result<AiSettings, String> {
    Ok(AiSettings { base_url: setting(connection, "ai_base_url", "https://api.openai.com/v1")?, analysis_model: setting(connection, "ai_analysis_model", "gpt-4o-mini")?, is_configured: has_ai_key() })
}

fn asr_engine_settings(connection: &Connection) -> Result<AsrEngineSettings, String> {
    Ok(AsrEngineSettings {
        provider: setting(connection, "asr_provider", "local")?,
        cloud_base_url: setting(connection, "cloud_asr_base_url", "https://api.siliconflow.cn/v1")?,
        cloud_model: setting(connection, "cloud_asr_model", "FunAudioLLM/SenseVoiceSmall")?,
        cloud_key_saved: has_cloud_asr_key(),
        local_hotwords: setting(connection, "local_asr_hotwords", "")?,
    })
}

fn run_cloud_asr(base_url: String, model: String, api_key: String, audio_path: String, prompt_hint: String) -> Result<String, String> {
    if !base_url.starts_with("https://") && !base_url.starts_with("http://") { return Err("云端转写服务地址必须以 http:// 或 https:// 开头".to_string()); }
    let endpoint = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));
    let file_name = PathBuf::from(&audio_path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording.webm".to_string());
    let file_bytes = fs::read(&audio_path).map_err(|error| format!("读取录音失败：{error}"))?;
    let part = reqwest::blocking::multipart::Part::bytes(file_bytes)
        .file_name(file_name)
        .mime_str("application/octet-stream")
        .map_err(app_error)?;
    let mut form = reqwest::blocking::multipart::Form::new()
        .text("model", model)
        .text("response_format", "json");
    // 会前背景作为 prompt 传给兼容 whisper 的服务（如 Groq/OpenAI），帮助识别专有名词；不支持的服务会忽略该字段
    if !prompt_hint.trim().is_empty() {
        let hint: String = prompt_hint.trim().chars().take(800).collect();
        form = form.text("prompt", hint);
    }
    let form = form.part("file", part);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()
        .map_err(app_error)?;
    let response = client.post(endpoint).bearer_auth(api_key).multipart(form).send().map_err(app_error)?;
    let response = response_error(response, "云端转写服务")?;
    let body: serde_json::Value = response.json().map_err(app_error)?;
    let transcript = body.get("text").and_then(serde_json::Value::as_str).unwrap_or("").trim().to_string();
    if transcript.is_empty() { return Err("云端转写服务没有返回可用的转写文本".to_string()); }
    Ok(transcript)
}

fn local_asr_status(state: &AppState) -> LocalAsrStatus {
    let model_path = state.models_dir.join(SENSEVOICE_MODEL_NAME);
    let vad_path = state.models_dir.join(FSMN_VAD_MODEL_NAME);
    LocalAsrStatus {
        installed: model_path.is_file() && vad_path.is_file(),
        runtime_available: state.runtime_dir.join(SENSEVOICE_EXECUTABLE).is_file() && state.ffmpeg_dir.join(FFMPEG_EXECUTABLE).is_file(),
        model_size_mb: fs::metadata(model_path).map_or(0, |metadata| metadata.len() / 1024 / 1024),
    }
}

fn configured_ai(state: &AppState) -> Result<(AiSettings, String), String> {
    let settings = { let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?; ai_settings(&connection)? };
    if !settings.base_url.starts_with("https://") && !settings.base_url.starts_with("http://") { return Err("AI 服务地址必须以 http:// 或 https:// 开头".to_string()); }
    let key = ai_key()?.get_password().map_err(|_| "请先在设置中保存 AI API 密钥".to_string())?;
    if key.trim().is_empty() { return Err("请先在设置中保存 AI API 密钥".to_string()); }
    Ok((settings, key))
}

const MEETING_COLUMNS: &str = "id, notebook_id, title, started_at, duration_seconds, status, transcript, minutes, decisions, speaker_segments, speaker_names, audio_path, updated_at, context, notes";

fn meeting_from_row(row: &rusqlite::Row) -> rusqlite::Result<Meeting> {
    Ok(Meeting { id: row.get(0)?, notebook_id: row.get(1)?, title: row.get(2)?, started_at: row.get(3)?, duration_seconds: row.get(4)?, status: row.get(5)?, transcript: row.get(6)?, minutes: row.get(7)?, decisions: row.get(8)?, speaker_segments: row.get(9)?, speaker_names: row.get(10)?, audio_path: row.get(11)?, updated_at: row.get(12)?, context: row.get(13)?, notes: row.get(14)? })
}

fn meeting_by_id(connection: &Connection, meeting_id: &str) -> Result<Meeting, String> {
    connection.query_row(
        &format!("SELECT {MEETING_COLUMNS} FROM meetings WHERE id = ?1"),
        params![meeting_id],
        meeting_from_row,
    ).map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => "找不到该会议".to_string(), other => app_error(other) })
}

fn response_error(response: reqwest::blocking::Response, source: &str) -> Result<reqwest::blocking::Response, String> {
    if response.status().is_success() { return Ok(response); }
    let status = response.status();
    let message = response.text().unwrap_or_else(|_| "无法读取服务错误".to_string());
    Err(format!("{source} 返回 {status}：{message}"))
}

fn clean_json(content: &str) -> String {
    let trimmed = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if trimmed.starts_with('{') {
        return trimmed.to_string();
    }

    if let Some(start) = trimmed.find('{') {
        if let Some(end) = trimmed.rfind('}') {
            if end > start {
                return trimmed[start..=end].to_string();
            }
        }
    }

    trimmed.to_string()
}

fn download_file(url: &str, destination: &Path) -> Result<(), String> {
    let temporary = destination.with_file_name(format!(
        "{}.part",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("model")
    ));
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_secs(2u64.saturating_pow(attempt)));
        }
        let result = (|| {
            let client = reqwest::blocking::Client::builder()
                .user_agent(MODEL_DOWNLOAD_USER_AGENT)
                .connect_timeout(std::time::Duration::from_secs(15))
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .map_err(app_error)?;
            let response = client
                .get(url)
                .header(
                    reqwest::header::ACCEPT,
                    "application/octet-stream,application/*;q=0.9,*/*;q=0.8",
                )
                .send()
                .map_err(app_error)?;
            let mut body = response_error(response, "模型下载服务")?;
            let mut output = fs::File::create(&temporary).map_err(app_error)?;
            io::copy(&mut body, &mut output).map_err(app_error)?;
            output.sync_all().map_err(app_error)?;
            fs::rename(&temporary, destination).map_err(app_error)
        })();
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = error;
                let _ = fs::remove_file(&temporary);
            }
        }
    }
    Err(format!("下载失败（已重试 3 次）：{last_error}"))
}

fn download_model(sources: &[&str], destination: &Path) -> Result<(), String> {
    let mut errors = Vec::new();
    for source in sources {
        match download_file(source, destination) {
            Ok(()) => {
                let size = fs::metadata(destination).map_err(app_error)?.len();
                if size > 1_000_000 { return Ok(()); }
                let _ = fs::remove_file(destination);
                errors.push(format!("{source} 返回的文件过小"));
            }
            Err(error) => errors.push(format!("{source}：{error}")),
        }
    }
    Err(format!("无法下载本地语音模型。已依次尝试 ModelScope 和 Hugging Face：{}", errors.join("；")))
}

fn strip_sensevoice_tokens(raw: &str) -> String {
    let mut cleaned = raw.to_string();
    while let Some(start) = cleaned.find("<|") {
        let Some(end) = cleaned[start..].find("|>") else { break; };
        cleaned.replace_range(start..start + end + 2, "");
    }
    cleaned
}

fn clean_speaker_segments(raw: &str) -> String {
    let Ok(mut segments) = serde_json::from_str::<Vec<SpeakerSegment>>(raw) else { return raw.to_string(); };
    for segment in &mut segments { segment.text = strip_sensevoice_tokens(&segment.text).trim().to_string(); }
    segments.retain(|segment| !segment.text.is_empty());
    serde_json::to_string(&segments).unwrap_or_else(|_| raw.to_string())
}

fn clean_stored_transcripts(connection: &Connection) -> Result<(), Box<dyn Error>> {
    let rows = {
        let mut statement = connection.prepare("SELECT id, transcript, speaker_segments FROM meetings")?;
        statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?
            .collect::<Result<Vec<_>, _>>()?
    };
    for (meeting_id, transcript, segments) in rows {
        let cleaned_transcript = strip_sensevoice_tokens(&transcript);
        let cleaned_segments = clean_speaker_segments(&segments);
        if cleaned_transcript != transcript || cleaned_segments != segments {
            connection.execute(
                "UPDATE meetings SET transcript = ?2, speaker_segments = ?3 WHERE id = ?1",
                params![meeting_id, cleaned_transcript, cleaned_segments],
            )?;
        }
    }
    Ok(())
}

fn clean_local_transcript(raw: &str) -> String {
    raw.lines().filter_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("INFO") || trimmed.starts_with("load_") || trimmed.starts_with("usage:") { return None; }
        let mut cleaned = strip_sensevoice_tokens(trimmed);
        if cleaned.starts_with('[') {
            if let Some(end) = cleaned.find(']') { cleaned = cleaned[end + 1..].trim().to_string(); }
        }
        (!cleaned.is_empty()).then_some(cleaned)
    }).collect::<Vec<_>>().join("\n")
}

fn to_wav(runtime_dir: &Path, ffmpeg_dir: &Path, audio_path: &str) -> Result<(PathBuf, bool), String> {
    let input = PathBuf::from(audio_path);
    if input.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("wav")) { return Ok((input, false)); }
    let ffmpeg = ffmpeg_dir.join(FFMPEG_EXECUTABLE);
    if !ffmpeg.is_file() { return Err("安装包中未找到音频转换组件，请重新安装知记".to_string()); }
    let output = runtime_dir.join(format!("zhiji-{}.wav", Uuid::new_v4()));
    let output_arg = output.to_string_lossy().into_owned();
    let result = Command::new(ffmpeg)
        .args([
            "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", &output_arg,
        ])
        .output()
        .map_err(app_error)?;
    if !result.status.success() { return Err(format!("无法读取录音：{}", String::from_utf8_lossy(&result.stderr).trim())); }
    Ok((output, true))
}

fn probe_audio_duration(ffmpeg_dir: &Path, audio_path: &Path) -> i64 {
    let ffmpeg = ffmpeg_dir.join(FFMPEG_EXECUTABLE);
    if !ffmpeg.is_file() { return 0; }
    let mut command = Command::new(ffmpeg);
    command.arg("-hide_banner").arg("-i").arg(audio_path);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = command.output() else { return 0; };
    let details = String::from_utf8_lossy(&output.stderr);
    let Some(duration) = details.split("Duration: ").nth(1).and_then(|value| value.split(',').next()) else { return 0; };
    let parts = duration.trim().split(':').collect::<Vec<_>>();
    if parts.len() != 3 { return 0; }
    let Ok(hours) = parts[0].parse::<f64>() else { return 0; };
    let Ok(minutes) = parts[1].parse::<f64>() else { return 0; };
    let Ok(seconds) = parts[2].parse::<f64>() else { return 0; };
    (hours * 3600.0 + minutes * 60.0 + seconds).round() as i64
}

fn remove_managed_recording(recordings_dir: &Path, audio_path: &str) {
    let path = PathBuf::from(audio_path);
    let Ok(root) = fs::canonicalize(recordings_dir) else { return; };
    let Ok(canonical_path) = fs::canonicalize(&path) else { return; };
    if canonical_path.starts_with(root) { let _ = fs::remove_file(canonical_path); }
}

fn remove_recording_bundle(recordings_dir: &Path, audio_path: &str) {
    let path = PathBuf::from(audio_path);
    let stem = path.file_stem().and_then(|value| value.to_str()).map(str::to_string);
    remove_managed_recording(recordings_dir, audio_path);
    if let Some(stem) = stem { recorder::remove_dual_track_sidecars(recordings_dir, &stem); }
}

fn remove_meeting_recordings(recordings_dir: &Path, meeting_id: &str, audio_path: Option<&str>) {
    if let Some(path) = audio_path { remove_recording_bundle(recordings_dir, path); }
    recorder::remove_dual_track_sidecars(recordings_dir, meeting_id);
    recorder::remove_dual_track_sidecars(recordings_dir, &format!("{meeting_id}-pending"));
}

fn run_local_asr(
    runtime_dir: PathBuf,
    ffmpeg_dir: PathBuf,
    models_dir: PathBuf,
    vcrt_dir: PathBuf,
    audio_path: String,
    cancel_flag: Arc<AtomicBool>,
    cancel_child: Arc<Mutex<Option<Child>>>,
) -> Result<String, String> {
    if cancel_flag.load(Ordering::SeqCst) { return Err("已取消转写".to_string()); }
    let executable = runtime_dir.join(SENSEVOICE_EXECUTABLE);
    if !executable.is_file() { return Err("本地语音引擎未随安装包找到，请重新安装知记".to_string()); }
    let model = models_dir.join(SENSEVOICE_MODEL_NAME);
    let vad = models_dir.join(FSMN_VAD_MODEL_NAME);
    if !model.is_file() || !vad.is_file() { return Err("请先在设置中下载本地语音模型".to_string()); }
    let (wav_path, remove_wav) = to_wav(&runtime_dir, &ffmpeg_dir, &audio_path)?;
    let model_arg = model.to_string_lossy().into_owned();
    let vad_arg = vad.to_string_lossy().into_owned();
    let audio_arg = wav_path.to_string_lossy().into_owned();
    let mut command = Command::new(&executable);
    command.current_dir(&runtime_dir).arg("-m").arg(model_arg).arg("--vad").arg(vad_arg).arg("-a").arg(audio_arg);
    let mut paths = vec![vcrt_dir, runtime_dir.clone()];
    if let Some(current_path) = std::env::var_os("PATH") { paths.extend(std::env::split_paths(&current_path)); }
    command.env("PATH", std::env::join_paths(paths).map_err(app_error)?);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    // 共享子进程槽持续保留句柄，取消按钮才能真正终止正在运行的本地引擎。
    let output = run_cancelable_command(command, &cancel_flag, &cancel_child)?;
    if remove_wav { let _ = fs::remove_file(&wav_path); }
    if cancel_flag.load(Ordering::SeqCst) { return Err("已取消转写".to_string()); }
    if !output.status.success() { return Err(format!("本地语音引擎运行失败：{}", String::from_utf8_lossy(&output.stderr).trim())); }
    let transcript = clean_local_transcript(&String::from_utf8_lossy(&output.stdout));
    if transcript.is_empty() { return Err("本地语音引擎没有返回可用的转写文本".to_string()); }
    Ok(transcript)
}

fn speaker_python(engine_dir: &Path) -> PathBuf { engine_dir.join("python").join("python.exe") }
fn speaker_script(engine_dir: &Path) -> PathBuf { engine_dir.join("diarize.py") }
fn live_asr_script(engine_dir: &Path) -> PathBuf { engine_dir.join("live_asr.py") }
fn speaker_marker(engine_dir: &Path) -> PathBuf { engine_dir.join(".installed") }
fn speaker_models_marker(models_dir: &Path) -> PathBuf { models_dir.join(".ready") }

fn quality_models_available(models_dir: &Path) -> bool {
    ["SeacoParaformer", "FsmnVADStreaming", "CTTransformer", "CAMPPlus"]
        .iter()
        .all(|model| model_config_available(models_dir, model, 7))
}

pub(crate) fn speaker_models_ready(models_dir: &Path) -> bool {
    fs::read_to_string(speaker_models_marker(models_dir))
        .is_ok_and(|version| version.trim() == SPEAKER_MODELS_VERSION)
        && quality_models_available(models_dir)
        && models_dir.join("realtime-online").join("config.yaml").is_file()
}

fn model_config_available(directory: &Path, model: &str, depth: u8) -> bool {
    if depth == 0 || !directory.is_dir() { return false; }
    if fs::read_to_string(directory.join("config.yaml"))
        .is_ok_and(|config| config.lines().any(|line| line.trim() == format!("model: {model}")))
    {
        return true;
    }
    fs::read_dir(directory).ok().is_some_and(|entries| {
        entries.flatten().any(|entry| model_config_available(&entry.path(), model, depth - 1))
    })
}

fn speaker_engine_installed(engine_dir: &Path) -> bool {
    speaker_python(engine_dir).is_file()
        && speaker_script(engine_dir).is_file()
        && live_asr_script(engine_dir).is_file()
        && fs::read_to_string(speaker_marker(engine_dir)).is_ok_and(|version| version.trim() == SPEAKER_ENGINE_VERSION)
}

fn speaker_engine_status(state: &AppState) -> SpeakerEngineStatus {
    SpeakerEngineStatus {
        installed: speaker_engine_installed(&state.speaker_engine_dir),
        models_ready: speaker_models_ready(&state.speaker_models_dir),
    }
}

fn refresh_speaker_engine_scripts(engine_dir: &Path, models_dir: &Path) -> Result<(), String> {
    let previously_installed = speaker_python(engine_dir).is_file()
        && speaker_marker(engine_dir).is_file()
        && speaker_models_marker(models_dir).is_file();
    if !previously_installed { return Ok(()); }
    fs::write(speaker_script(engine_dir), include_str!("speaker_engine.py")).map_err(app_error)?;
    fs::write(live_asr_script(engine_dir), include_str!("live_asr.py")).map_err(app_error)?;
    fs::write(speaker_marker(engine_dir), SPEAKER_ENGINE_VERSION).map_err(app_error)?;
    // 老版本已经下载过 SeACo 时直接复用，不让用户重新下载近 1 GB 权重。
    if quality_models_available(models_dir) {
        fs::write(speaker_models_marker(models_dir), SPEAKER_MODELS_VERSION).map_err(app_error)?;
    } else {
        fs::write(speaker_models_marker(models_dir), "quality-model-required").map_err(app_error)?;
    }
    Ok(())
}

fn recent_live_asr_diagnostics(state: &AppState) -> Option<String> {
    let log_path = state.speaker_engine_dir.join("live-asr-last.log");
    let content = fs::read_to_string(log_path).ok()?;
    let mut tail = content.lines().rev().take(80).collect::<Vec<_>>();
    tail.reverse();
    let mut sanitized = tail.join("\n");
    for (path, replacement) in [
        (&state.speaker_engine_dir, "<SPEAKER_ENGINE>"),
        (&state.speaker_models_dir, "<MEETING_MODELS>"),
        (&state.data_dir, "<APP_DATA>"),
    ] {
        sanitized = sanitized.replace(&path.to_string_lossy().to_string(), replacement);
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        sanitized = sanitized.replace(&user_profile, "<USER_PROFILE>");
    }
    (!sanitized.trim().is_empty()).then_some(sanitized)
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(app_error)?;
    let mut zip = zip::ZipArchive::new(file).map_err(app_error)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(app_error)?;
        let Some(name) = entry.enclosed_name().map(PathBuf::from) else { return Err("Python 运行时压缩包包含不安全路径".to_string()); };
        let output = destination.join(name);
        if entry.is_dir() { fs::create_dir_all(output).map_err(app_error)?; continue; }
        if let Some(parent) = output.parent() { fs::create_dir_all(parent).map_err(app_error)?; }
        let mut file = fs::File::create(output).map_err(app_error)?;
        io::copy(&mut entry, &mut file).map_err(app_error)?;
        file.flush().map_err(app_error)?;
    }
    Ok(())
}

fn run_python(python: &Path, arguments: &[&str], stage: &str) -> Result<(), String> {
    let mut command = Command::new(python);
    command.args(arguments);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(app_error)?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr);
    let standard_output = String::from_utf8_lossy(&output.stdout);
    let details = if error.trim().is_empty() { standard_output.trim() } else { error.trim() };
    Err(format!("{stage}失败：{details}"))
}

fn run_cancelable_python(
    python: &Path,
    arguments: &[&str],
    stage: &str,
    cancel_flag: &Arc<AtomicBool>,
    cancel_child: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    let mut command = Command::new(python);
    command.args(arguments);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = run_cancelable_command(command, cancel_flag, cancel_child)?;
    if output.status.success() { return Ok(()); }
    let error = String::from_utf8_lossy(&output.stderr);
    let standard_output = String::from_utf8_lossy(&output.stdout);
    let details = concise_python_failure(&error, &standard_output);
    Err(format!("{stage}失败：{details}"))
}

fn concise_python_failure(stderr: &str, stdout: &str) -> String {
    let details = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
    if details.contains("IndexError: list index out of range") {
        return "音频分段与声纹结果不一致，请升级到包含兼容性修复的版本后重试".to_string();
    }
    if details.contains("MemoryError") || details.to_ascii_lowercase().contains("out of memory") {
        return "可用内存不足，请关闭占用内存较大的程序后重试".to_string();
    }
    if let Some(message) = details.lines().rev().map(str::trim).find(|line| {
        line.starts_with("RuntimeError:") || line.starts_with("ValueError:")
    }) {
        return message.split_once(':').map_or(message, |(_, value)| value).trim().to_string();
    }
    let mut tail = details.lines().rev().filter(|line| !line.trim().is_empty()).take(8).collect::<Vec<_>>();
    tail.reverse();
    let summary = tail.join("\n");
    if summary.chars().count() > 800 { summary.chars().take(800).collect() } else { summary }
}

fn run_cancelable_command(
    mut command: Command,
    cancel_flag: &Arc<AtomicBool>,
    cancel_child: &Arc<Mutex<Option<Child>>>,
) -> Result<std::process::Output, String> {
    if cancel_flag.load(Ordering::SeqCst) { return Err("已取消转写".to_string()); }
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(app_error)?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_worker = std::thread::spawn(move || {
        let mut output = Vec::new();
        if let Some(mut stream) = stdout { let _ = stream.read_to_end(&mut output); }
        output
    });
    let stderr_worker = std::thread::spawn(move || {
        let mut output = Vec::new();
        if let Some(mut stream) = stderr { let _ = stream.read_to_end(&mut output); }
        output
    });
    if let Ok(mut slot) = cancel_child.lock() { *slot = Some(child); }
    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            if let Ok(mut slot) = cancel_child.lock() {
                if let Some(child) = slot.as_mut() { let _ = child.kill(); }
                if let Some(mut child) = slot.take() { let _ = child.wait(); }
            }
            let _ = stdout_worker.join();
            let _ = stderr_worker.join();
            return Err("已取消转写".to_string());
        }
        let finished = {
            let mut slot = cancel_child.lock().map_err(|_| "进程锁异常".to_string())?;
            match slot.as_mut() {
                Some(child) => child.try_wait().map_err(app_error)?.is_some(),
                None => {
                    let _ = stdout_worker.join();
                    let _ = stderr_worker.join();
                    return Err("已取消转写".to_string());
                }
            }
        };
        if finished { break; }
        std::thread::sleep(std::time::Duration::from_millis(80));
    }
    let mut child = cancel_child.lock().map_err(|_| "进程锁异常".to_string())?.take()
        .ok_or_else(|| "已取消转写".to_string())?;
    let status = child.wait().map_err(app_error)?;
    let stdout = stdout_worker.join().unwrap_or_default();
    let stderr = stderr_worker.join().unwrap_or_default();
    if cancel_flag.load(Ordering::SeqCst) { return Err("已取消转写".to_string()); }
    Ok(std::process::Output { status, stdout, stderr })
}

fn prepare_speaker_runtime(vcrt_dir: &Path, engine_dir: &Path) -> Result<(), String> {
    let python_dir = engine_dir.join("python");
    if !python_dir.is_dir() { return Err("本地 Python 运行时不存在，请重新安装说话人引擎".to_string()); }
    for name in VC_RUNTIME_DLLS {
        let source = vcrt_dir.join(name);
        if !source.is_file() { return Err("安装包缺少 Windows VC++ 运行库，请覆盖安装最新版知记后重试".to_string()); }
        let destination = python_dir.join(name);
        let needs_copy = !destination.is_file()
            || fs::metadata(&source).map_err(app_error)?.len() != fs::metadata(&destination).map_err(app_error)?.len();
        if needs_copy { fs::copy(&source, &destination).map_err(app_error)?; }
    }
    Ok(())
}

fn remove_broken_torch_installation(engine_dir: &Path) -> Result<(), String> {
    let site_packages = engine_dir.join("python").join("Lib").join("site-packages");
    if !site_packages.is_dir() { return Ok(()); }
    for entry in fs::read_dir(&site_packages).map_err(app_error)? {
        let entry = entry.map_err(app_error)?;
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        let is_torch_package = matches!(name.as_str(), "torch" | "torchgen" | "torchaudio" | "functorch")
            || (name.starts_with("torch-") && name.ends_with(".dist-info"))
            || (name.starts_with("torchaudio-") && name.ends_with(".dist-info"));
        if !is_torch_package { continue; }
        let path = entry.path();
        let result = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        result.map_err(|error| format!("清理损坏的本地计算组件失败（{}）：{error}", path.display()))?;
    }
    Ok(())
}

fn install_python_packages(python: &Path, packages: &[&str], index: &str, extra_index: Option<&str>, force_reinstall: bool, stage: &str) -> Result<(), String> {
    let mut arguments = vec![
        "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-warn-script-location", "--prefer-binary",
        "--retries", "12", "--resume-retries", "12", "--timeout", "90", "--index-url", index,
    ];
    if let Some(extra_index) = extra_index { arguments.extend_from_slice(&["--extra-index-url", extra_index]); }
    if force_reinstall { arguments.push("--force-reinstall"); }
    arguments.extend_from_slice(packages);
    run_python(python, &arguments, stage)
}

fn install_python_packages_with_fallback(python: &Path, packages: &[&str], stage: &str) -> Result<(), String> {
    match install_python_packages(python, packages, ALIYUN_PYPI_INDEX, Some(PYTORCH_CPU_INDEX), false, stage) {
        Ok(()) => Ok(()),
        Err(mirror_error) => install_python_packages(python, packages, OFFICIAL_PYPI_INDEX, Some(PYTORCH_CPU_INDEX), false, stage)
            .map_err(|official_error| format!("{official_error}\n\n国内镜像的首次尝试也失败：{mirror_error}")),
    }
}

fn install_speaker_engine(engine_dir: PathBuf, models_dir: PathBuf, vcrt_dir: PathBuf) -> Result<(), String> {
    let python = speaker_python(&engine_dir);
    fs::create_dir_all(&engine_dir).map_err(app_error)?;
    fs::create_dir_all(&models_dir).map_err(app_error)?;
    if speaker_engine_installed(&engine_dir) && speaker_models_ready(&models_dir) {
        prepare_speaker_runtime(&vcrt_dir, &engine_dir)?;
        if run_python(
            &python,
            &["-c", "import funasr, modelscope, numpy, torch, torchaudio, torchgen"],
            "检查会议引擎依赖",
        ).is_ok() {
            return Ok(());
        }
    }
    let archive = engine_dir.join("python-embed.zip");
    if !python.is_file() {
        download_file(PYTHON_EMBED_URL, &archive)?;
        extract_zip(&archive, &engine_dir.join("python"))?;
        let _ = fs::remove_file(&archive);
    }
    if !python.is_file() { return Err("本地 Python 运行时下载不完整，请重试".to_string()); }
    let pth = engine_dir.join("python").join("python311._pth");
    let content = fs::read_to_string(&pth).map_err(app_error)?;
    fs::write(&pth, content.replace("#import site", "import site")).map_err(app_error)?;
    prepare_speaker_runtime(&vcrt_dir, &engine_dir)?;
    let packages_ready = run_python(
        &python,
        &["-c", "import funasr, modelscope, numpy, torch, torchaudio, torchgen"],
        "检查会议引擎依赖",
    ).is_ok();
    if !packages_ready {
        let get_pip = engine_dir.join("get-pip.py");
        if !get_pip.is_file() { download_file(GET_PIP_URL, &get_pip)?; }
        let get_pip_arg = get_pip.to_string_lossy().into_owned();
        run_python(&python, &[&get_pip_arg, "--disable-pip-version-check"], "准备会议引擎")?;
        remove_broken_torch_installation(&engine_dir)?;
        install_python_packages(&python, &[TORCH_CPU_VERSION, TORCHAUDIO_CPU_VERSION], PYTORCH_CPU_INDEX, None, false, "修复本地计算组件")?;
        install_python_packages_with_fallback(&python, &["funasr", "modelscope", "soundfile", TORCH_CPU_VERSION, TORCHAUDIO_CPU_VERSION], "安装会议引擎组件")?;
    }
    run_python(&python, &["-c", "import torch, torchaudio, torchgen; print(torch.__version__, torchaudio.__version__)"], "验证本地计算组件")?;
    run_python(&python, &["-m", "pip", "check"], "检查说话人引擎依赖")?;
    fs::write(speaker_script(&engine_dir), include_str!("speaker_engine.py")).map_err(app_error)?;
    fs::write(live_asr_script(&engine_dir), include_str!("live_asr.py")).map_err(app_error)?;
    let live_script_arg = live_asr_script(&engine_dir).to_string_lossy().into_owned();
    let models_arg = models_dir.to_string_lossy().into_owned();
    run_python(&python, &[&live_script_arg, "--model-cache", &models_arg, "--prepare"], "准备本地实时转写模型")?;
    fs::write(speaker_models_marker(&models_dir), SPEAKER_MODELS_VERSION).map_err(app_error)?;
    fs::write(speaker_marker(&engine_dir), SPEAKER_ENGINE_VERSION).map_err(app_error)?;
    Ok(())
}

fn run_speaker_engine(
    engine_dir: PathBuf,
    models_dir: PathBuf,
    runtime_dir: PathBuf,
    ffmpeg_dir: PathBuf,
    vcrt_dir: PathBuf,
    audio_path: String,
    hotwords: String,
    cancel_flag: Arc<AtomicBool>,
    cancel_child: Arc<Mutex<Option<Child>>>,
) -> Result<SpeakerTranscript, String> {
    let python = speaker_python(&engine_dir);
    let script = speaker_script(&engine_dir);
    if !speaker_engine_installed(&engine_dir) || !python.is_file() || !script.is_file() { return Err("说话人引擎需要修复，请点击“安装说话人引擎”完成升级".to_string()); }
    prepare_speaker_runtime(&vcrt_dir, &engine_dir)?;
    if cancel_flag.load(Ordering::SeqCst) { return Err("已取消转写".to_string()); }
    let (wav_path, remove_wav) = to_wav(&runtime_dir, &ffmpeg_dir, &audio_path)?;
    let result_path = engine_dir.join(format!("speaker-result-{}.json", Uuid::new_v4()));
    let audio_arg = wav_path.to_string_lossy().into_owned();
    let output_arg = result_path.to_string_lossy().into_owned();
    let models_arg = models_dir.to_string_lossy().into_owned();
    let script_arg = script.to_string_lossy().into_owned();
    let result = run_cancelable_python(
        &python,
        &[&script_arg, "--audio", &audio_arg, "--output", &output_arg, "--model-cache", &models_arg, "--hotwords", &hotwords],
        "本地说话人分离",
        &cancel_flag,
        &cancel_child,
    );
    if remove_wav { let _ = fs::remove_file(&wav_path); }
    result?;
    let mut input = fs::File::open(&result_path).map_err(app_error)?;
    let mut content = String::new();
    input.read_to_string(&mut content).map_err(app_error)?;
    let _ = fs::remove_file(&result_path);
    let mut transcript: SpeakerTranscript = serde_json::from_str(&content).map_err(|error| format!("本地说话人分离结果无效：{error}"))?;
    for segment in &mut transcript.segments { segment.text = strip_sensevoice_tokens(&segment.text).trim().to_string(); }
    transcript.segments.retain(|segment| !segment.text.is_empty());
    transcript.transcript = transcript.segments.iter()
        .map(|segment| format!("【{}】{}", segment.speaker, segment.text))
        .collect::<Vec<_>>()
        .join("\n");
    if transcript.transcript.trim().is_empty() || transcript.segments.is_empty() { return Err("本地说话人分离没有返回可用结果".to_string()); }
    fs::write(speaker_models_marker(&models_dir), SPEAKER_MODELS_VERSION).map_err(app_error)?;
    Ok(transcript)
}

fn run_source_transcript(
    engine_dir: PathBuf,
    models_dir: PathBuf,
    runtime_dir: PathBuf,
    ffmpeg_dir: PathBuf,
    vcrt_dir: PathBuf,
    audio_path: PathBuf,
    hotwords: String,
    fixed_speaker: Option<(&str, i64)>,
    cancel_flag: Arc<AtomicBool>,
    cancel_child: Arc<Mutex<Option<Child>>>,
) -> Result<Vec<SpeakerSegment>, String> {
    let mut result = run_speaker_engine(
        engine_dir,
        models_dir,
        runtime_dir,
        ffmpeg_dir,
        vcrt_dir,
        audio_path.to_string_lossy().into_owned(),
        hotwords,
        cancel_flag,
        cancel_child,
    )?;
    if let Some((speaker, speaker_id)) = fixed_speaker {
        for segment in &mut result.segments {
            segment.speaker = speaker.to_string();
            segment.speaker_id = speaker_id;
        }
    } else {
        let mut speaker_ids = HashMap::<i64, i64>::new();
        let mut next_id = 1_i64;
        for segment in &mut result.segments {
            let mapped = *speaker_ids.entry(segment.speaker_id).or_insert_with(|| {
                let current = next_id;
                next_id += 1;
                current
            });
            segment.speaker_id = mapped;
            segment.speaker = format!("会议发言人 {mapped}");
        }
    }
    Ok(result.segments)
}

fn run_dual_track_speaker_engine(
    engine_dir: PathBuf,
    models_dir: PathBuf,
    runtime_dir: PathBuf,
    ffmpeg_dir: PathBuf,
    vcrt_dir: PathBuf,
    microphone: PathBuf,
    system: PathBuf,
    hotwords: String,
    cancel_flag: Arc<AtomicBool>,
    cancel_child: Arc<Mutex<Option<Child>>>,
) -> Result<SpeakerTranscript, String> {
    let mut segments = Vec::new();
    let mut failures = Vec::new();
    match run_source_transcript(
        engine_dir.clone(),
        models_dir.clone(),
        runtime_dir.clone(),
        ffmpeg_dir.clone(),
        vcrt_dir.clone(),
        system,
        hotwords.clone(),
        None,
        cancel_flag.clone(),
        cancel_child.clone(),
    ) {
        Ok(source_segments) => segments.extend(source_segments),
        Err(error) if error.contains("已取消") => return Err(error),
        Err(error) => failures.push(format!("会议声音：{error}")),
    }
    match run_source_transcript(
        engine_dir,
        models_dir,
        runtime_dir,
        ffmpeg_dir,
        vcrt_dir,
        microphone,
        hotwords,
        Some(("我", 0)),
        cancel_flag,
        cancel_child,
    ) {
        Ok(source_segments) => segments.extend(source_segments),
        Err(error) if error.contains("已取消") => return Err(error),
        Err(error) => failures.push(format!("麦克风：{error}")),
    }
    if segments.is_empty() {
        return Err(format!("双轨会议转写没有返回可用结果（{}）", failures.join("；")));
    }
    segments.sort_by_key(|segment| (segment.start_ms, segment.speaker_id));
    let transcript = segments.iter()
        .map(|segment| format!("【{}】{}", segment.speaker, segment.text))
        .collect::<Vec<_>>()
        .join("\n");
    if transcript.trim().is_empty() { return Err("双轨会议转写没有返回可用结果".to_string()); }
    Ok(SpeakerTranscript { transcript, segments })
}

fn meeting_hotwords(context: &str, manual: &str) -> String {
    let mut words = Vec::new();
    let separators = |ch| matches!(ch, '\n' | '\r' | ',' | '，' | '、' | ';' | '；' | ':' | '：' | '.' | '。' | '!' | '！' | '?' | '？');
    for (source, explicit) in [(manual, true), (context, false)] {
        for value in source.split(separators) {
            let word = value.trim();
            let length = word.chars().count();
            let looks_like_context_term = explicit
                || length <= 12
                || !word.chars().any(|ch| matches!(ch, '的' | '了' | '是' | '在' | '将' | '与' | '和'));
            if (2..=24).contains(&length)
                && looks_like_context_term
                && !words.iter().any(|existing| existing == word)
            {
                words.push(word.to_string());
            }
            if words.len() >= 80 { break; }
        }
        if words.len() >= 80 { break; }
    }
    words.join(" ")
}

fn start_live_asr(
    app: AppHandle,
    meeting_id: String,
    engine_dir: PathBuf,
    models_dir: PathBuf,
    hotwords: String,
) -> Result<live_session::LiveSession, String> {
    live_session::LiveSession::start(app, meeting_id, engine_dir, models_dir, hotwords)
}

fn finish_live_asr(session: live_session::LiveSession) -> (String, Vec<SpeakerSegment>, Option<String>) {
    let result = session.finish();
    (result.transcript, result.segments, result.warning)
}

fn meetings(connection: &Connection) -> Result<Vec<Meeting>, String> {
    let mut statement = connection.prepare(&format!("SELECT {MEETING_COLUMNS} FROM meetings ORDER BY started_at DESC")).map_err(app_error)?;
    statement.query_map([], meeting_from_row).map_err(app_error)?.collect::<Result<Vec<_>, _>>().map_err(app_error)
}

fn tasks(connection: &Connection) -> Result<Vec<Task>, String> {
    // 旧备份的 tasks 表可能没有 owner 列：缺列时用空串占位，保证恢复旧备份不报错。
    let sql = if table_has_column(connection, "tasks", "owner") {
        "SELECT id, title, source_type, source_id, completed, due_date, created_at, origin, owner FROM tasks ORDER BY completed ASC, created_at DESC"
    } else {
        "SELECT id, title, source_type, source_id, completed, due_date, created_at, origin, '' AS owner FROM tasks ORDER BY completed ASC, created_at DESC"
    };
    let mut statement = connection.prepare(sql).map_err(app_error)?;
    statement.query_map([], |row| Ok(Task { id: row.get(0)?, title: row.get(1)?, source_type: row.get(2)?, source_id: row.get(3)?, completed: row.get::<_, i64>(4)? != 0, due_date: row.get(5)?, created_at: row.get(6)?, origin: row.get(7)?, owner: row.get(8)? })).map_err(app_error)?.collect::<Result<Vec<_>, _>>().map_err(app_error)
}

#[tauri::command]
fn load_workspace(state: State<'_, AppState>) -> Result<Workspace, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    Ok(Workspace { meetings: meetings(&connection)?, tasks: tasks(&connection)? })
}

#[tauri::command]
fn export_meeting_markdown(state: State<'_, AppState>, meeting_id: String, target_path: String) -> Result<String, String> {
    let target = PathBuf::from(target_path);
    if target.file_name().is_none() { return Err("请选择有效的导出文件位置".to_string()); }
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    let meeting_tasks = tasks(&connection)?.into_iter()
        .filter(|task| task.source_type.as_deref() == Some("meeting") && task.source_id.as_deref() == Some(&meeting_id))
        .collect::<Vec<_>>();
    fs::write(&target, markdown_export(&meeting, &meeting_tasks)).map_err(|error| format!("导出会议失败：{error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// 导出文件名片段：清洗文件系统非法字符与首尾空白，限长 40 字
fn sanitize_file_component(raw: &str) -> String {
    let cleaned: String = raw.chars().filter(|ch| !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t')).collect();
    cleaned.trim().chars().take(40).collect()
}

/// 导出文件名（不含扩展名）：YYYYMMDD-标题，标题为空退回「未命名会议」
fn export_file_name(meeting: &Meeting) -> String {
    let title = sanitize_file_component(meeting.title.trim());
    let title = if title.is_empty() { "未命名会议".to_string() } else { title };
    format!("{}-{}", meeting_date_prefix(&meeting.started_at), title)
}

#[tauri::command]
fn export_all_markdown(state: State<'_, AppState>, target_dir: String) -> Result<String, String> {
    let dir = PathBuf::from(target_dir);
    if !dir.is_dir() { return Err("请选择有效的导出目录".to_string()); }
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let all_meetings = meetings(&connection)?;
    let all_tasks = tasks(&connection)?;
    let mut exported = 0usize;
    let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for meeting in &all_meetings {
        let meeting_tasks: Vec<Task> = all_tasks.iter()
            .filter(|task| task.source_type.as_deref() == Some("meeting") && task.source_id.as_deref() == Some(meeting.id.as_str()))
            .cloned()
            .collect();
        let mut file_name = format!("{}.md", export_file_name(meeting));
        if !used_names.insert(file_name.clone()) {
            // 同一天同主题撞名时，追加会议 id 前 8 位区分
            let short_id: String = meeting.id.chars().take(8).collect();
            file_name = format!("{}-{}.md", export_file_name(meeting), short_id);
            used_names.insert(file_name.clone());
        }
        let target = dir.join(&file_name);
        fs::write(&target, markdown_export(meeting, &meeting_tasks)).map_err(|error| format!("导出会议失败：{error}"))?;
        exported += 1;
    }
    Ok(format!("已导出 {exported} 场会议到 {}", dir.to_string_lossy()))
}

#[tauri::command]
fn reveal_recording(state: State<'_, AppState>, meeting_id: String) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    let path = meeting.audio_path.map(PathBuf::from).ok_or_else(|| "该会议没有录音".to_string())?;
    if !path.is_file() { return Err("录音文件不存在，可能已被移动或删除".to_string()); }
    reveal_path(&path, true)
}

#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Result<Vec<BackupInfo>, String> {
    backup_infos(&state.backups_dir)
}

#[tauri::command]
fn create_backup(state: State<'_, AppState>) -> Result<BackupInfo, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    create_backup_snapshot(&connection, &state.backups_dir)
}

#[tauri::command]
fn restore_backup(state: State<'_, AppState>, file_name: String) -> Result<Workspace, String> {
    let path = safe_backup_path(&state.backups_dir, &file_name)?;
    let source = Connection::open(path).map_err(|error| format!("无法打开备份：{error}"))?;
    let integrity: String = source.query_row("PRAGMA integrity_check", [], |row| row.get(0)).map_err(app_error)?;
    if integrity != "ok" { return Err("备份文件校验失败，未恢复任何数据".to_string()); }
    let restored_meetings = meetings(&source)?;
    let restored_tasks = tasks(&source)?;
    let restored_notebooks = {
        let mut statement = source.prepare("SELECT id, name, color, created_at FROM notebooks").map_err(app_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
            .map_err(app_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(app_error)?
    };
    let restored_notes = {
        let mut statement = source.prepare("SELECT id, notebook_id, title, content, tags, updated_at FROM notes").map_err(app_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)))
            .map_err(app_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(app_error)?
    };
    let restored_settings = {
        let mut statement = source.prepare("SELECT key, value FROM settings").map_err(app_error)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(app_error)?;
        rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(app_error)?
    };

    let mut connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    create_backup_snapshot(&connection, &state.backups_dir)?;
    let transaction = connection.transaction().map_err(app_error)?;
    transaction.execute("DELETE FROM tasks", []).map_err(app_error)?;
    transaction.execute("DELETE FROM meetings", []).map_err(app_error)?;
    transaction.execute("DELETE FROM notes", []).map_err(app_error)?;
    transaction.execute("DELETE FROM notebooks", []).map_err(app_error)?;
    transaction.execute("DELETE FROM settings", []).map_err(app_error)?;
    for (id, name, color, created_at) in restored_notebooks {
        transaction.execute(
            "INSERT INTO notebooks (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, color, created_at],
        ).map_err(app_error)?;
    }
    for (id, notebook_id, title, content, tags, updated_at) in restored_notes {
        transaction.execute(
            "INSERT INTO notes (id, notebook_id, title, content, tags, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, notebook_id, title, content, tags, updated_at],
        ).map_err(app_error)?;
    }
    for meeting in restored_meetings {
        transaction.execute(
            &format!("INSERT INTO meetings ({MEETING_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
            params![meeting.id, meeting.notebook_id, meeting.title, meeting.started_at, meeting.duration_seconds, meeting.status, meeting.transcript, meeting.minutes, meeting.decisions, meeting.speaker_segments, meeting.speaker_names, meeting.audio_path, meeting.updated_at, meeting.context, meeting.notes],
        ).map_err(app_error)?;
    }
    for task in restored_tasks {
        transaction.execute(
            "INSERT INTO tasks (id, title, source_type, source_id, completed, due_date, created_at, origin, owner) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![task.id, task.title, task.source_type, task.source_id, task.completed, task.due_date, task.created_at, task.origin, task.owner],
        ).map_err(app_error)?;
    }
    for (key, value) in restored_settings {
        transaction.execute("INSERT INTO settings (key, value) VALUES (?1, ?2)", params![key, value]).map_err(app_error)?;
    }
    transaction.commit().map_err(app_error)?;
    Ok(Workspace { meetings: meetings(&connection)?, tasks: tasks(&connection)? })
}

#[tauri::command]
fn open_backups_folder(state: State<'_, AppState>) -> Result<(), String> {
    reveal_path(&state.backups_dir, false)
}

#[tauri::command]
fn get_data_location(state: State<'_, AppState>) -> serde_json::Value {
    json!({
        "dataDir": state.data_dir.to_string_lossy().to_string(),
        "defaultDir": state.default_data_dir.to_string_lossy().to_string(),
        "error": read_relocation_error(&state.config_dir),
    })
}

#[tauri::command]
fn reveal_data_folder(state: State<'_, AppState>) -> Result<(), String> {
    reveal_path(&state.data_dir, false)
}

#[tauri::command]
fn clear_data_relocation_error(state: State<'_, AppState>) -> Result<(), String> {
    clear_relocation_error(&state.config_dir);
    Ok(())
}

/// 安排一次“更改数据位置”：写入待迁移目标并交由前端重启应用。
/// 真正迁移在重启后、打开数据库前执行（见 apply_pending_relocation），避免移动正在使用的数据库文件。
#[tauri::command]
fn schedule_data_relocation(state: State<'_, AppState>, target: String) -> Result<(), String> {
    if state.active_recording.lock().map_err(|_| "录音状态被占用，请重试".to_string())?.is_some() {
        return Err("正在录音或保存中，请先结束录音并等待保存完成，再更改数据位置".to_string());
    }
    let current = state.data_dir.clone();
    let raw_target = PathBuf::from(target.trim());
    if !raw_target.is_dir() {
        return Err("目标文件夹不存在或不可访问，请重新选择".to_string());
    }
    let target = raw_target.canonicalize().map_err(|error| format!("无法访问目标文件夹：{error}"))?;
    if target == current {
        return Err("目标文件夹与当前数据位置相同，无需更改".to_string());
    }
    if path_within(&target, &current) || path_within(&current, &target) {
        return Err("目标文件夹不能位于当前数据目录之内（也不能包含当前数据目录），请选择其他位置".to_string());
    }
    write_relocation_pending(&state.config_dir, &target)?;
    Ok(())
}

#[tauri::command]
fn export_diagnostics(state: State<'_, AppState>, target_path: String) -> Result<String, String> {
    let target = PathBuf::from(target_path);
    if target.file_name().is_none() { return Err("请选择有效的诊断文件位置".to_string()); }
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting_count: i64 = connection.query_row("SELECT COUNT(*) FROM meetings", [], |row| row.get(0)).map_err(app_error)?;
    let task_count: i64 = connection.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0)).map_err(app_error)?;
    let database_integrity: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(app_error)?;
    let database_size_mb = fs::metadata(state.data_dir.join("zhiji.sqlite3")).map_or(0.0, |metadata| metadata.len() as f64 / 1024.0 / 1024.0);
    let engine = asr_engine_settings(&connection)?;
    let backups = backup_infos(&state.backups_dir)?;
    let report = json!({
        "generatedAt": now(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "operatingSystem": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "meetingCount": meeting_count,
        "taskCount": task_count,
        "databaseSizeMb": database_size_mb,
        "databaseIntegrity": database_integrity,
        "localAsr": local_asr_status(&state),
        "speakerEngine": speaker_engine_status(&state),
        "asrProvider": engine.provider,
        "asrModel": engine.cloud_model,
        "aiConfigured": has_ai_key(),
        "backupCount": backups.len(),
        "validBackupCount": backups.iter().filter(|backup| backup.is_valid).count(),
        "latestBackupAt": backups.first().map(|backup| backup.created_at.clone()),
        "recordingsDirectoryAvailable": state.recordings_dir.is_dir(),
        "liveAsrDiagnostic": recent_live_asr_diagnostics(&state),
    });
    let content = serde_json::to_string_pretty(&report).map_err(app_error)?;
    fs::write(&target, content).map_err(|error| format!("导出诊断信息失败：{error}"))?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
fn get_ai_settings(state: State<'_, AppState>) -> Result<AiSettings, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    ai_settings(&connection)
}

#[tauri::command]
fn get_local_asr_status(state: State<'_, AppState>) -> LocalAsrStatus { local_asr_status(&state) }

#[tauri::command]
fn get_speaker_engine_status(state: State<'_, AppState>) -> SpeakerEngineStatus { speaker_engine_status(&state) }

#[tauri::command]
async fn download_local_asr_model(state: State<'_, AppState>) -> Result<LocalAsrStatus, String> {
    let models_dir = state.models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let model_path = models_dir.join(SENSEVOICE_MODEL_NAME);
        let vad_path = models_dir.join(FSMN_VAD_MODEL_NAME);
        if !model_path.is_file() { download_model(SENSEVOICE_MODEL_URLS, &model_path)?; }
        if !vad_path.is_file() { download_model(FSMN_VAD_MODEL_URLS, &vad_path)?; }
        Ok::<(), String>(())
    }).await.map_err(|error| format!("模型下载任务中断：{error}"))??;
    Ok(local_asr_status(&state))
}

#[tauri::command]
async fn install_speaker_engine_command(state: State<'_, AppState>) -> Result<SpeakerEngineStatus, String> {
    live_session::shutdown_warm_engine();
    let engine_dir = state.speaker_engine_dir.clone();
    let models_dir = state.speaker_models_dir.clone();
    let vcrt_dir = state.vcrt_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_speaker_engine(engine_dir.clone(), models_dir.clone(), vcrt_dir.clone())?;
        if let Err(first_error) = live_session::check_engine(engine_dir.clone(), models_dir.clone()) {
            let _ = fs::remove_file(speaker_marker(&engine_dir));
            install_speaker_engine(engine_dir.clone(), models_dir.clone(), vcrt_dir)?;
            live_session::check_engine(engine_dir, models_dir)
                .map_err(|error| format!("实时字幕修复后仍未通过自检：{error}\n首次自检：{first_error}"))?;
        }
        Ok::<(), String>(())
    }).await.map_err(|error| format!("说话人引擎安装任务中断：{error}"))??;
    Ok(speaker_engine_status(&state))
}

#[tauri::command]
async fn check_live_engine(state: State<'_, AppState>) -> Result<String, String> {
    if state.live_sessions.lock().map_err(|_| "实时字幕状态被占用".to_string())?.len() > 0 {
        return Err("录音进行中，不能同时运行实时字幕自检".to_string());
    }
    if !speaker_engine_installed(&state.speaker_engine_dir)
        || !speaker_models_ready(&state.speaker_models_dir) {
        return Err("实时会议引擎尚未安装完整，请先修复引擎".to_string());
    }
    let engine_dir = state.speaker_engine_dir.clone();
    let models_dir = state.speaker_models_dir.clone();
    tauri::async_runtime::spawn_blocking(move || live_session::check_engine(engine_dir, models_dir))
        .await.map_err(|error| format!("实时字幕自检任务中断：{error}"))??;
    Ok("实时字幕自检通过".to_string())
}

#[tauri::command]
fn save_ai_settings(state: State<'_, AppState>, settings: AiSettingsInput) -> Result<AiSettings, String> {
    let base_url = settings.base_url.trim_end_matches('/').to_string();
    if !base_url.starts_with("https://") && !base_url.starts_with("http://") { return Err("AI 服务地址必须以 http:// 或 https:// 开头".to_string()); }
    if settings.analysis_model.trim().is_empty() { return Err("请填写纪要模型名称".to_string()); }
    if let Some(api_key) = settings.api_key.filter(|value| !value.trim().is_empty()) { ai_key()?.set_password(api_key.trim()).map_err(app_error)?; }
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    for (key, value) in [("ai_base_url", base_url), ("ai_analysis_model", settings.analysis_model.trim().to_string())] {
        connection.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(app_error)?;
    }
    ai_settings(&connection)
}

#[tauri::command]
fn clear_ai_api_key() -> Result<(), String> {
    match ai_key()?.delete_password() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(error) => Err(app_error(error)) }
}

#[tauri::command]
fn get_asr_engine_settings(state: State<'_, AppState>) -> Result<AsrEngineSettings, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    asr_engine_settings(&connection)
}

#[tauri::command]
fn save_asr_engine_settings(state: State<'_, AppState>, settings: AsrEngineSettingsInput) -> Result<AsrEngineSettings, String> {
    let provider = settings.provider.trim().to_string();
    let use_local = provider == "local";
    if provider != "local" && provider != "cloud" { return Err("转写引擎只能是 local 或 cloud".to_string()); }
    let base_url = settings.cloud_base_url.trim_end_matches('/').to_string();
    if provider == "cloud" {
        if !base_url.starts_with("https://") && !base_url.starts_with("http://") { return Err("云端转写服务地址必须以 http:// 或 https:// 开头".to_string()); }
        if settings.cloud_model.trim().is_empty() { return Err("请填写云端转写模型名称".to_string()); }
    }
    if let Some(api_key) = settings.api_key.filter(|value| !value.trim().is_empty()) { cloud_asr_key()?.set_password(api_key.trim()).map_err(app_error)?; }
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    for (key, value) in [("asr_provider", provider), ("cloud_asr_base_url", base_url), ("cloud_asr_model", settings.cloud_model.trim().to_string()), ("local_asr_hotwords", settings.local_hotwords.trim().to_string())] {
        connection.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value]).map_err(app_error)?;
    }
    let saved = asr_engine_settings(&connection)?;
    drop(connection);
    if use_local { live_session::warm_engine(state.speaker_engine_dir.clone(), state.speaker_models_dir.clone()); }
    else { live_session::shutdown_warm_engine(); }
    Ok(saved)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSettingsInput {
    capture_system_audio: bool,
}

#[tauri::command]
fn get_recording_settings(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let enabled = setting(&connection, "capture_system_audio", "false")? == "true";
    Ok(json!({ "captureSystemAudio": enabled }))
}

#[tauri::command]
fn save_recording_settings(state: State<'_, AppState>, settings: RecordingSettingsInput) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params!["capture_system_audio", if settings.capture_system_audio { "true" } else { "false" }],
    ).map_err(app_error)?;
    Ok(())
}

#[tauri::command]
fn clear_cloud_asr_key() -> Result<(), String> {
    match cloud_asr_key()?.delete_password() { Ok(()) | Err(keyring::Error::NoEntry) => Ok(()), Err(error) => Err(app_error(error)) }
}

#[tauri::command]
fn create_meeting(state: State<'_, AppState>, notebook_id: Option<String>) -> Result<Meeting, String> {
    let timestamp = now();
    let meeting = Meeting { id: id(), notebook_id, title: "未命名会议".to_string(), started_at: timestamp.clone(), duration_seconds: 0, status: "草稿".to_string(), transcript: String::new(), minutes: String::new(), decisions: String::new(), speaker_segments: "[]".to_string(), speaker_names: "{}".to_string(), audio_path: None, updated_at: timestamp, context: String::new(), notes: String::new() };
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute(&format!("INSERT INTO meetings ({MEETING_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"), params![meeting.id, meeting.notebook_id, meeting.title, meeting.started_at, meeting.duration_seconds, meeting.status, meeting.transcript, meeting.minutes, meeting.decisions, meeting.speaker_segments, meeting.speaker_names, meeting.audio_path, meeting.updated_at, meeting.context, meeting.notes]).map_err(app_error)?;
    Ok(meeting)
}

#[tauri::command]
fn save_meeting(state: State<'_, AppState>, meeting: Meeting) -> Result<(), String> {
    let recording_this_meeting = state.active_recording.lock()
        .map_err(|_| "录音状态被占用，请重试".to_string())?
        .as_deref() == Some(meeting.id.as_str());
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    if recording_this_meeting {
        connection.execute(
            "UPDATE meetings SET notebook_id = ?2, title = ?3, started_at = ?4, updated_at = ?5, context = ?6, notes = ?7 WHERE id = ?1",
            params![meeting.id, meeting.notebook_id, meeting.title, meeting.started_at, now(), meeting.context, meeting.notes],
        ).map_err(app_error)?;
    } else {
        connection.execute("UPDATE meetings SET notebook_id = ?2, title = ?3, started_at = ?4, duration_seconds = ?5, status = ?6, transcript = ?7, minutes = ?8, decisions = ?9, speaker_segments = ?10, speaker_names = ?11, audio_path = ?12, updated_at = ?13, context = ?14, notes = ?15 WHERE id = ?1", params![meeting.id, meeting.notebook_id, meeting.title, meeting.started_at, meeting.duration_seconds, meeting.status, meeting.transcript, meeting.minutes, meeting.decisions, meeting.speaker_segments, meeting.speaker_names, meeting.audio_path, now(), meeting.context, meeting.notes]).map_err(app_error)?;
    }
    Ok(())
}

#[tauri::command]
fn upsert_task(state: State<'_, AppState>, task: Task) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("INSERT INTO tasks (id, title, source_type, source_id, completed, due_date, created_at, origin, owner) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO UPDATE SET title = excluded.title, source_type = excluded.source_type, source_id = excluded.source_id, completed = excluded.completed, due_date = excluded.due_date, owner = excluded.owner", params![task.id, task.title, task.source_type, task.source_id, task.completed, task.due_date, task.created_at, task.origin, task.owner]).map_err(app_error)?;
    Ok(())
}

#[tauri::command]
fn delete_task(state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("DELETE FROM tasks WHERE id = ?1", params![task_id]).map_err(app_error)?;
    Ok(())
}

fn recording_file(recordings_dir: &Path, meeting_id: &str) -> Result<PathBuf, String> {
    // meeting_id 来自前端，只允许安全字符，防止路径穿越
    if meeting_id.is_empty() || !meeting_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("会议标识无效".to_string());
    }
    Ok(recordings_dir.join(format!("{meeting_id}.webm")))
}

fn pending_recording_key(meeting_id: &str) -> Result<String, String> {
    if meeting_id.is_empty() || !meeting_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("会议标识无效".to_string());
    }
    Ok(format!("{meeting_id}-pending"))
}

fn pending_recording_file(recordings_dir: &Path, meeting_id: &str) -> Result<PathBuf, String> {
    recording_file(recordings_dir, &pending_recording_key(meeting_id)?)
}

fn has_recoverable_pending_recording(recordings_dir: &Path, meeting_id: &str) -> bool {
    let Ok(key) = pending_recording_key(meeting_id) else { return false; };
    ["webm", "wav"].into_iter().any(|extension| recordings_dir.join(format!("{key}.{extension}")).is_file())
}

fn release_active_recording(state: &AppState, meeting_id: &str) {
    if let Ok(mut active) = state.active_recording.lock() {
        if active.as_deref() == Some(meeting_id) {
            *active = None;
            // 录音结束/中止/保存完成时撤销防睡眠请求，恢复系统正常睡眠策略。
            if let Ok(mut prevention) = state.sleep_prevention.lock() {
                *prevention = None;
            }
        }
    }
}

fn ensure_meeting_recording_idle(state: &AppState, meeting_id: &str) -> Result<(), String> {
    let active = state.active_recording.lock().map_err(|_| "录音状态被占用，请重试".to_string())?;
    if let Some(active_meeting_id) = active.as_deref() {
        return Err(if active_meeting_id == meeting_id {
            "这场会议正在录音或保存，请结束并等待保存完成后再操作".to_string()
        } else {
            "另一场会议正在录音或保存，请完成后再操作".to_string()
        });
    }
    Ok(())
}

fn restore_meeting_status(connection: &Connection, meeting_id: &str) -> Result<(), String> {
    connection.execute(
        "UPDATE meetings SET status = CASE WHEN minutes <> '' THEN '已分析' WHEN transcript <> '' THEN '已转写' WHEN audio_path IS NOT NULL THEN '已录音' ELSE '草稿' END, updated_at = ?2 WHERE id = ?1",
        params![meeting_id, now()],
    ).map_err(app_error)?;
    Ok(())
}

#[tauri::command]
fn check_recording_readiness(state: State<'_, AppState>, capture_system: bool) -> serde_json::Value {
    let test_path = state.recordings_dir.join(format!(".recording-check-{}.tmp", Uuid::new_v4()));
    let storage_ready = fs::write(&test_path, b"ready").is_ok();
    if storage_ready { let _ = fs::remove_file(&test_path); }

    let (system_audio_ready, system_audio_message) = if !capture_system {
        (true, "未开启，本次只录麦克风".to_string())
    } else if !state.ffmpeg_dir.join(FFMPEG_EXECUTABLE).is_file() {
        (false, "缺少音频转换组件，将仅录制麦克风".to_string())
    } else {
        match recorder::check_system_capture() {
            Ok(()) => (true, "默认播放设备可用，将同时录制电脑声音".to_string()),
            Err(error) => (false, format!("{error}，将仅录制麦克风")),
        }
    };

    json!({
        "storageReady": storage_ready,
        "systemAudioReady": system_audio_ready,
        "systemAudioMessage": system_audio_message,
    })
}

#[tauri::command]
fn begin_recording(app: AppHandle, state: State<'_, AppState>, meeting_id: String, capture_system: bool) -> Result<BeginRecordingResult, String> {
    {
        let mut active = state.active_recording.lock().map_err(|_| "录音状态被占用，请重试".to_string())?;
        if let Some(current) = active.as_deref() {
            return Err(if current == meeting_id { "这场会议已经在录音".to_string() } else { "已有另一场会议正在录音，请先结束并保存".to_string() });
        }
        *active = Some(meeting_id.clone());
        // 录音期间阻止系统睡眠（曾出现会议中电脑休眠导致中间内容缺失）。
        // 仅在窗口期起始时创建一次电源请求；后续失败路径统一由 release_active_recording 撤销。
        if let Ok(mut prevention) = state.sleep_prevention.lock() {
            if prevention.is_none() { *prevention = SleepGuard::acquire(); }
        }
    }
    let result = (|| {
        let path = pending_recording_file(&state.recordings_dir, &meeting_id)?;
        let pending_key = pending_recording_key(&meeting_id)?;
        let (meeting_context, asr_settings) = {
            let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
            let meeting = meeting_by_id(&connection, &meeting_id)?;
            (format!("{}\n{}", meeting.title, meeting.context), asr_engine_settings(&connection)?)
        };
        let _ = fs::remove_file(&path);
        recorder::remove_dual_track_sidecars(&state.recordings_dir, &pending_key);
        fs::File::create(&path).map_err(|error| format!("无法创建录音临时文件：{error}"))?;
        {
            let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
            connection.execute(
                "UPDATE meetings SET status = ?2, updated_at = ?3 WHERE id = ?1",
                params![meeting_id, "正在录音", now()],
            ).map_err(app_error)?;
        }
        let mut live_enabled = false;
        let mut live_warning = None;
        let live_source = if capture_system { "microphone+system" } else { "microphone" }.to_string();
        if asr_settings.provider == "local" {
            let hotwords = meeting_hotwords(&meeting_context, &asr_settings.local_hotwords);
            match start_live_asr(app, meeting_id.clone(), state.speaker_engine_dir.clone(), state.speaker_models_dir.clone(), hotwords) {
                Ok(session) => {
                    state.live_sessions.lock().map_err(|_| "实时转写状态被占用".to_string())?.insert(meeting_id.clone(), session);
                    live_enabled = true;
                }
                Err(error) => live_warning = Some(format!("实时字幕未启动：{error}。录音和会后转写不受影响。")),
            }
        }
        if capture_system {
            let live_sender = state.live_sessions.lock().ok().and_then(|sessions| sessions.get(&meeting_id).map(live_session::LiveSession::audio_input));
            let mut recorders = state.recorders.lock().map_err(|_| "录音状态被占用，请重试".to_string())?;
            let handle = recorder::begin_system_capture(&state.recordings_dir, &pending_key, live_sender);
            recorders.insert(meeting_id.clone(), handle);
        }
        Ok(BeginRecordingResult { live_enabled, live_source: if live_enabled { live_source } else { "none".to_string() }, warning: live_warning })
    })();
    if result.is_err() {
        release_active_recording(&state, &meeting_id);
        let _ = fs::remove_file(pending_recording_file(&state.recordings_dir, &meeting_id).unwrap_or_default());
        if let Ok(key) = pending_recording_key(&meeting_id) { recorder::remove_dual_track_sidecars(&state.recordings_dir, &key); }
        if let Ok(mut sessions) = state.live_sessions.lock() {
            if let Some(session) = sessions.remove(&meeting_id) { session.abort(); }
        }
        if let Ok(connection) = state.connection.lock() { let _ = restore_meeting_status(&connection, &meeting_id); }
    }
    result
}

#[tauri::command]
fn abort_recording(state: State<'_, AppState>, meeting_id: String) -> Result<(), String> {
    let path = pending_recording_file(&state.recordings_dir, &meeting_id)?;
    let pending_key = pending_recording_key(&meeting_id)?;
    let handle = state.recorders.lock().map_err(|_| "录音状态被占用，请重试".to_string())?.remove(&meeting_id);
    if let Some(handle) = handle {
        let _ = recorder::finalize_system_capture(handle, &state.recordings_dir, &pending_key);
    }
    if let Ok(mut sessions) = state.live_sessions.lock() {
        if let Some(session) = sessions.remove(&meeting_id) { session.abort(); }
    }
    let _ = fs::remove_file(&path);
    recorder::remove_dual_track_sidecars(&state.recordings_dir, &pending_key);
    release_active_recording(&state, &meeting_id);
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    restore_meeting_status(&connection, &meeting_id)
}

#[tauri::command]
fn stop_recording_capture(state: State<'_, AppState>, meeting_id: String) -> Result<(), String> {
    let recorders = state.recorders.lock().map_err(|_| "录音状态被占用，请重试".to_string())?;
    if let Some(handle) = recorders.get(&meeting_id) { handle.stop_flag.store(true, Ordering::Relaxed); }
    Ok(())
}

#[tauri::command]
fn append_live_audio(state: State<'_, AppState>, meeting_id: String, audio_base64: String) -> Result<(), String> {
    let audio = STANDARD.decode(audio_base64).map_err(app_error)?;
    if audio.is_empty() { return Ok(()); }
    let sessions = state.live_sessions.lock().map_err(|_| "实时转写状态被占用".to_string())?;
    let Some(session) = sessions.get(&meeting_id) else {
        return Err("实时转写会话已经结束".to_string());
    };
    session.send_microphone(audio)
}

#[tauri::command]
fn recover_interrupted_recordings(state: State<'_, AppState>) -> Result<usize, String> {
    let mut recovered = 0usize;
    let entries = fs::read_dir(&state.recordings_dir).map_err(app_error)?;
    let mut connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    for entry in entries.flatten() {
        let mut path = entry.path();
        if !matches!(path.extension().and_then(|value| value.to_str()), Some("webm" | "wav")) { continue; }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()).map(str::to_string) else { continue; };
        let pending = stem.ends_with("-pending");
        let meeting_id = stem.strip_suffix("-pending").unwrap_or(stem.as_str()).to_string();
        if !meeting_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { continue; }
        let Ok(meeting) = meeting_by_id(&connection, &meeting_id) else { continue; };
        if !pending && meeting.audio_path.is_some() { continue; }
        let size = fs::metadata(&path).map_err(app_error)?.len();
        if size == 0 { continue; }
        let pending_path = path.clone();
        if pending {
            let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("webm");
            let recovered_path = state.recordings_dir.join(format!("{meeting_id}-recording-recovered-{}.{extension}", Local::now().timestamp_millis()));
            fs::rename(&path, &recovered_path).map_err(|error| format!("无法恢复中断录音：{error}"))?;
            path = recovered_path;
        }
        let duration = probe_audio_duration(&state.ffmpeg_dir, &path);
        if pending {
            let recovery_result = (|| -> Result<(), String> {
                let transaction = connection.transaction().map_err(app_error)?;
                transaction.execute(
                    "UPDATE meetings SET audio_path = ?2, duration_seconds = ?3, status = ?4, updated_at = ?5, transcript = '', minutes = '', decisions = '', speaker_segments = '[]', speaker_names = '{}' WHERE id = ?1",
                    params![meeting_id, path.to_string_lossy().to_string(), duration, "录音已恢复", now()],
                ).map_err(app_error)?;
                transaction.execute("DELETE FROM tasks WHERE source_type = 'meeting' AND source_id = ?1 AND origin = 'ai'", params![meeting_id]).map_err(app_error)?;
                transaction.commit().map_err(app_error)
            })();
            if let Err(error) = recovery_result {
                let _ = fs::rename(&path, &pending_path);
                return Err(error);
            }
            if let Some(recovered_key) = path.file_stem().and_then(|value| value.to_str()) {
                let pending_key = format!("{meeting_id}-pending");
                let (pending_microphone, pending_system) = recorder::dual_track_paths(&state.recordings_dir, &pending_key);
                let (recovered_microphone, recovered_system) = recorder::dual_track_paths(&state.recordings_dir, recovered_key);
                if pending_microphone.is_file() && pending_system.is_file() {
                    if fs::rename(&pending_microphone, &recovered_microphone)
                        .and_then(|_| fs::rename(&pending_system, &recovered_system))
                        .is_err()
                    {
                        recorder::remove_dual_track_sidecars(&state.recordings_dir, recovered_key);
                    }
                }
                recorder::remove_dual_track_sidecars(&state.recordings_dir, &pending_key);
            }
            if let Some(old_audio) = meeting.audio_path.as_deref() { remove_recording_bundle(&state.recordings_dir, old_audio); }
        } else {
            connection.execute(
                "UPDATE meetings SET audio_path = ?2, duration_seconds = ?3, status = ?4, updated_at = ?5 WHERE id = ?1",
                params![meeting_id, path.to_string_lossy().to_string(), duration, "录音已恢复", now()],
            ).map_err(app_error)?;
        }
        recovered += 1;
    }
    Ok(recovered)
}

#[tauri::command]
fn append_recording_chunk(state: State<'_, AppState>, meeting_id: String, data_url: String) -> Result<(), String> {
    let encoded = data_url.split_once(',').map_or(data_url.as_str(), |(_, data)| data);
    let audio = STANDARD.decode(encoded).map_err(app_error)?;
    if audio.is_empty() { return Ok(()); }
    if state.active_recording.lock().map_err(|_| "录音状态被占用，请重试".to_string())?.as_deref() != Some(meeting_id.as_str()) {
        return Err("当前录音会话已经结束".to_string());
    }
    let path = pending_recording_file(&state.recordings_dir, &meeting_id)?;
    let mut file = fs::OpenOptions::new().create(true).append(true).open(&path)
        .map_err(|error| format!("无法写入录音文件：{error}"))?;
    file.write_all(&audio).map_err(|error| format!("录音写入失败：{error}"))?;
    Ok(())
}

#[tauri::command]
fn finalize_recording(state: State<'_, AppState>, meeting_id: String, duration_seconds: i64) -> Result<RecordingFinalizeResult, String> {
    let result = finalize_recording_inner(&state, &meeting_id, duration_seconds);
    release_active_recording(&state, &meeting_id);
    if result.is_err() {
        if let Ok(connection) = state.connection.lock() {
            if has_recoverable_pending_recording(&state.recordings_dir, &meeting_id) {
                let _ = connection.execute("UPDATE meetings SET status = ?2, updated_at = ?3 WHERE id = ?1", params![meeting_id, "录音保存待恢复", now()]);
            } else {
                let _ = restore_meeting_status(&connection, &meeting_id);
            }
        }
    }
    result
}

fn finalize_recording_inner(state: &AppState, meeting_id: &str, duration_seconds: i64) -> Result<RecordingFinalizeResult, String> {
    if state.active_recording.lock().map_err(|_| "录音状态被占用，请重试".to_string())?.as_deref() != Some(meeting_id) {
        return Err("当前录音会话已经结束".to_string());
    }
    let pending_key = pending_recording_key(meeting_id)?;
    let path = pending_recording_file(&state.recordings_dir, meeting_id)?;
    let size = fs::metadata(&path).map_err(|error| format!("录音文件不存在：{error}"))?.len();
    if size == 0 { let _ = fs::remove_file(&path); return Err("没有录到任何声音，请检查麦克风后重试".to_string()); }
    // 若本场开启了系统声音采集，保存独立双轨，并生成一份抑制串音的播放文件；失败时回退为仅麦克风。
    let (final_audio, mut system_audio_captured, mut warning): (PathBuf, bool, Option<String>) = {
        let handle = state.recorders.lock().map_err(|_| "录音状态被占用，请重试".to_string())?.remove(meeting_id);
        match handle {
            Some(h) => match recorder::finalize_system_capture(h, &state.recordings_dir, &pending_key) {
                Ok(sys_raw) => match recorder::prepare_dual_track_audio(&state.ffmpeg_dir.join(FFMPEG_EXECUTABLE), &state.recordings_dir, &pending_key, &path, &sys_raw) {
                    Ok(tracks) => {
                        let _ = fs::remove_file(&path);
                        let _ = fs::remove_file(&sys_raw);
                        eprintln!("双轨录音已保留：microphone={}, system={}", tracks.microphone.display(), tracks.system.display());
                        (tracks.playback, true, None)
                    }
                    Err(e) => { eprintln!("双轨录音处理失败，回退仅麦克风：{e}"); recorder::remove_dual_track_sidecars(&state.recordings_dir, &pending_key); (path, false, Some(format!("电脑声音处理失败，已保存麦克风录音：{e}"))) }
                },
                Err(e) => (path, false, Some(format!("电脑声音未录到，已保存麦克风录音：{e}"))),
            },
            None => (path, false, None),
        }
    };
    let probed = probe_audio_duration(&state.ffmpeg_dir, &final_audio);
    let final_duration = if probed > 0 { probed } else { duration_seconds };
    let live_session = {
        state.live_sessions.lock().ok().and_then(|mut sessions| sessions.remove(meeting_id))
    };
    let live_result = live_session.map(finish_live_asr);
    let (live_transcript, live_segments, live_warning) = live_result.unwrap_or_default();
    let committed_key = format!("{meeting_id}-recording-{}", Local::now().timestamp_millis());
    let extension = final_audio.extension().and_then(|value| value.to_str()).unwrap_or("webm");
    let committed_audio = state.recordings_dir.join(format!("{committed_key}.{extension}"));
    fs::rename(&final_audio, &committed_audio).map_err(|error| format!("无法提交新录音：{error}"))?;
    if system_audio_captured {
        let (pending_microphone, pending_system) = recorder::dual_track_paths(&state.recordings_dir, &pending_key);
        let (committed_microphone, committed_system) = recorder::dual_track_paths(&state.recordings_dir, &committed_key);
        if let Err(error) = fs::rename(&pending_microphone, &committed_microphone)
            .and_then(|_| fs::rename(&pending_system, &committed_system))
        {
            recorder::remove_dual_track_sidecars(&state.recordings_dir, &committed_key);
            recorder::remove_dual_track_sidecars(&state.recordings_dir, &pending_key);
            system_audio_captured = false;
            let detail = format!("双轨源文件未能保留，但合成录音已经安全保存：{error}");
            warning = Some(warning.map_or(detail.clone(), |current| format!("{current}；{detail}")));
        }
    }
    let path_string = committed_audio.to_string_lossy().to_string();
    let segments = serde_json::to_string(&live_segments).unwrap_or_else(|_| "[]".to_string());
    let database_result = (|| -> Result<(Meeting, Option<String>), String> {
        let mut connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        let previous_audio = meeting_by_id(&connection, meeting_id)?.audio_path;
        let transaction = connection.transaction().map_err(app_error)?;
        transaction.execute(
            "UPDATE meetings SET audio_path = ?2, duration_seconds = ?3, status = ?4, updated_at = ?5, transcript = ?6, minutes = '', decisions = '', speaker_segments = ?7, speaker_names = '{}' WHERE id = ?1",
            params![meeting_id, path_string, final_duration, if live_transcript.is_empty() { "已录音" } else { "实时转写完成" }, now(), live_transcript, segments],
        ).map_err(app_error)?;
        transaction.execute("DELETE FROM tasks WHERE source_type = 'meeting' AND source_id = ?1 AND origin = 'ai'", params![meeting_id]).map_err(app_error)?;
        transaction.commit().map_err(app_error)?;
        Ok((meeting_by_id(&connection, meeting_id)?, previous_audio))
    })();
    let (meeting, previous_audio) = match database_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&committed_audio);
            recorder::remove_dual_track_sidecars(&state.recordings_dir, &committed_key);
            return Err(error);
        }
    };
    if let Some(old_audio) = previous_audio.as_deref() {
        if old_audio != path_string { remove_recording_bundle(&state.recordings_dir, old_audio); }
    }
    recorder::remove_dual_track_sidecars(&state.recordings_dir, meeting_id);
    let warning = [warning, live_warning].into_iter().flatten().collect::<Vec<_>>().join("；");
    Ok(RecordingFinalizeResult { meeting, system_audio_captured, warning: if warning.is_empty() { None } else { Some(warning) } })
}

#[tauri::command]
fn get_recording_path(state: State<'_, AppState>, meeting_id: String) -> Result<String, String> {
    let meeting = { let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?; meeting_by_id(&connection, &meeting_id)? };
    let audio_path = meeting.audio_path.ok_or_else(|| "该会议没有录音".to_string())?;
    if !PathBuf::from(&audio_path).is_file() { return Err("录音文件不存在，可能已被移动或删除".to_string()); }
    Ok(audio_path)
}

#[tauri::command]
fn import_meeting_audio(state: State<'_, AppState>, meeting_id: String, audio_path: String) -> Result<Meeting, String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    let source = PathBuf::from(&audio_path);
    if !source.is_file() { return Err("找不到选择的录音文件".to_string()); }
    if fs::metadata(&source).map_err(app_error)?.len() == 0 { return Err("选择的录音文件是空文件".to_string()); }
    let extension = source.extension().and_then(|value| value.to_str()).map(str::to_ascii_lowercase)
        .ok_or_else(|| "录音文件缺少扩展名".to_string())?;
    const AUDIO_EXTENSIONS: &[&str] = &["wav", "mp3", "m4a", "aac", "flac", "ogg", "opus", "webm", "wma", "mp4"];
    if !AUDIO_EXTENSIONS.contains(&extension.as_str()) { return Err(format!("暂不支持 .{extension} 格式的录音")); }

    let existing = {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        meeting_by_id(&connection, &meeting_id)?
    };
    let destination = state.recordings_dir.join(format!("{meeting_id}-import-{}.{}", Local::now().timestamp(), extension));
    fs::copy(&source, &destination).map_err(|error| format!("导入录音失败：{error}"))?;
    let duration_seconds = probe_audio_duration(&state.ffmpeg_dir, &destination);
    let destination_string = destination.to_string_lossy().into_owned();
    let update_result = (|| {
        let mut connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        let transaction = connection.transaction().map_err(app_error)?;
        transaction.execute(
            "UPDATE meetings SET audio_path = ?2, duration_seconds = ?3, status = ?4, updated_at = ?5, transcript = '', minutes = '', decisions = '', speaker_segments = '[]', speaker_names = '{}' WHERE id = ?1",
            params![meeting_id, destination_string, duration_seconds, "已导入录音", now()],
        ).map_err(app_error)?;
        transaction.execute("DELETE FROM tasks WHERE source_type = 'meeting' AND source_id = ?1 AND origin = 'ai'", params![meeting_id]).map_err(app_error)?;
        transaction.commit().map_err(app_error)?;
        meeting_by_id(&connection, &existing.id)
    })();
    if update_result.is_err() { let _ = fs::remove_file(&destination); }
    let meeting = update_result?;
    if let Some(old_audio) = existing.audio_path.as_deref() {
        if old_audio != destination_string { remove_recording_bundle(&state.recordings_dir, old_audio); }
    }
    recorder::remove_dual_track_sidecars(&state.recordings_dir, &meeting_id);
    Ok(meeting)
}

async fn transcribe_audio(state: &State<'_, AppState>, meeting: &Meeting) -> Result<String, String> {
    let audio_path = meeting.audio_path.clone().ok_or_else(|| "请先完成录音，再开始语音转写".to_string())?;
    let engine = {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        asr_engine_settings(&connection)?
    };
    // 新一轮转写开始，清除上一次的取消标志
    state.cancel_flag.store(false, Ordering::SeqCst);
    if engine.provider == "cloud" {
        let api_key = cloud_asr_key()?.get_password().map_err(|_| "请先在设置中保存云端转写 API 密钥".to_string())?;
        if api_key.trim().is_empty() { return Err("请先在设置中保存云端转写 API 密钥".to_string()); }
        let prompt_hint = meeting.context.clone();
        tauri::async_runtime::spawn_blocking(move || run_cloud_asr(engine.cloud_base_url, engine.cloud_model, api_key, audio_path, prompt_hint))
            .await.map_err(|error| format!("云端转写任务中断：{error}"))?
    } else {
        let runtime_dir = state.runtime_dir.clone();
        let ffmpeg_dir = state.ffmpeg_dir.clone();
        let models_dir = state.models_dir.clone();
        let vcrt_dir = state.vcrt_dir.clone();
        let cancel_flag = state.cancel_flag.clone();
        let cancel_child = state.cancel_child.clone();
        tauri::async_runtime::spawn_blocking(move || run_local_asr(runtime_dir, ffmpeg_dir, models_dir, vcrt_dir, audio_path, cancel_flag, cancel_child))
            .await.map_err(|error| format!("本地转写任务中断：{error}"))?
    }
}

#[tauri::command]
async fn transcribe_meeting(state: State<'_, AppState>, meeting_id: String) -> Result<Meeting, String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    let meeting = { let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?; meeting_by_id(&connection, &meeting_id)? };
    // 会后模型本身会加载大权重；先释放预热的实时双模型，避免低内存电脑同时驻留多套模型。
    live_session::shutdown_warm_engine();
    let transcript_result = transcribe_audio(&state, &meeting).await;
    live_session::warm_engine(state.speaker_engine_dir.clone(), state.speaker_models_dir.clone());
    let transcript = transcript_result?;
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("UPDATE meetings SET transcript = ?2, status = ?3, updated_at = ?4 WHERE id = ?1", params![meeting_id, transcript, "已转写", now()]).map_err(app_error)?;
    let updated = meeting_by_id(&connection, &meeting.id)?;
    drop(connection);
    Ok(updated)
}

#[tauri::command]
async fn transcribe_meeting_with_speakers(state: State<'_, AppState>, meeting_id: String) -> Result<Meeting, String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    state.cancel_flag.store(false, Ordering::SeqCst);
    let meeting = { let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?; meeting_by_id(&connection, &meeting_id)? };
    let provider = {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        asr_engine_settings(&connection)?.provider
    };
    // 云端引擎暂不做说话人分离：退化为纯云端转写，由前端提示用户
    if provider == "cloud" {
        let transcript = transcribe_audio(&state, &meeting).await?;
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        connection.execute("UPDATE meetings SET transcript = ?2, status = ?3, updated_at = ?4 WHERE id = ?1", params![meeting_id, transcript, "已转写", now()]).map_err(app_error)?;
        return meeting_by_id(&connection, &meeting.id);
    }
    // 结束录音后释放实时双模型，再启动包含说话人分离的整场模型，降低内存峰值。
    live_session::shutdown_warm_engine();
    let playback_path = meeting.audio_path.clone().ok_or_else(|| "请先完成录音，再开始说话人分离".to_string())?;
    let recording_key = Path::new(&playback_path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(&meeting.id);
    let (microphone_track, system_track) = recorder::dual_track_paths(&state.recordings_dir, recording_key);
    let dual_track = microphone_track.is_file() && system_track.is_file();
    let engine_dir = state.speaker_engine_dir.clone();
    let models_dir = state.speaker_models_dir.clone();
    let runtime_dir = state.runtime_dir.clone();
    let ffmpeg_dir = state.ffmpeg_dir.clone();
    let vcrt_dir = state.vcrt_dir.clone();
    let hotwords = {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        let settings = asr_engine_settings(&connection)?;
        meeting_hotwords(&format!("{}\n{}", meeting.title, meeting.context), &settings.local_hotwords)
    };
    let cancel_flag = state.cancel_flag.clone();
    let cancel_child = state.cancel_child.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        if dual_track {
            run_dual_track_speaker_engine(engine_dir, models_dir, runtime_dir, ffmpeg_dir, vcrt_dir, microphone_track, system_track, hotwords, cancel_flag, cancel_child)
        } else {
            run_speaker_engine(engine_dir, models_dir, runtime_dir, ffmpeg_dir, vcrt_dir, playback_path, hotwords, cancel_flag, cancel_child)
        }
    }).await.map_err(|error| format!("说话人分离任务中断：{error}"));
    live_session::warm_engine(state.speaker_engine_dir.clone(), state.speaker_models_dir.clone());
    let result = result??;
    let segments = serde_json::to_string(&result.segments).map_err(app_error)?;
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("UPDATE meetings SET transcript = ?2, speaker_segments = ?3, status = ?4, updated_at = ?5 WHERE id = ?1", params![meeting_id, result.transcript, segments, "已区分发言人", now()]).map_err(app_error)?;
    let updated = meeting_by_id(&connection, &meeting.id)?;
    drop(connection);
    Ok(updated)
}

/// 取消当前正在进行的本地转写：置取消标志并杀掉本地语音引擎子进程
#[tauri::command]
async fn cancel_processing(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::SeqCst);
    if let Ok(mut slot) = state.cancel_child.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

/// 把转写稿里的「发言人 N」按本会议的自定义名称替换，让智能纪要使用用户改名后的称呼。
/// 无正则依赖：顺序扫描 【发言人 N】 片段，用 speaker_names 映射（键为 speaker_id，即 N-1）替换。
fn apply_speaker_names(transcript: &str, names_json: &str) -> String {
    let names: std::collections::HashMap<i64, String> = match serde_json::from_str(names_json) {
        Ok(m) => m,
        Err(_) => return transcript.to_string(),
    };
    if names.is_empty() {
        return transcript.to_string();
    }
    let mut out = String::with_capacity(transcript.len());
    let mut rest = transcript;
    let prefix = "【发言人 ";
    while let Some(start) = rest.find(prefix) {
        out.push_str(&rest[..start]);
        let after = &rest[start + prefix.len()..];
        match after.find("】") {
            Some(end) => {
                let num_str = &after[..end];
                let replaced = if let Ok(n) = num_str.parse::<i64>() {
                    names.get(&(n - 1)).map(|name| format!("【{}】", name))
                } else {
                    None
                };
                match replaced {
                    Some(label) => out.push_str(&label),
                    None => out.push_str(&rest[start..start + prefix.len() + end + "】".len()]),
                }
                rest = &after[end + "】".len()..];
            }
            None => {
                out.push_str(rest);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 拼智能纪要的 user prompt：有会前背景时带上，让 AI 结合背景理解转写稿
fn analysis_template_instruction(template: &str) -> &'static str {
    match template {
        "weekly" => "周会：突出本周进展、阻塞问题、下周计划和负责人。",
        "interview" => "访谈：按主题归纳受访者观点、需求、痛点、原话证据和待验证假设。",
        "review" => "复盘：突出目标与结果、做得好的地方、问题根因、改进措施和责任人。",
        "project" => "项目会议：突出里程碑、风险、依赖、关键决策、负责人和截止时间。",
        "decision" => "决策会议：突出备选方案、主要分歧、取舍依据、最终决定和后续验证。",
        _ => "通用会议：按议题、讨论结论、关键决策和下一步行动组织。",
    }
}

/// 会议正文的统一文本形态：优先用说话人时间线（带 mm:ss 与改名后的称呼），否则退回完整转写稿。
/// 智能纪要与会议问答共用，保证两条链路看到的会议内容一致。
fn meeting_transcript_text(meeting: &Meeting) -> String {
    let speaker_names = serde_json::from_str::<std::collections::HashMap<i64, String>>(&meeting.speaker_names)
        .unwrap_or_default();
    let timeline = serde_json::from_str::<Vec<SpeakerSegment>>(&meeting.speaker_segments)
        .unwrap_or_default()
        .into_iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .map(|segment| {
            let display_name = speaker_names.get(&segment.speaker_id)
                .filter(|name| !name.trim().is_empty())
                .cloned()
                .unwrap_or(segment.speaker);
            format!("[{:02}:{:02}] 【{}】 {}", segment.start_ms / 60_000, (segment.start_ms / 1_000) % 60, display_name, segment.text.trim())
        })
        .collect::<Vec<_>>()
        .join("\n");
    if timeline.is_empty() {
        apply_speaker_names(&meeting.transcript, &meeting.speaker_names)
    } else {
        apply_speaker_names(&timeline, &meeting.speaker_names)
    }
}

/// 单次智能纪要请求可容纳的转写字数上限（按字符粗估；中文对主流模型约 0.6~1 token/字，
/// 10k 字符叠加提示词与输出在常见上下文窗口内安全）。转写超出后按说话人时间线分段生成再合并。
const ANALYSIS_SINGLE_CHARS: usize = 10_000;

/// 会前背景文本块（带说明前缀）；无背景时为空串。智能纪要全链路共用，保证提示词口径一致。
fn analysis_context_block(meeting: &Meeting) -> String {
    if meeting.context.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n会前背景（用户提供的会议材料，供你理解会议，不要在纪要中照抄）：\n{}", meeting.context.trim())
    }
}

/// 会议正文的“行”视图：优先说话人时间线（每行带 mm:ss 与改名后的称呼），
/// 否则把整段转写按句切成逻辑行。仅在超长会议需要分段时使用。
fn meeting_transcript_rows(meeting: &Meeting) -> Vec<String> {
    let speaker_names = serde_json::from_str::<std::collections::HashMap<i64, String>>(&meeting.speaker_names)
        .unwrap_or_default();
    let timeline: Vec<String> = serde_json::from_str::<Vec<SpeakerSegment>>(&meeting.speaker_segments)
        .unwrap_or_default()
        .into_iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .map(|segment| {
            let display_name = speaker_names.get(&segment.speaker_id)
                .filter(|name| !name.trim().is_empty())
                .cloned()
                .unwrap_or(segment.speaker);
            format!("[{:02}:{:02}] 【{}】 {}", segment.start_ms / 60_000, (segment.start_ms / 1_000) % 60, display_name, segment.text.trim())
        })
        .collect();
    if !timeline.is_empty() { return timeline; }
    split_text_near_boundaries(&apply_speaker_names(&meeting.transcript, &meeting.speaker_names), 240)
}

/// 把文本切成若干“逻辑行”：优先在换行或句子终止符（。！？；…）处断行，找不到就按 limit 硬切。
fn split_text_near_boundaries(text: &str, limit: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut rows: Vec<String> = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + limit).min(chars.len());
        if end == chars.len() {
            let rest: String = chars[start..].iter().collect();
            if !rest.trim().is_empty() { rows.push(rest); }
            break;
        }
        let mut cut: Option<usize> = None;
        for offset in (0..end - start).rev() {
            if chars[start + offset] == '\n' { cut = Some(start + offset + 1); break; }
        }
        if cut.is_none() {
            for offset in (0..end - start).rev() {
                if matches!(chars[start + offset], '。' | '！' | '？' | '；' | '…') {
                    cut = Some(start + offset + 1);
                    break;
                }
            }
        }
        if let Some(pos) = cut {
            let row: String = chars[start..pos].iter().collect();
            if !row.trim().is_empty() { rows.push(row); }
            start = pos;
        } else {
            let row: String = chars[start..end].iter().collect();
            if !row.trim().is_empty() { rows.push(row); }
            start = end;
        }
    }
    rows
}

/// 按字符预算把转写行切成若干块：贪心累积，尽量在说话人行边界收尾；
/// 单行超限的极端情况（一人连续讲超长）先按句子边界拆开再成块。
fn chunk_transcript_rows(rows: &[String], limit: usize) -> Vec<Vec<String>> {
    let mut chunks: Vec<Vec<String>> = Vec::new();
    let mut current: Vec<String> = Vec::new();
    let mut current_len = 0usize;
    for row in rows {
        let row_len = row.chars().count();
        if row_len > limit {
            if !current.is_empty() { chunks.push(std::mem::take(&mut current)); current_len = 0; }
            for piece in split_text_near_boundaries(row, limit) {
                chunks.push(vec![piece]);
            }
            continue;
        }
        if current_len + row_len > limit && !current.is_empty() {
            chunks.push(std::mem::take(&mut current));
            current_len = 0;
        }
        current_len += row_len;
        current.push(row.clone());
    }
    if !current.is_empty() { chunks.push(current); }
    chunks
}

/// 智能纪要 user prompt 的固定头部（标题 + 时间 + 模板说明 + 会前背景）。
fn analysis_prompt_head(meeting: &Meeting, template: &str) -> String {
    format!(
        "会议标题：{}\n会议时间：{}\n纪要模板：{}{}",
        meeting.title, meeting.started_at, analysis_template_instruction(template), analysis_context_block(meeting)
    )
}

fn build_analysis_user_prompt(meeting: &Meeting, template: &str) -> String {
    format!(
        "{}\n\n转写稿（可能包含真实时间标记）：\n{}",
        analysis_prompt_head(meeting, template),
        meeting_transcript_text(meeting)
    )
}

/// 分段生成时某一段的 user prompt：带“第 k/N 段”说明，正文只含该段时间线。
fn build_chunk_user_prompt(meeting: &Meeting, template: &str, index: usize, total: usize, chunk: &[String]) -> String {
    format!(
        "{}\n这是同一场长会议切分后的第 {}/{} 段时间片段，只整理本片段的内容。\n\n转写稿片段（可能包含真实时间标记）：\n{}",
        analysis_prompt_head(meeting, template),
        index, total,
        chunk.join("\n")
    )
}

/// 合并轮的 user prompt：只喂各段已生成的纪要正文，让模型去重整合成一份完整纪要并提炼整体主题。
fn build_merge_user_prompt(meeting: &Meeting, template: &str, minutes_parts: &[String]) -> String {
    let nonempty: Vec<&str> = minutes_parts.iter().map(String::as_str).filter(|part| !part.trim().is_empty()).collect();
    let body: Vec<String> = nonempty.iter().enumerate()
        .map(|(index, part)| format!("【第 {} 段时间片段纪要】\n{}", index + 1, part.trim()))
        .collect();
    format!(
        "{}\n下面按会议时间顺序列出各段时间片段的纪要，请把它们合并成一份连贯完整的纪要。\n\n各段纪要片段：\n{}",
        analysis_prompt_head(meeting, template),
        body.join("\n\n")
    )
}

fn dedupe_action_items(items: Vec<AnalysisActionItem>) -> Vec<AnalysisActionItem> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter()
        .filter(|item| seen.insert(format!("{}|{}", item.title.trim(), item.assignee.as_deref().unwrap_or("").trim())))
        .collect()
}

fn dedupe_source_highlights(items: Vec<AnalysisSourceHighlight>) -> Vec<AnalysisSourceHighlight> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter()
        .filter(|item| seen.insert(format!("{}|{}", item.time_ms, item.quote.trim())))
        .collect()
}

/// 长会议分段纪要主流程：分块逐段生成 → decisions/actionItems/sourceHighlights 程序侧按序去重合并
/// → 各段 minutes 交一次短请求整理成完整纪要并提炼整体主题。任一段失败则整体报错（可重试）。
fn generate_chunked_analysis(settings: &AiSettings, api_key: &str, meeting: &Meeting, template: &str) -> Result<AnalysisResponse, String> {
    let rows = meeting_transcript_rows(meeting);
    let chunks = chunk_transcript_rows(&rows, ANALYSIS_SINGLE_CHARS);
    let total = chunks.len();
    if total < 2 {
        return request_analysis(settings, api_key, &build_analysis_user_prompt(meeting, template));
    }
    let mut decisions: Vec<String> = Vec::new();
    let mut action_items: Vec<AnalysisActionItem> = Vec::new();
    let mut highlights: Vec<AnalysisSourceHighlight> = Vec::new();
    let mut minutes_parts: Vec<String> = Vec::new();
    for (index, chunk) in chunks.iter().enumerate() {
        let part_prompt = build_chunk_user_prompt(meeting, template, index + 1, total, chunk);
        let part = request_analysis_with(settings, api_key, ANALYSIS_CHUNK_SYSTEM_PROMPT, &part_prompt)
            .map_err(|error| format!("长会议分段生成失败（第 {}/{} 段）：{}", index + 1, total, error))?;
        if !part.minutes.trim().is_empty() { minutes_parts.push(part.minutes); }
        for line in part.decisions.split('\n') {
            let line = line.trim();
            if !line.is_empty() && !decisions.iter().any(|existing| existing.as_str() == line) {
                decisions.push(line.to_string());
            }
        }
        action_items.extend(part.action_items);
        highlights.extend(part.source_highlights);
    }
    if minutes_parts.is_empty() { return Err("智能纪要没有生成内容".to_string()); }
    let merge_prompt = build_merge_user_prompt(meeting, template, &minutes_parts);
    let merged = request_analysis_with(settings, api_key, ANALYSIS_MERGE_SYSTEM_PROMPT, &merge_prompt)
        .map_err(|error| format!("长会议纪要合并失败：{error}"))?;
    if merged.minutes.trim().is_empty() { return Err("智能纪要没有生成内容".to_string()); }
    Ok(AnalysisResponse {
        theme: merged.theme,
        minutes: merged.minutes,
        decisions: decisions.join("\n"),
        action_items: dedupe_action_items(action_items),
        source_highlights: dedupe_source_highlights(highlights),
    })
}

const ANALYSIS_SYSTEM_PROMPT: &str = "你是严谨的中文会议纪要助手。仅根据输入内容整理，不要编造事实、负责人或日期。只输出合法 JSON，不要 Markdown 代码围栏。\n\nJSON 格式要求（严格遵循类型）：\n- theme：字符串（4-12 个字的会议主题短语，不要带日期和标点）\n- minutes：字符串（Markdown 格式完整纪要，只用 Markdown 语法）\n- decisions：字符串（关键决策，多项用换行分隔）\n- actionItems：数组，每项为 { \"title\": \"行动内容\", \"dueDate\": \"YYYY-MM-DD或null\", \"assignee\": \"原文明确的负责人或null\" }\n- sourceHighlights：数组，每项为 { \"label\": \"简短说明\", \"timeMs\": 毫秒整数, \"quote\": \"对应原文短句\" }\n\n行动项只保留明确或高度可信的事项。若输入包含带时间原文，在 minutes 的关键结论后添加【来源 mm:ss】，并把同一时间写入 sourceHighlights；没有真实时间时不要编造引用。decisions 和 minutes 必须是字符串。";

/// 长会议分段生成时用的 system prompt：只要求整理本时间片段的内容，JSON 结构与单次请求一致，便于程序侧合并。
const ANALYSIS_CHUNK_SYSTEM_PROMPT: &str = "你是严谨的中文会议纪要助手。你正在处理同一场长会议按时间切分出的其中一个片段，只依据本片段内容整理，不要编造事实、负责人或日期，也不要脑补片段之外的内容。只输出合法 JSON，不要 Markdown 代码围栏。\n\nJSON 格式要求（严格遵循类型）：\n- theme：字符串（本片段的小主题短语，4-12 个字，不要带日期和标点）\n- minutes：字符串（Markdown 格式的本片段纪要：按讨论顺序给出要点与结论，不写开场白，不要用“会议纪要”这类整体标题）\n- decisions：字符串（本片段出现的关键决策，多项用换行分隔，没有就留空字符串）\n- actionItems：数组，每项为 { \"title\": \"行动内容\", \"dueDate\": \"YYYY-MM-DD或null\", \"assignee\": \"原文明确的负责人或null\" }\n- sourceHighlights：数组，每项为 { \"label\": \"简短说明\", \"timeMs\": 毫秒整数, \"quote\": \"对应原文短句\" }\n\n行动项只保留明确或高度可信的事项。片段文本若带 mm:ss 时间标记，在 minutes 的关键结论后添加【来源 mm:ss】，并把同一时间写入 sourceHighlights；没有真实时间时不要编造引用。";

/// 合并轮用的 system prompt：把各段纪要合成一份完整纪要并提炼整体主题；结构化字段由程序侧合并，本轮固定留空。
const ANALYSIS_MERGE_SYSTEM_PROMPT: &str = "你是严谨的中文会议纪要助手。下面是同一场长会议按时间顺序切分的各段纪要片段，请把它们合并成一份连贯、无重复、结构完整的会议纪要。只依据片段内容整合，不要编造事实。只输出合法 JSON，不要 Markdown 代码围栏。\n\nJSON 格式要求（严格遵循类型）：\n- theme：字符串（整场会议的总结主题短语，4-12 个字，不要带日期和标点）\n- minutes：字符串（Markdown 格式的完整纪要：按时间顺序组织各段要点，删除重复的引导语和段落标题，保留各段结论与【来源 mm:ss】时间标注）\n- decisions：字符串（固定输出空字符串）\n- actionItems：数组（固定输出空数组 []）\n- sourceHighlights：数组（固定输出空数组 []）";

/// 调聊天补全接口并解析出 AnalysisResponse（theme + minutes + decisions + actionItems）
fn request_analysis(settings: &AiSettings, api_key: &str, user_prompt: &str) -> Result<AnalysisResponse, String> {
    request_analysis_with(settings, api_key, ANALYSIS_SYSTEM_PROMPT, user_prompt)
}

/// request_analysis 的带自定义 system prompt 版本（长会议分段生成与合并轮使用）
fn request_analysis_with(settings: &AiSettings, api_key: &str, system_prompt: &str, user_prompt: &str) -> Result<AnalysisResponse, String> {
    let body = json!({
      "model": settings.analysis_model,
      "temperature": 0.2,
      "messages": [
        { "role": "system", "content": system_prompt },
        { "role": "user", "content": user_prompt }
      ]
    });
    let endpoint = format!("{}/chat/completions", settings.base_url.trim_end_matches('/'));
    let response: serde_json::Value = response_error(reqwest::blocking::Client::new().post(endpoint).bearer_auth(api_key).json(&body).send().map_err(app_error)?, "智能纪要服务")?.json().map_err(app_error)?;
    let content = response.pointer("/choices/0/message/content").and_then(serde_json::Value::as_str).ok_or_else(|| "智能纪要服务没有返回可解析的内容".to_string())?;
    let cleaned = clean_json(content);
    serde_json::from_str(&cleaned).map_err(|error| {
        let preview: String = cleaned.chars().take(500).collect();
        format!("智能纪要返回的格式无效，请重试：{error}\n\n返回内容前500字符：\n{preview}")
    })
}

fn generate_analysis(state: &AppState, meeting_id: &str, template: &str) -> Result<AnalysisResponse, String> {
    let (settings, api_key) = configured_ai(state)?;
    let meeting = { let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?; meeting_by_id(&connection, meeting_id)? };
    if meeting.transcript.trim().is_empty() { return Err("请先完成语音转写，或在原始记录中粘贴会议内容".to_string()); }
    if meeting_transcript_text(&meeting).chars().count() > ANALYSIS_SINGLE_CHARS {
        // 长会议：按说话人时间线分段生成再合并，避免单次请求撑爆模型上下文
        return generate_chunked_analysis(&settings, &api_key, &meeting, template);
    }
    let prompt = build_analysis_user_prompt(&meeting, template);
    let analysis = request_analysis(&settings, &api_key, &prompt)?;
    if analysis.minutes.trim().is_empty() { return Err("智能纪要没有生成内容".to_string()); }
    Ok(analysis)
}

/// 调聊天补全接口并返回纯文本回答（会议问答、周报等自由文本场景共用）
fn request_chat_text(settings: &AiSettings, api_key: &str, system_prompt: &str, user_prompt: &str, service_label: &str) -> Result<String, String> {
    let body = json!({
      "model": settings.analysis_model,
      "temperature": 0.3,
      "messages": [
        { "role": "system", "content": system_prompt },
        { "role": "user", "content": user_prompt }
      ]
    });
    let endpoint = format!("{}/chat/completions", settings.base_url.trim_end_matches('/'));
    let response: serde_json::Value = response_error(reqwest::blocking::Client::new().post(endpoint).bearer_auth(api_key).json(&body).send().map_err(app_error)?, service_label)?.json().map_err(app_error)?;
    let content = response.pointer("/choices/0/message/content").and_then(serde_json::Value::as_str).ok_or_else(|| format!("{service_label}没有返回可解析的内容"))?;
    let answer = content.trim().to_string();
    if answer.is_empty() { return Err(format!("{service_label}没有返回内容")); }
    Ok(answer)
}

const QA_SYSTEM_PROMPT: &str = "你是严谨的会议问答助手。只根据提供的会议内容（转写稿、智能纪要、我的笔记、会前背景）回答问题；会议内容里没有依据的，直接说「会议中没有提到」，不要编造。用简体中文回答，简明扼要，可以用 Markdown 列表。回答中不要复述整个会议内容。";

/// 拼会议问答的 user prompt：会议全文 + 已有纪要/笔记 + 最近几轮问答（支持追问）
fn build_qa_user_prompt(meeting: &Meeting, history: &[QaMessage], question: &str) -> String {
    let context_block = if meeting.context.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n会前背景：\n{}", meeting.context.trim())
    };
    let minutes_block = if meeting.minutes.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n智能纪要：\n{}", meeting.minutes.trim())
    };
    let notes_block = if meeting.notes.trim().is_empty() {
        String::new()
    } else {
        format!("\n\n我的笔记：\n{}", meeting.notes.trim())
    };
    let recent: Vec<&QaMessage> = history.iter().rev().take(4).collect();
    let history_block = if recent.is_empty() {
        String::new()
    } else {
        let pairs = recent.into_iter().rev()
            .map(|message| format!("问：{}\n答：{}", message.question, message.answer))
            .collect::<Vec<_>>()
            .join("\n\n");
        format!("\n\n之前的问答（供理解追问）：\n{pairs}")
    };
    let transcript = meeting_transcript_text(meeting);
    format!(
        "会议标题：{}\n会议时间：{}{}{}{}{}\n\n转写稿（可能包含真实时间标记）：\n{}\n\n问题：{}",
        meeting.title, meeting.started_at, context_block, minutes_block, notes_block, history_block, transcript, question,
    )
}

fn qa_history(connection: &Connection, meeting_id: &str) -> Result<Vec<QaMessage>, String> {
    let mut statement = connection.prepare("SELECT id, meeting_id, question, answer, created_at FROM qa_messages WHERE meeting_id = ?1 ORDER BY created_at ASC").map_err(app_error)?;
    let rows = statement.query_map(params![meeting_id], |row| {
        Ok(QaMessage { id: row.get(0)?, meeting_id: row.get(1)?, question: row.get(2)?, answer: row.get(3)?, created_at: row.get(4)? })
    }).map_err(app_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(app_error)
}

#[tauri::command]
fn list_qa_messages(state: State<'_, AppState>, meeting_id: String) -> Result<Vec<QaMessage>, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    qa_history(&connection, &meeting_id)
}

#[tauri::command]
fn ask_meeting_question(state: State<'_, AppState>, meeting_id: String, question: String) -> Result<QaMessage, String> {
    let question = question.trim().to_string();
    if question.is_empty() { return Err("请输入问题".to_string()); }
    let (settings, api_key) = configured_ai(&state)?;
    let (meeting, history) = {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        (meeting_by_id(&connection, &meeting_id)?, qa_history(&connection, &meeting_id)?)
    };
    if meeting.transcript.trim().is_empty() && meeting.minutes.trim().is_empty() {
        return Err("请先完成转写，或在原文中粘贴会议内容后再提问".to_string());
    }
    let prompt = build_qa_user_prompt(&meeting, &history, &question);
    let answer = request_chat_text(&settings, &api_key, QA_SYSTEM_PROMPT, &prompt, "会议问答服务")?;
    let message = QaMessage { id: id(), meeting_id, question, answer, created_at: now() };
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("INSERT INTO qa_messages (id, meeting_id, question, answer, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![message.id, message.meeting_id, message.question, message.answer, message.created_at]).map_err(app_error)?;
    Ok(message)
}

#[tauri::command]
fn clear_qa_history(state: State<'_, AppState>, meeting_id: String) -> Result<(), String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("DELETE FROM qa_messages WHERE meeting_id = ?1", params![meeting_id]).map_err(app_error)?;
    Ok(())
}

const WEEKLY_SYSTEM_PROMPT: &str = "你是严谨的中文工作周报助手。根据用户提供的本周会议材料汇总一份个人周报；只依据提供的内容，不要编造事实、数据或日期。输出 Markdown，结构固定为：## 本周概览（3-5 句总结）、## 重点工作进展（按主题分点）、## 关键决策、## 风险与阻塞、## 下周计划（依据各会议未完成的待办）。某节没有内容就写「本周无」。不要输出 Markdown 代码围栏。";

/// 控制送给周报的会议材料长度：每场最多 2500 字，整体最多 16000 字，避免超长会议撑爆上下文
fn clip_chars(text: &str, limit: usize) -> String {
    let clipped: String = text.chars().take(limit).collect();
    if text.chars().count() > limit { format!("{clipped}…") } else { clipped }
}

#[tauri::command]
fn generate_weekly_report(state: State<'_, AppState>, week_start: String) -> Result<String, String> {
    let start = chrono::NaiveDate::parse_from_str(week_start.trim(), "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD".to_string())?;
    let end = start + chrono::Duration::days(6);
    let (settings, api_key) = configured_ai(&state)?;
    let (mut week_meetings, week_tasks) = {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        let start_key = start.format("%Y-%m-%d").to_string();
        let end_key = end.format("%Y-%m-%d").to_string();
        let in_range: Vec<Meeting> = meetings(&connection)?
            .into_iter()
            .filter(|meeting| {
                let day = meeting.started_at.get(..10).unwrap_or("");
                !day.is_empty() && day >= start_key.as_str() && day <= end_key.as_str()
            })
            .filter(|meeting| !meeting.minutes.trim().is_empty() || !meeting.transcript.trim().is_empty())
            .collect();
        let meeting_ids: std::collections::HashSet<String> = in_range.iter().map(|meeting| meeting.id.clone()).collect();
        let open_tasks: Vec<Task> = tasks(&connection)?
            .into_iter()
            .filter(|task| !task.completed)
            .filter(|task| task.source_type.as_deref() == Some("meeting") && task.source_id.as_ref().is_some_and(|source| meeting_ids.contains(source)))
            .collect();
        (in_range, open_tasks)
    };
    if week_meetings.is_empty() {
        return Err(format!("{} 至 {} 这一周没有可用会议（需要有纪要或转写内容）", start.format("%Y-%m-%d"), end.format("%Y-%m-%d")));
    }
    week_meetings.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    let mut budget = 16_000usize;
    let mut sections = Vec::new();
    for meeting in &week_meetings {
        let day = meeting.started_at.get(..10).unwrap_or("未知日期");
        let material = if !meeting.minutes.trim().is_empty() {
            format!("智能纪要：\n{}", meeting.minutes.trim())
        } else {
            format!("转写稿节选（尚未生成纪要）：\n{}", meeting_transcript_text(meeting))
        };
        let decisions_block = if meeting.decisions.trim().is_empty() { String::new() } else { format!("\n关键决策：\n{}", meeting.decisions.trim()) };
        let per_meeting = clip_chars(&format!("{material}{decisions_block}"), 2_500.min(budget));
        budget = budget.saturating_sub(per_meeting.chars().count());
        sections.push(format!("### {}（{}）\n{}", meeting.title, day, per_meeting));
        if budget == 0 { break; }
    }
    let tasks_block = if week_tasks.is_empty() {
        String::new()
    } else {
        let items = week_tasks.iter()
            .map(|task| match &task.due_date { Some(due) if !due.trim().is_empty() => format!("- {}（截止 {}）", task.title, due), _ => format!("- {}", task.title) })
            .collect::<Vec<_>>()
            .join("\n");
        format!("\n\n本周会议未完成的待办：\n{items}")
    };
    let user_prompt = format!(
        "本周范围：{} 至 {}，共 {} 场会议。\n\n{}\n{}",
        start.format("%Y-%m-%d"), end.format("%Y-%m-%d"), week_meetings.len(), sections.join("\n\n"), tasks_block,
    );
    request_chat_text(&settings, &api_key, WEEKLY_SYSTEM_PROMPT, &user_prompt, "周报服务")
}

#[tauri::command]
fn preview_meeting_analysis(state: State<'_, AppState>, meeting_id: String, template: String) -> Result<AnalysisResponse, String> {
    generate_analysis(&state, &meeting_id, &template)
}

fn replace_ai_tasks(connection: &Connection, meeting_id: &str, items: Vec<AnalysisActionItem>) -> Result<Vec<Task>, String> {
    connection.execute("DELETE FROM tasks WHERE source_type = 'meeting' AND source_id = ?1 AND origin = 'ai'", params![meeting_id]).map_err(app_error)?;
    let mut created_tasks = Vec::new();
    for item in items.into_iter().filter(|item| !item.title.trim().is_empty()) {
        let owner = item.assignee.as_deref().map(str::trim).filter(|value| !value.is_empty()).unwrap_or("").to_string();
        let title = match item.assignee.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            Some(assignee) if !item.title.trim().starts_with(assignee) => format!("{assignee}：{}", item.title.trim()),
            _ => item.title.trim().to_string(),
        };
        let task = Task { id: id(), title, source_type: Some("meeting".to_string()), source_id: Some(meeting_id.to_string()), completed: false, due_date: item.due_date.filter(|date| !date.trim().is_empty()), created_at: now(), origin: "ai".to_string(), owner };
        connection.execute("INSERT INTO tasks (id, title, source_type, source_id, completed, due_date, created_at, origin, owner) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![task.id, task.title, task.source_type, task.source_id, task.completed, task.due_date, task.created_at, task.origin, task.owner]).map_err(app_error)?;
        created_tasks.push(task);
    }
    Ok(created_tasks)
}

fn apply_analysis(connection: &Connection, meeting: &Meeting, analysis: AnalysisResponse) -> Result<AnalysisResult, String> {
    if analysis.minutes.trim().is_empty() { return Err("智能纪要没有生成内容".to_string()); }
    // 自动命名：仅当标题仍是默认占位时，按「YYYYMMDD-主题」改名；用户改过的标题不动
    let auto_title = if meeting.title.trim() == "未命名会议" || meeting.title.trim().is_empty() {
        auto_meeting_title(&meeting.started_at, &analysis.theme)
    } else { None };
    if let Some(title) = auto_title {
        connection.execute("UPDATE meetings SET minutes = ?2, decisions = ?3, status = ?4, title = ?5, updated_at = ?6 WHERE id = ?1", params![&meeting.id, analysis.minutes.trim(), analysis.decisions.trim(), "已分析", title, now()]).map_err(app_error)?;
    } else {
        connection.execute("UPDATE meetings SET minutes = ?2, decisions = ?3, status = ?4, updated_at = ?5 WHERE id = ?1", params![&meeting.id, analysis.minutes.trim(), analysis.decisions.trim(), "已分析", now()]).map_err(app_error)?;
    }
    let created_tasks = replace_ai_tasks(connection, &meeting.id, analysis.action_items)?;
    Ok(AnalysisResult { meeting: meeting_by_id(connection, &meeting.id)?, tasks: created_tasks })
}

#[tauri::command]
fn apply_meeting_analysis(state: State<'_, AppState>, meeting_id: String, analysis: AnalysisResponse) -> Result<AnalysisResult, String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    apply_analysis(&connection, &meeting, analysis)
}

#[tauri::command]
fn analyze_meeting(state: State<'_, AppState>, meeting_id: String) -> Result<AnalysisResult, String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    let analysis = generate_analysis(&state, &meeting_id, "general")?;
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    apply_analysis(&connection, &meeting, analysis)
}

#[tauri::command]
fn regenerate_meeting_section(state: State<'_, AppState>, meeting_id: String, template: String, section: String) -> Result<AnalysisResult, String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    let analysis = generate_analysis(&state, &meeting_id, &template)?;
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    let tasks = match section.as_str() {
        "minutes" => {
            connection.execute("UPDATE meetings SET minutes = ?2, status = ?3, updated_at = ?4 WHERE id = ?1", params![meeting_id, analysis.minutes.trim(), "已分析", now()]).map_err(app_error)?;
            Vec::new()
        }
        "decisions" => {
            connection.execute("UPDATE meetings SET decisions = ?2, status = ?3, updated_at = ?4 WHERE id = ?1", params![meeting_id, analysis.decisions.trim(), "已分析", now()]).map_err(app_error)?;
            Vec::new()
        }
        "tasks" => replace_ai_tasks(&connection, &meeting_id, analysis.action_items)?,
        _ => return Err("不支持的纪要分区".to_string()),
    };
    Ok(AnalysisResult { meeting: meeting_by_id(&connection, &meeting.id)?, tasks })
}

/// AI 重命名：根据转写稿（含会前背景）重新提炼主题，无条件按「YYYYMMDD-主题」覆盖当前标题
#[tauri::command]
fn rename_meeting(state: State<'_, AppState>, meeting_id: String) -> Result<Meeting, String> {
    let (settings, api_key) = configured_ai(&state)?;
    let meeting = { let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?; meeting_by_id(&connection, &meeting_id)? };
    if meeting.transcript.trim().is_empty() { return Err("请先完成语音转写，或在原始记录中粘贴会议内容，再来生成名称".to_string()); }
    let analysis = request_analysis(&settings, &api_key, &build_analysis_user_prompt(&meeting, "general"))?;
    let title = auto_meeting_title(&meeting.started_at, &analysis.theme)
        .ok_or_else(|| "智能纪要服务没有给出可用的会议主题，请重试".to_string())?;
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    connection.execute("UPDATE meetings SET title = ?2, updated_at = ?3 WHERE id = ?1", params![meeting_id, title, now()]).map_err(app_error)?;
    meeting_by_id(&connection, &meeting_id)
}

/// 修改某说话人在本会议中的显示名称。name 为空则清除自定义名，回退到默认「发言人 N」。
#[tauri::command]
fn rename_speaker(state: State<'_, AppState>, meeting_id: String, speaker_id: i64, name: String) -> Result<Meeting, String> {
    let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    let mut names: std::collections::HashMap<i64, String> = serde_json::from_str(&meeting.speaker_names).unwrap_or_default();
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        names.remove(&speaker_id);
    } else {
        names.insert(speaker_id, trimmed);
    }
    let json = serde_json::to_string(&names).map_err(app_error)?;
    let now_ts = now();
    connection.execute("UPDATE meetings SET speaker_names = ?2, updated_at = ?3 WHERE id = ?1", params![meeting_id, json, now_ts]).map_err(app_error)?;
    meeting_by_id(&connection, &meeting_id)
}

#[tauri::command]
fn delete_meeting(state: State<'_, AppState>, meeting_id: String) -> Result<(), String> {
    ensure_meeting_recording_idle(&state, &meeting_id)?;
    let mut connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
    let meeting = meeting_by_id(&connection, &meeting_id)?;
    let transaction = connection.transaction().map_err(app_error)?;
    transaction.execute("DELETE FROM tasks WHERE source_type = 'meeting' AND source_id = ?1", params![meeting_id]).map_err(app_error)?;
    transaction.execute("DELETE FROM qa_messages WHERE meeting_id = ?1", params![meeting_id]).map_err(app_error)?;
    let deleted = transaction.execute("DELETE FROM meetings WHERE id = ?1", params![meeting_id]).map_err(app_error)?;
    if deleted == 0 { return Err("找不到要删除的会议".to_string()); }
    transaction.commit().map_err(app_error)?;
    drop(connection);
    remove_meeting_recordings(&state.recordings_dir, &meeting_id, meeting.audio_path.as_deref());
    Ok(())
}

/// 启动时对待办做一次系统级提醒：已逾期或今天到期的未完成待办，每天最多提醒一次（settings 表按天去重）。
/// 应用内另有 toast 提醒；这里走 Windows 通知中心，即使用户没盯着窗口也能看到。失败不阻塞启动。
fn notify_due_tasks(app: &AppHandle, state: &AppState) {
    use tauri_plugin_notification::NotificationExt;
    let today = Local::now().format("%Y-%m-%d").to_string();
    let summary = (|| -> Result<Option<String>, String> {
        let connection = state.connection.lock().map_err(|_| "数据库正被占用，请重试".to_string())?;
        if setting(&connection, "task_notify_date", "")? == today { return Ok(None); }
        let open_tasks: Vec<Task> = tasks(&connection)?.into_iter().filter(|task| !task.completed).collect();
        let overdue = open_tasks.iter().filter(|task| task.due_date.as_deref().map(str::trim).is_some_and(|due| !due.is_empty() && due < today.as_str())).count();
        let due_today = open_tasks.iter().filter(|task| task.due_date.as_deref().map(str::trim) == Some(today.as_str())).count();
        if overdue == 0 && due_today == 0 { return Ok(None); }
        set_setting(&connection, "task_notify_date", &today)?;
        let mut parts = Vec::new();
        if overdue > 0 { parts.push(format!("{overdue} 项已逾期")); }
        if due_today > 0 { parts.push(format!("{due_today} 项今天到期")); }
        Ok(Some(parts.join("，")))
    })();
    match summary {
        Ok(Some(text)) => {
            if let Err(error) = app.notification().builder().title("知记待办提醒").body(format!("你有 {text}，打开知记查看。")).show() {
                eprintln!("发送待办系统通知失败：{error}");
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("统计到期事项失败：{error}"),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .setup(|app| {
            // 全局快捷键：任意应用界面按下 Ctrl+Shift+K 都能唤起并聚焦主窗口
            use tauri_plugin_global_shortcut::ShortcutState;
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcuts(["CommandOrControl+Shift+K"])?
                    .with_handler(|app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(),
            )?;

            let state = open_state(app.handle())?;
            notify_due_tasks(app.handle(), &state);
            app.manage(state);
            setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|_, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                live_session::shutdown_warm_engine();
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace, get_ai_settings, get_local_asr_status, get_speaker_engine_status,
            export_meeting_markdown, export_all_markdown, reveal_recording,
            list_backups, create_backup, restore_backup, open_backups_folder, export_diagnostics,
            get_data_location, reveal_data_folder, schedule_data_relocation, clear_data_relocation_error,
            download_local_asr_model, install_speaker_engine_command, check_live_engine,
            save_ai_settings, clear_ai_api_key,
            get_asr_engine_settings, save_asr_engine_settings, clear_cloud_asr_key, get_recording_settings, save_recording_settings,
            create_meeting, save_meeting, upsert_task, delete_task,
            check_recording_readiness, begin_recording, abort_recording, recover_interrupted_recordings,
            append_recording_chunk, append_live_audio, stop_recording_capture, finalize_recording, get_recording_path,
            import_meeting_audio, transcribe_meeting,
            transcribe_meeting_with_speakers, cancel_processing,
            preview_meeting_analysis, apply_meeting_analysis, analyze_meeting, regenerate_meeting_section,
            rename_meeting, delete_meeting, rename_speaker,
            list_qa_messages, ask_meeting_question, clear_qa_history, generate_weekly_report
        ])
        .run(tauri::generate_context!())
        .expect("启动知记时发生错误");
}

/// 系统托盘：常驻，右键菜单提供「打开知记 / 退出」。配合开机自启，即使窗口被关闭也能一键唤起。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, "open", "打开知记", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    // 复用应用窗口图标作为托盘图标；极少数环境取不到时跳过托盘（不阻塞启动）
    let Some(icon) = app.default_window_icon() else { return Ok(()); };

    TrayIconBuilder::with_id("zhiji-tray")
        .icon(icon.clone())
        .menu(&menu)
        .tooltip("知记")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                    let _ = window.unminimize();
                }
            }
            "quit" => {
                live_session::shutdown_warm_engine();
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}
