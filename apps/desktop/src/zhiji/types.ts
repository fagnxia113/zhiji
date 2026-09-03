// 领域类型集中定义：从 App.tsx 抽出，供组件层与页面共享，避免巨型单文件耦合。
export type Meeting = {
  id: string;
  // 已废弃的笔记本概念（无笔记本 UI，恒为 null）。保留字段仅为兼容数据库列，勿再使用。
  notebookId: string | null;
  title: string;
  startedAt: string;
  durationSeconds: number;
  status: string;
  transcript: string;
  minutes: string;
  decisions: string;
  speakerSegments: string;
  speakerNames?: string;
  audioPath: string | null;
  updatedAt: string;
  context: string;
  notes: string;
};

// 会议状态全集（数据库里存的就是这些中文文案，同时充当展示标签）。
// 后端 Rust 是写入方、前端据此分类。新增状态时两边都要加，并更新 statusTone。
export const MeetingStatus = {
  Draft: "草稿",
  Recorded: "已录音",
  LiveTranscribed: "实时转写完成",
  PendingRecovery: "录音保存待恢复",
  Recovered: "录音已恢复",
  Imported: "已导入录音",
  Transcribed: "已转写",
  Diarized: "已区分发言人",
  Analyzed: "已分析",
  Proofread: "已人工校对",
} as const;
export type MeetingStatusValue = (typeof MeetingStatus)[keyof typeof MeetingStatus];

export type StatusTone = "brand" | "success" | "info" | "neutral";
// 状态色点语义：发言人=品牌色，纪要完成=成功，转写/录音/导入=信息，其余=中性。
export function statusTone(status: string): StatusTone {
  switch (status) {
    case MeetingStatus.Diarized:
      return "brand";
    case MeetingStatus.Analyzed:
      return "success";
    case MeetingStatus.LiveTranscribed:
    case MeetingStatus.Transcribed:
    case MeetingStatus.Recorded:
    case MeetingStatus.PendingRecovery:
    case MeetingStatus.Recovered:
    case MeetingStatus.Imported:
      return "info";
    default:
      return "neutral";
  }
}

// 实时初稿：实时字幕先行、会后还需用高精度引擎校正的会议。
export function isLiveDraft(status: string): boolean {
  return status === MeetingStatus.LiveTranscribed;
}

export type Task = {
  id: string;
  title: string;
  sourceType: string | null;
  sourceId: string | null;
  completed: boolean;
  dueDate: string | null;
  createdAt: string;
  origin?: string;
  // 负责人：结构化字段（AI 提取时写入）。老数据可能为空，读取时回退标题「XX：」前缀解析。
  owner?: string;
};

export type Workspace = {
  meetings: Meeting[];
  tasks: Task[];
};

// 会议问答消息：一问一答，按会议持久化（对应后端 qa_messages 表）
export type QaMessage = {
  id: string;
  meetingId: string;
  question: string;
  answer: string;
  createdAt: string;
};

export type BackupInfo = {
  fileName: string;
  createdAt: string;
  sizeMb: number;
  isValid: boolean;
  meetingCount: number;
  taskCount: number;
  noteCount: number;
};

export type AiSettings = {
  baseUrl: string;
  analysisModel: string;
  isConfigured: boolean;
};

export type LocalAsrStatus = {
  installed: boolean;
  runtimeAvailable: boolean;
  modelSizeMb: number;
};

export type SpeakerEngineStatus = { installed: boolean; modelsReady: boolean };

export type AsrEngineSettings = {
  provider: "local" | "cloud";
  cloudBaseUrl: string;
  cloudModel: string;
  cloudKeySaved: boolean;
  localHotwords: string;
};

// 录音设置：系统声音（loopback 双轨）默认关闭，保护隐私。
export type RecordingSettings = {
  captureSystemAudio: boolean;
};

export const defaultRecordingSettings: RecordingSettings = {
  captureSystemAudio: false,
};

export type RecordingBackendReadiness = {
  storageReady: boolean;
  systemAudioReady: boolean;
  systemAudioMessage: string;
};

export type RecordingSessionStatus = {
  microphoneLabel: string;
  captureSystemAudio: boolean;
  warning: string;
  liveEnabled: boolean;
  liveSource: "microphone" | "microphone+system" | "none";
};

export type BeginRecordingResult = {
  liveEnabled: boolean;
  liveSource: "microphone" | "microphone+system" | "none";
  warning: string | null;
};

export type LiveTranscriptState = {
  meetingId: string;
  sessionId: string;
  lastSequence: number;
  phase: "idle" | "starting" | "running" | "recovering" | "degraded" | "finished";
  ready: boolean;
  text: string;
  partial: string;
  partialId: string;
  partialSource: string;
  segments: SpeakerSegment[];
  warning: string;
  listeningSources: string[];
  microphoneLevel: number;
  systemLevel: number;
  qualityState: "loading" | "ready" | "fallback";
  refiningCount: number;
};

export type RecordingFinalizeResult = {
  meeting: Meeting;
  systemAudioCaptured: boolean;
  warning: string | null;
};

export type SpeakerSegment = {
  speaker: string;
  speakerId?: number;
  startMs: number;
  endMs: number;
  text: string;
  refined?: boolean;
};

// 说话人显示名：优先用本会议自定义名（speaker_names 映射），否则回退段内字面标签或「发言人 N」。
// segment.speakerId 为后端稳定 id（0 基）；旧数据无 id 时从字面标签「发言人 N」反推。
export function speakerDisplayName(
  segment: SpeakerSegment,
  names: Record<string, string>,
): string {
  const id = segment.speakerId ?? parseSpeakerId(segment.speaker);
  if (id != null) {
    const custom = names[String(id)];
    if (custom && custom.trim()) return custom.trim();
  }
  return segment.speaker || `发言人 ${(id ?? 0) + 1}`;
}

function parseSpeakerId(label: string): number | null {
  const match = label?.match(/\d+/);
  return match ? Number(match[0]) - 1 : null;
}

export type MeetingTemplate = "general" | "weekly" | "interview" | "review" | "project" | "decision";

export type AnalysisActionItem = {
  title: string;
  dueDate: string | null;
  assignee: string | null;
};

export type AnalysisSourceHighlight = {
  label: string;
  timeMs: number;
  quote: string;
};

export type AnalysisPreview = {
  theme: string;
  minutes: string;
  decisions: string;
  actionItems: AnalysisActionItem[];
  sourceHighlights: AnalysisSourceHighlight[];
};

export type AnalysisResult = { meeting: Meeting; tasks: Task[] };

export type View = "home" | "meetings" | "tasks" | "settings";

export type Processing =
  | "downloading"
  | "transcribing"
  | "analyzing"
  | "applyingAnalysis"
  | "regeneratingMinutes"
  | "regeneratingDecisions"
  | "regeneratingTasks"
  | "renaming"
  | "installingSpeaker"
  | "checkingLiveEngine"
  | "speakerTranscribing"
  | "importing"
  | "deleting"
  | "autoTranscribing"
  | null;
