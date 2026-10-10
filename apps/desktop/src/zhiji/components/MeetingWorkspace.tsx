import { Check, CheckCircle2, ChevronRight, Columns2, Copy, FileAudio, FileDown, FolderOpen, LoaderCircle, MessageCircleQuestion, Mic, MoreHorizontal, Play, Plus, RefreshCw, Sparkles, StickyNote, Trash2, Upload, Wand2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AsrEngineSettings, LiveTranscriptState, RecordingSessionStatus, LocalAsrStatus, Meeting, Processing, SpeakerEngineStatus, SpeakerSegment, Task } from "../types";
import { MeetingStatus, isLiveDraft } from "../types";
import { meetingJourney } from "../workflow";
import { duration } from "../format";
import { AiWorkflow, AudioPlayer, Dialog, EditorField, Empty, IconButton, MarkdownField, LiveMeetingStage, MeetingQaPanel, MeetingSidebar, Popover, SpeakerTimeline, StatusDot, stripHtml, TaskComposer, TaskRow, Tooltip } from "../components";

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function minuteSources(markdown: string) {
  const matches = markdown.matchAll(/【来源\s*(\d{1,3}):(\d{2})】/g);
  const seen = new Set<number>();
  return Array.from(matches)
    .map((match) => Number(match[1]) * 60 + Number(match[2]))
    .filter((seconds) => Number.isFinite(seconds) && !seen.has(seconds) && Boolean(seen.add(seconds)));
}

// 对照阅读需要足够的横向空间：详情列在「导航 + 会议列表 + 详情」三层布局下只有约 850px，
// 强行对分会把转写正文压到 100px 上下。因此只有宽屏才默认进入对照，窄屏沿用原来的单栏 Tab。
function wideEnoughForContrast() {
  return typeof window !== "undefined" && window.matchMedia("(min-width: 1400px)").matches;
}
function initialWorkspaceTab(target: Meeting | null): "split" | "summary" | "transcript" {
  if (!target?.minutes.trim()) return "transcript";
  return wideEnoughForContrast() ? "split" : "summary";
}

export function MeetingWorkspace({
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
  onCopyText,
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
  onRediarize,
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
  onCopyText: (text: string, label: string) => void;
  onRevealRecording: () => void;
  onTask: (title: string, due: string | null) => Promise<boolean>;
  onToggleTask: (task: Task) => void;
  onSaveTask: (task: Task) => Promise<boolean>;
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
  onRediarize: (speakerCount: number | null) => Promise<boolean>;
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
  const [workspaceTab, setWorkspaceTab] = useState<"split" | "summary" | "transcript" | "qa">(
    initialWorkspaceTab(meeting),
  );
  const [notesOpen, setNotesOpen] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [expectedSpeakers, setExpectedSpeakers] = useState("auto");
  const [correctingRoles, setCorrectingRoles] = useState(false);
  // 会前背景条：默认收起；有内容时收起并显示首行预览，空时展开引导填写
  const [contextOpen, setContextOpen] = useState<boolean | null>(null);
  const contextExpanded = contextOpen ?? !meeting?.context?.trim();
  const isContrast = workspaceTab === "split";

  useEffect(() => {
    setWorkspaceTab(initialWorkspaceTab(meeting));
    setContextOpen(null);
    setNotesOpen(false);
    setRolesOpen(false);
    setExpectedSpeakers("auto");
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

  // 我的笔记改为右侧抽屉：不再长期占用主栏，只在需要时滑出。
  // 复用 Dialog 原语，以沿用统一的遮罩、Esc、Tab 焦点循环与关闭后还焦。
  const notesDrawer = meeting && notesOpen ? (
    <Dialog className="notes-drawer" ariaLabel="我的笔记" onClose={() => setNotesOpen(false)}>
      <div className="notes-drawer-head">
        <div>
          <h3>我的笔记</h3>
          <small>随手记下观察和想法，智能纪要不会覆盖这里 · 自动保存</small>
        </div>
        <IconButton icon={X} label="关闭笔记" onClick={() => setNotesOpen(false)} />
      </div>
      <textarea
        className="notes-drawer-input"
        aria-label="我的笔记"
        autoFocus
        value={meeting.notes}
        onChange={(event) => onChange({ ...meeting, notes: event.target.value })}
        placeholder="随时记下你的观察与想法（纯文本，自动保存）"
      />
    </Dialog>
  ) : null;

  const transcriptPane = meeting ? (
    <section className="transcript-pane">
      <div className="pane-head">
        <div>
          <h3>原文校对</h3>
          <small>{speakerSegments.length > 0 ? "边听边改每个片段，修改会同步到完整原文" : "可以直接修正识别文字"}</small>
        </div>
        {meeting.transcript.trim() && (
          <div className="pane-actions">
            <Tooltip label="复制完整原文到剪贴板">
              <button
                className="pane-action secondary icon-only"
                aria-label="复制原文"
                onClick={() => onCopyText(meeting.transcript, "原文")}
              >
                <Copy size={15} />
              </button>
            </Tooltip>
            <span className="count-pill">约 {meeting.transcript.trim().length} 字</span>
          </div>
        )}
      </div>
      {speakerSegments.length > 0 && meeting.audioPath && asrEngine.provider === "local" && (
        <div className={`speaker-correction-strip ${speakerCount === 1 ? "needs-review" : ""}`}>
          <span>{speakerCount === 1 ? "目前只识别到一个声音角色，实际多人时可重新区分。" : "声音角色不准确时，可以保留正文重新区分。"}</span>
          <button className="ghost-button" disabled={busy || recording || recordingFinalizing || !speakerStatus.installed} onClick={() => setRolesOpen(true)}><RefreshCw size={14} />重新区分角色</button>
        </div>
      )}
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
            <Tooltip label="复制智能纪要全文到剪贴板">
              <button
                className="pane-action secondary icon-only"
                aria-label="复制纪要"
                onClick={() => onCopyText(stripHtml(meeting.minutes), "智能纪要")}
              >
                <Copy size={15} />
              </button>
            </Tooltip>
          )}
          {meeting.minutes.trim() && (
            <Tooltip label="只重新生成智能纪要，保留决策和待办">
              <button
                className="pane-action secondary icon-only"
                aria-label="只重写纪要"
                onClick={() => onRegenerateSection("minutes")}
                disabled={!aiConfigured || !meeting.transcript.trim() || busy}
              >
                <RefreshCw size={15} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {meeting.minutes.trim() || aiConfigured ? (
        <MarkdownField
          hint="Markdown 预览会渲染标题、列表与表格"
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
              <Tooltip label="只重新提取决策与共识，保留纪要和待办">
                <button className="pane-action secondary icon-only" aria-label="只重提决策" onClick={() => onRegenerateSection("decisions")} disabled={!aiConfigured || !meeting.transcript.trim() || busy}>
                  <RefreshCw size={14} />
                </button>
              </Tooltip>
            </div>
            <MarkdownField
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
                <Tooltip label="只重新提取本会议的行动项">
                  <button className="pane-action secondary icon-only" aria-label="重新提取" onClick={() => onRegenerateSection("tasks")} disabled={!aiConfigured || !meeting.transcript.trim() || busy}>
                    <RefreshCw size={14} />
                  </button>
                </Tooltip>
                <Tooltip label="添加待办">
                  <button className="icon-btn" aria-label="添加待办" onClick={() => setTaskComposing((value) => !value)}><Plus size={14} /></button>
                </Tooltip>
              </div>
            </div>
            {taskComposing && (
              <TaskComposer
                autoFocus
                onAdd={async (title, due) => {
                  const saved = await onTask(title, due);
                  if (saved) setTaskComposing(false);
                  return saved;
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

  const workflow = meeting ? (
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
  ) : null;

  return (
    <div className={`meeting-shell ${meeting ? "has-meeting" : ""} ${recording ? "is-live" : ""} ${isContrast ? "is-contrast" : ""}`}>
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
                {journey && (journey.step === 4 ? (
                  <section className="meeting-journey-card is-complete">
                    <div className="journey-complete-copy">
                      <Check size={15} />
                      <strong>{journey.label}</strong>
                      <small>{journey.detail}</small>
                    </div>
                    <div className="meeting-journey-actions">
                      <button className="secondary-button compact-button" disabled={busy} onClick={onImport}>
                        {processing === "importing" ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
                        {processing === "importing" ? "正在导入" : "导入录音"}
                      </button>
                      <button className="record-button compact-button" disabled={busy} onClick={onRecord}>
                        <Mic size={14} />{meeting.audioPath ? "重新录音" : "开始录音"}
                      </button>
                      {workflow}
                    </div>
                  </section>
                ) : (
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
                ))}

                {/* 常驻一行：会议背景直接影响热词校正与纪要理解，不该藏在外层卡片标题之后 */}
                <section className="meeting-context" aria-label="会议背景">
                  <div className={`context-strip ${contextExpanded ? "open" : ""}`}>
                    <button
                      className="context-strip-head"
                      aria-expanded={contextExpanded}
                      onClick={() => setContextOpen(!contextExpanded)}
                    >
                      <ChevronRight size={14} style={{ transform: contextExpanded ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
                      <span>会议背景</span>
                      {!contextExpanded && meeting.context.trim() && <small>{meeting.context.trim().split("\n")[0]}</small>}
                      {!contextExpanded && !meeting.context.trim() && <small className="context-empty">议程、参会人、术语用于热词校正与纪要理解</small>}
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
                  {journey?.step !== 4 && workflow}
                </section>

                <div className={`meeting-workspace ${isContrast ? "is-contrast" : ""}`}>
                  <nav className="meeting-workspace-tabs" aria-label="会议内容">
                    <button className={workspaceTab === "split" ? "active" : ""} onClick={() => setWorkspaceTab("split")}>
                      <span><Columns2 size={15} />对照阅读</span>
                    </button>
                    <button className={workspaceTab === "summary" ? "active" : ""} onClick={() => setWorkspaceTab("summary")}>
                      <span><Sparkles size={15} />智能纪要</span>{meetingTasks.length > 0 && <b>{meetingTasks.length}</b>}
                    </button>
                    <button className={workspaceTab === "transcript" ? "active" : ""} onClick={() => setWorkspaceTab("transcript")}>
                      <span><FileAudio size={15} />原文校对</span>{speakerSegments.length > 0 && <b>{speakerSegments.length}</b>}
                    </button>
                    <button className={workspaceTab === "qa" ? "active" : ""} onClick={() => setWorkspaceTab("qa")}><span><MessageCircleQuestion size={15} />会议问答</span></button>
                    <button
                      type="button"
                      className="meeting-notes-trigger"
                      aria-haspopup="dialog"
                      title="打开笔记抽屉"
                      onClick={() => setNotesOpen(true)}
                    >
                      <span><StickyNote size={15} />我的笔记{meeting.notes.trim() && <i className="notes-dot" aria-hidden="true" />}</span>
                    </button>
                  </nav>
                  <div className="meeting-workspace-content">
                    {workspaceTab === "split" && (
                      <div className="meeting-contrast">
                        {transcriptPane}
                        {minutesPane}
                      </div>
                    )}
                    {workspaceTab === "summary" && minutesPane}
                    {workspaceTab === "transcript" && transcriptPane}
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
      {notesDrawer}
      {meeting && rolesOpen && (
        <Dialog className="speaker-correction-modal" ariaLabel="重新区分角色" onClose={correctingRoles ? undefined : () => setRolesOpen(false)} closeOnEsc={!correctingRoles}>
          <div className="modal-head"><h3>重新区分角色</h3><IconButton icon={X} label="关闭角色修正" disabled={correctingRoles} onClick={() => setRolesOpen(false)} /></div>
          <p>只重新分析声音角色，保留已校对的文字和纪要。角色名称需重新核对。</p>
          <label className="speaker-count-field">实际发言人数
            <select aria-label="实际发言人数" value={expectedSpeakers} disabled={correctingRoles} onChange={(event) => setExpectedSpeakers(event.target.value)}>
              <option value="auto">不确定，自动判断</option>
              {Array.from({ length: 15 }, (_, index) => index + 1).map((count) => <option key={count} value={String(count)}>{count} 人</option>)}
            </select>
          </label>
          <small>自动结果漏分时，选择实际发言人数会更有帮助。</small>
          <div className="modal-actions"><button className="secondary-button" disabled={correctingRoles} onClick={() => setRolesOpen(false)}>取消</button><button className="primary-button" disabled={busy || correctingRoles} onClick={async () => {
            if (correctingRoles) return;
            setCorrectingRoles(true);
            try { if (await onRediarize(expectedSpeakers === "auto" ? null : Number(expectedSpeakers))) setRolesOpen(false); }
            finally { setCorrectingRoles(false); }
          }}>{correctingRoles ? "正在区分…" : "开始区分"}</button></div>
        </Dialog>
      )}
    </div>
  );
}
