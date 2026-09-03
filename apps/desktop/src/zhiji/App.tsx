import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  FileAudio,
  FileDown,
  FolderOpen,
  House,
  LoaderCircle,
  MessageCircleQuestion,
  Mic,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  UsersRound,
  Wand2,
} from "lucide-react";
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiSettings,
  AnalysisPreview,
  AnalysisResult,
  AsrEngineSettings,
  BackupInfo,
  BeginRecordingResult,
  LiveTranscriptState,
  RecordingFinalizeResult,
  RecordingSessionStatus,
  RecordingSettings,
  LocalAsrStatus,
  Meeting,
  MeetingTemplate,
  Processing,
  SpeakerEngineStatus,
  SpeakerSegment,
  Task,
  View,
  Workspace,
} from "./types";
import { defaultRecordingSettings, MeetingStatus, isLiveDraft } from "./types";
import { localDateKey, meetingJourney, taskDueState, taskDueText } from "./workflow";
import { duration } from "./format";
import {
  applyTheme,
  loadThemePreference,
  saveThemePreference,
  type ThemePreference,
  watchSystemTheme,
} from "./theme";
import { SettingsView } from "./SettingsView";
import {
  AiWorkflow,
  AudioPlayer,
  CommandPalette,
  type Command,
  EditorField,
  Empty,
  GlobalSearch,
  GenerationModal,
  IconButton,
  MarkdownField,
  LiveMeetingStage,
  MeetingQaPanel,
  MeetingSidebar,
  OnboardingModal,
  Popover,
  ProgressModal,
  RailItem,
  RecordingCheckModal,
  SpeakerTimeline,
  StatusDot,
  stripHtml,
  TaskComposer,
  TaskRow,
  Tasks,
  TitleBar,
  UpdateModal,
  WeeklyReportModal,
} from "./components";

const emptyWorkspace: Workspace = {
  meetings: [],
  tasks: [],
};
const PROCESSING_JOB_KEY = "zhiji:processing-job";
type RecordingPhase = "idle" | "checking" | "starting" | "recording" | "finalizing";
type InterruptedProcessingJob = {
  stage: Exclude<Processing, null>;
  meetingId: string;
  startedAt: number;
};

function interruptedJobCopy(stage: Exclude<Processing, null>) {
  if (["transcribing", "speakerTranscribing", "autoTranscribing"].includes(stage)) {
    return {
      title: "上次转写没有完成",
      detail: "原录音仍然完整保留，可以回到会议后重新转写。",
    };
  }
  if (["analyzing", "applyingAnalysis", "regeneratingMinutes", "regeneratingDecisions", "regeneratingTasks", "renaming"].includes(stage)) {
    return {
      title: "上次智能处理没有完成",
      detail: "原文和已保存内容没有丢失，可以回到会议后重新操作。",
    };
  }
  if (["downloading", "installingSpeaker", "checkingLiveEngine"].includes(stage)) {
    return {
      title: "上次引擎准备没有完成",
      detail: "可以在设置中重新检查或继续下载。",
    };
  }
  return {
    title: "上次处理没有完成",
    detail: "已保存的数据不会丢失，可以重新执行这项操作。",
  };
}

function interruptedProcessingJob(): InterruptedProcessingJob | null {
  try {
    const saved = localStorage.getItem(PROCESSING_JOB_KEY);
    if (!saved) return null;
    const job = JSON.parse(saved) as Partial<InterruptedProcessingJob>;
    if (typeof job.stage !== "string" || typeof job.startedAt !== "number") return null;
    return {
      stage: job.stage as Exclude<Processing, null>,
      meetingId: typeof job.meetingId === "string" ? job.meetingId : "",
      startedAt: job.startedAt,
    };
  } catch {
    return null;
  }
}
const emptyLiveTranscript: LiveTranscriptState = {
  meetingId: "",
  sessionId: "",
  lastSequence: 0,
  phase: "idle",
  ready: false,
  text: "",
  partial: "",
  partialId: "",
  partialSource: "",
  segments: [],
  warning: "",
  listeningSources: [],
  microphoneLevel: 0,
  systemLevel: 0,
  qualityState: "loading",
  refiningCount: 0,
};
const defaultAiSettings: AiSettings = {
  baseUrl: "https://api.openai.com/v1",
  analysisModel: "gpt-4o-mini",
  isConfigured: false,
};
const defaultAsrStatus: LocalAsrStatus = {
  installed: false,
  runtimeAvailable: false,
  modelSizeMb: 0,
};
const defaultSpeakerStatus: SpeakerEngineStatus = {
  installed: false,
  modelsReady: false,
};
const defaultAsrEngine: AsrEngineSettings = {
  provider: "local",
  cloudBaseUrl: "https://api.siliconflow.cn/v1",
  cloudModel: "FunAudioLLM/SenseVoiceSmall",
  cloudKeySaved: false,
  localHotwords: "",
};
const LIVE_AUDIO_BACKLOG_WARNING = "实时字幕处理暂时落后，正在补齐；完整录音不会受影响。";

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function pcmBase64(samples: Int16Array) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

class StreamingPcmResampler {
  private readonly ratio: number;
  private buffer = new Float32Array(0);
  private position = 0;

  constructor(inputRate: number, outputRate = 16000) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array) {
    if (!input.length) return new Int16Array(0);
    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer);
    merged.set(input, this.buffer.length);
    this.buffer = merged;

    const values: number[] = [];
    while (this.position + 1 < this.buffer.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const sample = this.buffer[left] * (1 - fraction) + this.buffer[left + 1] * fraction;
      const value = Math.max(-1, Math.min(1, sample));
      values.push(value < 0 ? Math.round(value * 32768) : Math.round(value * 32767));
      this.position += this.ratio;
    }

    const consumed = Math.floor(this.position);
    if (consumed > 0) {
      this.buffer = this.buffer.slice(consumed);
      this.position -= consumed;
    }
    return Int16Array.from(values);
  }
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// 首页用的相对时间标签：今天 14:30 / 昨天 09:12 / 8月5日 16:40
function meetingTimeLabel(value: string) {
  const d = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(d);
  if (sameDay(d, now)) return `今天 ${time}`;
  if (sameDay(d, yesterday)) return `昨天 ${time}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

// 分组分隔文案：今天 / 昨天 / 更早
function daySeparator(value: string) {
  const d = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return "今天";
  if (sameDay(d, yesterday)) return "昨天";
  return "更早";
}

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "凌晨好";
  if (h < 12) return "上午好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function todayFullDate() {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());
}

function updateErrorMessage(error: unknown) {
  const message = String(error).replace(/^Error:\s*/i, "").trim();
  if (!message) return "更新服务暂时不可用，请稍后重试。";
  if (/timed?\s*out|timeout/i.test(message)) return "连接 GitHub 超时，请检查网络后重试。";
  if (/signature|verify|public key/i.test(message)) return "更新包签名校验失败，已停止安装以保护数据安全。";
  if (/network|connect|dns|request|download/i.test(message)) return `无法连接更新服务：${message}`;
  return message;
}

function safeExportName(value: string) {
  const cleaned = value.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim();
  return cleaned || "会议纪要";
}

function minuteSources(markdown: string) {
  const matches = markdown.matchAll(/【来源\s*(\d{1,3}):(\d{2})】/g);
  const seen = new Set<number>();
  return Array.from(matches)
    .map((match) => Number(match[1]) * 60 + Number(match[2]))
    .filter((seconds) => Number.isFinite(seconds) && !seen.has(seconds) && Boolean(seen.add(seconds)));
}

function newTask(
  title: string,
  sourceType: string | null = null,
  sourceId: string | null = null,
): Task {
  return {
    id: crypto.randomUUID(),
    title,
    sourceType,
    sourceId,
    completed: false,
    dueDate: null,
    createdAt: new Date().toISOString(),
    owner: "",
  };
}

export function App() {
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettings>(defaultAiSettings);
  const [asrStatus, setAsrStatus] = useState<LocalAsrStatus>(defaultAsrStatus);
  const [speakerStatus, setSpeakerStatus] =
    useState<SpeakerEngineStatus>(defaultSpeakerStatus);
  const [asrEngine, setAsrEngine] = useState<AsrEngineSettings>(defaultAsrEngine);
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(defaultRecordingSettings);
  const [asrKeyInput, setAsrKeyInput] = useState("");
  const [autoSaveHint, setAutoSaveHint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [view, setView] = useState<View>("home");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>("idle");
  const [activeRecordingMeetingId, setActiveRecordingMeetingId] = useState("");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingCandidate, setRecordingCandidate] = useState<Meeting | null>(null);
  const [recordingSession, setRecordingSession] = useState<RecordingSessionStatus | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<LiveTranscriptState>(emptyLiveTranscript);
  const [processing, setProcessing] = useState<Processing>(null);
  const [processingMeetingId, setProcessingMeetingId] = useState("");
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const [processingCancelRequested, setProcessingCancelRequested] = useState(false);
  const [interruptedJob, setInterruptedJob] = useState<InterruptedProcessingJob | null>(interruptedProcessingJob);
  const recorder = useRef<MediaRecorder | null>(null);
  const liveCaptureCleanup = useRef<(() => void) | null>(null);
  const liveAudioQueue = useRef<Promise<void>>(Promise.resolve());
  const liveAudioPendingCount = useRef(0);
  const liveAudioWritable = useRef(false);
  const pendingUpdateRef = useRef<Update | null>(null);
  const recordingSecondsRef = useRef(0);
  const asrStatusRef = useRef(asrStatus);
  const speakerStatusRef = useRef(speakerStatus);
  const asrEngineRef = useRef(asrEngine);
  const savedSnapshot = useRef<{ id: string; json: string }>({ id: "", json: "" });
  const processingWasActive = useRef(false);
  const processingMeetingIdRef = useRef("");
  const selectedMeetingRef = useRef<Meeting | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const allowWindowCloseRef = useRef(false);
  selectedMeetingRef.current = selectedMeeting;
  const recording = recordingPhase === "recording";
  const recordingBusy = recordingPhase !== "idle";
  const recordingWorkspaceLocked = recordingPhase === "starting" || recordingPhase === "recording" || recordingPhase === "finalizing";

  const [updateState, setUpdateState] = useState<
    "idle" | "checking" | "available" | "latest" | "downloading" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [currentVersion, setCurrentVersion] = useState("");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState("");
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showGeneration, setShowGeneration] = useState(false);
  const [weeklyReportOpen, setWeeklyReportOpen] = useState(false);
  const [analysisPreview, setAnalysisPreview] = useState<AnalysisPreview | null>(null);
  const [analysisTemplate, setAnalysisTemplate] = useState<MeetingTemplate>(() =>
    (localStorage.getItem("zhiji:analysis-template") as MeetingTemplate | null) ?? "general"
  );
  // 外观主题：浅色 / 深色 / 跟随系统（纯前端偏好，默认跟随系统）
  const [themePref, setThemePref] = useState<ThemePreference>(() => loadThemePreference());

  const rememberUpdate = useCallback(async (next: Update | null) => {
    const previous = pendingUpdateRef.current;
    if (previous && previous !== next) {
      await previous.close().catch(() => undefined);
    }
    pendingUpdateRef.current = next;
  }, []);

  // 应用外观主题：随偏好/系统切换，把 data-theme 挂到 <html> 触发 tokens 换肤。
  // 跟随系统时监听系统变化实时切换；固定主题时无需监听。
  useEffect(() => {
    applyTheme(themePref);
    if (themePref === "system") {
      return watchSystemTheme(() => applyTheme("system"));
    }
    return undefined;
  }, [themePref]);

  const changeTheme = useCallback((pref: ThemePreference) => {
    setThemePref(pref);
    saveThemePreference(pref);
  }, []);

  useEffect(() => {
    asrStatusRef.current = asrStatus;
  }, [asrStatus]);
  useEffect(() => {
    speakerStatusRef.current = speakerStatus;
  }, [speakerStatus]);
  useEffect(() => {
    asrEngineRef.current = asrEngine;
  }, [asrEngine]);
  const beginProcessing = (stage: Exclude<Processing, null>, meetingId = "") => {
    processingMeetingIdRef.current = meetingId;
    setProcessingMeetingId(meetingId);
    setProcessingSeconds(0);
    setProcessing(stage);
  };

  const finishProcessing = () => {
    setProcessing(null);
    setProcessingMeetingId("");
    processingMeetingIdRef.current = "";
  };

  const persistMeeting = useCallback(async (meeting: Meeting) => {
    await invoke("save_meeting", { meeting });
    const target = { id: meeting.id, json: JSON.stringify(meeting) };
    savedSnapshot.current = target;
    setWorkspace((current) => ({
      ...current,
      meetings: current.meetings.map((item) => item.id === meeting.id ? meeting : item),
    }));
    setAutoSaveHint("已自动保存");
  }, []);

  useEffect(() => {
    setProcessingCancelRequested(false);
    if (processing) {
      processingWasActive.current = true;
      setInterruptedJob(null);
      localStorage.setItem(PROCESSING_JOB_KEY, JSON.stringify({
        stage: processing,
        meetingId: processingMeetingIdRef.current,
        startedAt: Date.now(),
      } satisfies InterruptedProcessingJob));
      return;
    }
    if (processingWasActive.current) {
      processingWasActive.current = false;
      localStorage.removeItem(PROCESSING_JOB_KEY);
    }
  }, [processing]);

  useEffect(() => {
    if (!processing) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setProcessingSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [processing]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<{ meetingId: string; event: Record<string, unknown> }>("zhiji://live-transcript", ({ payload }) => {
      const event = payload.event;
      const type = String(event.type ?? "");
      setLiveTranscript((current) => {
        if (current.meetingId && current.meetingId !== payload.meetingId) return current;
        const sessionId = String(event.sessionId ?? "");
        const sequence = Math.max(0, Number(event.sequence ?? 0));
        // 每次录音只接收自己的有序事件。这样模型自动重启或事件重复投递时，
        // 旧状态不会覆盖新字幕，同一句 final 也不会重复追加。
        if (!current.sessionId && sessionId && type !== "starting" && type !== "ready") return current;
        if (current.sessionId && sessionId && current.sessionId !== sessionId) return current;
        if (sessionId && current.sessionId === sessionId && sequence > 0 && sequence <= current.lastSequence) {
          return current;
        }
        const next = {
          ...current,
          meetingId: payload.meetingId,
          sessionId: current.sessionId || sessionId,
          lastSequence: sequence > 0 ? sequence : current.lastSequence,
        };
        if (type === "ready") {
          next.ready = true;
          next.phase = "running";
          next.warning = "";
        }
        if (type === "starting") {
          next.ready = false;
          next.phase = "starting";
          next.warning = "";
        }
        if (type === "restarting") {
          next.ready = false;
          next.phase = "recovering";
          next.warning = "";
          next.partial = "";
          next.partialId = "";
          next.partialSource = "";
          next.listeningSources = [];
          next.refiningCount = 0;
        }
        if (type === "degraded") {
          next.ready = false;
          next.phase = "degraded";
          next.partial = "";
          next.partialId = "";
          next.partialSource = "";
          next.warning = String(event.message ?? "本场会议已切换为会后校正");
          next.refiningCount = 0;
        }
        if (type === "finished") {
          next.ready = false;
          next.phase = "finished";
        }
        if (type === "listening") {
          const source = String(event.source ?? "microphone");
          if (!next.listeningSources.includes(source)) next.listeningSources = [...next.listeningSources, source];
        }
        if (type === "level") {
          const level = Math.max(0, Math.min(1, Number(event.level ?? 0)));
          if (event.source === "system") next.systemLevel = level;
          else next.microphoneLevel = level;
        }
        if (type === "partial") {
          next.text = String(event.transcript ?? next.text);
          next.partial = String(event.partial ?? "");
          next.partialId = String(event.utteranceId ?? "");
          next.partialSource = String(event.source ?? "microphone");
        }
        if (type === "quality-loading") next.qualityState = "loading";
        if (type === "quality-ready") next.qualityState = "ready";
        if (type === "quality-unavailable") {
          next.qualityState = "fallback";
          next.warning = String(event.message ?? "本场使用实时初稿，会后仍会完整校正");
        }
        if (type === "refining") {
          next.refiningCount += 1;
        }
        if (type === "refining-done") {
          next.refiningCount = Math.max(0, next.refiningCount - 1);
        }
        if (type === "final") {
          const text = String(event.text ?? "").trim();
          next.text = String(event.transcript ?? next.text);
          const utteranceId = String(event.utteranceId ?? "");
          if (!utteranceId || !next.partialId || next.partialId === utteranceId) {
            next.partial = "";
            next.partialId = "";
            next.partialSource = "";
          }
          if (text) {
            const source = event.source === "system" ? "system" : "microphone";
            const startMs = Number(event.startMs ?? 0);
            const endMs = Number(event.endMs ?? 0);
            const duplicate = next.segments.some((segment) =>
              segment.speakerId === (source === "system" ? 1 : 0)
              && segment.startMs === startMs
              && segment.endMs === endMs
              && segment.text === text
            );
            if (!duplicate) {
              next.segments = [...next.segments, {
                speaker: source === "system" ? "会议声音" : "我",
                speakerId: source === "system" ? 1 : 0,
                startMs,
                endMs,
                text,
                refined: Boolean(event.refined),
              }].sort((left, right) => left.startMs - right.startMs);
            }
          }
        }
        if (type === "warning") next.warning = String(event.message ?? "实时转写出现异常");
        if (type === "quality-warning") next.qualityState = "fallback";
        return next;
      });
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const update = await check({ timeout: 15_000 });
        if (!active) {
          await update?.close().catch(() => undefined);
          return;
        }
        if (update) {
          await rememberUpdate(update);
          setUpdateVersion(update.version);
          setUpdateError("");
          setUpdateState("available");
          setShowUpdateModal(true);
        } else {
          await rememberUpdate(null);
          setUpdateState("latest");
        }
      } catch (error) {
        if (!active) return;
        setUpdateError(updateErrorMessage(error));
        setUpdateState("error");
        // 启动时不弹窗打扰，错误会保留在设置页供诊断
      }
    })();
    return () => {
      active = false;
    };
  }, [rememberUpdate]);

  const reload = async () => {
    const next = await invoke<Workspace>("load_workspace");
    setWorkspace(next);
    return next;
  };

  const notify = useCallback((next: string) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setMessage(next);
    toastTimerRef.current = window.setTimeout(() => {
      setMessage("");
      toastTimerRef.current = null;
    }, 4200);
  }, []);

  const flushSelectedMeeting = useCallback(async () => {
    const current = selectedMeetingRef.current;
    if (!current) return;
    const json = JSON.stringify(current);
    if (savedSnapshot.current.id === current.id && savedSnapshot.current.json === json) return;
    await persistMeeting(current);
  }, [persistMeeting]);

  const openRecordingMeeting = useCallback(() => {
    if (!activeRecordingMeetingId) return;
    const activeMeeting = (selectedMeetingRef.current?.id === activeRecordingMeetingId ? selectedMeetingRef.current : null)
      ?? workspace.meetings.find((meeting) => meeting.id === activeRecordingMeetingId);
    if (activeMeeting) setSelectedMeeting(activeMeeting);
    setView("meetings");
  }, [activeRecordingMeetingId, workspace.meetings]);

  const selectMeeting = useCallback(async (meeting: Meeting | null) => {
    if (recordingBusy && activeRecordingMeetingId && meeting?.id !== activeRecordingMeetingId) {
      notify(recordingPhase === "finalizing" ? "录音正在安全保存，请稍候" : "录音仍在进行，已返回当前会议");
      openRecordingMeeting();
      return;
    }
    try {
      await flushSelectedMeeting();
      setSelectedMeeting(meeting);
    } catch (error) {
      notify(`当前会议尚未保存，已阻止切换：${String(error)}`);
    }
  }, [activeRecordingMeetingId, flushSelectedMeeting, notify, openRecordingMeeting, recordingBusy, recordingPhase]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWindow().onCloseRequested(async (event) => {
      if (allowWindowCloseRef.current) return;
      if (recordingWorkspaceLocked) {
        event.preventDefault();
        notify(recordingPhase === "finalizing"
          ? "正在安全保存录音，完成后才能关闭知记"
          : "会议仍在录音，请先结束录音并等待保存完成");
        openRecordingMeeting();
        return;
      }
      const current = selectedMeetingRef.current;
      if (!current) return;
      const json = JSON.stringify(current);
      if (savedSnapshot.current.id === current.id && savedSnapshot.current.json === json) return;
      event.preventDefault();
      // 未保存修改：先自动保存。若 6 秒内未完成或保存失败，询问用户是否放弃修改直接关闭，
      // 避免「自动保存异常导致窗口永远关不掉」（只能从托盘退出的问题）。
      const saved = await Promise.race([
        persistMeeting(current).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 6000)),
      ]);
      if (!saved) {
        const force = window.confirm("会议自动保存没有完成。仍要关闭知记吗？最近的修改可能丢失。");
        if (!force) return;
      }
      allowWindowCloseRef.current = true;
      await getCurrentWindow().close().catch(() => undefined);
    }).then((dispose) => { unlisten = dispose; });
    return () => unlisten?.();
  }, [notify, openRecordingMeeting, persistMeeting, recordingPhase, recordingWorkspaceLocked]);

  const manualCheck = async () => {
    setUpdateState("checking");
    setUpdateError("");
    try {
      const update = await check({ timeout: 20_000 });
      if (update) {
        await rememberUpdate(update);
        setUpdateVersion(update.version);
        setUpdateState("available");
        setShowUpdateModal(true);
      } else {
        await rememberUpdate(null);
        setUpdateState("latest");
        notify("已是最新版本");
      }
    } catch (error: unknown) {
      const message = updateErrorMessage(error);
      setUpdateError(message);
      setUpdateState("error");
      notify(`检查更新失败：${message}`);
    }
  };

  const installUpdate = async () => {
    try {
      setUpdateError("");
      const update = pendingUpdateRef.current ?? await check({ timeout: 20_000 });
      if (!update) {
        setShowUpdateModal(false);
        setUpdateState("latest");
        return;
      }
      pendingUpdateRef.current = update;
      setUpdateVersion(update.version);
      setUpdateState("downloading");
      setUpdateProgress(0);
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) {
            setUpdateProgress(Math.round((downloaded / total) * 100));
          }
        }
      }, { timeout: 10 * 60_000 });
      pendingUpdateRef.current = null;
      await relaunch();
    } catch (error: unknown) {
      const message = updateErrorMessage(error);
      setUpdateError(message);
      setUpdateState("error");
      notify(`更新失败：${message}`);
    }
  };

  useEffect(() => {
    let active = true;
    void Promise.all([
      invoke<number>("recover_interrupted_recordings").then(async (count) => {
        await reload();
        return count;
      }),
      invoke<AiSettings>("get_ai_settings"),
      invoke<LocalAsrStatus>("get_local_asr_status"),
      invoke<SpeakerEngineStatus>("get_speaker_engine_status"),
      invoke<AsrEngineSettings>("get_asr_engine_settings"),
      invoke<RecordingSettings>("get_recording_settings"),
      invoke<BackupInfo[]>("list_backups"),
      getVersion(),
    ])
      .then(([recovered, settings, asr, speaker, engine, recording, storedBackups, version]) => {
        if (!active) return;
        setAiSettings(settings);
        setAsrStatus(asr);
        setSpeakerStatus(speaker);
        setAsrEngine(engine);
        if (recording) setRecordingSettings(recording);
        setBackups(storedBackups);
        setCurrentVersion(version);
        setShowOnboarding(localStorage.getItem("zhiji:onboarding-complete") !== "1");
        if (recovered > 0) notify(`已恢复 ${recovered} 段上次意外中断的录音。`);
      })
      .catch(
        (error: unknown) =>
          active && notify(`无法打开本地资料库：${String(error)}`),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      recordingSecondsRef.current += 1;
      setRecordingSeconds(recordingSecondsRef.current);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    if (loading || workspace.tasks.length === 0) return;
    const today = localDateKey();
    if (localStorage.getItem("zhiji:task-reminder-date") === today) return;
    const overdue = workspace.tasks.filter((task) => taskDueState(task) === "overdue").length;
    const dueToday = workspace.tasks.filter((task) => taskDueState(task) === "today").length;
    if (overdue || dueToday) {
      localStorage.setItem("zhiji:task-reminder-date", today);
      notify(`${overdue ? `${overdue} 项待办已逾期` : ""}${overdue && dueToday ? "，" : ""}${dueToday ? `${dueToday} 项今天到期` : ""}`);
    }
  }, [loading, workspace.tasks]);

  // 自动保存：选中会议内容变化后 1.5 秒无操作即静默保存（不打断输入，不刷新列表）
  useEffect(() => {
    if (!selectedMeeting) return;
    if (processingMeetingId === selectedMeeting.id) {
      setAutoSaveHint("处理完成后继续保存");
      return;
    }
    const snap = savedSnapshot.current;
    if (snap.id !== selectedMeeting.id) {
      savedSnapshot.current = { id: selectedMeeting.id, json: JSON.stringify(selectedMeeting) };
      setAutoSaveHint("");
      return;
    }
    setAutoSaveHint("有未保存更改…");
    const timer = window.setTimeout(() => {
      void (async () => {
        const target = { id: selectedMeeting.id, json: JSON.stringify(selectedMeeting) };
        if (savedSnapshot.current.id === target.id && savedSnapshot.current.json === target.json) {
          setAutoSaveHint("已自动保存");
          return;
        }
        try {
          await persistMeeting(selectedMeeting);
        } catch (error) {
          setAutoSaveHint(`自动保存失败：${String(error)}`);
        }
      })();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [selectedMeeting, persistMeeting, processingMeetingId]);

  const deferredQuery = useDeferredValue(query);
  const filteredMeetings = useMemo(
    () =>
      workspace.meetings.filter((meeting) =>
        `${meeting.title} ${meeting.transcript} ${meeting.minutes}`
          .toLowerCase()
          .includes(deferredQuery.toLowerCase()),
      ),
    [deferredQuery, workspace.meetings],
  );

  const createMeeting = async () => {
    if (recordingBusy) {
      notify(recordingPhase === "finalizing" ? "录音正在安全保存，请稍候" : "请先结束当前录音");
      openRecordingMeeting();
      return;
    }
    try {
      await flushSelectedMeeting();
    } catch (error) {
      notify(`当前会议尚未保存，已阻止新建：${String(error)}`);
      return;
    }
    const meeting = await invoke<Meeting>("create_meeting", { notebookId: null });
    setSelectedMeeting(meeting);
    setView("meetings");
    await reload();
  };

  const quickRecord = async () => {
    if (recordingBusy) {
      notify(recordingPhase === "finalizing" ? "录音正在安全保存，请稍候" : "当前会议仍在录音");
      openRecordingMeeting();
      return;
    }
    if (processing) {
      notify("请先等待当前处理结束或取消转写");
      return;
    }
    try {
      await flushSelectedMeeting();
    } catch (error) {
      notify(`当前会议尚未保存，已阻止开始新录音：${String(error)}`);
      return;
    }
    const meeting = await invoke<Meeting>("create_meeting", { notebookId: null });
    setSelectedMeeting(meeting);
    setView("meetings");
    await reload();
    requestRecording(meeting);
  };

  const importMeetingAudio = async () => {
    if (!selectedMeeting) return;
    if (
      selectedMeeting.audioPath &&
      !window.confirm(
        "这场会议已有录音。继续导入会替换应用内的旧录音，是否继续？",
      )
    )
      return;
    try {
      const audioPath = await open({
        multiple: false,
        directory: false,
        title: "导入会议录音",
        filters: [
          {
            name: "音频文件",
            extensions: [
              "wav",
              "mp3",
              "m4a",
              "aac",
              "flac",
              "ogg",
              "opus",
              "webm",
              "wma",
              "mp4",
            ],
          },
        ],
      });
      if (!audioPath) return;
      beginProcessing("importing", selectedMeeting.id);
      const meeting = await invoke<Meeting>("import_meeting_audio", {
        meetingId: selectedMeeting.id,
        audioPath,
      });
      if (selectedMeetingRef.current?.id === meeting.id) setSelectedMeeting(meeting);
      await reload();
      notify("录音已导入到本地资料库，可以开始转写");
    } catch (error) {
      notify(`导入录音失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const deleteMeeting = async () => {
    if (!selectedMeeting) return;
    if (
      !window.confirm(
        `确定删除“${selectedMeeting.title}”吗？\n\n会议、应用内录音和该会议生成的待办将被删除，此操作无法撤销。`,
      )
    )
      return;
    try {
      beginProcessing("deleting", selectedMeeting.id);
      const deletedId = selectedMeeting.id;
      await invoke("delete_meeting", { meetingId: deletedId });
      const latest = await reload();
      setSelectedMeeting(
        latest.meetings.find((meeting) => meeting.id !== deletedId) ?? null,
      );
      notify("会议已删除");
    } catch (error) {
      notify(`删除会议失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const exportMeeting = async () => {
    if (!selectedMeeting) return;
    try {
      const targetPath = await save({
        title: "导出会议纪要",
        defaultPath: `${safeExportName(selectedMeeting.title)}.md`,
        filters: [{ name: "Markdown 文档", extensions: ["md"] }],
      });
      if (!targetPath) return;
      await invoke<string>("export_meeting_markdown", {
        meetingId: selectedMeeting.id,
        targetPath,
      });
      notify("会议已导出为 Markdown 文档");
    } catch (error) {
      notify(`导出会议失败：${String(error)}`);
    }
  };

  const copyMeeting = async () => {
    if (!selectedMeeting) return;
    const content = stripHtml(selectedMeeting.minutes).trim()
      || selectedMeeting.transcript.trim()
      || selectedMeeting.notes.trim();
    if (!content) {
      notify("当前会议还没有可以复制的内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      notify("会议内容已复制");
    } catch (error) {
      notify(`复制失败：${String(error)}`);
    }
  };

  const revealRecording = async () => {
    if (!selectedMeeting) return;
    try {
      await invoke("reveal_recording", { meetingId: selectedMeeting.id });
    } catch (error) {
      notify(`无法打开录音位置：${String(error)}`);
    }
  };

  const refreshBackups = async () => {
    const storedBackups = await invoke<BackupInfo[]>("list_backups");
    setBackups(storedBackups);
  };

  const createManualBackup = async () => {
    try {
      await invoke<BackupInfo>("create_backup");
      await refreshBackups();
      notify("本地资料已完成备份");
    } catch (error) {
      notify(`创建备份失败：${String(error)}`);
    }
  };

  const restoreStoredBackup = async (backup: BackupInfo) => {
    if (!backup.isValid) {
      notify("这份备份未通过完整性检查，已阻止恢复");
      return;
    }
    const contents = `${backup.meetingCount} 场会议、${backup.taskCount} 个待办`;
    if (!window.confirm(`确定恢复 ${new Date(backup.createdAt).toLocaleString("zh-CN")} 的备份吗？\n\n备份内容：${contents}\n当前资料会先自动备份，然后替换为所选版本。`)) return;
    try {
      await invoke<Workspace>("restore_backup", { fileName: backup.fileName });
      notify("备份恢复完成，正在重新载入资料");
      window.setTimeout(() => window.location.reload(), 500);
    } catch (error) {
      notify(`恢复备份失败：${String(error)}`);
    }
  };

  const openBackupsFolder = async () => {
    try {
      await invoke("open_backups_folder");
    } catch (error) {
      notify(`无法打开备份目录：${String(error)}`);
    }
  };

  const exportDiagnostics = async () => {
    try {
      const targetPath = await save({
        title: "导出知记诊断信息",
        defaultPath: `zhiji-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: "JSON 文件", extensions: ["json"] }],
      });
      if (!targetPath) return;
      await invoke<string>("export_diagnostics", { targetPath });
      notify("诊断信息已导出，内容不包含录音、转写和密钥");
    } catch (error) {
      notify(`导出诊断信息失败：${String(error)}`);
    }
  };

  const exportAllMarkdown = async () => {
    try {
      const targetDir = await open({
        title: "选择 Markdown 导出目录",
        directory: true,
      });
      if (!targetDir || Array.isArray(targetDir)) return;
      const result = await invoke<string>("export_all_markdown", { targetDir });
      notify(result);
    } catch (error) {
      notify(`导出失败：${String(error)}`);
    }
  };

  const addTask = async (
    title: string,
    dueDate: string | null = null,
    sourceType: string | null = null,
    sourceId: string | null = null,
  ) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await invoke("upsert_task", {
      task: { ...newTask(trimmed, sourceType, sourceId), dueDate },
    });
    await reload();
    notify("已加入待办");
  };

  const saveTask = async (task: Task) => {
    await invoke("upsert_task", { task });
    await reload();
  };

  const deleteTask = async (task: Task) => {
    if (!window.confirm(`确定删除待办“${task.title}”吗？`)) return;
    await invoke("delete_task", { taskId: task.id });
    await reload();
  };

  const toggleTask = async (task: Task) => {
    await invoke("upsert_task", {
      task: { ...task, completed: !task.completed },
    });
    await reload();
  };

  const requestRecording = (presetMeeting?: Meeting) => {
    if (recordingBusy) {
      notify(recordingPhase === "finalizing" ? "录音正在安全保存，请稍候" : "当前会议仍在录音");
      openRecordingMeeting();
      return;
    }
    if (processing) {
      notify("请先等待当前处理结束或取消转写");
      return;
    }
    const meeting = presetMeeting ?? selectedMeeting;
    if (!meeting) {
      notify("请先新建或打开一场会议");
      return;
    }
    if (meeting.audioPath && !window.confirm("这场会议已有录音。重新录音会替换旧录音，是否继续？")) return;
    setRecordingPhase("checking");
    setRecordingCandidate(meeting);
  };

  const startMicrophoneLiveCapture = async (
    stream: MediaStream,
    meetingId: string,
    context: AudioContext,
    contextReady: Promise<void>,
  ) => {
    await contextReady;
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") {
      await context.close();
      throw new Error("麦克风实时音频通道未能启动");
    }
    await context.audioWorklet.addModule("/zhiji-pcm-capture.js");
    const source = context.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(context, "zhiji-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      outputChannelCount: [1],
    });
    const silent = context.createGain();
    silent.gain.value = 0;
    let pending = new Int16Array(0);
    // 保留跨 AudioWorklet 数据块的分数采样位置，避免 44.1kHz 设备每 4096 帧产生一次断点和时间漂移。
    const resampler = new StreamingPcmResampler(context.sampleRate);
    let lastLevelAt = 0;
    const send = (samples: Int16Array) => {
      if (!liveAudioWritable.current) return;
      const audioBase64 = pcmBase64(samples);
      liveAudioPendingCount.current += 1;
      if (liveAudioPendingCount.current >= 8) {
        setLiveTranscript((current) => ({
          ...current,
          warning: current.warning || LIVE_AUDIO_BACKLOG_WARNING,
        }));
      }
      liveAudioQueue.current = liveAudioQueue.current
        .then(async () => {
          try {
            await invoke("append_live_audio", { meetingId, audioBase64 });
          } catch (error) {
            liveAudioWritable.current = false;
            const message = String(error);
            setLiveTranscript((current) => ({
              ...current,
              ready: false,
              phase: "degraded",
              warning: message.includes("会后校正")
                ? message
                : `实时音频写入失败：${message}`,
            }));
          }
        })
        .finally(() => {
          const remaining = Math.max(0, liveAudioPendingCount.current - 1);
          liveAudioPendingCount.current = remaining;
          if (remaining <= 2) {
            setLiveTranscript((current) => current.warning === LIVE_AUDIO_BACKLOG_WARNING
              ? { ...current, warning: "" }
              : current);
          }
        });
    };
    processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const input = event.data;
      const chunk = resampler.push(input);
      const now = performance.now();
      if (now - lastLevelAt > 250) {
        let energy = 0;
        for (const sample of input) energy += sample * sample;
        const level = Math.min(1, Math.sqrt(energy / Math.max(1, input.length)) * 8);
        setLiveTranscript((current) => ({ ...current, microphoneLevel: level }));
        lastLevelAt = now;
      }
      const combined = new Int16Array(pending.length + chunk.length);
      combined.set(pending);
      combined.set(chunk, pending.length);
      let offset = 0;
      while (combined.length - offset >= 9600) {
        send(combined.slice(offset, offset + 9600));
        offset += 9600;
      }
      pending = combined.slice(offset);
    };
    source.connect(processor);
    processor.connect(silent);
    silent.connect(context.destination);
    liveCaptureCleanup.current = () => {
      processor.port.onmessage = null;
      processor.port.close();
      source.disconnect();
      processor.disconnect();
      silent.disconnect();
      if (pending.length) send(pending);
      liveAudioWritable.current = false;
      pending = new Int16Array(0);
      void context.close();
      liveCaptureCleanup.current = null;
    };
  };

  const startRecording = async (
    stream: MediaStream,
    microphoneLabel: string,
    captureSystemAudio: boolean,
    presetMeeting?: Meeting,
  ) => {
    const meeting = presetMeeting ?? selectedMeeting;
    setRecordingCandidate(null);
    if (!meeting) {
      setRecordingPhase("idle");
      stream.getTracks().forEach((track) => track.stop());
      notify("没有找到要录制的会议");
      return;
    }
    // 必须在用户点击“开始录音”的同步调用栈中创建并唤醒 AudioContext；
    // 等后端模型启动后再创建，Windows WebView 可能因自动播放策略保持 suspended。
    // 优先让 Web Audio 使用浏览器内建的高质量重采样；不支持 16kHz 时再由连续重采样器兜底。
    let liveContext: AudioContext;
    try {
      liveContext = new AudioContext({ sampleRate: 16000 });
    } catch {
      liveContext = new AudioContext();
    }
    const liveContextReady = liveContext.resume().catch(() => undefined);
    setActiveRecordingMeetingId(meeting.id);
    setRecordingPhase("starting");
    try {
      const meetingId = meeting.id;
      // 先在后端建好空文件，录音过程中每 10 秒追加一段，意外退出时尽量保留已录内容。
      setLiveTranscript({ ...emptyLiveTranscript, meetingId });
      liveAudioQueue.current = Promise.resolve();
      liveAudioPendingCount.current = 0;
      liveAudioWritable.current = false;
      const begin = await invoke<BeginRecordingResult>("begin_recording", { meetingId, captureSystem: captureSystemAudio });
      if (begin.warning) notify(begin.warning);
      if (begin.liveEnabled) {
        try {
          // 前端只负责采集。后端保留少量启动前声音，并统一处理启动、恢复、停止和会后降级。
          liveAudioWritable.current = true;
          await startMicrophoneLiveCapture(stream, meetingId, liveContext, liveContextReady);
        } catch (error) {
          liveAudioWritable.current = false;
          await liveContext.close().catch(() => undefined);
          const warning = `麦克风实时字幕未启动：${String(error)}。录音仍会正常保存。`;
          setLiveTranscript((current) => ({ ...current, phase: "degraded", warning }));
          notify(warning);
        }
      } else {
        await liveContext.close().catch(() => undefined);
      }
      const mediaRecorder = new MediaRecorder(stream);
      let chunkQueue: Promise<void> = Promise.resolve();
      let chunkFailed = "";
      let stopping = false;

      const stopAfterIssue = (warning: string) => {
        if (stopping || mediaRecorder.state === "inactive") return;
        stopping = true;
        setRecordingSession((current) => current ? { ...current, warning } : current);
        notify(warning);
        setRecordingPhase("finalizing");
        void invoke("stop_recording_capture", { meetingId });
        mediaRecorder.stop();
      };

      stream.getAudioTracks().forEach((track) => {
        track.onended = () => stopAfterIssue("麦克风已断开，正在保存已经录到的内容。");
      });
      mediaRecorder.onerror = () => stopAfterIssue("录音设备出现异常，正在保存已经录到的内容。");
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        const blob = event.data;
        chunkQueue = chunkQueue.then(async () => {
          if (chunkFailed) return;
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(String(reader.result));
              reader.onerror = () => reject(reader.error);
              reader.readAsDataURL(blob);
            });
            await invoke("append_recording_chunk", { meetingId, dataUrl });
          } catch (error) {
            chunkFailed = String(error);
            const warning = `录音写入遇到问题：${chunkFailed}。请尽快结束录音，已写入的部分会保留。`;
            setRecordingSession((current) => current ? { ...current, warning } : current);
            notify(warning);
          }
        });
      };
      mediaRecorder.onstop = () => {
        void (async () => {
          try {
            await chunkQueue;
            liveCaptureCleanup.current?.();
            await liveAudioQueue.current;
            if (chunkFailed) {
              notify(`录音写入失败：${chunkFailed}。已保留写入成功的部分。`);
            }
            const result = await invoke<RecordingFinalizeResult>("finalize_recording", {
              meetingId,
              durationSeconds: recordingSecondsRef.current,
            });
            if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(result.meeting);
            await reload();
            if (result.warning) notify(result.warning);

            const engine = asrEngineRef.current;
            if (engine.provider === "cloud") {
              if (!engine.cloudKeySaved) {
                notify("录音已保存。请先在设置中配置云端转写密钥。");
                return;
              }
              beginProcessing("autoTranscribing", meetingId);
              try {
                const transcribed = await invoke<Meeting>("transcribe_meeting", {
                  meetingId,
                });
                if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(transcribed);
                await reload();
                notify("录音已保存，并自动完成云端转写（录音已按你的配置上传处理）。");
              } catch (error) {
                const detail = String(error);
                notify(detail.includes("已取消")
                  ? "已取消自动转写，录音仍然保留。"
                  : `云端转写失败：${detail}。可手动点击转写按钮重试。`);
              } finally {
                finishProcessing();
              }
              return;
            }

            const preciseEngineReady = speakerStatusRef.current.installed && speakerStatusRef.current.modelsReady;
            if (!preciseEngineReady && !asrStatusRef.current.installed) {
              notify("录音已保存。请在设置中下载本地语音模型后再转写。");
              return;
            }

            beginProcessing("autoTranscribing", meetingId);
            try {
              if (preciseEngineReady) {
                const meeting = await invoke<Meeting>(
                  "transcribe_meeting_with_speakers",
                  { meetingId },
                );
                if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
                setSpeakerStatus((status) => ({
                  ...status,
                  modelsReady: true,
                }));
                notify("录音已保存，并自动完成转写与说话人区分。");
              } else {
                const meeting = await invoke<Meeting>("transcribe_meeting", {
                  meetingId,
                });
                if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
                notify(
                  "录音已保存，并自动完成转写。安装本地实时会议引擎后，还可边录边出字幕并区分发言人。",
                );
              }
              await reload();
            } catch (error) {
              const detail = String(error);
              notify(detail.includes("已取消")
                ? "已取消自动转写，录音仍然保留。"
                : `自动转写失败：${detail}。可手动点击转写按钮重试。`);
            } finally {
              finishProcessing();
            }
          } catch (error) {
            notify(`保存录音失败：${String(error)}`);
          } finally {
            stream.getTracks().forEach((track) => track.stop());
            recorder.current = null;
            setRecordingSession(null);
            setActiveRecordingMeetingId("");
            setRecordingPhase("idle");
          }
        })();
      };
      recorder.current = mediaRecorder;
      recordingSecondsRef.current = 0;
      setRecordingSeconds(0);
      setRecordingSession({
        microphoneLabel,
        captureSystemAudio,
        warning: "",
        liveEnabled: begin.liveEnabled,
        liveSource: begin.liveSource,
      });
      setRecordingPhase("recording");
      mediaRecorder.start(4000);
    } catch (error) {
      liveCaptureCleanup.current?.();
      await liveContext.close().catch(() => undefined);
      await liveAudioQueue.current.catch(() => undefined);
      await invoke("abort_recording", { meetingId: meeting.id }).catch(() => undefined);
      stream.getTracks().forEach((track) => track.stop());
      setRecordingSession(null);
      setActiveRecordingMeetingId("");
      setRecordingPhase("idle");
      notify(`无法启用麦克风：${String(error)}`);
    }
  };

  const stopRecording = () => {
    if (recordingPhase !== "recording") return;
    setRecordingPhase("finalizing");
    if (activeRecordingMeetingId) void invoke("stop_recording_capture", { meetingId: activeRecordingMeetingId });
    liveCaptureCleanup.current?.();
    if (recorder.current?.state !== "inactive") {
      recorder.current?.stop();
    }
  };

  const transcribeMeeting = async () => {
    if (!selectedMeeting) return;
    const meetingId = selectedMeeting.id;
    try {
      await persistMeeting(selectedMeeting);
      beginProcessing("transcribing", meetingId);
      const meeting = await invoke<Meeting>("transcribe_meeting", {
        meetingId,
      });
      if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
      await reload();
      notify(
        asrEngine.provider === "cloud"
          ? "云端转写完成，已写入原始记录"
          : "本地语音转写完成，已写入原始记录",
      );
    } catch (error) {
      const msg = String(error);
      notify(msg.includes("已取消") ? "已取消转写" : `转写失败：${msg}`);
    } finally {
      finishProcessing();
    }
  };

  const downloadLocalAsr = async () => {
    try {
      beginProcessing("downloading");
      const status = await invoke<LocalAsrStatus>("download_local_asr_model");
      setAsrStatus(status);
      notify(`本地中文语音模型已就绪（${status.modelSizeMb} MB）`);
    } catch (error) {
      notify(`下载本地语音模型失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const openGeneration = () => {
    if (!selectedMeeting) return;
    setAnalysisPreview(null);
    setShowGeneration(true);
  };

  const generateAnalysisPreview = async () => {
    if (!selectedMeeting) return;
    const meetingId = selectedMeeting.id;
    try {
      await persistMeeting(selectedMeeting);
      beginProcessing("analyzing", meetingId);
      const preview = await invoke<AnalysisPreview>("preview_meeting_analysis", {
        meetingId,
        template: analysisTemplate,
      });
      localStorage.setItem("zhiji:analysis-template", analysisTemplate);
      if (selectedMeetingRef.current?.id === meetingId) setAnalysisPreview(preview);
    } catch (error) {
      notify(`智能分析失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const applyAnalysisPreview = async () => {
    if (!selectedMeeting || !analysisPreview) return;
    const meetingId = selectedMeeting.id;
    try {
      await persistMeeting(selectedMeeting);
      beginProcessing("applyingAnalysis", meetingId);
      const result = await invoke<AnalysisResult>("apply_meeting_analysis", {
        meetingId,
        analysis: analysisPreview,
      });
      if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(result.meeting);
      await reload();
      setShowGeneration(false);
      setAnalysisPreview(null);
      notify(`智能纪要已生成，并提取了 ${result.tasks.length} 项待办`);
    } catch (error) {
      notify(`保存智能纪要失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const regenerateMeetingSection = async (section: "minutes" | "decisions" | "tasks") => {
    if (!selectedMeeting) return;
    const meetingId = selectedMeeting.id;
    const labels = { minutes: "智能纪要", decisions: "决策与共识", tasks: "AI 提取的待办" };
    if (!window.confirm(`只重新生成“${labels[section]}”吗？其他内容和手工待办不会改变。`)) return;
    const stages = { minutes: "regeneratingMinutes", decisions: "regeneratingDecisions", tasks: "regeneratingTasks" } as const;
    try {
      await persistMeeting(selectedMeeting);
      beginProcessing(stages[section], meetingId);
      const result = await invoke<AnalysisResult>("regenerate_meeting_section", {
        meetingId,
        template: analysisTemplate,
        section,
      });
      if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(result.meeting);
      await reload();
      notify(section === "tasks" ? `已重新提取 ${result.tasks.length} 项待办，手工待办保持不变` : `${labels[section]}已重新生成`);
    } catch (error) {
      notify(`重新生成失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const renameMeeting = async () => {
    if (!selectedMeeting) return;
    const meetingId = selectedMeeting.id;
    try {
      await persistMeeting(selectedMeeting);
      beginProcessing("renaming", meetingId);
      const meeting = await invoke<Meeting>("rename_meeting", {
        meetingId,
      });
      if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
      await reload();
      notify(`已重命名为「${meeting.title}」`);
    } catch (error) {
      notify(`AI 重命名失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  // 说话人改名：调后端 rename_speaker 更新本会议的 speaker_names 映射，仅换显示名不碰转写原文
  const renameSpeaker = useCallback(
    async (speakerId: number, name: string) => {
      if (!selectedMeeting) return;
      const meetingId = selectedMeeting.id;
      try {
        const meeting = await invoke<Meeting>("rename_speaker", {
          meetingId,
          speakerId,
          name,
        });
        if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
      } catch (error) {
        notify(`说话人改名失败：${String(error)}`);
      }
    },
    [selectedMeeting, notify],
  );

  const installSpeakerEngine = async () => {
    try {
      beginProcessing("installingSpeaker");
      const status = await invoke<SpeakerEngineStatus>(
        "install_speaker_engine_command",
      );
      setSpeakerStatus(status);
      notify("本地双遍会议引擎已就绪。现在会先实时出字，再按句高精度校正，并在会后区分发言人。");
    } catch (error) {
      notify(`安装本地实时会议引擎失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const checkLiveEngine = async () => {
    try {
      beginProcessing("checkingLiveEngine");
      await invoke<string>("check_live_engine");
      notify("实时字幕自检通过：流式初稿、句末高精度校正和热词模型均正常。");
    } catch (error) {
      notify(`实时字幕自检失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const cancelProcessing = async () => {
    setProcessingCancelRequested(true);
    try {
      await invoke("cancel_processing");
    } catch {
      /* 子进程可能已结束，忽略 */
    }
  };

  const transcribeWithSpeakers = async () => {
    if (!selectedMeeting) return;
    if (asrEngine.provider === "cloud") {
      // 云端引擎暂不含说话人分离，退化为纯云端转写
      await transcribeMeeting();
      return;
    }
    const meetingId = selectedMeeting.id;
    try {
      await persistMeeting(selectedMeeting);
      beginProcessing("speakerTranscribing", meetingId);
      const meeting = await invoke<Meeting>(
        "transcribe_meeting_with_speakers",
        { meetingId },
      );
      if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
      setSpeakerStatus((status) => ({ ...status, modelsReady: true }));
      await reload();
      notify("已完成本地转写与说话人区分，可继续生成智能纪要。");
    } catch (error) {
      const msg = String(error);
      notify(msg.includes("已取消") ? "已取消转写" : `说话人分离失败：${msg}`);
    } finally {
      finishProcessing();
    }
  };

  const saveAiSettings = async () => {
    try {
      const saved = await invoke<AiSettings>("save_ai_settings", {
        settings: { ...aiSettings, apiKey: apiKey.trim() || null },
      });
      setAiSettings(saved);
      setApiKey("");
      notify(
        saved.isConfigured
          ? "智能纪要服务已保存，密钥已存入 Windows 凭据库"
          : "服务地址已保存；填写 API 密钥后才会启用智能纪要",
      );
    } catch (error) {
      notify(`无法保存智能纪要设置：${String(error)}`);
    }
  };

  const clearAiKey = async () => {
    try {
      await invoke("clear_ai_api_key");
      setAiSettings((settings) => ({ ...settings, isConfigured: false }));
      setApiKey("");
      notify("已从 Windows 凭据库删除 API 密钥");
    } catch (error) {
      notify(`无法删除密钥：${String(error)}`);
    }
  };

  const saveAsrEngine = async (next: AsrEngineSettings, withKey: boolean) => {
    try {
      const saved = await invoke<AsrEngineSettings>("save_asr_engine_settings", {
        settings: {
          provider: next.provider,
          cloudBaseUrl: next.cloudBaseUrl,
          cloudModel: next.cloudModel,
          localHotwords: next.localHotwords,
          apiKey: withKey ? asrKeyInput.trim() || null : null,
        },
      });
      setAsrEngine(saved);
      setAsrKeyInput("");
      notify(
        saved.provider === "cloud"
          ? "已切换为云端转写，录音将按你的配置上传处理"
          : "已切换为本地转写，录音不会离开本机",
      );
    } catch (error) {
      notify(`无法保存转写引擎设置：${String(error)}`);
    }
  };
  const saveRecordingSettings = async (next: RecordingSettings) => {
    try {
      await invoke("save_recording_settings", { settings: next });
      setRecordingSettings(next);
    } catch (error) {
      notify(`无法保存录音设置：${String(error)}`);
    }
  };

  const clearCloudAsrKey = async () => {
    try {
      await invoke("clear_cloud_asr_key");
      setAsrEngine((settings) => ({ ...settings, cloudKeySaved: false }));
      setAsrKeyInput("");
      notify("已从 Windows 凭据库删除云端转写密钥");
    } catch (error) {
      notify(`无法删除密钥：${String(error)}`);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading)
    return (
      <div className="loading">
        <LoaderCircle size={26} className="spin" />
        正在打开知记…
      </div>
    );

  const commands: Command[] = [
    { id: "record", label: "一键开始录音", icon: <Mic size={16} />, run: () => void quickRecord() },
    { id: "new", label: "新建会议", icon: <Plus size={16} />, run: () => void createMeeting() },
    { id: "home", label: "转到首页", icon: <House size={16} />, run: () => setView("home") },
    { id: "meetings", label: "转到会议", icon: <UsersRound size={16} />, run: () => setView("meetings") },
    { id: "tasks", label: "转到待办", icon: <CheckCircle2 size={16} />, run: () => setView("tasks") },
    { id: "settings", label: "打开设置", icon: <Settings size={16} />, run: () => setView("settings") },
  ];
  const activeRecordingMeeting = activeRecordingMeetingId
    ? (selectedMeeting?.id === activeRecordingMeetingId ? selectedMeeting : null)
      ?? workspace.meetings.find((meeting) => meeting.id === activeRecordingMeetingId)
    : null;

  return (
    <div className="app-shell">
      <TitleBar />
      <aside className="icon-rail">
        <button className="rail-brand" title="返回工作台" onClick={() => setView("home")}>
          <span>记</span>
          <small>知记</small>
        </button>
        <button className="rail-new" title="新建会议" onClick={() => void createMeeting()}>
          <Plus size={20} />
          <span>新建</span>
        </button>
        <nav className="rail-nav">
          <RailItem
            active={view === "home"}
            icon={<House size={20} />}
            title="首页"
            onClick={() => setView("home")}
          />
          <RailItem
            active={view === "meetings"}
            icon={<UsersRound size={20} />}
            title="会议"
            onClick={() => setView("meetings")}
          />
          <RailItem
            active={view === "tasks"}
            icon={<CheckCircle2 size={20} />}
            title="待办"
            onClick={() => setView("tasks")}
          />
        </nav>
        <button className={`rail-settings ${view === "settings" ? "active" : ""}`} title="设置" onClick={() => setView("settings")}>
          <Settings size={20} />
          <span>设置</span>
        </button>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <div className="page-heading-copy">
            <h1>{pageCopy[view].title}</h1>
            <p>{pageCopy[view].subtitle}</p>
          </div>
          <div className="header-search">
            <label className="search-box">
              <Search size={17} />
              <input
                ref={searchInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setQuery("");
                }}
                placeholder="搜索会议、笔记与待办"
              />
              {!query && <kbd>Ctrl F</kbd>}
            </label>
            <GlobalSearch
              query={deferredQuery}
              workspace={workspace}
              onOpenMeeting={(meeting) => {
                void selectMeeting(meeting);
                setView("meetings");
              }}
              onOpenTasks={() => setView("tasks")}
              onClose={() => setQuery("")}
            />
          </div>
        </header>
        {message && <div className="toast" role="status" aria-live="polite">{message}</div>}
        {recordingPhase !== "idle" && recordingPhase !== "checking" && (
          <div className={`global-recording-banner ${recordingPhase}`} role="status" aria-live="polite">
            {recordingPhase === "recording" ? <span className="recording-live-dot" /> : <LoaderCircle size={17} className="spin" />}
            <div>
              <strong>
                {recordingPhase === "starting"
                  ? "正在启动录音"
                  : recordingPhase === "finalizing"
                    ? "正在安全保存录音"
                    : `正在录音 · ${duration(recordingSeconds)}`}
              </strong>
              <small>
                {activeRecordingMeeting?.title || "当前会议"}
                {recordingPhase === "finalizing" ? " · 请保持知记打开，完成后会自动开始转写" : " · 录音控制在所有页面保持可见"}
              </small>
            </div>
            <button className="secondary-button compact-button" onClick={openRecordingMeeting}>返回会议</button>
            {recordingPhase === "recording" && (
              <button className="danger-button compact-button" onClick={stopRecording}>
                <Square size={12} fill="currentColor" />结束并保存
              </button>
            )}
          </div>
        )}
        {interruptedJob && (
          <div className="interrupted-task-banner">
            <div>
              <strong>{interruptedJobCopy(interruptedJob.stage).title}</strong>
              <small>{interruptedJobCopy(interruptedJob.stage).detail}</small>
            </div>
            <span>
              {interruptedJob.meetingId && workspace.meetings.some((meeting) => meeting.id === interruptedJob.meetingId) && (
                <button
                  className="secondary-button compact-button"
                  onClick={() => {
                    const meeting = workspace.meetings.find((item) => item.id === interruptedJob.meetingId);
                    if (meeting) {
                      void selectMeeting(meeting);
                      setView("meetings");
                    }
                    localStorage.removeItem(PROCESSING_JOB_KEY);
                    setInterruptedJob(null);
                  }}
                >
                  打开会议
                </button>
              )}
              <button
                className="text-button"
                onClick={() => {
                  localStorage.removeItem(PROCESSING_JOB_KEY);
                  setInterruptedJob(null);
                }}
              >
                知道了
              </button>
            </span>
          </div>
        )}
        {(processing === "autoTranscribing" || processing === "transcribing" || processing === "speakerTranscribing") && (
          <div className="background-processing-banner" aria-live="polite">
            <LoaderCircle size={17} className="spin" />
            <div>
              <strong>
                {processingCancelRequested
                  ? "正在安全停止转写"
                  : `正在处理「${workspace.meetings.find((meeting) => meeting.id === processingMeetingId)?.title || "刚刚的会议"}」`}
              </strong>
              <small>
                {processingCancelRequested
                  ? "正在结束本地模型，录音不会丢失。"
                  : asrEngine.provider === "cloud"
                    ? "正在使用你配置的云端服务转写；可以继续查看其他页面。"
                    : "正在本机生成高精度原文；可以继续查看其他页面。"}
                {` · 已处理 ${duration(processingSeconds)}`}
              </small>
            </div>
            {asrEngine.provider !== "cloud" && (
              <button className="secondary-button compact-button" disabled={processingCancelRequested} onClick={() => void cancelProcessing()}>
                {processingCancelRequested ? "正在取消…" : "取消转写"}
              </button>
            )}
          </div>
        )}
        {view === "home" && (
          <Home
            workspace={workspace}
            onMeeting={() => void createMeeting()}
            onOpenMeeting={(meeting) => {
              void selectMeeting(meeting);
              setView("meetings");
            }}
            onQuickRecord={() => void quickRecord()}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenTasks={() => setView("tasks")}
            onOpenMeetings={() => setView("meetings")}
          />
        )}
        {view === "meetings" && (
          <Meetings
            meetings={filteredMeetings}
            meeting={selectedMeeting}
            tasks={workspace.tasks}
            onSelect={(meeting) => void selectMeeting(meeting)}
            onCreate={() => void createMeeting()}
            onChange={setSelectedMeeting}
            onDelete={() => void deleteMeeting()}
            onImport={() => void importMeetingAudio()}
            onExport={() => void exportMeeting()}
            onCopy={() => void copyMeeting()}
            onRevealRecording={() => void revealRecording()}
            onTask={(title, due) => void addTask(title, due, "meeting", selectedMeeting?.id ?? null)}
            onToggleTask={(task) => void toggleTask(task)}
            onSaveTask={(task) => void saveTask(task)}
            onDeleteTask={(task) => void deleteTask(task)}
            recording={recordingWorkspaceLocked}
            recordingFinalizing={recordingPhase === "finalizing"}
            recordingSeconds={recordingSeconds}
            recordingSession={recordingSession}
            liveTranscript={liveTranscript}
            onRecord={() => requestRecording()}
            onStop={stopRecording}
            asrStatus={asrStatus}
            speakerStatus={speakerStatus}
            asrEngine={asrEngine}
            aiConfigured={aiSettings.isConfigured}
            processing={processingMeetingId === selectedMeeting?.id ? processing : null}
            backgroundBusy={processing !== null && processingMeetingId !== selectedMeeting?.id}
            autoSaveHint={autoSaveHint}
            onTranscribe={() => void transcribeMeeting()}
            onTranscribeWithSpeakers={() => void transcribeWithSpeakers()}
            onAnalyze={openGeneration}
            onRegenerateSection={(section) => void regenerateMeetingSection(section)}
            onRename={() => void renameMeeting()}
            onRenameSpeaker={(speakerId, name) => void renameSpeaker(speakerId, name)}
            onInstallSpeaker={() => void installSpeakerEngine()}
            onOpenSettings={() => setView("settings")}
            onWeeklyReport={() => setWeeklyReportOpen(true)}
          />
        )}
        {view === "tasks" && (
          <Tasks
            tasks={workspace.tasks}
            onAdd={(title, due) => void addTask(title, due)}
            onToggle={(task) => void toggleTask(task)}
            onSave={(task) => void saveTask(task)}
            onDelete={(task) => void deleteTask(task)}
            onOpenSource={(task) => {
              const meeting = workspace.meetings.find((item) => item.id === task.sourceId);
              if (!meeting) return notify("找不到这项待办对应的会议");
              void selectMeeting(meeting);
              setView("meetings");
            }}
          />
        )}
        {view === "settings" && (
          <SettingsView
            workspace={workspace}
            backups={backups}
            aiSettings={aiSettings}
            asrStatus={asrStatus}
            speakerStatus={speakerStatus}
            asrEngine={asrEngine}
            asrKeyInput={asrKeyInput}
            apiKey={apiKey}
            processing={processing}
            onAiChange={setAiSettings}
            onApiKeyChange={setApiKey}
            onSaveAi={() => void saveAiSettings()}
            onClearAiKey={() => void clearAiKey()}
            onDownloadAsr={() => void downloadLocalAsr()}
            onInstallSpeaker={() => void installSpeakerEngine()}
            onCheckLiveEngine={() => void checkLiveEngine()}
            onAsrEngineChange={setAsrEngine}
            onAsrKeyInputChange={setAsrKeyInput}
            onSaveAsrEngine={(next, withKey) => void saveAsrEngine(next, withKey)}
            onClearCloudAsrKey={() => void clearCloudAsrKey()}
            recordingSettings={recordingSettings}
            onSaveRecordingSettings={(next) => void saveRecordingSettings(next)}
            onCheckUpdate={() => void manualCheck()}
            updateState={updateState}
            currentVersion={currentVersion}
            updateVersion={updateVersion}
            updateError={updateError}
            onCreateBackup={() => void createManualBackup()}
            onRestoreBackup={(backup) => void restoreStoredBackup(backup)}
            onOpenBackups={() => void openBackupsFolder()}
            onExportDiagnostics={() => void exportDiagnostics()}
            onExportAllMarkdown={() => void exportAllMarkdown()}
            onOpenOnboarding={() => setShowOnboarding(true)}
            themePref={themePref}
            onThemeChange={changeTheme}
          />
        )}
      </main>
      {showOnboarding && (
        <OnboardingModal
          asrStatus={asrStatus}
          asrEngine={asrEngine}
          speakerStatus={speakerStatus}
          aiSettings={aiSettings}
          onOpenSettings={() => {
            setShowOnboarding(false);
            setView("settings");
          }}
          onComplete={() => {
            localStorage.setItem("zhiji:onboarding-complete", "1");
            setShowOnboarding(false);
          }}
        />
      )}
      {recordingCandidate && !showOnboarding && (
        <RecordingCheckModal
          captureSystemAudio={recordingSettings.captureSystemAudio}
          transcriptionReady={
            asrEngine.provider === "cloud"
              ? asrEngine.cloudKeySaved
              : speakerStatus.installed && speakerStatus.modelsReady
          }
          transcriptionLabel={
            asrEngine.provider === "cloud"
              ? asrEngine.cloudKeySaved
                ? "云端转写已配置，录音结束后自动转写"
                : "云端密钥尚未配置，录音仍会正常保存"
              : speakerStatus.installed && speakerStatus.modelsReady
                ? "本地双遍字幕已就绪：实时出初稿，停顿后按句精校"
                : "实时引擎尚未就绪，录音仍会正常保存并可会后转写"
          }
          onClose={() => {
            setRecordingCandidate(null);
            setRecordingPhase("idle");
          }}
          onOpenSettings={() => {
            setRecordingCandidate(null);
            setRecordingPhase("idle");
            setView("settings");
          }}
          onStart={(stream, microphoneLabel, captureSystemAudio) =>
            void startRecording(stream, microphoneLabel, captureSystemAudio, recordingCandidate)
          }
        />
      )}
      {showGeneration && selectedMeeting && !showOnboarding && (
        <GenerationModal
          meeting={selectedMeeting}
          template={analysisTemplate}
          preview={analysisPreview}
          onTemplateChange={(template) => {
            setAnalysisTemplate(template);
            setAnalysisPreview(null);
          }}
          onGenerate={() => void generateAnalysisPreview()}
          onApply={() => void applyAnalysisPreview()}
          onClose={() => {
            setShowGeneration(false);
            setAnalysisPreview(null);
          }}
        />
      )}
      {weeklyReportOpen && !showOnboarding && (
        <WeeklyReportModal onClose={() => setWeeklyReportOpen(false)} />
      )}
      {showUpdateModal && !showOnboarding && !showGeneration && (
        <UpdateModal
          version={updateVersion}
          state={
            updateState === "downloading"
              ? "downloading"
              : updateState === "error"
                ? "error"
                : "available"
          }
          progress={updateProgress}
          errorMessage={updateError}
          onInstall={() => void installUpdate()}
          onDismiss={() => setShowUpdateModal(false)}
        />
      )}
      {processing && !["autoTranscribing", "transcribing", "speakerTranscribing"].includes(processing) && (
        <ProgressModal
          stage={processing}
          canCancel={asrEngine.provider !== "cloud"}
          onCancel={cancelProcessing}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}



function Home({
  workspace,
  onMeeting,
  onOpenMeeting,
  onQuickRecord,
  onOpenPalette,
  onOpenTasks,
  onOpenMeetings,
}: {
  workspace: Workspace;
  onMeeting: () => void;
  onOpenMeeting: (meeting: Meeting) => void;
  onQuickRecord: () => void;
  onOpenPalette: () => void;
  onOpenTasks: () => void;
  onOpenMeetings: () => void;
}) {
  const openTasks = workspace.tasks.filter((task) => !task.completed);
  const overdue = openTasks.filter((task) => taskDueState(task) === "overdue");
  const dueToday = openTasks.filter((task) => taskDueState(task) === "today");
  const continueMeeting = workspace.meetings.find((meeting) => meetingJourney(meeting).step < 4);
  const upcomingTasks = [...openTasks]
    .sort((left, right) => {
      if (!left.dueDate && !right.dueDate) return left.createdAt.localeCompare(right.createdAt);
      if (!left.dueDate) return 1;
      if (!right.dueDate) return -1;
      return left.dueDate.localeCompare(right.dueDate);
    })
    .slice(0, 5);
  const recentMeetings = workspace.meetings.slice(0, 8);
  return (
    <div className="page-grid home-dashboard">
      <section className="home-command-card">
        <div className="home-command-copy">
          <span className="home-date-label">{todayFullDate()}</span>
          <h2>{greeting()}，准备记录下一场会议吗？</h2>
          <p>直接开始录音，知记会同步保存声音、生成实时字幕，并在会后整理完整原文。</p>
        </div>
        <div className="home-command-actions">
          <button className="primary-button record-cta" onClick={onQuickRecord}>
            <Mic size={17} /> 一键开始录音
          </button>
          <button className="ghost-button" onClick={onMeeting}>
            <CalendarDays size={15} /> 先准备议程
          </button>
          <button className="home-command-shortcut" onClick={onOpenPalette} title="打开命令面板">
            更多操作 <kbd>Ctrl K</kbd>
          </button>
        </div>
      </section>

      {continueMeeting && (
        <section className="continue-meeting-card">
          <span className="continue-icon"><Clock3 size={19} /></span>
          <div className="continue-copy">
            <small>继续上次工作</small>
            <strong>{continueMeeting.title}</strong>
            <span>{meetingJourney(continueMeeting).detail}</span>
          </div>
          <div className="continue-progress" aria-label={`当前第 ${meetingJourney(continueMeeting).step} 步`}>
            {[1, 2, 3, 4].map((step) => <i className={step <= meetingJourney(continueMeeting).step ? "active" : ""} key={step} />)}
          </div>
          <button className="secondary-button compact-button" onClick={() => onOpenMeeting(continueMeeting)}>
            {meetingJourney(continueMeeting).label}<ChevronRight size={15} />
          </button>
        </section>
      )}

      <section className="panel home-meetings-panel">
        <div className="panel-title">
          <div><h3>最近会议</h3><small>{workspace.meetings.length ? `共 ${workspace.meetings.length} 场` : "从第一场会议开始"}</small></div>
          {workspace.meetings.length > recentMeetings.length && (
            <button onClick={onOpenMeetings}>查看全部<ChevronRight size={14} /></button>
          )}
        </div>
        {workspace.meetings.length === 0 ? (
          <Empty label="还没有会议，点「一键开始录音」记录第一场。" />
        ) : (
          recentMeetings.map((meeting, idx) => {
            const bucket = daySeparator(meeting.startedAt);
            const showSep = idx === 0 || daySeparator(recentMeetings[idx - 1].startedAt) !== bucket;
            const journey = meetingJourney(meeting);
            return (
              <Fragment key={meeting.id}>
                {showSep && <div className="day-sep">{bucket}</div>}
                <button className="recent-row" onClick={() => onOpenMeeting(meeting)}>
                  <span className={`meeting-stage-icon step-${journey.step}`}>
                    {meeting.audioPath ? <FileAudio size={16} /> : <CalendarDays size={16} />}
                  </span>
                  <span className="recent-row-copy">
                    <strong>{meeting.title}</strong>
                    <small>{meetingTimeLabel(meeting.startedAt)}{meeting.durationSeconds > 0 ? ` · ${duration(meeting.durationSeconds)}` : ""}</small>
                  </span>
                  <span className={`journey-label step-${journey.step}`}><i />{journey.label}</span>
                  <ChevronRight size={17} />
                </button>
              </Fragment>
            );
          })
        )}
      </section>

      <aside className="home-focus-column">
        <section className="home-focus-card">
          <div className="home-focus-head">
            <div><h3>今日行动</h3><small>优先处理临近到期事项</small></div>
            <button onClick={onOpenTasks}>全部待办<ChevronRight size={13} /></button>
          </div>
          <div className="home-task-metrics">
            <button className={overdue.length ? "attention" : ""} onClick={onOpenTasks}><strong>{overdue.length}</strong><span>已逾期</span></button>
            <button className={dueToday.length ? "today" : ""} onClick={onOpenTasks}><strong>{dueToday.length}</strong><span>今天到期</span></button>
            <button onClick={onOpenTasks}><strong>{openTasks.length}</strong><span>待完成</span></button>
          </div>
          <div className="home-task-list">
            {upcomingTasks.map((task) => (
              <button key={task.id} onClick={onOpenTasks}>
                <span className={`task-mini-check ${taskDueState(task)}`} />
                <span><strong>{task.title}</strong><small>{taskDueText(task)}</small></span>
                <ChevronRight size={14} />
              </button>
            ))}
            {upcomingTasks.length === 0 && (
              <div className="home-all-clear"><CheckCircle2 size={22} /><strong>没有待处理事项</strong><small>会议中提取的行动项会出现在这里</small></div>
            )}
          </div>
        </section>
        <section className="home-guide-card">
          <strong>推荐工作方式</strong>
          <ol><li><span>1</span>录音时标记重点</li><li><span>2</span>会后校对原文与姓名</li><li><span>3</span>生成纪要和待办</li></ol>
        </section>
      </aside>
    </div>
  );
}

function Meetings({
  meetings,
  meeting,
  tasks,
  onSelect,
  onCreate,
  onChange,
  onDelete,
  onImport,
  onExport,
  onCopy,
  onRevealRecording,
  onTask,
  onToggleTask,
  onSaveTask,
  onDeleteTask,
  recording,
  recordingFinalizing,
  recordingSeconds,
  recordingSession,
  liveTranscript,
  onRecord,
  onStop,
  asrStatus,
  speakerStatus,
  asrEngine,
  aiConfigured,
  processing,
  backgroundBusy,
  autoSaveHint,
  onTranscribe,
  onTranscribeWithSpeakers,
  onAnalyze,
  onRegenerateSection,
  onRename,
  onInstallSpeaker,
  onOpenSettings,
  onRenameSpeaker,
  onWeeklyReport,
}: {
  meetings: Meeting[];
  meeting: Meeting | null;
  tasks: Task[];
  onSelect: (meeting: Meeting | null) => void;
  onCreate: () => void;
  onChange: (meeting: Meeting) => void;
  onDelete: () => void;
  onImport: () => void;
  onExport: () => void;
  onCopy: () => void;
  onRevealRecording: () => void;
  onTask: (title: string, due: string | null) => void;
  onToggleTask: (task: Task) => void;
  onSaveTask: (task: Task) => void;
  onDeleteTask: (task: Task) => void;
  recording: boolean;
  recordingFinalizing: boolean;
  recordingSeconds: number;
  recordingSession: RecordingSessionStatus | null;
  liveTranscript: LiveTranscriptState;
  onRecord: () => void;
  onStop: () => void;
  asrStatus: LocalAsrStatus;
  asrEngine: AsrEngineSettings;
  speakerStatus: SpeakerEngineStatus;
  aiConfigured: boolean;
  processing: Processing;
  backgroundBusy: boolean;
  autoSaveHint: string;
  onTranscribe: () => void;
  onTranscribeWithSpeakers: () => void;
  onAnalyze: () => void;
  onRegenerateSection: (section: "minutes" | "decisions" | "tasks") => void;
  onRename: () => void;
  onInstallSpeaker: () => void;
  onOpenSettings: () => void;
  onRenameSpeaker: (speakerId: number, name: string) => void;
  onWeeklyReport: () => void;
}) {
  const busy = processing !== null || backgroundBusy;
  // 音文联动：seekRequest 用于点击说话人段落后跳转音频时间，currentMs 用于高亮当前播放段落
  const [seekRequest, setSeekRequest] = useState<{ time: number; nonce: number } | null>(null);
  const [currentMs, setCurrentMs] = useState(-1);
  const [taskComposing, setTaskComposing] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<"summary" | "transcript" | "notes" | "qa">(
    meeting?.minutes.trim() ? "summary" : "transcript",
  );
  // 会前背景条：默认收起；有内容时收起并显示首行预览，空时展开引导填写
  const [contextOpen, setContextOpen] = useState<boolean | null>(null);
  const contextExpanded = contextOpen ?? !meeting?.context?.trim();

  useEffect(() => {
    setWorkspaceTab(meeting?.minutes.trim() ? "summary" : "transcript");
    setContextOpen(null);
  }, [meeting?.id]);

  // 解析说话人段数用于 Tab 计数徽章
  const speakerSegments = useMemo<SpeakerSegment[]>(() => {
    if (!meeting?.speakerSegments) return [];
    try {
      return JSON.parse(meeting.speakerSegments) as SpeakerSegment[];
    } catch {
      return [];
    }
  }, [meeting?.speakerSegments]);

  // 本会议说话人自定义名映射（speakerId -> 名称）
  const speakerNames = useMemo<Record<string, string>>(() => {
    if (!meeting?.speakerNames) return {};
    try {
      return JSON.parse(meeting.speakerNames) as Record<string, string>;
    } catch {
      return {};
    }
  }, [meeting?.speakerNames]);

  // 本会议关联待办
  const meetingTasks = useMemo(
    () =>
      meeting
        ? tasks.filter(
            (task) => task.sourceType === "meeting" && task.sourceId === meeting.id,
          )
        : [],
    [tasks, meeting],
  );
  const citedSources = useMemo(() => minuteSources(meeting?.minutes ?? ""), [meeting?.minutes]);
  const speakerCount = useMemo(
    () => new Set(speakerSegments.map((segment) => segment.speakerId ?? segment.speaker)).size,
    [speakerSegments],
  );
  const journey = meeting ? meetingJourney(meeting) : null;

  const updateSpeakerSegment = (index: number, text: string) => {
    if (!meeting) return;
    const cleaned = text.trim();
    if (!cleaned || !speakerSegments[index]) return;
    const segments = speakerSegments.map((segment, segmentIndex) =>
      segmentIndex === index ? { ...segment, text: cleaned } : segment
    );
    const transcript = segments
      .map((segment) => `【${segment.speaker || "发言人"}】${segment.text}`)
      .join("\n");
    onChange({
      ...meeting,
      transcript,
      speakerSegments: JSON.stringify(segments),
      status: MeetingStatus.Proofread,
    });
  };

  const notesPane = meeting ? (
    <section className="my-notes-pane">
      <div className="my-notes-head">
        <h3>我的笔记</h3>
        <small>随手记下观察和想法，智能纪要不会覆盖这里</small>
      </div>
      <EditorField
        label="我的笔记"
        hint="随时记录你的观察和想法（纯文本，自动保存）"
        value={meeting.notes}
        onChange={(notes) => onChange({ ...meeting, notes })}
        placeholder="随时记下你的观察与想法"
      />
    </section>
  ) : null;

  const transcriptPane = meeting ? (
    <section className="transcript-pane">
      <div className="pane-head">
        <div>
          <h3>原文校对</h3>
          <small>{speakerSegments.length > 0 ? "边听边改每个片段，修改会同步到完整原文" : "可以直接修正识别文字"}</small>
        </div>
        {meeting.transcript.trim() && (
          <span className="count-pill">约 {meeting.transcript.trim().length} 字</span>
        )}
      </div>
      {meeting.transcript.trim() && (
        <div className="transcript-quality-strip">
          <div className={speakerSegments.length > 0 ? "ready" : "attention"}>
            <CheckCircle2 size={15} />
            <span>
              <strong>{speakerSegments.length > 0 ? "高精度分段已生成" : "当前为整段原文"}</strong>
              <small>{speakerSegments.length > 0 ? `${speakerSegments.length} 个片段 · ${speakerCount} 个声音角色` : "如需区分说话人，可重新运行高精度转写"}</small>
            </span>
          </div>
          <div className={isLiveDraft(meeting.status) ? "attention" : "ready"}>
            <CheckCircle2 size={15} />
            <span>
              <strong>{isLiveDraft(meeting.status) ? "实时初稿待会后校正" : meeting.status}</strong>
              <small>{isLiveDraft(meeting.status) ? "点击上方“生成完整原文”获得更准确结果" : "修改内容会自动保存"}</small>
            </span>
          </div>
        </div>
      )}
      {speakerSegments.length > 0 && (
        <div className="transcript-timeline-wrap">
          <SpeakerTimeline
            segments={meeting.speakerSegments}
            currentMs={currentMs}
            names={speakerNames}
            onRename={onRenameSpeaker}
            onEdit={updateSpeakerSegment}
            onSeek={(ms) => setSeekRequest({ time: ms / 1000, nonce: Date.now() })}
          />
        </div>
      )}
      {speakerSegments.length === 0 ? (
        <EditorField
          label="完整原文"
          hint="修改后会自动保存"
          value={meeting.transcript}
          onChange={(transcript) => onChange({ ...meeting, transcript, status: transcript.trim() ? MeetingStatus.Proofread : meeting.status })}
          placeholder={recording ? "会议结束后将在这里生成转写" : "转写完成后显示在这里"}
        />
      ) : (
        <details className="raw-transcript-details">
          <summary>查看合并后的完整原文</summary>
          <pre className="raw-transcript-preview">{meeting.transcript}</pre>
        </details>
      )}
    </section>
  ) : null;

  const minutesPane = meeting ? (
    <section className="minutes-pane">
      <div className="pane-head">
        <div>
          <h3>智能纪要</h3>
          <small>先校对原文和说话人，再生成最终纪要</small>
        </div>
        <div className="pane-actions">
          {meeting.minutes.trim() && (
            <button
              className="pane-action secondary"
              onClick={() => onRegenerateSection("minutes")}
              disabled={!aiConfigured || !meeting.transcript.trim() || busy}
              title="只重新生成智能纪要，保留决策和待办"
            >
              <RefreshCw size={14} />只重写纪要
            </button>
          )}
          <button
            className="pane-action"
            onClick={onAnalyze}
            disabled={!aiConfigured || !meeting.transcript.trim() || busy}
            title="选择模板并先预览，不会直接覆盖"
          >
            {processing === "analyzing" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
            {meeting.minutes.trim() ? "生成新版本" : "生成纪要"}
          </button>
        </div>
      </div>
      {meeting.minutes.trim() || aiConfigured ? (
        <MarkdownField
          label="智能纪要"
          hint="AI 基于转写稿生成的结构化纪要（Markdown，预览时渲染格式）"
          value={stripHtml(meeting.minutes)}
          onChange={(minutes) => onChange({ ...meeting, minutes })}
          placeholder="生成纪要后显示在这里"
        />
      ) : (
        <div className="tab-panel-empty">
          请先到设置中配置智能纪要服务，之后即可根据转写稿生成结构化纪要。
        </div>
      )}
      {meeting.audioPath && citedSources.length > 0 && (
        <div className="minute-sources">
          <span>录音来源</span>
          {citedSources.map((seconds) => (
            <button key={seconds} onClick={() => setSeekRequest({ time: seconds, nonce: Date.now() })}>
              <Play size={11} fill="currentColor" />{duration(seconds)}
            </button>
          ))}
        </div>
      )}
      <details className="pane-details" open>
        <summary>决策与待办（{meetingTasks.length}）</summary>
        <div className="meeting-editor">
          <div>
            <div className="section-heading">
              <h3>决策与共识</h3>
              <button className="pane-action secondary" onClick={() => onRegenerateSection("decisions")} disabled={!aiConfigured || !meeting.transcript.trim() || busy}>
                <RefreshCw size={13} />只重提决策
              </button>
            </div>
            <MarkdownField
              label="决策与共识"
              hint="只保留明确决定；不确定项会标记待确认"
              value={meeting.decisions}
              onChange={(decisions) => onChange({ ...meeting, decisions })}
              placeholder="例如：周五前交付初稿"
            />
          </div>
          <div>
            <div className="section-heading">
              <h3>本会议待办</h3>
              <div className="section-actions">
                <button className="pane-action secondary" onClick={() => onRegenerateSection("tasks")} disabled={!aiConfigured || !meeting.transcript.trim() || busy}>
                  <RefreshCw size={13} />重新提取
                </button>
                <button className="icon-btn" title="添加待办" onClick={() => setTaskComposing((value) => !value)}><Plus size={14} /></button>
              </div>
            </div>
            {taskComposing && (
              <TaskComposer
                autoFocus
                onAdd={(title, due) => {
                  onTask(title, due);
                  setTaskComposing(false);
                }}
                onCancel={() => setTaskComposing(false)}
              />
            )}
            {meetingTasks.length > 0 ? (
              <section className="task-group">
                {meetingTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onToggle={onToggleTask}
                    onSave={onSaveTask}
                    onDelete={onDeleteTask}
                  />
                ))}
              </section>
            ) : (
              <div className="tab-panel-empty">
                智能纪要生成后会自动提取行动项到这里，也可以手动添加。
              </div>
            )}
          </div>
        </div>
      </details>
    </section>
  ) : null;

  return (
    <div className={`meeting-shell ${meeting ? "has-meeting" : ""} ${recording ? "is-live" : ""}`}>
      {!recording && (
        <MeetingSidebar
          meetings={meetings}
          selectedId={meeting?.id}
          onSelect={onSelect}
          onCreate={onCreate}
          onWeeklyReport={onWeeklyReport}
          formatDate={dateTime}
        />
      )}
      <main className="meeting-detail">
        {meeting ? (
          <>
            <header className="meeting-detail-header">
              <button className="back-to-list" onClick={() => onSelect(null)}>← 会议</button>
              <div className="meeting-title-block">
                <input
                  className="title-input"
                  value={meeting.title}
                  onChange={(event) => onChange({ ...meeting, title: event.target.value })}
                  aria-label="会议标题"
                />
                <div className="meeting-meta">
                  <span>{dateTime(meeting.startedAt)}</span>
                  <StatusDot status={meeting.status} />
                  <span>{recording ? "会议进行中" : meeting.minutes.trim() ? "纪要已生成" : meeting.transcript.trim() ? "等待整理" : "会前准备"}</span>
                </div>
              </div>
              <div className="meeting-header-actions">
                {autoSaveHint && <small className="autosave-hint">{autoSaveHint}</small>}
                {!recording && (
                  <>
                    <IconButton
                      icon={Wand2}
                      label="根据内容整理会议标题"
                      onClick={onRename}
                      disabled={!aiConfigured || !meeting.transcript.trim() || busy}
                      loading={processing === "renaming"}
                    />
                    <Popover
                      align="end"
                      trigger={<span className="icon-btn" title="更多操作"><MoreHorizontal size={17} /></span>}
                    >
                      {(close) => (
                        <div className="meeting-action-menu">
                          <button onClick={() => { onCopy(); close(); }} disabled={!meeting.minutes.trim() && !meeting.transcript.trim() && !meeting.notes.trim()}><Copy size={15} />复制内容</button>
                          <button onClick={() => { onExport(); close(); }}><FileDown size={15} />导出 Markdown</button>
                          <button onClick={() => { onRevealRecording(); close(); }} disabled={!meeting.audioPath}><FolderOpen size={15} />打开录音位置</button>
                          <button onClick={() => { setTaskComposing(true); setWorkspaceTab("summary"); close(); }}><Plus size={15} />添加待办</button>
                          <span />
                          <button className="danger" onClick={() => { onDelete(); close(); }} disabled={busy}><Trash2 size={15} />删除会议</button>
                        </div>
                      )}
                    </Popover>
                  </>
                )}
              </div>
            </header>

            {recording ? (
              <LiveMeetingStage
                meeting={meeting}
                recordingSeconds={recordingSeconds}
                recordingSession={recordingSession}
                finalizing={recordingFinalizing}
                liveTranscript={liveTranscript}
                formatDuration={duration}
                onChange={onChange}
                onStop={onStop}
              />
            ) : (
              <>
                {journey && (
                  <section className={`meeting-journey-card step-${journey.step}`}>
                    <div className="meeting-journey-copy">
                      <span>当前进度</span>
                      <strong>{journey.label}</strong>
                      <small>{journey.detail}</small>
                    </div>
                    <div className="meeting-journey-steps" aria-label="会议处理进度">
                      {[
                        [1, "录音"],
                        [2, "原文"],
                        [3, "纪要"],
                        [4, "完成"],
                      ].map(([step, label]) => (
                        <button
                          key={step}
                          className={Number(step) < journey.step ? "done" : Number(step) === journey.step ? "current" : ""}
                          disabled={Number(step) === 1 || Number(step) > journey.step || (Number(step) === 2 && !meeting.transcript.trim())}
                          onClick={() => {
                            if (Number(step) === 2) setWorkspaceTab("transcript");
                            if (Number(step) >= 3) setWorkspaceTab("summary");
                          }}
                        >
                          <i>{Number(step) < journey.step ? <Check size={12} /> : step}</i>
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                    <div className="meeting-journey-actions">
                      <button className="secondary-button compact-button" disabled={busy} onClick={onImport}>
                        {processing === "importing" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                        {processing === "importing" ? "正在导入" : "导入录音"}
                      </button>
                      <button className="record-button compact-button" disabled={busy} onClick={onRecord}>
                        <Mic size={14} />{meeting.audioPath ? "重新录音" : "开始录音"}
                      </button>
                    </div>
                  </section>
                )}

                <section className="meeting-preflight">
                  <div className="preflight-heading">
                    <div>
                      <strong>会议上下文</strong>
                      <small>议程、参会人和专业术语会用于热词校正与纪要理解</small>
                    </div>
                  </div>
                  <div className={`context-strip ${contextExpanded ? "open" : ""}`}>
                    <button className="context-strip-head" onClick={() => setContextOpen(!contextExpanded)}>
                      <ChevronRight size={14} style={{ transform: contextExpanded ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
                      <span>议程与背景</span>
                      {!contextExpanded && meeting.context.trim() && <small>{meeting.context.trim().split("\n")[0]}</small>}
                      {!contextExpanded && !meeting.context.trim() && <small className="context-empty">添加议程、术语或参会人</small>}
                    </button>
                    {contextExpanded && (
                      <textarea
                        className="context-input"
                        value={meeting.context}
                        onChange={(event) => onChange({ ...meeting, context: event.target.value })}
                        placeholder="例如：会议目标、议程、专业术语、参会人姓名…"
                        rows={3}
                      />
                    )}
                  </div>
                </section>

                <section className="meeting-review-tools">
                  {meeting.audioPath && (
                    <AudioPlayer
                      meetingId={meeting.id}
                      audioPath={meeting.audioPath}
                      seekRequest={seekRequest}
                      onTimeUpdate={(seconds) => setCurrentMs(seconds * 1000)}
                    />
                  )}
                  <AiWorkflow
                    meeting={meeting}
                    asrStatus={asrStatus}
                    asrEngine={asrEngine}
                    speakerStatus={speakerStatus}
                    aiConfigured={aiConfigured}
                    processing={processing}
                    blocked={backgroundBusy}
                    onTranscribe={onTranscribe}
                    onTranscribeWithSpeakers={onTranscribeWithSpeakers}
                    onAnalyze={onAnalyze}
                    onInstallSpeaker={onInstallSpeaker}
                    onOpenSettings={onOpenSettings}
                  />
                </section>

                <div className="meeting-workspace">
                  <nav className="meeting-workspace-tabs" aria-label="会议内容">
                    <button className={workspaceTab === "summary" ? "active" : ""} onClick={() => setWorkspaceTab("summary")}>
                      <span><Sparkles size={15} />智能纪要</span>{meetingTasks.length > 0 && <b>{meetingTasks.length}</b>}
                    </button>
                    <button className={workspaceTab === "transcript" ? "active" : ""} onClick={() => setWorkspaceTab("transcript")}>
                      <span><FileAudio size={15} />原文校对</span>{speakerSegments.length > 0 && <b>{speakerSegments.length}</b>}
                    </button>
                    <button className={workspaceTab === "notes" ? "active" : ""} onClick={() => setWorkspaceTab("notes")}><span><Pencil size={15} />我的笔记</span></button>
                    <button className={workspaceTab === "qa" ? "active" : ""} onClick={() => setWorkspaceTab("qa")}><span><MessageCircleQuestion size={15} />会议问答</span></button>
                  </nav>
                  <div className="meeting-workspace-content">
                    {workspaceTab === "summary" && minutesPane}
                    {workspaceTab === "transcript" && transcriptPane}
                    {workspaceTab === "notes" && notesPane}
                    {workspaceTab === "qa" && (
                      <MeetingQaPanel
                        meetingId={meeting.id}
                        aiConfigured={aiConfigured}
                        hasContent={Boolean(meeting.transcript.trim() || meeting.minutes.trim())}
                      />
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="meeting-welcome">
            <Empty label="选择一场会议，或新建会议开始记录。" />
            <button className="primary-button" onClick={onCreate}><Plus size={15} />新建会议</button>
          </div>
        )}
      </main>
    </div>
  );
}

const pageCopy: Record<View, { title: string; subtitle: string }> = {
  home: { title: "工作台", subtitle: "从录音到纪要，继续最重要的一步" },
  meetings: { title: "会议", subtitle: "录音、原文、纪要与行动项" },
  tasks: { title: "待办", subtitle: "集中跟进每场会议产生的行动项" },
  settings: { title: "设置", subtitle: "录音、转写、智能纪要与数据保护" },
};
