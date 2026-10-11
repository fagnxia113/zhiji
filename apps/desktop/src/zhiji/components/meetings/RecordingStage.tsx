import { Flag, Square } from "lucide-react";
import { useRef } from "react";
import type { Meeting, RecordingSessionStatus } from "../../types";

type RecordingStageProps = {
  meeting: Meeting;
  recordingSeconds: number;
  recordingSession: RecordingSessionStatus | null;
  finalizing: boolean;
  formatDuration: (seconds: number) => string;
  onChange: (meeting: Meeting) => void;
  onStop: () => void;
};

export function RecordingStage({ meeting, recordingSeconds, recordingSession, finalizing, formatDuration, onChange, onStop }: RecordingStageProps) {
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const markMoment = () => {
    const prefix = meeting.notes && !meeting.notes.endsWith("\n") ? "\n" : "";
    onChange({ ...meeting, notes: `${meeting.notes}${prefix}[重点 ${formatDuration(recordingSeconds)}] ` });
    requestAnimationFrame(() => {
      const input = notesRef.current;
      if (!input) return;
      input.focus();
      input.selectionStart = input.value.length;
      input.selectionEnd = input.value.length;
    });
  };
  return (
    <section className="recording-stage" aria-label="录音进行中">
      <header className="recording-stage-toolbar">
        <div className="recording-session-identity">
          <div>
            <strong>{finalizing ? "正在安全保存录音" : recordingSession ? "正在录音" : "正在启动录音"}</strong>
            <small>{recordingSession?.captureSystemAudio ? `麦克风 + 电脑声音 · ${recordingSession.microphoneLabel}` : `仅麦克风 · ${recordingSession?.microphoneLabel || "默认麦克风"}`}</small>
          </div>
          <time>{formatDuration(recordingSeconds)}</time>
        </div>
        <div className="recording-stage-actions">
          <button className="secondary-button compact-button" onClick={markMoment} disabled={finalizing || !recordingSession}><Flag size={14} />标记重点</button>
          <button className="danger-button compact-button" onClick={onStop} disabled={finalizing || !recordingSession}><Square size={13} fill="currentColor" />{finalizing ? "正在保存" : "结束并转写"}</button>
        </div>
      </header>
      <p className="recording-stage-hint">录音会持续保存到本机。结束后使用已配置的引擎生成完整原文；本地会议引擎可区分发言人。</p>
      {recordingSession?.warning && <p className="recording-warning" role="status">{recordingSession.warning}</p>}
      <div className="recording-notes-pane">
        <div className="recording-notes-head"><h3>会议笔记</h3><small>可随手记录，或标记录音中的重点位置</small></div>
        <textarea ref={notesRef} disabled={finalizing || !recordingSession} value={meeting.notes} onChange={(event) => onChange({ ...meeting, notes: event.target.value })} placeholder="记录重点、判断和待协调事项…" aria-label="会议笔记" />
      </div>
    </section>
  );
}
