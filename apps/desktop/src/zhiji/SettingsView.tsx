import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  Check,
  CheckCircle2,
  Database,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Mic,
  Monitor,
  Moon,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Sun,
  Volume2,
} from "lucide-react";
import { useEffect, useState } from "react";

import type {
  AiSettings,
  AsrEngineSettings,
  BackupInfo,
  LocalAsrStatus,
  Processing,
  RecordingSettings,
  SpeakerEngineStatus,
  Workspace,
} from "./types";
import type { ThemePreference } from "./theme";

const CLOUD_ASR_PRESETS = [
  {
    label: "硅基流动 · SenseVoiceSmall（有免费额度）",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "FunAudioLLM/SenseVoiceSmall",
  },
  {
    label: "OpenAI · whisper-1",
    baseUrl: "https://api.openai.com/v1",
    model: "whisper-1",
  },
  {
    label: "Groq · whisper-large-v3",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3",
  },
];

type SettingsSection =
  | "general"
  | "transcription"
  | "summary"
  | "data"
  | "about";

interface DataLocationInfo {
  dataDir: string;
  defaultDir: string;
  error: string | null;
}

export function SettingsView({
  workspace,
  backups,
  onCheckUpdate,
  updateState,
  currentVersion,
  updateVersion,
  updateError,
  aiSettings,
  asrStatus,
  speakerStatus,
  asrEngine,
  asrKeyInput,
  apiKey,
  processing,
  onAiChange,
  onApiKeyChange,
  onSaveAi,
  onClearAiKey,
  onDownloadAsr,
  onInstallSpeaker,
  onCheckLiveEngine,
  onAsrEngineChange,
  onAsrKeyInputChange,
  onSaveAsrEngine,
  onClearCloudAsrKey,
  recordingSettings,
  onSaveRecordingSettings,
  onCreateBackup,
  onRestoreBackup,
  onOpenBackups,
  onExportDiagnostics,
  onExportAllMarkdown,
  onOpenOnboarding,
  themePref,
  onThemeChange,
}: {
  workspace: Workspace;
  backups: BackupInfo[];
  aiSettings: AiSettings;
  asrStatus: LocalAsrStatus;
  speakerStatus: SpeakerEngineStatus;
  asrEngine: AsrEngineSettings;
  asrKeyInput: string;
  apiKey: string;
  processing: Processing;
  onAiChange: (settings: AiSettings) => void;
  onApiKeyChange: (key: string) => void;
  onSaveAi: () => void;
  onClearAiKey: () => void;
  onDownloadAsr: () => void;
  onInstallSpeaker: () => void;
  onCheckLiveEngine: () => void;
  onAsrEngineChange: (settings: AsrEngineSettings) => void;
  onAsrKeyInputChange: (key: string) => void;
  onSaveAsrEngine: (next: AsrEngineSettings, withKey: boolean) => void;
  onClearCloudAsrKey: () => void;
  recordingSettings: RecordingSettings;
  onSaveRecordingSettings: (settings: RecordingSettings) => void;
  onCreateBackup: () => void;
  onRestoreBackup: (backup: BackupInfo) => void;
  onOpenBackups: () => void;
  onExportDiagnostics: () => void;
  onExportAllMarkdown: () => void;
  onOpenOnboarding: () => void;
  themePref: ThemePreference;
  onThemeChange: (pref: ThemePreference) => void;
  onCheckUpdate: () => void;
  updateState:
    | "idle"
    | "checking"
    | "available"
    | "latest"
    | "downloading"
    | "error";
  currentVersion: string;
  updateVersion: string;
  updateError: string;
}) {
  const [section, setSection] = useState<SettingsSection>("general");
  // 开机自启：设置页自包含状态，读取系统实际开关状态
  const [autoStart, setAutoStart] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);
  useEffect(() => {
    let active = true;
    isEnabled()
      .then((enabled) => {
        if (active) setAutoStart(enabled);
      })
      .catch(() => {
        // 平台不支持时保持关闭态
      })
      .finally(() => {
        if (active) setAutoStartLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const toggleAutoStart = async (checked: boolean) => {
    try {
      if (checked) {
        await enable();
      } else {
        await disable();
      }
      setAutoStart(checked);
    } catch (cause) {
      setAutoStart((previous) => previous);
      console.error("切换开机自启失败", cause);
    }
  };
  // 数据位置：自包含状态，读取当前数据目录并支持“更改位置后重启迁移”
  const [dataLocation, setDataLocation] = useState<DataLocationInfo | null>(
    null,
  );
  const [relocating, setRelocating] = useState(false);
  const refreshDataLocation = async () => {
    try {
      setDataLocation(await invoke<DataLocationInfo>("get_data_location"));
    } catch (cause) {
      console.error("读取数据位置失败", cause);
    }
  };
  useEffect(() => {
    void refreshDataLocation();
  }, []);
  const onRevealDataFolder = () => {
    invoke("reveal_data_folder").catch((cause) => {
      window.alert(String(cause));
    });
  };
  const onDismissRelocationError = async () => {
    try {
      await invoke("clear_data_relocation_error");
      await refreshDataLocation();
    } catch (cause) {
      console.error("清除迁移错误失败", cause);
    }
  };
  const onPickDataLocation = async () => {
    if (relocating) return;
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择新的数据位置（建议空文件夹）",
    });
    if (typeof selected !== "string" || !selected) return;
    const confirmed = window.confirm(
      `更改后知记会立即重启并完成数据迁移。\n\n新位置：${selected}\n\n说明：\n· 数据库、录音与备份会迁移到新位置（可放在同步盘/网盘）；\n· 语音模型与运行组件留在系统默认位置；\n· 迁移在重启后自动进行，视数据量大小可能需要几分钟，期间请勿强制关闭应用；\n· 原位置的数据会保留，确认新位置一切正常后可手动删除。\n\n是否重启并迁移？`,
    );
    if (!confirmed) return;
    try {
      await invoke("schedule_data_relocation", { target: selected });
      setRelocating(true);
      await relaunch();
    } catch (cause) {
      window.alert(typeof cause === "string" ? cause : String(cause));
      setRelocating(false);
    }
  };
  const cloud = asrEngine.provider === "cloud";
  const realtimeReady = speakerStatus.installed && speakerStatus.modelsReady;
  const transcriptionReady = cloud ? asrEngine.cloudKeySaved : realtimeReady;
  const lastBackup = backups.find((backup) => backup.isValid);
  const presetValue =
    CLOUD_ASR_PRESETS.find(
      (preset) =>
        preset.baseUrl === asrEngine.cloudBaseUrl &&
        preset.model === asrEngine.cloudModel,
    )?.label ?? "custom";
  const navItems: Array<{
    id: SettingsSection;
    label: string;
    hint: string;
    icon: typeof Settings2;
    state?: "ready" | "attention";
  }> = [
    {
      id: "general",
      label: "使用概览",
      hint: "常用设置与当前状态",
      icon: Settings2,
    },
    {
      id: "transcription",
      label: "录音与转写",
      hint: "声音来源、模型与热词",
      icon: Mic,
      state: transcriptionReady ? "ready" : "attention",
    },
    {
      id: "summary",
      label: "智能纪要",
      hint: "摘要服务与隐私范围",
      icon: FileText,
      state: aiSettings.isConfigured ? "ready" : "attention",
    },
    {
      id: "data",
      label: "数据与备份",
      hint: "本地资料和故障诊断",
      icon: Database,
      state: lastBackup ? "ready" : undefined,
    },
    {
      id: "about",
      label: "关于与更新",
      hint: "版本与软件更新",
      icon: RefreshCw,
    },
  ];

  const selectSection = (next: SettingsSection) => setSection(next);

  return (
    <div className="settings-page settings-layout">
      <aside className="settings-sidebar" aria-label="设置分类">
        <div className="settings-sidebar-heading">
          <h2>设置</h2>
          <p>只展示与使用有关的选项</p>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`settings-nav-item ${section === item.id ? "active" : ""}`}
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => selectSection(item.id)}
              >
                <Icon size={17} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.hint}</small>
                </span>
                {item.state && <i className={`settings-nav-state ${item.state}`} title={item.state === "ready" ? "已就绪" : "需要检查"} />}
              </button>
            );
          })}
        </nav>
        <div className="settings-privacy-note">
          <ShieldCheck size={16} />
          <span>
            录音与资料库保存在本机。只有主动使用云端服务时才发送对应内容。
          </span>
        </div>
      </aside>

      <main className="settings-content">
        {section === "general" && (
          <>
            <SettingsHeading
              title="使用概览"
              description="先确认录音与转写是否就绪，需要时再进入对应分类调整。"
            />
            <div className="settings-status-grid">
              <StatusCard
                icon={Mic}
                title="实时字幕"
                value={transcriptionReady ? "可以使用" : "需要准备"}
                detail={
                  cloud
                    ? asrEngine.cloudKeySaved
                      ? "当前使用云端转写"
                      : "云端密钥尚未保存"
                    : realtimeReady
                      ? "本地实时引擎已就绪"
                      : "请先安装或修复实时引擎"
                }
                ready={transcriptionReady}
                onClick={() => selectSection("transcription")}
              />
              <StatusCard
                icon={Volume2}
                title="会议声音"
                value={
                  recordingSettings.captureSystemAudio
                    ? "已同时录制"
                    : "仅麦克风"
                }
                detail={
                  recordingSettings.captureSystemAudio
                    ? "适合线上会议"
                    : "适合面对面会议"
                }
                ready
                onClick={() => selectSection("transcription")}
              />
              <StatusCard
                icon={Sparkles}
                title="智能纪要"
                value={aiSettings.isConfigured ? "可以生成" : "尚未配置"}
                detail={
                  aiSettings.isConfigured
                    ? "只发送转写文字"
                    : "不影响录音和转写"
                }
                ready={aiSettings.isConfigured}
                onClick={() => selectSection("summary")}
              />
              <StatusCard
                icon={HardDrive}
                title="资料保护"
                value={lastBackup ? "已有可用备份" : "建议立即备份"}
                detail={
                  lastBackup
                    ? new Date(lastBackup.createdAt).toLocaleString("zh-CN")
                    : "尚未找到可恢复备份"
                }
                ready={Boolean(lastBackup)}
                onClick={() => selectSection("data")}
              />
            </div>

            <h3 className="settings-section-title">常用设置</h3>
            <section className="settings-card settings-choice-card settings-theme-card">
              <button
                type="button"
                className={`settings-choice ${themePref === "light" ? "active" : ""}`}
                onClick={() => onThemeChange("light")}
              >
                <Sun size={19} />
                <span>
                  <strong>浅色</strong>
                  <small>始终使用明亮外观</small>
                </span>
                {themePref === "light" && <CheckCircle2 size={17} />}
              </button>
              <button
                type="button"
                className={`settings-choice ${themePref === "dark" ? "active" : ""}`}
                onClick={() => onThemeChange("dark")}
              >
                <Moon size={19} />
                <span>
                  <strong>深色</strong>
                  <small>低光环境下更护眼</small>
                </span>
                {themePref === "dark" && <CheckCircle2 size={17} />}
              </button>
              <button
                type="button"
                className={`settings-choice ${themePref === "system" ? "active" : ""}`}
                onClick={() => onThemeChange("system")}
              >
                <Monitor size={19} />
                <span>
                  <strong>跟随系统</strong>
                  <small>自动匹配 Windows 外观</small>
                </span>
                {themePref === "system" && <CheckCircle2 size={17} />}
              </button>
            </section>
            <section className="settings-card">
              <div>
                <h3>同时录制电脑声音</h3>
                <p>
                  线上会议建议开启，可以分别采集你的麦克风和对方声音；面对面会议保持关闭即可。
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="同时录制电脑声音"
                  checked={recordingSettings.captureSystemAudio}
                  onChange={(event) =>
                    onSaveRecordingSettings({
                      captureSystemAudio: event.target.checked,
                    })
                  }
                />
                <span className="switch-slider" />
              </label>
            </section>
            <section className="settings-card">
              <div>
                <h3>开机自动启动</h3>
                <p>
                  登录 Windows 后自动在后台启动知记，方便随时录音或查看待办；关闭后需手动打开。
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="开机自动启动"
                  disabled={autoStartLoading}
                  checked={autoStart}
                  onChange={(event) => void toggleAutoStart(event.target.checked)}
                />
                <span className="switch-slider" />
              </label>
            </section>
            <section className="settings-card settings-action-card">
              <div>
                <h3>首次使用检查</h3>
                <p>重新检查录音权限、存储空间和实时转写模型。</p>
              </div>
              <button className="secondary-button" onClick={onOpenOnboarding}>
                <Stethoscope size={16} />
                运行检查
              </button>
            </section>
          </>
        )}

        {section === "transcription" && (
          <>
            <SettingsHeading
              title="录音与转写"
              description="本地模式免费且录音不离开电脑；云端模式会把整场录音发送给你配置的服务商。"
            />
            <section className="settings-card">
              <div>
                <h3>同时录制电脑声音</h3>
                <p>
                  用于线上会议。开启后会同时捕获电脑播放的对方声音，默认关闭以保护隐私。
                </p>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="同时录制电脑声音"
                  checked={recordingSettings.captureSystemAudio}
                  onChange={(event) =>
                    onSaveRecordingSettings({
                      captureSystemAudio: event.target.checked,
                    })
                  }
                />
                <span className="switch-slider" />
              </label>
            </section>

            <h3 className="settings-section-title">转写方式</h3>
            <section className="settings-card settings-choice-card">
              <button
                type="button"
                className={`settings-choice ${cloud ? "" : "active"}`}
                onClick={() =>
                  onSaveAsrEngine({ ...asrEngine, provider: "local" }, false)
                }
              >
                <HardDrive size={19} />
                <span>
                  <strong>本地转写</strong>
                  <small>免费、离线，录音不离开电脑</small>
                </span>
                {!cloud && <CheckCircle2 size={17} />}
              </button>
              <button
                type="button"
                className={`settings-choice ${cloud ? "active" : ""}`}
                onClick={() =>
                  onAsrEngineChange({ ...asrEngine, provider: "cloud" })
                }
              >
                <Sparkles size={19} />
                <span>
                  <strong>云端转写</strong>
                  <small>通常更快，会上传整场录音</small>
                </span>
                {cloud && <CheckCircle2 size={17} />}
              </button>
            </section>

            {!cloud && (
              <>
                <section className="settings-card ai-settings local-meeting-engine">
                  <div>
                    <h3>本地实时字幕</h3>
                    <p>
                      会议中快速出字，停顿后自动精校；会议结束后再进行完整校正和说话人区分。
                    </p>
                  </div>
                  <span className={`ai-status ${realtimeReady ? "ready" : ""}`}>
                    {realtimeReady
                      ? "可以使用"
                      : speakerStatus.installed
                        ? "模型不完整"
                        : speakerStatus.modelsReady
                          ? "启动组件需修复"
                          : "尚未安装"}
                  </span>
                  <div className="settings-actions">
                    <button
                      className="primary-button"
                      disabled={processing !== null}
                      onClick={onInstallSpeaker}
                    >
                      {processing === "installingSpeaker" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Sparkles size={16} />
                      )}
                      {processing === "installingSpeaker"
                        ? "正在准备"
                        : realtimeReady
                          ? "检查并修复"
                          : "安装实时字幕"}
                    </button>
                    <button
                      className="secondary-button"
                      disabled={processing !== null || !realtimeReady}
                      onClick={onCheckLiveEngine}
                    >
                      {processing === "checkingLiveEngine" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <CheckCircle2 size={16} />
                      )}
                      {processing === "checkingLiveEngine"
                        ? "正在自检"
                        : "运行自检"}
                    </button>
                  </div>
                </section>

                <section className="settings-card ai-settings">
                  <div>
                    <h3>会议热词</h3>
                    <p>
                      填写人名、项目名和专业词。会议标题与会前背景会自动加入，不需要重复填写。
                    </p>
                  </div>
                  <div className="ai-grid local-hotword-grid">
                    <label>
                      专有名词
                      <textarea
                        value={asrEngine.localHotwords}
                        onChange={(event) =>
                          onAsrEngineChange({
                            ...asrEngine,
                            localHotwords: event.target.value,
                          })
                        }
                        placeholder="例如：智记、张明、星河项目；可用逗号或换行分隔"
                        rows={4}
                      />
                    </label>
                  </div>
                  <div className="settings-actions">
                    <button
                      className="primary-button"
                      disabled={processing !== null}
                      onClick={() => onSaveAsrEngine(asrEngine, false)}
                    >
                      <Check size={16} />
                      保存热词
                    </button>
                  </div>
                </section>

                <section className="settings-card ai-settings">
                  <div>
                    <h3>轻量会后转写</h3>
                    <p>
                      占用资源较少，适合配置一般的 Windows
                      电脑，也可作为实时字幕不可用时的备用方案。
                    </p>
                  </div>
                  <span
                    className={`ai-status ${asrStatus.installed ? "ready" : ""}`}
                  >
                    {asrStatus.installed
                      ? `已安装 ${asrStatus.modelSizeMb} MB`
                      : "尚未下载"}
                  </span>
                  <div className="settings-actions">
                    <button
                      className="secondary-button"
                      disabled={processing !== null || asrStatus.installed}
                      onClick={onDownloadAsr}
                    >
                      {processing === "downloading" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Download size={16} />
                      )}
                      {processing === "downloading"
                        ? "正在下载"
                        : asrStatus.installed
                          ? "已经就绪"
                          : "下载备用模型"}
                    </button>
                    {!asrStatus.runtimeAvailable && (
                      <small className="runtime-warning">
                        语音运行组件将在正式安装包中提供。
                      </small>
                    )}
                  </div>
                </section>
              </>
            )}

            {cloud && (
              <section className="settings-card ai-settings">
                <div>
                  <h3>云端转写服务</h3>
                  <p>
                    兼容 OpenAI 的音频转写接口。API 密钥存入 Windows
                    凭据库，不写入会议数据库。
                  </p>
                </div>
                <span
                  className={`ai-status ${asrEngine.cloudKeySaved ? "ready" : ""}`}
                >
                  {asrEngine.cloudKeySaved ? "已配置" : "需要密钥"}
                </span>
                <div className="settings-disclosure">
                  <ShieldCheck size={16} />
                  <span>
                    使用云端转写时会发送整场录音；会议笔记和资料库不会一并发送。
                  </span>
                </div>
                <div className="ai-grid">
                  <label>
                    服务商预设
                    <select
                      value={presetValue}
                      onChange={(event) => {
                        const preset = CLOUD_ASR_PRESETS.find(
                          (item) => item.label === event.target.value,
                        );
                        if (preset) {
                          onAsrEngineChange({
                            ...asrEngine,
                            cloudBaseUrl: preset.baseUrl,
                            cloudModel: preset.model,
                          });
                        }
                      }}
                    >
                      {CLOUD_ASR_PRESETS.map((preset) => (
                        <option value={preset.label} key={preset.label}>
                          {preset.label}
                        </option>
                      ))}
                      <option value="custom">自定义</option>
                    </select>
                  </label>
                  <label>
                    服务地址
                    <input
                      value={asrEngine.cloudBaseUrl}
                      onChange={(event) =>
                        onAsrEngineChange({
                          ...asrEngine,
                          cloudBaseUrl: event.target.value,
                        })
                      }
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                  <label>
                    转写模型
                    <input
                      value={asrEngine.cloudModel}
                      onChange={(event) =>
                        onAsrEngineChange({
                          ...asrEngine,
                          cloudModel: event.target.value,
                        })
                      }
                      placeholder="whisper-1"
                    />
                  </label>
                  <label>
                    API 密钥
                    <input
                      type="password"
                      value={asrKeyInput}
                      onChange={(event) =>
                        onAsrKeyInputChange(event.target.value)
                      }
                      placeholder={
                        asrEngine.cloudKeySaved
                          ? "已保存；留空保留原密钥"
                          : "粘贴 API 密钥"
                      }
                    />
                  </label>
                </div>
                <div className="settings-actions">
                  <button
                    className="primary-button"
                    disabled={processing !== null}
                    onClick={() =>
                      onSaveAsrEngine({ ...asrEngine, provider: "cloud" }, true)
                    }
                  >
                    <Check size={16} />
                    保存云端转写
                  </button>
                  {asrEngine.cloudKeySaved && (
                    <button
                      className="secondary-button"
                      onClick={onClearCloudAsrKey}
                    >
                      删除密钥
                    </button>
                  )}
                </div>
              </section>
            )}
          </>
        )}

        {section === "summary" && (
          <>
            <SettingsHeading
              title="智能纪要"
              description="这是可选功能。未配置时，录音、实时字幕和会后转写仍然可以正常使用。"
            />
            <section className="settings-card ai-settings">
              <div>
                <h3>纪要生成服务</h3>
                <p>
                  兼容 OpenAI
                  的聊天补全接口。只有你主动生成纪要时才会发送转写文字，不会发送录音。
                </p>
              </div>
              <span
                className={`ai-status ${aiSettings.isConfigured ? "ready" : ""}`}
              >
                {aiSettings.isConfigured ? "可以使用" : "尚未配置"}
              </span>
              <div className="settings-disclosure">
                <ShieldCheck size={16} />
                <span>
                  发送内容：会议转写文字。不会发送：录音文件、个人笔记、其他会议和
                  API 密钥。
                </span>
              </div>
              <div className="ai-grid summary-settings-grid">
                <label>
                  服务地址
                  <input
                    value={aiSettings.baseUrl}
                    onChange={(event) =>
                      onAiChange({ ...aiSettings, baseUrl: event.target.value })
                    }
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label>
                  纪要模型
                  <input
                    value={aiSettings.analysisModel}
                    onChange={(event) =>
                      onAiChange({
                        ...aiSettings,
                        analysisModel: event.target.value,
                      })
                    }
                    placeholder="gpt-4o-mini"
                  />
                </label>
                <label>
                  API 密钥
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => onApiKeyChange(event.target.value)}
                    placeholder={
                      aiSettings.isConfigured
                        ? "已保存；留空保留原密钥"
                        : "粘贴 API 密钥"
                    }
                  />
                </label>
              </div>
              <div className="settings-actions">
                <button
                  className="primary-button"
                  disabled={processing !== null}
                  onClick={onSaveAi}
                >
                  <Check size={16} />
                  保存智能纪要
                </button>
                {aiSettings.isConfigured && (
                  <button className="secondary-button" onClick={onClearAiKey}>
                    删除密钥
                  </button>
                )}
              </div>
            </section>
          </>
        )}

        {section === "data" && (
          <>
            <SettingsHeading
              title="数据与备份"
              description="会议、录音和待办保存在这台电脑。这里可以备份、恢复和导出故障诊断。"
            />
            <div className="settings-data-summary">
              <span>
                <strong>{workspace.meetings.length}</strong>场会议
              </span>
              <span>
                <strong>{workspace.tasks.length}</strong>项待办
              </span>
              <span>
                <strong>
                  {backups.filter((backup) => backup.isValid).length}
                </strong>
                份可用备份
              </span>
            </div>
            <section className="settings-card">
              <div>
                <h3>数据位置</h3>
                <p className="data-location-path">
                  {dataLocation ? dataLocation.dataDir : "读取中…"}
                </p>
                <small className="runtime-warning">
                  数据库、录音与备份保存在该目录，可放在同步盘/网盘等自定义位置；
                  语音模型与运行组件仍保留在系统默认位置。更改后应用会重启并完成迁移，
                  原位置数据会保留，确认正常后可手动删除。
                </small>
                {dataLocation?.error && (
                  <p className="runtime-warning">
                    上次更改位置未成功：{dataLocation.error}（当前仍在用原位置）
                  </p>
                )}
              </div>
              <div className="settings-actions">
                {dataLocation?.error ? (
                  <button
                    className="secondary-button"
                    onClick={onDismissRelocationError}
                  >
                    知道了
                  </button>
                ) : (
                  <button
                    className="secondary-button"
                    onClick={onRevealDataFolder}
                  >
                    <FolderOpen size={16} />
                    打开数据文件夹
                  </button>
                )}
                <button
                  className="secondary-button"
                  disabled={relocating}
                  onClick={onPickDataLocation}
                >
                  <HardDrive size={16} />
                  {relocating ? "重启迁移中…" : "更改位置…"}
                </button>
              </div>
            </section>
            <section className="settings-card backups-card">
              <div>
                <h3>自动备份</h3>
                <p>
                  每天首次启动时自动备份资料库，最多保留最近 2
                  份。恢复前会再保存一次当前数据。
                </p>
              </div>
              <div className="settings-actions">
                <button className="primary-button" onClick={onCreateBackup}>
                  <Download size={16} />
                  立即备份
                </button>
                <button className="secondary-button" onClick={onOpenBackups}>
                  <FolderOpen size={16} />
                  打开备份目录
                </button>
              </div>
              {backups.slice(0, 5).map((backup) => (
                <div
                  className={`backup-row${backup.isValid ? "" : " invalid"}`}
                  key={backup.fileName}
                >
                  <div className="backup-summary">
                    <span>
                      {new Date(backup.createdAt).toLocaleString("zh-CN")}
                    </span>
                    <small>
                      {backup.isValid
                        ? `${backup.meetingCount} 场会议 · ${backup.taskCount} 个待办 · ${backup.sizeMb.toFixed(1)} MB`
                        : `完整性检查未通过 · ${backup.sizeMb.toFixed(1)} MB`}
                    </small>
                  </div>
                  <span
                    className={`backup-health ${backup.isValid ? "ready" : "error"}`}
                  >
                    {backup.isValid ? "可恢复" : "不可用"}
                  </span>
                  <button
                    className="secondary-button compact-button"
                    disabled={!backup.isValid}
                    onClick={() => onRestoreBackup(backup)}
                  >
                    恢复预览
                  </button>
                </div>
              ))}
              {backups.length === 0 && (
                <small className="runtime-warning">尚未生成可用备份</small>
              )}
            </section>
            <section className="settings-card settings-action-card">
              <div>
                <h3>导出全部会议</h3>
                <p>
                  把 {workspace.meetings.length} 场会议按「YYYYMMDD-主题.md」导出为
                  Markdown，便于归档或迁移。
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={onExportAllMarkdown}
              >
                <FileText size={16} />
                导出全部为 Markdown
              </button>
            </section>
            <section className="settings-card settings-action-card">
              <div>
                <h3>故障诊断</h3>
                <p>
                  导出的诊断信息不包含录音、转写正文和 API
                  密钥，可用于排查实时字幕或升级问题。
                </p>
              </div>
              <button
                className="secondary-button"
                onClick={onExportDiagnostics}
              >
                <Stethoscope size={16} />
                导出诊断信息
              </button>
            </section>
          </>
        )}

        {section === "about" && (
          <>
            <SettingsHeading
              title="关于与更新"
              description="查看当前版本并检查正式更新。"
            />
            <section className="settings-card settings-version-card">
              <div className="settings-app-mark">记</div>
              <div>
                <h3>知记</h3>
                <p>
                  {currentVersion
                    ? `当前版本 ${currentVersion}`
                    : "正在读取版本信息"}
                </p>
              </div>
              <div className="settings-actions">
                <button
                  className="primary-button"
                  onClick={onCheckUpdate}
                  disabled={
                    updateState === "checking" || updateState === "downloading"
                  }
                >
                  {updateState === "checking" ||
                  updateState === "downloading" ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                  {updateState === "checking"
                    ? "检查中…"
                    : updateState === "downloading"
                      ? "更新中…"
                      : "检查更新"}
                </button>
                {updateState === "latest" && (
                  <span className="ai-status ready">已是最新</span>
                )}
                {updateState === "available" && (
                  <span className="ai-status ready">发现 {updateVersion}</span>
                )}
              </div>
            </section>
            {updateState === "error" && (
              <div className="settings-error-panel">
                <strong>检查更新没有成功</strong>
                <span>{updateError || "请检查网络连接后重试。"}</span>
              </div>
            )}
            <section className="settings-card settings-action-card">
              <div>
                <h3>使用检查</h3>
                <p>
                  如果更换了麦克风、播放设备或网络环境，可以重新运行完整检查。
                </p>
              </div>
              <button className="secondary-button" onClick={onOpenOnboarding}>
                <Stethoscope size={16} />
                运行使用检查
              </button>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function SettingsHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <header className="settings-content-heading">
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function StatusCard({
  icon: Icon,
  title,
  value,
  detail,
  ready,
  onClick,
}: {
  icon: typeof Mic;
  title: string;
  value: string;
  detail: string;
  ready: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="settings-status-card" onClick={onClick}>
      <span className={`settings-status-icon ${ready ? "ready" : ""}`}>
        <Icon size={18} />
      </span>
      <span className="settings-status-copy">
        <small>{title}</small>
        <strong>{value}</strong>
        <span>{detail}</span>
      </span>
    </button>
  );
}
