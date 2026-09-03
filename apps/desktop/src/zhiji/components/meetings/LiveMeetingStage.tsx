import { ArrowDown, Flag, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LiveTranscriptState, Meeting, RecordingSessionStatus } from "../../types";

type LiveMeetingStageProps = {
  meeting: Meeting;
  recordingSeconds: number;
  recordingSession: RecordingSessionStatus | null;
  finalizing: boolean;
  liveTranscript: LiveTranscriptState;
  formatDuration: (seconds: number) => string;
  onChange: (meeting: Meeting) => void;
  onStop: () => void;
};

export function LiveMeetingStage({
  meeting,
  recordingSeconds,
  recordingSession,
  finalizing,
  liveTranscript,
  formatDuration,
  onChange,
  onStop,
}: LiveMeetingStageProps) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  // 静音检测：电平持续低于阈值时提示可能没开麦，防录空。仅实时字幕运行中判定，避免启动期误报。
  const SILENCE_LEVEL = 0.02;
  const SILENCE_WARN_SECONDS = 20;
  const lastActiveAtRef = useRef<number>(Date.now());
  const [silentFor, setSilentFor] = useState(0);

  useEffect(() => {
    const element = transcriptRef.current;
    if (element && followLatest) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [followLatest, liveTranscript.segments.length, liveTranscript.partial]);

  const liveReady = recordingSession?.liveEnabled && liveTranscript.phase === "running";

  useEffect(() => {
    const active = liveTranscript.microphoneLevel > SILENCE_LEVEL || liveTranscript.systemLevel > SILENCE_LEVEL;
    if (active) lastActiveAtRef.current = Date.now();
  }, [liveTranscript.microphoneLevel, liveTranscript.systemLevel]);

  useEffect(() => {
    if (!liveReady || finalizing) {
      lastActiveAtRef.current = Date.now();
      setSilentFor(0);
      return;
    }
    const timer = window.setInterval(() => {
      setSilentFor(Math.floor((Date.now() - lastActiveAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [liveReady, finalizing]);

  const showSilenceWarning = liveReady && !finalizing && silentFor >= SILENCE_WARN_SECONDS;
  const qualityLabel = liveTranscript.qualityState === "ready"
    ? liveTranscript.refiningCount > 0 ? `高精度校正中（${liveTranscript.refiningCount}）` : "双遍高精度"
    : liveTranscript.qualityState === "fallback"
      ? "实时初稿"
      : "精校模型加载中";
  const stateLabel = !recordingSession?.liveEnabled
    ? "会后转写"
    : liveTranscript.phase === "degraded"
      ? "已切换会后校正"
      : liveTranscript.phase === "recovering"
        ? "自动恢复中"
        : liveTranscript.phase === "starting" || !liveTranscript.ready
          ? "模型启动中"
          : liveTranscript.listeningSources.length === 0
            ? "等待声音"
            : liveTranscript.partial || liveTranscript.segments.length
              ? "字幕生成中"
              : "正在聆听";

  const markMoment = () => {
    const marker = `[重点 ${formatDuration(recordingSeconds)}] `;
    const prefix = meeting.notes && !meeting.notes.endsWith("\n") ? "\n" : "";
    onChange({ ...meeting, notes: `${meeting.notes}${prefix}${marker}` });
    requestAnimationFrame(() => {
      const input = notesRef.current;
      if (!input) return;
      input.focus();
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
    });
  };

  return (
    <div className="live-stage">
      <header className="live-stage-toolbar">
        <div className="live-session-identity">
          <span className="recording-wave" aria-hidden="true">
            <span /><span /><span /><span /><span />
          </span>
          <div>
            <strong>{finalizing ? "正在安全保存录音" : recordingSession ? "会议进行中" : "正在启动录音"}</strong>
            <small>
              {recordingSession?.captureSystemAudio
                ? `麦克风 + 电脑声音 · ${recordingSession.microphoneLabel}`
                : `仅麦克风 · ${recordingSession?.microphoneLabel || "默认麦克风"}`}
            </small>
          </div>
          <time>{formatDuration(recordingSeconds)}</time>
        </div>
        <div className="live-stage-actions">
          <button className="secondary-button compact-button" onClick={markMoment} disabled={finalizing || !recordingSession}>
            <Flag size={14} />标记重点
          </button>
          <button className="danger-button compact-button" onClick={onStop} disabled={finalizing || !recordingSession}>
            <Square size={13} fill="currentColor" />{finalizing ? "正在保存" : "结束并转写"}
          </button>
        </div>
      </header>

      <div className="live-stage-grid">
        <section className="live-transcript-pane">
          <div className="pane-head live-pane-head">
            <div>
              <h3>实时字幕</h3>
              <small>先实时出字，每句停顿后在本机结合会议热词自动精校。</small>
            </div>
            <div className="live-quality-status">
              <small>{qualityLabel}</small>
              <span className={`live-status ${liveReady ? "ready" : "loading"}`}>{stateLabel}</span>
            </div>
          </div>
          {recordingSession?.liveEnabled && (
            <div className="live-source-monitors" aria-label="实时音频输入状态">
              <div>
                <span>麦克风</span>
                <i><b style={{ width: `${Math.round(liveTranscript.microphoneLevel * 100)}%` }} /></i>
                <small>{liveTranscript.listeningSources.includes("microphone") ? "已接入" : "连接中"}</small>
              </div>
              {recordingSession.liveSource === "microphone+system" && (
                <div>
                  <span>电脑声音</span>
                  <i><b style={{ width: `${Math.round(liveTranscript.systemLevel * 100)}%` }} /></i>
                  <small>{liveTranscript.listeningSources.includes("system") ? "已接入" : "连接中"}</small>
                </div>
              )}
            </div>
          )}
          <div
            className="live-transcript-scroll"
            aria-live="polite"
            ref={transcriptRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              setFollowLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 56);
            }}
          >
            {liveTranscript.segments.map((segment, index) => (
              <div className="live-caption-row" key={`${segment.startMs}-${index}`}>
                <span>{formatDuration(Math.floor(segment.startMs / 1000))}</span>
                <strong>{segment.speaker}</strong>
                <p>{segment.text}{segment.refined && <small className="caption-refined">已精校</small>}</p>
              </div>
            ))}
            {liveTranscript.partial && (
              <div className="live-caption-row partial">
                <span>正在说</span>
                <strong>{liveTranscript.partialSource === "system" ? "会议声音" : "我"}</strong>
                <p>{liveTranscript.partial}<i /></p>
              </div>
            )}
            {!liveTranscript.segments.length && !liveTranscript.partial && (
              <div className="live-caption-empty">
                <Mic size={26} />
                <strong>{recordingSession?.liveEnabled ? "正在准备第一句字幕…" : "本场会议将在结束后转写"}</strong>
                <small>
                  {recordingSession?.liveEnabled
                    ? "正常说话即可。音量条有变化表示声音已经进入识别。"
                    : "录音仍在安全保存；结束后会自动生成完整原文。"}
                </small>
              </div>
            )}
          </div>
          {!followLatest && (
            <button
              className="live-follow-latest"
              onClick={() => {
                setFollowLatest(true);
                const element = transcriptRef.current;
                element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
              }}
            >
              <ArrowDown size={13} />回到最新字幕
            </button>
          )}
          {showSilenceWarning && (
            <small className="recording-warning">已 {silentFor} 秒没有检测到声音输入，请确认麦克风已开启、电脑声音选择正确。</small>
          )}
          {(liveTranscript.warning || recordingSession?.warning) && (
            <small className="recording-warning">{liveTranscript.warning || recordingSession?.warning}</small>
          )}
        </section>

        <aside className="live-notes-pane">
          <div className="live-notes-head">
            <div>
              <h3>会议笔记</h3>
              <small>记录判断和结论，不会被智能纪要覆盖</small>
            </div>
            <span>自动保存</span>
          </div>
          <textarea
            ref={notesRef}
            value={meeting.notes}
            onChange={(event) => onChange({ ...meeting, notes: event.target.value })}
            placeholder="随手记录重点；点击“标记重点”可插入当前时间…"
            aria-label="会议笔记"
          />
        </aside>
      </div>
    </div>
  );
}
