import { Check, Cloud, Database, Mic, Sparkles } from "lucide-react";
import type { AiSettings, AsrEngineSettings, LocalAsrStatus, SpeakerEngineStatus } from "../../types";
import { Dialog } from "../ui/Dialog";

export function OnboardingModal({
  asrStatus,
  asrEngine,
  speakerStatus,
  aiSettings,
  onOpenSettings,
  onComplete,
}: {
  asrStatus: LocalAsrStatus;
  asrEngine: AsrEngineSettings;
  speakerStatus: SpeakerEngineStatus;
  aiSettings: AiSettings;
  onOpenSettings: () => void;
  onComplete: () => void;
}) {
  const transcriptionReady =
    asrEngine.provider === "local"
      ? speakerStatus.installed && speakerStatus.modelsReady
      : asrEngine.cloudKeySaved;

  return (
    <Dialog closeOnBackdrop={false} closeOnEsc={false} className="onboarding-modal" ariaLabel="知记首次使用向导">
      <div className="onboarding-brand">
        <span className="round-icon accent"><Sparkles size={20} /></span>
        <div>
          <small>欢迎使用知记</small>
          <h2>开始第一场会议前，花一分钟确认环境</h2>
        </div>
      </div>
      <p className="onboarding-intro">
        录音和资料默认只保存在这台电脑。转写可以完全离线，智能纪要按你的配置使用。
      </p>
      <div className="onboarding-checks">
        <div className="onboarding-check ready">
          <span><Database size={18} /></span>
          <div><strong>本地资料库</strong><small>已准备，会议与录音保存在本机</small></div>
          <Check size={17} />
        </div>
        <div className={`onboarding-check ${transcriptionReady ? "ready" : "attention"}`}>
          <span>{asrEngine.provider === "local" ? <Mic size={18} /> : <Cloud size={18} />}</span>
          <div>
            <strong>{asrEngine.provider === "local" ? "本地语音转写" : "云端语音转写"}</strong>
            <small>{transcriptionReady ? "实时字幕与会后高精度转写已经可以使用" : asrStatus.installed ? "轻量模型可用；实时字幕引擎还需要准备" : "还需要在设置中完成引擎配置"}</small>
          </div>
          {transcriptionReady && <Check size={17} />}
        </div>
        <div className={`onboarding-check ${aiSettings.isConfigured ? "ready" : "optional"}`}>
          <span><Sparkles size={18} /></span>
          <div>
            <strong>智能纪要</strong>
            <small>{aiSettings.isConfigured ? "AI 服务已经配置" : "可稍后配置，不影响录音与转写"}</small>
          </div>
          {aiSettings.isConfigured && <Check size={17} />}
        </div>
      </div>
      <div className="modal-actions onboarding-actions">
        <button className="secondary-button" onClick={onOpenSettings}>打开设置</button>
        <button className="primary-button" onClick={onComplete}>
          {transcriptionReady ? "开始使用" : "暂时跳过"}
        </button>
      </div>
    </Dialog>
  );
}
