use std::{
    collections::{HashSet, VecDeque},
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex, OnceLock, mpsc::{self, Receiver, Sender, SyncSender, TryRecvError, TrySendError}},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

use crate::{
    CREATE_NO_WINDOW, SpeakerSegment, live_asr_script, speaker_engine_installed,
    speaker_models_ready, speaker_python,
};
use crate::recorder::LiveAudioChunk;

const ENGINE_INPUT_CAPACITY: usize = 12;
// 同时保留麦克风和系统声音最多 200 秒，覆盖完整模型启动超时并留出余量。
const PRE_ROLL_MAX_BYTES: usize = 12_800_000;
const MAX_RESTARTS: u8 = 1;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
const FINISH_TIMEOUT: Duration = Duration::from_secs(210);

enum ControlMessage { Finish, Abort }
enum EngineControl { Configure(String), Finish, SelfTest, Abort }

#[derive(Default)]
struct WarmEngineSlot {
    engine: Option<EngineProcess>,
    starting: bool,
    disabled: bool,
}

static WARM_ENGINE: OnceLock<Mutex<WarmEngineSlot>> = OnceLock::new();

fn warm_engine_slot() -> &'static Mutex<WarmEngineSlot> {
    WARM_ENGINE.get_or_init(|| Mutex::new(WarmEngineSlot::default()))
}

pub fn warm_engine(engine_dir: PathBuf, models_dir: PathBuf) {
    if !speaker_engine_installed(&engine_dir) || !speaker_models_ready(&models_dir) { return; }
    {
        let Ok(mut slot) = warm_engine_slot().lock() else { return; };
        slot.disabled = false;
        if slot.starting || slot.engine.is_some() { return; }
        slot.starting = true;
    }
    thread::spawn(move || {
        let mut engine = match EngineProcess::spawn(&engine_dir, &models_dir, "", 0) {
            Ok(engine) => engine,
            Err(_) => {
                if let Ok(mut slot) = warm_engine_slot().lock() { slot.starting = false; }
                return;
            }
        };
        let ready = engine.wait_for_event("ready", STARTUP_TIMEOUT);
        let Ok(mut slot) = warm_engine_slot().lock() else {
            engine.stop();
            return;
        };
        slot.starting = false;
        if ready.is_ok() && !slot.disabled && slot.engine.is_none() { slot.engine = Some(engine); }
        else { engine.stop(); }
    });
}

pub fn shutdown_warm_engine() {
    let Ok(mut slot) = warm_engine_slot().lock() else { return; };
    slot.disabled = true;
    if let Some(mut engine) = slot.engine.take() { engine.stop(); }
}

pub fn check_engine(engine_dir: PathBuf, models_dir: PathBuf) -> Result<(), String> {
    if let Ok(mut slot) = warm_engine_slot().lock() { slot.disabled = false; }
    let mut engine = match take_warm_engine() {
        Some(engine) => engine,
        None => EngineProcess::spawn(&engine_dir, &models_dir, "", 0)?,
    };
    let result = (|| {
        engine.wait_for_event("ready", STARTUP_TIMEOUT)?;
        engine.request_self_test()?;
        engine.wait_for_event("self-test-passed", Duration::from_secs(240))
    })();
    if result.is_ok() { store_warm_engine(engine); }
    else { engine.stop(); }
    result
}

fn take_warm_engine() -> Option<EngineProcess> {
    let mut engine = warm_engine_slot().lock().ok()?.engine.take()?;
    match engine.exit_status() {
        Ok(None) => Some(engine),
        _ => {
            engine.stop();
            None
        }
    }
}

fn store_warm_engine(mut engine: EngineProcess) {
    engine.ready = true;
    let Ok(mut slot) = warm_engine_slot().lock() else {
        engine.stop();
        return;
    };
    if slot.disabled || slot.engine.is_some() { engine.stop(); }
    else { slot.engine = Some(engine); }
}

#[derive(Clone)]
pub struct LiveAudioInput {
    sender: Sender<LiveAudioChunk>,
}

impl LiveAudioInput {
    pub fn send(&self, chunk: LiveAudioChunk) -> Result<(), String> {
        self.sender.send(chunk).map_err(|_| "实时字幕会话已经结束".to_string())
    }
}

#[derive(Default)]
pub struct LiveResult {
    pub transcript: String,
    pub segments: Vec<SpeakerSegment>,
    pub warning: Option<String>,
}

pub struct LiveSession {
    input: LiveAudioInput,
    control: Sender<ControlMessage>,
    worker: Option<JoinHandle<LiveResult>>,
}

impl LiveSession {
    pub fn start(
        app: AppHandle,
        meeting_id: String,
        engine_dir: PathBuf,
        models_dir: PathBuf,
        hotwords: String,
    ) -> Result<Self, String> {
        if let Ok(mut slot) = warm_engine_slot().lock() { slot.disabled = false; }
        if !speaker_engine_installed(&engine_dir) || !speaker_models_ready(&models_dir) {
            return Err("请先安装本地实时转写引擎".to_string());
        }
        // 第一次进程在当前调用中启动，路径或运行时错误可立即反馈给录音准备页。
        let mut engine = match take_warm_engine() {
            Some(engine) => engine,
            None => EngineProcess::spawn(&engine_dir, &models_dir, &hotwords, 0)?,
        };
        // 预热进程启动时没有会议上下文；每场会议开始前重新注入标题、背景与自定义热词。
        engine.configure(hotwords.clone())?;
        let (audio_sender, audio_receiver) = mpsc::channel();
        let (control, control_receiver) = mpsc::channel();
        let input = LiveAudioInput { sender: audio_sender };
        let worker = thread::spawn(move || {
            run_controller(app, meeting_id, engine_dir, models_dir, hotwords, audio_receiver, control_receiver, engine)
        });
        Ok(Self { input, control, worker: Some(worker) })
    }

    pub fn audio_input(&self) -> LiveAudioInput { self.input.clone() }

    pub fn send_microphone(&self, audio: Vec<u8>) -> Result<(), String> {
        self.input.send(LiveAudioChunk { source: "microphone", audio })
    }

    pub fn finish(mut self) -> LiveResult {
        let _ = self.control.send(ControlMessage::Finish);
        self.worker.take().and_then(|worker| worker.join().ok()).unwrap_or_else(|| LiveResult {
            warning: Some("实时字幕控制器未能返回结果，已保留完整录音供会后校正".to_string()),
            ..LiveResult::default()
        })
    }

    pub fn abort(mut self) {
        let _ = self.control.send(ControlMessage::Abort);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

impl Drop for LiveSession {
    fn drop(&mut self) {
        if self.worker.is_none() { return; }
        let _ = self.control.send(ControlMessage::Abort);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

struct EngineProcess {
    child: Child,
    input: SyncSender<LiveAudioChunk>,
    control: Sender<EngineControl>,
    events: Receiver<Value>,
    last_error: Arc<Mutex<String>>,
    ready: bool,
    events_closed: bool,
    started_at: Instant,
}

impl EngineProcess {
    fn spawn(engine_dir: &PathBuf, models_dir: &PathBuf, hotwords: &str, attempt: u8) -> Result<Self, String> {
        let python = speaker_python(engine_dir);
        let script = live_asr_script(engine_dir);
        let mut command = Command::new(&python);
        command
            .arg(script)
            .arg("--model-cache").arg(models_dir)
            .arg("--hotwords").arg(hotwords)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(engine_dir)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONFAULTHANDLER", "1")
            .env("MODELSCOPE_CACHE", models_dir)
            .env("HF_HOME", models_dir)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1")
            .env("OMP_NUM_THREADS", "2")
            .env("MKL_NUM_THREADS", "2");
        #[cfg(windows)]
        std::os::windows::process::CommandExt::creation_flags(&mut command, CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|error| format!("无法启动本地实时转写：{error}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "无法连接实时转写输入".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "无法连接实时转写输出".to_string())?;
        let stderr = child.stderr.take().ok_or_else(|| "无法读取实时转写诊断信息".to_string())?;
        let (event_sender, events) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(payload) = serde_json::from_str::<Value>(&line) {
                    if event_sender.send(payload).is_err() { break; }
                }
            }
        });
        let (input, input_receiver) = mpsc::sync_channel::<LiveAudioChunk>(ENGINE_INPUT_CAPACITY);
        let (control, control_receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut stdin = stdin;
            loop {
                match control_receiver.try_recv() {
                    Ok(EngineControl::Configure(hotwords)) => {
                        let _ = writeln!(stdin, "{}", json!({ "type": "configure", "hotwords": hotwords }));
                        let _ = stdin.flush();
                    }
                    Ok(EngineControl::Finish) => {
                        // 控制消息优先于普通音频；结束前必须把已经进入写入队列的尾音全部送完。
                        while let Ok(chunk) = input_receiver.try_recv() {
                            let message = json!({ "type": "audio", "source": chunk.source, "audio": STANDARD.encode(chunk.audio) });
                            if writeln!(stdin, "{message}").and_then(|_| stdin.flush()).is_err() { break; }
                        }
                        let _ = writeln!(stdin, "{}", json!({ "type": "finish" }));
                        let _ = stdin.flush();
                    }
                    Ok(EngineControl::SelfTest) => {
                        let _ = writeln!(stdin, "{}", json!({ "type": "self-test" }));
                        let _ = stdin.flush();
                    }
                    Ok(EngineControl::Abort) | Err(TryRecvError::Disconnected) => break,
                    Err(TryRecvError::Empty) => {}
                }
                match input_receiver.recv_timeout(Duration::from_millis(20)) {
                    Ok(chunk) => {
                        let message = json!({ "type": "audio", "source": chunk.source, "audio": STANDARD.encode(chunk.audio) });
                        if writeln!(stdin, "{message}").and_then(|_| stdin.flush()).is_err() { break; }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
            }
        });
        let last_error = Arc::new(Mutex::new(String::new()));
        let error_state = last_error.clone();
        let diagnostic_path = engine_dir.join("live-asr-last.log");
        if attempt == 0 && fs::metadata(&diagnostic_path).is_ok_and(|metadata| metadata.len() > 1_048_576) {
            let _ = fs::remove_file(&diagnostic_path);
        }
        thread::spawn(move || {
            let mut diagnostics = fs::OpenOptions::new().create(true).append(true).open(diagnostic_path).ok();
            if let Some(file) = diagnostics.as_mut() {
                let _ = writeln!(file, "\n===== attempt {attempt} {} =====", chrono::Local::now().to_rfc3339());
            }
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if let Some(file) = diagnostics.as_mut() {
                    let _ = writeln!(file, "{trimmed}");
                    let _ = file.flush();
                }
                let normalized = trimmed.to_ascii_lowercase();
                if ["traceback", "error", "exception", "fatal", "failed", "fault"].iter().any(|value| normalized.contains(value)) {
                    if let Ok(mut current) = error_state.lock() { *current = trimmed.to_string(); }
                }
            }
        });
        Ok(Self { child, input, control, events, last_error, ready: false, events_closed: false, started_at: Instant::now() })
    }

    fn write_audio(&mut self, chunk: LiveAudioChunk) -> Result<Option<LiveAudioChunk>, String> {
        match self.input.try_send(chunk) {
            Ok(()) => Ok(None),
            Err(TrySendError::Full(chunk)) => Ok(Some(chunk)),
            Err(TrySendError::Disconnected(_)) => Err("实时音频写入线程已经结束".to_string()),
        }
    }

    fn write_audio_final(&mut self, chunk: LiveAudioChunk) -> Result<(), String> {
        self.input.send(chunk).map_err(|_| "实时音频尾段写入线程已经结束".to_string())
    }

    fn request_finish(&mut self) -> Result<(), String> {
        self.control.send(EngineControl::Finish).map_err(|_| "无法通知实时模型结束".to_string())
    }

    fn configure(&mut self, hotwords: String) -> Result<(), String> {
        self.control.send(EngineControl::Configure(hotwords)).map_err(|_| "无法配置实时模型热词".to_string())
    }

    fn request_self_test(&mut self) -> Result<(), String> {
        self.control.send(EngineControl::SelfTest).map_err(|_| "无法启动实时模型自检".to_string())
    }

    fn wait_for_event(&mut self, expected: &str, timeout: Duration) -> Result<(), String> {
        if expected == "ready" && self.ready { return Ok(()); }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match self.events.recv_timeout(Duration::from_millis(100)) {
                Ok(payload) => {
                    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
                    if event_type == "ready" { self.ready = true; }
                    if event_type == expected || (expected == "ready" && self.ready) { return Ok(()); }
                    if event_type == "warning" {
                        let message = payload.get("message").and_then(Value::as_str).unwrap_or("实时模型自检失败");
                        return Err(message.to_string());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let status = self.child.try_wait().ok().flatten();
                    return Err(self.exit_detail(status, "实时模型意外结束"));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
                return Err(self.exit_detail(Some(status), "实时模型意外结束"));
            }
        }
        Err(format!("等待实时模型事件 {expected} 超时"))
    }

    fn stop(&mut self) {
        let _ = self.control.send(EngineControl::Abort);
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn exit_status(&mut self) -> Result<Option<ExitStatus>, String> { self.child.try_wait().map_err(|error| error.to_string()) }

    fn exit_detail(&self, status: Option<ExitStatus>, fallback: &str) -> String {
        let diagnostic = self.last_error.lock().ok().map(|value| value.clone()).unwrap_or_default();
        if !diagnostic.is_empty() { return diagnostic; }
        if let Some(status) = status {
            return status.code().map_or_else(|| "进程被系统终止".to_string(), |code| format!("退出码 {code}"));
        }
        fallback.to_string()
    }
}

fn emit_live_event(
    app: &AppHandle,
    meeting_id: &str,
    session_id: &str,
    sequence: &mut u64,
    mut event: Value,
) {
    *sequence = sequence.saturating_add(1);
    if let Some(object) = event.as_object_mut() {
        object.insert("sessionId".to_string(), Value::String(session_id.to_string()));
        object.insert("sequence".to_string(), Value::from(*sequence));
    }
    let _ = app.emit("zhiji://live-transcript", json!({
        "meetingId": meeting_id,
        "event": event
    }));
}

fn emit_phase(
    app: &AppHandle,
    meeting_id: &str,
    session_id: &str,
    sequence: &mut u64,
    event_type: &str,
    message: &str,
) {
    emit_live_event(
        app,
        meeting_id,
        session_id,
        sequence,
        json!({ "type": event_type, "message": message }),
    );
}

fn append_controller_diagnostic(engine_dir: &PathBuf, message: &str) {
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(engine_dir.join("live-asr-last.log"))
    {
        let _ = writeln!(file, "[controller {}] {message}", chrono::Local::now().to_rfc3339());
    }
}

fn run_controller(
    app: AppHandle,
    meeting_id: String,
    engine_dir: PathBuf,
    models_dir: PathBuf,
    hotwords: String,
    audio: Receiver<LiveAudioChunk>,
    controls: Receiver<ControlMessage>,
    mut engine: EngineProcess,
) -> LiveResult {
    let mut result = LiveResult::default();
    let mut restarts = 0_u8;
    let mut degraded = false;
    let mut finishing = false;
    let mut finish_deadline: Option<Instant> = None;
    let mut pre_roll = VecDeque::<LiveAudioChunk>::new();
    let mut pre_roll_bytes = 0_usize;
    let mut overflow_warned = false;
    let session_id = format!("{meeting_id}-{}", chrono::Local::now().timestamp_millis());
    let mut event_sequence = 0_u64;
    let mut finalized_utterances = HashSet::<String>::new();
    append_controller_diagnostic(&engine_dir, "会话启动");
    if engine.ready { emit_phase(&app, &meeting_id, &session_id, &mut event_sequence, "ready", "实时字幕已就绪"); }
    else { emit_phase(&app, &meeting_id, &session_id, &mut event_sequence, "starting", "正在启动本地实时字幕"); }

    loop {
        loop {
            match engine.events.try_recv() {
                Ok(mut payload) => {
                    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("").to_string();
                    if let Some(utterance_id) = payload
                        .get("utteranceId")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                    {
                        if let Some(object) = payload.as_object_mut() {
                            object.insert(
                                "utteranceId".to_string(),
                                Value::String(format!("{restarts}:{utterance_id}")),
                            );
                        }
                    }
                    match event_type.as_str() {
                        "ready" => {
                            engine.ready = true;
                            result.warning = None;
                            append_controller_diagnostic(&engine_dir, "模型就绪");
                            emit_phase(&app, &meeting_id, &session_id, &mut event_sequence, "ready", "实时字幕已就绪");
                        }
                        "final" => {
                            let text = payload.get("text").and_then(Value::as_str).unwrap_or("").trim();
                            if !text.is_empty() {
                                let source = payload.get("source").and_then(Value::as_str).unwrap_or("microphone");
                                let start_ms = payload.get("startMs").and_then(Value::as_i64).unwrap_or(0);
                                let end_ms = payload.get("endMs").and_then(Value::as_i64).unwrap_or(0);
                                let utterance_id = payload
                                    .get("utteranceId")
                                    .and_then(Value::as_str)
                                    .filter(|value| !value.is_empty())
                                    .map(str::to_string)
                                    .unwrap_or_else(|| format!("{source}:{start_ms}:{end_ms}:{text}"));
                                if finalized_utterances.insert(utterance_id) {
                                    result.segments.push(SpeakerSegment {
                                        speaker: if source == "system" { "会议声音".to_string() } else { "我".to_string() },
                                        speaker_id: if source == "system" { 1 } else { 0 },
                                        start_ms,
                                        end_ms,
                                        text: text.to_string(),
                                    });
                                    result.segments.sort_by_key(|segment| segment.start_ms);
                                }
                            }
                        }
                        "warning" => result.warning = payload.get("message").and_then(Value::as_str).map(str::to_string),
                        "quality-warning" | "quality-unavailable" => {
                            if let Some(message) = payload.get("message").and_then(Value::as_str) {
                                append_controller_diagnostic(&engine_dir, message);
                            }
                        }
                        "finished" => {
                            result.transcript = result.segments.iter().map(|segment| format!("【{}】{}", segment.speaker, segment.text)).collect::<Vec<_>>().join("\n");
                            append_controller_diagnostic(&engine_dir, "会话正常结束");
                            emit_phase(&app, &meeting_id, &session_id, &mut event_sequence, "finished", "实时字幕已结束");
                            store_warm_engine(engine);
                            return result;
                        }
                        _ => {}
                    }
                    emit_live_event(&app, &meeting_id, &session_id, &mut event_sequence, payload);
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    engine.events_closed = true;
                    break;
                }
            }
        }

        match controls.try_recv() {
            Ok(ControlMessage::Finish) => {
                if degraded { return result; }
                finishing = true;
                finish_deadline = Some(Instant::now() + FINISH_TIMEOUT);
                // 前端的 IPC 已完成不代表两层有界队列已经排空；先按时间顺序冲刷尾音，再发送 finish。
                while let Some(chunk) = pre_roll.pop_front() {
                    pre_roll_bytes = pre_roll_bytes.saturating_sub(chunk.audio.len());
                    if let Err(error) = engine.write_audio_final(chunk) {
                        result.warning = Some(format!("{error}，已保留完整录音供会后校正"));
                        break;
                    }
                }
                for chunk in audio.try_iter() {
                    if let Err(error) = engine.write_audio_final(chunk) {
                        result.warning = Some(format!("{error}，已保留完整录音供会后校正"));
                        break;
                    }
                }
                if let Err(error) = engine.request_finish() {
                    result.warning = Some(format!("{error}，已保留完整录音供会后校正"));
                    engine.stop();
                    return result;
                }
            }
            Ok(ControlMessage::Abort) | Err(TryRecvError::Disconnected) => {
                engine.stop();
                return LiveResult::default();
            }
            Err(TryRecvError::Empty) => {}
        }

        if engine.ready && !degraded && !finishing {
            for _ in 0..2 {
                let Some(chunk) = pre_roll.pop_front() else { break; };
                pre_roll_bytes = pre_roll_bytes.saturating_sub(chunk.audio.len());
                match engine.write_audio(chunk) {
                    Ok(None) => {}
                    Ok(Some(chunk)) => {
                        pre_roll_bytes += chunk.audio.len();
                        pre_roll.push_front(chunk);
                        break;
                    }
                    Err(error) => {
                        recover_or_degrade(&app, &meeting_id, &session_id, &mut event_sequence, &engine_dir, &models_dir, &hotwords, &mut engine, &mut restarts, &mut degraded, &mut result, &error);
                        break;
                    }
                }
            }
        }

        match audio.recv_timeout(Duration::from_millis(20)) {
            Ok(chunk) => {
                if !degraded && !finishing && !engine.ready {
                    pre_roll_bytes += chunk.audio.len();
                    pre_roll.push_back(chunk);
                    while pre_roll_bytes > PRE_ROLL_MAX_BYTES {
                        if let Some(discarded) = pre_roll.pop_front() {
                            pre_roll_bytes = pre_roll_bytes.saturating_sub(discarded.audio.len());
                            if !overflow_warned {
                                overflow_warned = true;
                                result.warning = Some("实时模型启动时间过长，最早一小段字幕可能需要会后补齐；完整录音未受影响".to_string());
                                emit_phase(&app, &meeting_id, &session_id, &mut event_sequence, "warning", "实时模型启动时间过长，最早一小段字幕可能需要会后补齐；完整录音未受影响");
                            }
                        } else {
                            break;
                        }
                    }
                } else if !degraded && !finishing && engine.ready && !pre_roll.is_empty() {
                    pre_roll_bytes += chunk.audio.len();
                    pre_roll.push_back(chunk);
                    while pre_roll_bytes > PRE_ROLL_MAX_BYTES {
                        if let Some(discarded) = pre_roll.pop_front() {
                            pre_roll_bytes = pre_roll_bytes.saturating_sub(discarded.audio.len());
                            if !overflow_warned {
                                overflow_warned = true;
                                result.warning = Some("实时字幕处理持续落后，最早一小段字幕可能需要会后补齐；完整录音未受影响".to_string());
                                emit_phase(&app, &meeting_id, &session_id, &mut event_sequence, "warning", "实时字幕处理持续落后，最早一小段字幕可能需要会后补齐；完整录音未受影响");
                            }
                        } else {
                            break;
                        }
                    }
                } else if !degraded && !finishing && engine.ready {
                    match engine.write_audio(chunk) {
                        Ok(None) => {}
                        Ok(Some(chunk)) => {
                            pre_roll_bytes += chunk.audio.len();
                            pre_roll.push_back(chunk);
                        }
                        Err(error) => {
                            recover_or_degrade(&app, &meeting_id, &session_id, &mut event_sequence, &engine_dir, &models_dir, &hotwords, &mut engine, &mut restarts, &mut degraded, &mut result, &error);
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) if !finishing => {
                engine.stop();
                return result;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) | Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        if finishing && finish_deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            result.warning = Some("实时字幕结束超时，已保留完整录音供会后校正".to_string());
            engine.stop();
            return result;
        }
        if !degraded && !engine.ready && engine.started_at.elapsed() >= STARTUP_TIMEOUT {
            recover_or_degrade(&app, &meeting_id, &session_id, &mut event_sequence, &engine_dir, &models_dir, &hotwords, &mut engine, &mut restarts, &mut degraded, &mut result, "模型启动超时");
        }
        if !degraded {
            match engine.exit_status() {
                Ok(Some(status)) if !finishing => {
                    let detail = engine.exit_detail(Some(status), "实时模型意外结束");
                    recover_or_degrade(&app, &meeting_id, &session_id, &mut event_sequence, &engine_dir, &models_dir, &hotwords, &mut engine, &mut restarts, &mut degraded, &mut result, &detail);
                }
                // stdout 读取线程可能比子进程状态晚几毫秒送出最后一个 final / finished。
                // 等事件通道真正排空后再返回，避免丢掉最后一句字幕。
                Ok(Some(_)) if finishing && engine.events_closed => return result,
                Ok(Some(_)) if finishing => {}
                Err(error) => {
                    recover_or_degrade(&app, &meeting_id, &session_id, &mut event_sequence, &engine_dir, &models_dir, &hotwords, &mut engine, &mut restarts, &mut degraded, &mut result, &error);
                }
                _ => {}
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn recover_or_degrade(
    app: &AppHandle,
    meeting_id: &str,
    session_id: &str,
    event_sequence: &mut u64,
    engine_dir: &PathBuf,
    models_dir: &PathBuf,
    hotwords: &str,
    engine: &mut EngineProcess,
    restarts: &mut u8,
    degraded: &mut bool,
    result: &mut LiveResult,
    reason: &str,
) {
    append_controller_diagnostic(engine_dir, &format!("引擎异常：{reason}"));
    engine.stop();
    if *restarts < MAX_RESTARTS {
        *restarts += 1;
        append_controller_diagnostic(engine_dir, "尝试自动恢复（1/1）");
        emit_phase(app, meeting_id, session_id, event_sequence, "restarting", "实时字幕正在自动恢复");
        match EngineProcess::spawn(engine_dir, models_dir, hotwords, *restarts) {
            Ok(replacement) => { *engine = replacement; return; }
            Err(error) => result.warning = Some(format!("实时字幕自动恢复失败：{error}")),
        }
    } else {
        result.warning = Some(format!("实时字幕两次运行失败：{reason}"));
    }
    *degraded = true;
    append_controller_diagnostic(engine_dir, "自动恢复未成功，切换会后校正");
    let message = format!("{}。本场录音继续保存，结束后自动完成完整转写。", result.warning.as_deref().unwrap_or("实时字幕不可用"));
    emit_phase(app, meeting_id, session_id, event_sequence, "degraded", &message);
}
