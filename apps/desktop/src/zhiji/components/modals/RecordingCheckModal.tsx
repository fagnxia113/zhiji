import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  HardDrive,
  LoaderCircle,
  Mic,
  MonitorSpeaker,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { RecordingBackendReadiness } from "../../types";
import { Dialog } from "../ui/Dialog";

type MicrophoneState = "checking" | "ready" | "error";
type MicrophoneQuality = "listening" | "good" | "quiet" | "clipping";

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError")
    return "没有麦克风权限，请在 Windows 隐私设置中允许知记使用麦克风。";
  if (name === "NotFoundError")
    return "没有找到可用的麦克风，请连接设备后重试。";
  if (name === "NotReadableError")
    return "麦克风正被其他程序独占，请关闭占用程序后重试。";
  return `麦克风检查失败：${String(error)}`;
}

export function RecordingCheckModal({
  captureSystemAudio,
  transcriptionReady,
  transcriptionLabel,
  onClose,
  onOpenSettings,
  onStart,
}: {
  captureSystemAudio: boolean;
  transcriptionReady: boolean;
  transcriptionLabel: string;
  onClose: () => void;
  onOpenSettings: () => void;
  onStart: (
    stream: MediaStream,
    microphoneLabel: string,
    captureSystemAudio: boolean,
  ) => void;
}) {
  const [microphoneState, setMicrophoneState] =
    useState<MicrophoneState>("checking");
  const [microphoneLabel, setMicrophoneLabel] = useState("正在检查麦克风…");
  const [backend, setBackend] = useState<RecordingBackendReadiness | null>(
    null,
  );
  const [level, setLevel] = useState(0);
  const [quality, setQuality] = useState<MicrophoneQuality>("listening");
  const streamRef = useRef<MediaStream | null>(null);
  const handedOffRef = useRef(false);

  useEffect(() => {
    let active = true;
    let animation = 0;
    let audioContext: AudioContext | null = null;

    void invoke<RecordingBackendReadiness>("check_recording_readiness", {
      captureSystem: captureSystemAudio,
    })
      .then((readiness) => {
        if (active) setBackend(readiness);
      })
      .catch(() => {
        if (active)
          setBackend({
            storageReady: false,
            systemAudioReady: false,
            systemAudioMessage: "无法完成电脑声音检查",
          });
      });

    void navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 16000 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        if (!active) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        setMicrophoneLabel(track?.label || "默认麦克风");
        setMicrophoneState(track?.readyState === "live" ? "ready" : "error");

        audioContext = new AudioContext();
        void audioContext.resume();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        let smoothedRms = 0;
        let windowRms = 0;
        let windowFrames = 0;
        let clippingFrames = 0;
        let lastQualityAt = performance.now();
        const updateLevel = () => {
          analyser.getFloatTimeDomainData(samples);
          let energy = 0;
          let peak = 0;
          for (const sample of samples) {
            energy += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
          }
          const rms = Math.sqrt(energy / Math.max(1, samples.length));
          smoothedRms = smoothedRms * 0.82 + rms * 0.18;
          windowRms += rms;
          windowFrames += 1;
          if (peak >= 0.985) clippingFrames += 1;
          setLevel(Math.min(100, Math.round((smoothedRms / 0.12) * 100)));

          const now = performance.now();
          if (now - lastQualityAt >= 1600 && windowFrames > 0) {
            const averageRms = windowRms / windowFrames;
            setQuality(
              clippingFrames >= 3
                ? "clipping"
                : averageRms < 0.008
                  ? "quiet"
                  : "good",
            );
            windowRms = 0;
            windowFrames = 0;
            clippingFrames = 0;
            lastQualityAt = now;
          }
          animation = requestAnimationFrame(updateLevel);
        };
        updateLevel();
      })
      .catch((error) => {
        if (!active) return;
        setMicrophoneState("error");
        setMicrophoneLabel(microphoneError(error));
      });

    return () => {
      active = false;
      cancelAnimationFrame(animation);
      void audioContext?.close();
      if (!handedOffRef.current) {
        streamRef.current?.getTracks().forEach((track) => track.stop());
      }
    };
  }, [captureSystemAudio]);

  const ready = microphoneState === "ready" && backend?.storageReady;
  const microphoneQualityMessage =
    quality === "good"
      ? "音量合适，适合语音识别"
      : quality === "quiet"
        ? "声音偏小，请靠近麦克风或提高输入音量"
        : quality === "clipping"
          ? "声音过大，建议降低输入音量或稍微远离麦克风"
          : "请说一句话，正在判断录音质量";
  const microphoneAttention = quality === "quiet" || quality === "clipping";
  const start = () => {
    const stream = streamRef.current;
    if (!stream || !ready) return;
    handedOffRef.current = true;
    onStart(
      stream,
      microphoneLabel,
      captureSystemAudio && Boolean(backend?.systemAudioReady),
    );
  };

  return (
    <Dialog
      onClose={onClose}
      className="recording-check-modal"
      ariaLabel="录音前检查"
    >
      <div className="recording-check-head">
        <span className="round-icon accent">
          <Mic size={20} />
        </span>
        <div>
          <small>录音前检查</small>
          <h2>确认声音来源</h2>
        </div>
      </div>
      <div className="recording-check-list">
        <div
          className={`recording-check-item ${microphoneState === "ready" && microphoneAttention ? "attention" : microphoneState}`}
        >
          <span>
            <Mic size={18} />
          </span>
          <div>
            <strong>麦克风</strong>
            <small>{microphoneLabel}</small>
            {microphoneState === "ready" && (
              <div className="microphone-meter" aria-label="麦克风音量">
                <i style={{ width: `${Math.max(level, 3)}%` }} />
              </div>
            )}
            {microphoneState === "ready" && (
              <small
                className={`microphone-quality ${microphoneAttention ? "attention" : ""}`}
              >
                {microphoneQualityMessage}
              </small>
            )}
          </div>
          {microphoneState === "checking" ? (
            <LoaderCircle className="spin" size={17} />
          ) : microphoneState === "ready" && !microphoneAttention ? (
            <Check size={17} />
          ) : (
            <AlertTriangle size={17} />
          )}
        </div>
        <div
          className={`recording-check-item ${backend?.storageReady ? "ready" : backend ? "error" : "checking"}`}
        >
          <span>
            <HardDrive size={18} />
          </span>
          <div>
            <strong>本地保存</strong>
            <small>
              {backend
                ? backend.storageReady
                  ? "录音目录可写，录音会分段保存"
                  : "录音目录暂时不可写"
                : "正在检查保存位置…"}
            </small>
          </div>
          {backend?.storageReady ? (
            <Check size={17} />
          ) : backend ? (
            <AlertTriangle size={17} />
          ) : (
            <LoaderCircle className="spin" size={17} />
          )}
        </div>
        <div
          className={`recording-check-item ${!captureSystemAudio || backend?.systemAudioReady ? "ready" : backend ? "attention" : "checking"}`}
        >
          <span>
            <MonitorSpeaker size={18} />
          </span>
          <div>
            <strong>电脑声音</strong>
            <small>
              {captureSystemAudio
                ? backend?.systemAudioMessage || "正在检查默认播放设备…"
                : "未开启，本次只录麦克风"}
            </small>
          </div>
          {!captureSystemAudio || backend?.systemAudioReady ? (
            <Check size={17} />
          ) : backend ? (
            <AlertTriangle size={17} />
          ) : (
            <LoaderCircle className="spin" size={17} />
          )}
        </div>
        <div
          className={`recording-check-item ${transcriptionReady ? "ready" : "attention"}`}
        >
          <span>
            <Mic size={18} />
          </span>
          <div>
            <strong>转写与实时字幕</strong>
            <small>{transcriptionLabel}</small>
          </div>
          {transcriptionReady ? (
            <Check size={17} />
          ) : (
            <AlertTriangle size={17} />
          )}
        </div>
      </div>
      <p className="recording-check-tip">
        请用开会时的距离说一句完整的话。音量偏小或过大时仍可继续，但先调整通常能明显提高识别准确率。
      </p>
      <div className="modal-actions">
        <button
          className="secondary-button"
          onClick={transcriptionReady ? onClose : onOpenSettings}
        >
          {transcriptionReady ? "取消" : "先配置实时字幕"}
        </button>
        <button className="primary-button" disabled={!ready} onClick={start}>
          <Mic size={15} /> 开始录音
        </button>
      </div>
    </Dialog>
  );
}
