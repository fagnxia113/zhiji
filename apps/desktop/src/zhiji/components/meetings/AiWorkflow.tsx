import { Download, LoaderCircle, Mic, Settings, Sparkles, UsersRound } from "lucide-react";
import type {
  AsrEngineSettings,
  LocalAsrStatus,
  Meeting,
  Processing,
  SpeakerEngineStatus,
} from "../../types";

// 转写/纪要工作流按钮条：根据本地/云端转写与智能纪要配置，展示对应的可用动作
export function AiWorkflow({
  meeting,
  asrStatus,
  asrEngine,
  speakerStatus,
  aiConfigured,
  processing,
  blocked,
  onTranscribe,
  onTranscribeWithSpeakers,
  onAnalyze,
  onInstallSpeaker,
  onOpenSettings,
}: {
  meeting: Meeting;
  asrStatus: LocalAsrStatus;
  asrEngine: AsrEngineSettings;
  speakerStatus: SpeakerEngineStatus;
  aiConfigured: boolean;
  processing: Processing;
  blocked: boolean;
  onTranscribe: () => void;
  onTranscribeWithSpeakers: () => void;
  onAnalyze: () => void;
  onInstallSpeaker: () => void;
  onOpenSettings: () => void;
}) {
  const cloud = asrEngine.provider === "cloud";
  const speakerReady = !cloud && speakerStatus.installed && speakerStatus.modelsReady;
  const engineReady = cloud ? asrEngine.cloudKeySaved : speakerReady || asrStatus.installed;
  const autoTranscribing = processing === "autoTranscribing";
  const transcribing =
    processing === "transcribing" || processing === "speakerTranscribing";
  // 本地实时会议引擎会同时完成高精度转写和说话人分离；轻量模型作为低配置电脑的回退。
  const handleTranscribe = speakerReady ? onTranscribeWithSpeakers : onTranscribe;
  return (
    <div className="ai-workflow">
      <div className="ai-flow-copy">
        <Sparkles size={18} />
        <span>
          <strong>录音即转写 · 智能纪要</strong>
          <small>
            {autoTranscribing
              ? cloud
                ? "录音已保存，正在云端转写，请稍候…"
                : "录音已保存，正在本地转写并区分说话人，请稍候…"
              : processing === "installingSpeaker"
                ? "首次安装约需 2–5 分钟；正在后台下载组件，请勿关闭知记。"
                : transcribing
                  ? cloud
                    ? "正在云端转写，录音按你的配置上传处理…"
                    : speakerReady
                      ? "正在本地转写并区分说话人…"
                      : "正在本地转写…"
                  : cloud
                    ? engineReady
                      ? "云端转写已就绪：速度快、不占本机算力；整场录音会发送给你配置的服务商。"
                      : "请在设置中配置云端转写密钥，录音后即可自动转写。"
                    : asrStatus.installed
                      ? speakerReady
                        ? "点击「开始转写」会一次性完成转写与说话人分离。"
                        : "点击「开始转写」即可；安装实时会议引擎后还能边录边出字幕并区分发言人。"
                      : "请先在设置中下载本地中文语音模型，录音后即可自动转写。"}
          </small>
        </span>
      </div>
      <div className="ai-flow-actions">
        {autoTranscribing ? (
          <button className="secondary-button compact-button" disabled>
            <LoaderCircle className="spin" size={14} />正在生成原文
          </button>
        ) : !engineReady ? (
          <button className="secondary-button compact-button" onClick={onOpenSettings} disabled={blocked}>
            {cloud ? <Settings size={14} /> : <Download size={14} />}
            {cloud ? "配置云端转写" : "下载本地模型"}
          </button>
        ) : (
          <button
            className="secondary-button compact-button"
            onClick={handleTranscribe}
            disabled={!meeting.audioPath || processing !== null || blocked}
            title={cloud ? "录音会发送到你配置的云端服务" : "使用本地录音生成完整原文"}
          >
            {transcribing ? <LoaderCircle className="spin" size={14} /> : <Mic size={14} />}
            {transcribing ? "正在转写" : meeting.transcript.trim() ? "重新转写" : "生成完整原文"}
          </button>
        )}
        {!cloud && !speakerReady && asrStatus.installed && !autoTranscribing ? (
          <button className="secondary-button compact-button" onClick={onInstallSpeaker} disabled={processing !== null || blocked}>
            {processing === "installingSpeaker" ? <LoaderCircle className="spin" size={14} /> : <UsersRound size={14} />}
            {processing === "installingSpeaker" ? "正在安装" : "安装实时字幕"}
          </button>
        ) : null}
        {!aiConfigured ? (
          <button className="primary-button compact-button" onClick={onOpenSettings} disabled={!meeting.transcript.trim() || blocked}>
            <Sparkles size={14} />配置智能纪要
          </button>
        ) : (
          <button className="primary-button compact-button" onClick={onAnalyze} disabled={!meeting.transcript.trim() || processing !== null || blocked}>
            {processing === "analyzing" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
            {processing === "analyzing" ? "正在生成" : meeting.minutes.trim() ? "更新智能纪要" : "生成智能纪要"}
          </button>
        )}
      </div>
    </div>
  );
}
