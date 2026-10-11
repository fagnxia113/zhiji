import { MeetingWorkspace } from "./components/MeetingWorkspace";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { CheckCircle2, FolderOpen, House, LoaderCircle, Mic, Plus, RefreshCw, Settings, Square, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiSettings, AnalysisPreview, AnalysisResult, AsrEngineSettings, BackupInfo, BeginRecordingResult, RecordingFinalizeResult, RecordingSessionStatus, RecordingSettings, LocalAsrStatus, Meeting, MeetingTemplate, OfflineInstallManifest, Processing, SpeakerEngineStatus, Task, View, Workspace } from "./types";
import { defaultRecordingSettings } from "./types";
import { localDateKey, taskDueState } from "./workflow";
import { duration } from "./format";
import { applyTheme, loadThemePreference, saveThemePreference, type ThemePreference, watchSystemTheme } from "./theme";
import { SettingsView } from "./SettingsView";
import { AppSidebar } from "./components/shell/AppSidebar";
import { PageHeader } from "./components/shell/PageHeader";
import { usePagePosition } from "./components/shell/usePagePosition";
import { WorkbenchHome } from "./components/WorkbenchHome";
import { WorkJournal } from "./components/WorkJournal";
import { ProjectsPage } from "./components/ProjectsPage";
import type { TaskFilter } from "./components/tasks/Tasks";
import { CommandPalette, type Command, GenerationModal, OnboardingModal, ProgressModal, RecordingCheckModal, stripHtml, Tasks, UpdateModal, WeeklyReportModal } from "./components";

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
  if (stage === "speakerCorrecting") return { title: "上次角色修正没有完成", detail: "原文和原有角色仍然保留，可以回到原文校对后重新区分。" };
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
  if (["downloading", "installingSpeaker"].includes(stage)) {
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
  const [offlineManifest, setOfflineManifest] = useState<OfflineInstallManifest | null>(null);
  const [asrEngine, setAsrEngine] = useState<AsrEngineSettings>(defaultAsrEngine);
  const [recordingSettings, setRecordingSettings] = useState<RecordingSettings>(defaultRecordingSettings);
  const [asrKeyInput, setAsrKeyInput] = useState("");
  const [autoSaveHint, setAutoSaveHint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [view, setView] = useState<View>("home");
  const pageScroller = usePagePosition(view);
  const [projectTarget, setProjectTarget] = useState("");
  const openProject = (id?: string) => { setProjectTarget(id || ""); setView("projects"); };
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("open");
  const [taskTarget, setTaskTarget] = useState<{ id: string; request: number }>();
  const [entryTarget, setEntryTarget] = useState<{ id: string; request: number }>();
  const navigationRequest = useRef(0);
  const openTasksView = (filter: TaskFilter = "open") => { setTaskTarget(undefined); setTaskFilter(filter); setView("tasks"); };
  const openTask = (task: Task) => { setTaskTarget({ id: task.id, request: ++navigationRequest.current }); setView("tasks"); };
  const openJournal = () => { setEntryTarget(undefined); setView("journal"); };
  const openEntry = (id: string) => { setEntryTarget({ id, request: ++navigationRequest.current }); setView("journal"); };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState("");
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [startupWarning, setStartupWarning] = useState("");
  const [message, setMessage] = useState("");
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>("idle");
  const [activeRecordingMeetingId, setActiveRecordingMeetingId] = useState("");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingCandidate, setRecordingCandidate] = useState<Meeting | null>(null);
  const [recordingSession, setRecordingSession] = useState<RecordingSessionStatus | null>(null);
  const [processing, setProcessing] = useState<Processing>(null);
  const [processingMeetingId, setProcessingMeetingId] = useState("");
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const [processingCancelRequested, setProcessingCancelRequested] = useState(false);
  const [interruptedJob, setInterruptedJob] = useState<InterruptedProcessingJob | null>(interruptedProcessingJob);
  const recorder = useRef<MediaRecorder | null>(null);
  const pendingUpdateRef = useRef<Update | null>(null);
  const recordingSecondsRef = useRef(0);
  const asrStatusRef = useRef(asrStatus);
  const speakerStatusRef = useRef(speakerStatus);
  const asrEngineRef = useRef(asrEngine);
  const savedSnapshot = useRef<{ id: string; json: string }>({ id: "", json: "" });
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const taskWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const processingWasActive = useRef(false);
  const processingMeetingIdRef = useRef("");
  const selectedMeetingRef = useRef<Meeting | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
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
    // Serialize autosave and navigation flushes so an older write cannot win a race.
    const write = saveQueue.current.catch(() => undefined).then(async () => {
      await invoke("save_meeting", { meeting });
      const target = { id: meeting.id, json: JSON.stringify(meeting) };
      if (selectedMeetingRef.current?.id === meeting.id) {
        savedSnapshot.current = target;
        setAutoSaveHint(JSON.stringify(selectedMeetingRef.current) === target.json ? "已自动保存" : "有未保存更改…");
      }
      setWorkspace((current) => ({
        ...current,
        meetings: current.meetings.map((item) => item.id === meeting.id ? { ...meeting, updatedAt: new Date().toISOString() } : item),
      }));
    });
    saveQueue.current = write;
    await write;
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

  const retryStartup = async () => {
    if (recordingBusy || processing) {
      notify("请等待当前录音或处理完成后再重新加载。");
      return;
    }
    try {
      await flushSelectedMeeting();
      await taskWriteQueue.current;
      setStartupAttempt(value => value + 1);
    } catch (error) { notify(`尚有内容未保存，暂未重新加载：${String(error)}`); }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    void getCurrentWindow().onCloseRequested(async (event) => {
      // The JS wrapper destroys the window unless the handler prevents default,
      // which would remove the last window and exit the whole process.
      // Rust's CloseRequested handler owns hide/minimize; preventing default
      // here keeps the process alive so pending writes finish after hiding.
      void invoke("trace_close_js", { message: "JS onCloseRequested entered, calling preventDefault" }).catch(() => {});
      event.preventDefault();
      void invoke("trace_close_js", { message: "JS preventDefault done" }).catch(() => {});
      try {
        await flushSelectedMeeting();
        void invoke("trace_close_js", { message: "JS flush done" }).catch(() => {});
      } catch {
        notify("当前会议尚未保存成功；从托盘重新打开知记后修改仍在，可再次保存。");
      }
      // Belt and braces: the Rust handler hides first, but re-assert it here so a
      // missed native listener can never leave the window on screen.
      try {
        await getCurrentWindow().hide();
        void invoke("trace_close_js", { message: "JS hide() done" }).catch(() => {});
      } catch (error) {
        void invoke("trace_close_js", { message: `JS hide() failed: ${String(error)}` }).catch(() => {});
      }
      if (!localStorage.getItem("zhiji:tray-hint-shown")) {
        localStorage.setItem("zhiji:tray-hint-shown", "1");
        notify("窗口已收起到系统托盘，知记仍在后台运行；退出请右键托盘图标选「退出」。");
      }
      void invoke("trace_close_js", { message: "JS handler complete" }).catch(() => {});
    }).then((dispose) => {
      if (active) {
        unlisten = dispose;
        void invoke("trace_close_js", { message: "JS close listener registered" }).catch(() => {});
      } else dispose();
    })
      .catch(error => notify(`窗口保存监听未启动：${String(error)}`));
    return () => { active = false; unlisten?.(); };
  }, [flushSelectedMeeting, notify]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    void listen("zhiji://request-exit", async () => {
      if (recordingBusy || processing) {
        notify("录音或处理仍在进行，请结束并等待保存完成后再退出。");
        return;
      }
      try {
        await flushSelectedMeeting();
        await saveQueue.current;
        await taskWriteQueue.current;
        await invoke("finish_app_exit");
      } catch (error) { notify(`暂未退出，请先保存工作：${String(error)}`); }
    }).then(dispose => { if (active) unlisten = dispose; else dispose(); })
      .catch(error => notify(`退出监听未启动：${String(error)}`));
    return () => { active = false; unlisten?.(); };
  }, [flushSelectedMeeting, notify, processing, recordingBusy]);

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
    setLoading(true);
    setStartupError("");
    setStartupWarning("");
    void Promise.allSettled([
      invoke<number>("recover_interrupted_recordings").then(async (count) => {
        await reload();
        return count;
      }),
      invoke<AiSettings>("get_ai_settings"),
      invoke<LocalAsrStatus>("get_local_asr_status"),
      invoke<SpeakerEngineStatus>("get_speaker_engine_status"),
      invoke<OfflineInstallManifest>("get_offline_manifest"),
      invoke<AsrEngineSettings>("get_asr_engine_settings"),
      invoke<RecordingSettings>("get_recording_settings"),
      invoke<BackupInfo[]>("list_backups"),
      getVersion(),
    ])
      .then(([recovered, settings, asr, speaker, offline, engine, recording, storedBackups, version]) => {
        if (!active) return;
        if (recovered.status === "rejected") {
          setStartupError(String(recovered.reason));
          return;
        }
        if (settings.status === "fulfilled") setAiSettings(settings.value);
        if (asr.status === "fulfilled") setAsrStatus(asr.value);
        if (speaker.status === "fulfilled") setSpeakerStatus(speaker.value);
        if (engine.status === "fulfilled") setAsrEngine(engine.value);
        if (offline.status === "fulfilled") setOfflineManifest(offline.value);
        if (recording.status === "fulfilled" && recording.value) setRecordingSettings(recording.value);
        if (storedBackups.status === "fulfilled") setBackups(storedBackups.value);
        if (version.status === "fulfilled") setCurrentVersion(version.value);
        const unavailable = [settings, asr, speaker, engine, offline, recording, storedBackups, version].filter(result => result.status === "rejected").length;
        if (unavailable) setStartupWarning("部分配置或引擎状态未能读取，会议资料已经打开。可在设置中检查，或重新加载后再开始录音与智能处理。");
        setShowOnboarding(localStorage.getItem("zhiji:onboarding-complete") !== "1");
        if (recovered.value > 0) notify(`已恢复 ${recovered.value} 段上次意外中断的录音。`);
      })
      .catch(
        (error: unknown) =>
          active && setStartupError(String(error)),
      )
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [startupAttempt]);

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
    if (processingMeetingId === selectedMeeting.id || (recordingPhase === "finalizing" && activeRecordingMeetingId === selectedMeeting.id)) {
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
  }, [selectedMeeting, persistMeeting, processingMeetingId, recordingPhase, activeRecordingMeetingId]);

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
    try {
      const meeting = await invoke<Meeting>("create_meeting", { notebookId: null });
      setSelectedMeeting(meeting);
      setWorkspace(current => ({ ...current, meetings: [meeting, ...current.meetings] }));
      setView("meetings");
    } catch (error) { notify(`新建会议失败：${String(error)}`); }
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
    try {
      const meeting = await invoke<Meeting>("create_meeting", { notebookId: null });
      setSelectedMeeting(meeting);
      setWorkspace(current => ({ ...current, meetings: [meeting, ...current.meetings] }));
      setView("meetings");
      requestRecording(meeting);
    } catch (error) { notify(`无法准备录音：${String(error)}`); }
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

  // 分区一键复制：原文、智能纪要等分别拷贝，避免只提供「整场复制」
  const copyBlock = async (text: string, label: string) => {
    const value = stripHtml(text).trim();
    if (!value) {
      notify(`${label}还没有内容可复制`);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label}已复制到剪贴板`);
    } catch (error) {
      notify(`复制${label}失败：${String(error)}`);
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

  const persistTaskCommand = async (command: string, args: Record<string, unknown>) => {
    const write = taskWriteQueue.current.catch(() => undefined).then(() => invoke<void>(command, args));
    taskWriteQueue.current = write;
    await write;
  };

  const addTask = async (
    title: string,
    dueDate: string | null = null,
    sourceType: string | null = null,
    sourceId: string | null = null,
  ) => {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const task = { ...newTask(trimmed, sourceType, sourceId), dueDate };
    try {
      await persistTaskCommand("upsert_task", { task });
      setWorkspace(current => ({ ...current, tasks: [task, ...current.tasks] }));
      notify("已加入待办");
      return true;
    } catch (error) { notify(`添加待办失败，请重试：${String(error)}`); return false; }
  };

  const saveTask = async (task: Task) => {
    try {
      await persistTaskCommand("upsert_task", { task });
      setWorkspace(current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? task : item) }));
      return true;
    } catch (error) { notify(`保存待办失败，请重试：${String(error)}`); return false; }
  };

  const deleteTask = async (task: Task) => {
    if (!window.confirm(`确定删除待办“${task.title}”吗？`)) return;
    try {
      await persistTaskCommand("delete_task", { taskId: task.id });
      setWorkspace(current => ({ ...current, tasks: current.tasks.filter(item => item.id !== task.id) }));
      notify("待办已删除");
    } catch (error) { notify(`删除待办失败：${String(error)}`); }
  };

  const toggleTask = async (task: Task) => {
    await saveTask({ ...task, completed: !task.completed });
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
    setActiveRecordingMeetingId(meeting.id);
    setRecordingPhase("starting");
    try {
      const meetingId = meeting.id;
      // 先在后端建好空文件，录音过程中每 4 秒追加一段，意外退出时尽量保留已录内容。
      const begin = await invoke<BeginRecordingResult>("begin_recording", { meetingId, captureSystem: captureSystemAudio });
      if (begin.warning) notify(begin.warning);
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
            await flushSelectedMeeting();
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
                const roles = new Set(JSON.parse(meeting.speakerSegments).map((segment: { speakerId: number }) => segment.speakerId)).size;
                notify(roles === 1 ? "录音和原文已保存，但只识别到一个声音角色。实际多人时，可在原文校对中重新区分角色。" : "录音已保存，并自动完成转写与说话人区分。");
              } else {
                const meeting = await invoke<Meeting>("transcribe_meeting", {
                  meetingId,
                });
                if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
                notify(
                  "录音已保存，并自动完成转写。安装本地会议引擎后，还可在会后区分发言人。",
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
      });
      setRecordingPhase("recording");
      mediaRecorder.start(4000);
    } catch (error) {
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
      notify("本地会议引擎已就绪。录音结束后可生成完整原文并区分发言人。");
    } catch (error) {
      notify(`安装本地会议引擎失败：${String(error)}`);
    } finally {
      finishProcessing();
    }
  };

  const refreshOfflineManifest = async () => {
    try {
      const [manifest, asr, speaker] = await Promise.all([
        invoke<OfflineInstallManifest>("get_offline_manifest"),
        invoke<LocalAsrStatus>("get_local_asr_status"),
        invoke<SpeakerEngineStatus>("get_speaker_engine_status"),
      ]);
      setOfflineManifest(manifest);
      setAsrStatus(asr);
      setSpeakerStatus(speaker);
      notify("已重新检测本地引擎状态。");
    } catch (error) {
      notify(`重新检测失败：${String(error)}`);
    }
  };

  const openOfflineFolder = async (id: string) => {
    try {
      await invoke("open_offline_folder", { id });
    } catch (error) {
      notify(`打开目录失败：${String(error)}`);
    }
  };

  const importOfflineItem = async (id: string, kind: string) => {
    try {
      const picked = await open({
        directory: kind === "directory",
        multiple: false,
        title: kind === "directory" ? "选择 funasr-meeting 文件夹" : "选择已下载的文件",
      });
      if (typeof picked !== "string" || !picked.trim()) return;
      await invoke("import_offline_item", { id, source: picked });
      await refreshOfflineManifest();
      notify("导入完成，引擎状态已更新。");
    } catch (error) {
      notify(`导入失败：${String(error)}`);
    }
  };

  const copyOfflineLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("下载链接已复制，可粘贴到浏览器或下载工具。");
    } catch {
      notify("复制失败，请直接打开链接下载。");
    }
  };

  const openOfflineLink = async (url: string) => {
    try {
      await invoke("open_offline_link", { url });
    } catch (error) {
      notify(`${String(error)}：${url}`);
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
      const count = new Set(JSON.parse(meeting.speakerSegments).map((segment: { speakerId: number }) => segment.speakerId)).size;
      notify(count === 1 ? "原文已生成，但只识别到一个声音角色。实际多人时，可在原文校对中重新区分角色。" : "已完成本地转写与说话人区分，可继续生成智能纪要。");
    } catch (error) {
      const msg = String(error);
      notify(msg.includes("已取消") ? "已取消转写" : `说话人分离失败：${msg}`);
    } finally {
      finishProcessing();
    }
  };

  const rediarizeMeeting = async (speakerCount: number | null): Promise<boolean> => {
    if (!selectedMeeting || processing) return false;
    const meetingId = selectedMeeting.id;
    try {
      beginProcessing("speakerCorrecting", meetingId);
      await persistMeeting(selectedMeeting);
      const meeting = await invoke<Meeting>("rediarize_meeting", { meetingId, speakerCount });
      if (selectedMeetingRef.current?.id === meetingId) setSelectedMeeting(meeting);
      await reload();
      const count = new Set(JSON.parse(meeting.speakerSegments).map((segment: { speakerId: number }) => segment.speakerId)).size;
      notify(count === 1 ? "仍只识别到一个声音角色，可指定实际发言人数再次区分。" : `已重新区分为 ${count} 个声音角色，校对文字与纪要已保留。`);
      return true;
    } catch (error) {
      const detail = String(error);
      notify(detail.includes("已取消") ? "已取消角色修正，原记录仍然保留。" : `角色修正失败：${detail}`);
      return false;
    } finally { finishProcessing(); }
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

  if (startupError) return <div className="app-shell"><main className="startup-error" style={{ gridColumn: "1 / -1" }} role="alert">
    <FolderOpen size={32} />
    <h1>暂时无法打开工作台</h1>
    <p>本地资料库或录音恢复未能完成。请确认数据目录可访问、磁盘空间充足，然后重试。</p>
    <details><summary>查看错误详情</summary><p>{startupError}</p></details>
    <button className="primary-button" onClick={() => setStartupAttempt(value => value + 1)}><RefreshCw size={16} />重新加载</button>
  </main></div>;

  const commands: Command[] = [
    { id: "record", label: "一键开始录音", icon: <Mic size={16} />, run: () => void quickRecord() },
    { id: "new", label: "新建会议", icon: <Plus size={16} />, run: () => void createMeeting() },
    { id: "home", label: "转到首页", icon: <House size={16} />, run: () => setView("home") },
    { id: "meetings", label: "转到会议", icon: <UsersRound size={16} />, run: () => setView("meetings") },
    { id: "tasks", label: "转到待办", icon: <CheckCircle2 size={16} />, run: () => openTasksView() },
    { id: "projects", label: "转到项目", icon: <FolderOpen size={16} />, run: () => openProject() },
    { id: "settings", label: "打开设置", icon: <Settings size={16} />, run: () => setView("settings") },
  ];
  const activeRecordingMeeting = activeRecordingMeetingId
    ? (selectedMeeting?.id === activeRecordingMeetingId ? selectedMeeting : null)
      ?? workspace.meetings.find((meeting) => meeting.id === activeRecordingMeetingId)
    : null;

  return (
    <div className="app-shell">
      <AppSidebar view={view} reportOpen={weeklyReportOpen} onNewMeeting={() => void createMeeting()} onReport={() => setWeeklyReportOpen(true)} onNavigate={next => {
        if (next === "projects") openProject();
        else if (next === "tasks") openTasksView();
        else if (next === "journal") openJournal();
        else setView(next);
      }} />
      <main className="main-content" ref={pageScroller}>
        <PageHeader view={view} workspace={workspace} searchInput={searchInputRef} onMeeting={meeting => { void selectMeeting(meeting); setView("meetings"); }} onTask={openTask} onProject={openProject} onEntry={openEntry} />
        {message && <div className="toast" role="status" aria-live="polite">{message}</div>}
        {startupWarning && <div className="interrupted-task-banner" role="status"><div><strong>部分功能需要检查</strong><small>{startupWarning}</small></div><button className="secondary-button compact-button" onClick={() => setView("settings")}>检查设置</button><button className="secondary-button compact-button" onClick={() => void retryStartup()} disabled={recordingBusy || Boolean(processing)}>重新加载</button></div>}
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
          <WorkbenchHome
            workspace={workspace}
            onOpenMeeting={(meeting) => {
              void selectMeeting(meeting);
              setView("meetings");
            }}
            onQuickRecord={() => void quickRecord()}
            onOpenTasks={openTasksView}
            onOpenTask={openTask}
            onOpenMeetings={() => setView("meetings")}
            aiReady={aiSettings.isConfigured}
            transcriptionReady={asrEngine.provider === "cloud" ? asrEngine.cloudKeySaved : (asrStatus.installed && asrStatus.runtimeAvailable) || (speakerStatus.installed && speakerStatus.modelsReady)}
            onSettings={() => setView("settings")}
            onReport={() => setWeeklyReportOpen(true)}
            onJournal={openJournal}
            onProjects={openProject}
          />
        )}
        {view === "meetings" && (
          <MeetingWorkspace
            meetings={workspace.meetings}
            meeting={selectedMeeting}
            tasks={workspace.tasks}
            onSelect={(meeting) => void selectMeeting(meeting)}
            onCreate={() => void createMeeting()}
            onChange={setSelectedMeeting}
            onDelete={() => void deleteMeeting()}
            onImport={() => void importMeetingAudio()}
            onExport={() => void exportMeeting()}
            onCopy={() => void copyMeeting()}
            onCopyText={(text, label) => void copyBlock(text, label)}
            onRevealRecording={() => void revealRecording()}
            onTask={(title, due) => addTask(title, due, "meeting", selectedMeeting?.id ?? null)}
            onToggleTask={(task) => void toggleTask(task)}
            onSaveTask={saveTask}
            onDeleteTask={(task) => void deleteTask(task)}
            recording={recordingWorkspaceLocked}
            recordingFinalizing={recordingPhase === "finalizing"}
            recordingSeconds={recordingSeconds}
            recordingSession={recordingSession}
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
            onRediarize={rediarizeMeeting}
            onAnalyze={openGeneration}
            onRegenerateSection={(section) => void regenerateMeetingSection(section)}
            onRename={() => void renameMeeting()}
            onRenameSpeaker={(speakerId, name) => void renameSpeaker(speakerId, name)}
            onInstallSpeaker={() => void installSpeakerEngine()}
            onOpenSettings={() => setView("settings")}
            onWeeklyReport={() => setWeeklyReportOpen(true)}
            onProject={openProject}
          />
        )}
        {view === "journal" && <WorkJournal workspace={workspace} targetEntry={entryTarget} onClearTarget={() => setEntryTarget(undefined)} onProjects={openProject} onMeeting={id => { const m = workspace.meetings.find(m => m.id === id); if (m) { void selectMeeting(m); setView("meetings"); } }} />}
        {view === "projects" && <ProjectsPage initialProjectId={projectTarget} workspace={workspace} onMeeting={id => { const m = workspace.meetings.find(m => m.id === id); if (m) { void selectMeeting(m); setView("meetings"); } }} />}
        {view === "tasks" && (
          <Tasks
            key={taskFilter}
            initialFilter={taskFilter}
            targetTask={taskTarget}
            onClearTarget={() => setTaskTarget(undefined)}
            tasks={workspace.tasks}
            onAdd={(title, due) => addTask(title, due)}
            onToggle={(task) => void toggleTask(task)}
            onSave={saveTask}
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
            offlineManifest={offlineManifest}
            onOpenOfflineFolder={(id) => void openOfflineFolder(id)}
            onImportOfflineItem={(id, kind) => void importOfflineItem(id, kind)}
            onRefreshOffline={() => void refreshOfflineManifest()}
            onCopyOfflineLink={(text) => void copyOfflineLink(text)}
            onOpenOfflineLink={(url) => void openOfflineLink(url)}
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
              : (speakerStatus.installed && speakerStatus.modelsReady) || (asrStatus.installed && asrStatus.runtimeAvailable)
          }
          transcriptionLabel={
            asrEngine.provider === "cloud"
              ? asrEngine.cloudKeySaved
                ? "云端转写已配置，录音结束后自动转写"
                : "云端密钥尚未配置，录音仍会正常保存"
              : speakerStatus.installed && speakerStatus.modelsReady
                ? "会后转写与说话人区分已就绪"
                : asrStatus.installed && asrStatus.runtimeAvailable
                  ? "轻量会后转写已就绪；区分发言人需安装会议引擎"
                : "会后引擎尚未就绪，录音仍会正常保存，可配置后再转写"
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
