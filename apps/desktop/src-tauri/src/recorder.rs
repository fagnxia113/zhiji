// 原生系统声音采集（WASAPI loopback）：仅捕获「电脑正在播放的声音」（线上会议里对方的声音）。
// 麦克风仍由前端 MediaRecorder 负责（已验证稳定），本模块是叠加的、默认关闭的一层；
// 若本模块任何环节失败，不影响麦克风录音。停止时保留独立双轨，并额外生成方便回放的混合音频。
// 捕获循环逐字参照 wasapi 官方 record.rs 示例（loopback 模式用 Direction::Render 取设备、Direction::Capture 初始化）。
use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use wasapi::*;

#[derive(Debug)]
pub struct LiveAudioChunk {
    pub source: &'static str,
    pub audio: Vec<u8>,
}

pub struct SystemCaptureHandle {
    pub stop_flag: Arc<AtomicBool>,
    pub join_handle: Option<JoinHandle<()>>,
    pub error: Arc<Mutex<Option<String>>>,
}

pub struct DualTrackRecording {
    pub playback: PathBuf,
    pub microphone: PathBuf,
    pub system: PathBuf,
}

pub fn dual_track_paths(recordings_dir: &Path, meeting_id: &str) -> (PathBuf, PathBuf) {
    (
        recordings_dir.join(format!("{meeting_id}-mic.wav")),
        recordings_dir.join(format!("{meeting_id}-system.wav")),
    )
}

pub fn remove_dual_track_sidecars(recordings_dir: &Path, meeting_id: &str) {
    let (microphone, system) = dual_track_paths(recordings_dir, meeting_id);
    let _ = fs::remove_file(microphone);
    let _ = fs::remove_file(system);
    let _ = fs::remove_file(recordings_dir.join(format!("{meeting_id}-mic-raw.wav")));
    let _ = fs::remove_file(recordings_dir.join(format!("{meeting_id}-sys.raw")));
}

fn run_ffmpeg(ffmpeg: &Path, args: &[String], stage: &str) -> Result<(), String> {
    let result = std::process::Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if result.status.success() { return Ok(()); }
    Err(format!("{stage}失败：{}", String::from_utf8_lossy(&result.stderr).trim()))
}

// 保留两条来源音轨，并为日常回放生成一份抑制扬声器串音的混合文件。
pub fn prepare_dual_track_audio(
    ffmpeg: &Path,
    recordings_dir: &Path,
    meeting_id: &str,
    mic_webm: &Path,
    sys_raw: &Path,
) -> Result<DualTrackRecording, String> {
    if !ffmpeg.is_file() { return Err("安装包中未找到音频转换组件，请重新安装知记".to_string()); }
    let playback = recordings_dir.join(format!("{meeting_id}.wav"));
    let (microphone, system) = dual_track_paths(recordings_dir, meeting_id);
    let microphone_raw = recordings_dir.join(format!("{meeting_id}-mic-raw.wav"));
    for path in [&playback, &microphone, &system, &microphone_raw] { let _ = fs::remove_file(path); }

    let microphone_args = vec![
        "-y".into(),
        "-i".into(), mic_webm.to_string_lossy().into_owned(),
        "-ar".into(), "16000".into(),
        "-ac".into(), "1".into(),
        "-c:a".into(), "pcm_s16le".into(),
        microphone_raw.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_ffmpeg(ffmpeg, &microphone_args, "麦克风音轨转换") {
        remove_dual_track_sidecars(recordings_dir, meeting_id);
        return Err(error);
    }
    let system_args = vec![
        "-y".into(),
        "-f".into(), "s16le".into(),
        "-ar".into(), "16000".into(),
        "-ac".into(), "1".into(),
        "-i".into(), sys_raw.to_string_lossy().into_owned(),
        "-c:a".into(), "pcm_s16le".into(),
        system.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_ffmpeg(ffmpeg, &system_args, "电脑声音转换") {
        let _ = fs::remove_file(&microphone_raw);
        remove_dual_track_sidecars(recordings_dir, meeting_id);
        return Err(error);
    }

    let clean_microphone_args = vec![
        "-y".into(),
        "-i".into(), microphone_raw.to_string_lossy().into_owned(),
        "-i".into(), system.to_string_lossy().into_owned(),
        "-filter_complex".into(), "[0:a][1:a]sidechaincompress=threshold=0.02:ratio=10:attack=5:release=220[out]".into(),
        "-map".into(), "[out]".into(),
        "-ar".into(), "16000".into(),
        "-ac".into(), "1".into(),
        microphone.to_string_lossy().into_owned(),
    ];
    if run_ffmpeg(ffmpeg, &clean_microphone_args, "麦克风串音抑制").is_err() {
        if let Err(error) = fs::copy(&microphone_raw, &microphone) {
            remove_dual_track_sidecars(recordings_dir, meeting_id);
            return Err(format!("保留麦克风音轨失败：{error}"));
        }
    }
    let _ = fs::remove_file(&microphone_raw);

    let playback_args = vec![
        "-y".into(),
        "-i".into(), microphone.to_string_lossy().into_owned(),
        "-i".into(), system.to_string_lossy().into_owned(),
        "-filter_complex".into(), "amix=inputs=2:normalize=1:dropout_transition=0".into(),
        "-ar".into(), "16000".into(),
        "-ac".into(), "1".into(),
        playback.to_string_lossy().into_owned(),
    ];
    if let Err(error) = run_ffmpeg(ffmpeg, &playback_args, "双轨混音") {
        remove_dual_track_sidecars(recordings_dir, meeting_id);
        return Err(error);
    }
    if fs::metadata(&playback).map_err(|error| error.to_string())?.len() == 0 {
        let _ = fs::remove_file(&playback);
        remove_dual_track_sidecars(recordings_dir, meeting_id);
        return Err("双轨录音文件为空".to_string());
    }
    Ok(DualTrackRecording { playback, microphone, system })
}

/// 在真正开始录音前确认 Windows 默认播放设备可供 loopback 使用。
pub fn check_system_capture() -> Result<(), String> {
    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(|e| format!("枚举音频设备失败：{e}"))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("没有可用的默认播放设备：{e}"))?;
    device
        .get_iaudioclient()
        .map_err(|e| format!("默认播放设备暂不可用：{e}"))?;
    Ok(())
}

/// 启动系统声音（loopback）采集线程，写入 {meeting_id}-sys.raw。失败仅记日志，不影响麦克风。
pub fn begin_system_capture(recordings_dir: &Path, meeting_id: &str, live_sender: Option<crate::live_session::LiveAudioInput>) -> SystemCaptureHandle {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let error = Arc::new(Mutex::new(None));
    let sys_path = recordings_dir.join(format!("{meeting_id}-sys.raw"));
    let flag = stop_flag.clone();
    let error_state = error.clone();
    let handle = thread::spawn(move || {
        if let Err(err) = capture_loop(sys_path, flag, live_sender) {
            eprintln!("系统声音采集失败（不影响麦克风录音）：{err}");
            if let Ok(mut value) = error_state.lock() {
                *value = Some(err);
            }
        }
    });
    SystemCaptureHandle {
        stop_flag,
        join_handle: Some(handle),
        error,
    }
}

fn capture_loop(temp_path: PathBuf, stop_flag: Arc<AtomicBool>, live_sender: Option<crate::live_session::LiveAudioInput>) -> Result<(), String> {
    let _ = wasapi::initialize_mta();
    let enumerator = DeviceEnumerator::new().map_err(|e| format!("枚举音频设备失败：{e}"))?;
    // loopback：在默认播放设备上以 Capture 初始化，即捕获系统输出声音
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("获取默认播放设备失败：{e}"))?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|e| format!("获取音频客户端失败：{e}"))?;
    // 16kHz 单声道 16-bit 整数 PCM（与转写管线目标一致，ffmpeg 无需再重采样）
    let desired_format = WaveFormat::new(16, 16, &SampleType::Int, 16000, 1, None);
    let (_, min_time) = audio_client
        .get_device_period()
        .map_err(|e| format!("获取设备周期失败：{e}"))?;
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_time,
    };
    audio_client
        .initialize_client(&desired_format, &Direction::Capture, &mode)
        .map_err(|e| format!("初始化 loopback 失败：{e}"))?;
    let h_event = audio_client
        .set_get_eventhandle()
        .map_err(|e| format!("获取音频事件失败：{e}"))?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|e| format!("获取采集客户端失败：{e}"))?;
    let mut file = fs::File::create(&temp_path)
        .map_err(|e| format!("创建系统声音临时文件失败：{e}"))?;
    audio_client
        .start_stream()
        .map_err(|e| format!("启动系统声音采集失败：{e}"))?;
    let mut queue: VecDeque<u8> = VecDeque::new();
    let mut live_pending: Vec<u8> = Vec::new();
    const LIVE_CHUNK_BYTES: usize = 19_200; // 16kHz * 0.6s * 16-bit mono
    loop {
        capture_client
            .read_from_device_to_deque(&mut queue)
            .map_err(|e| format!("读取系统声音失败：{e}"))?;
        if !queue.is_empty() {
            let chunk: Vec<u8> = queue.drain(..).collect();
            file.write_all(&chunk)
                .map_err(|e| format!("写入系统声音失败：{e}"))?;
            if let Some(sender) = &live_sender {
                live_pending.extend_from_slice(&chunk);
                while live_pending.len() >= LIVE_CHUNK_BYTES {
                    let remainder = live_pending.split_off(LIVE_CHUNK_BYTES);
                    let audio = std::mem::replace(&mut live_pending, remainder);
                    let _ = sender.send(LiveAudioChunk { source: "system", audio });
                }
            }
        }
        if stop_flag.load(Ordering::Relaxed) {
            if let Some(sender) = &live_sender {
                if !live_pending.is_empty() {
                    let _ = sender.send(LiveAudioChunk { source: "system", audio: std::mem::take(&mut live_pending) });
                }
            }
            audio_client.stop_stream().ok();
            break;
        }
        if h_event.wait_for_event(1000).is_err() {
            audio_client.stop_stream().ok();
            break;
        }
    }
    Ok(())
}

/// 停止采集线程并返回 sys.raw 路径（若存在）。调用方负责混音与清理。
pub fn finalize_system_capture(
    handle: SystemCaptureHandle,
    recordings_dir: &Path,
    meeting_id: &str,
) -> Result<PathBuf, String> {
    handle.stop_flag.store(true, Ordering::Relaxed);
    if let Some(jh) = handle.join_handle {
        jh.join().map_err(|_| "系统声音采集线程异常结束".to_string())?;
    }
    let sys_raw = recordings_dir.join(format!("{meeting_id}-sys.raw"));
    let error_message = handle.error.lock().ok().and_then(|error| error.clone());
    if let Some(message) = error_message {
        let _ = fs::remove_file(&sys_raw);
        return Err(message);
    }
    let size = fs::metadata(&sys_raw)
        .map_err(|_| "没有生成系统声音轨道".to_string())?
        .len();
    if size == 0 {
        let _ = fs::remove_file(&sys_raw);
        return Err("系统声音轨道为空，请确认电脑正在播放声音".to_string());
    }
    Ok(sys_raw)
}
