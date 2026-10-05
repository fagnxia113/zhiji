import { Fragment } from "react";
import { CalendarDays, CheckCircle2, ChevronRight, Clock3, FileAudio, FileDown, Mic } from "lucide-react";
import type { Meeting, Task, Workspace } from "../types";
import { meetingJourney, taskDueState, taskDueText } from "../workflow";
import { duration } from "../format";
import type { TaskFilter } from "./tasks/Tasks";
import { Empty } from "./ui";
import { WorkbenchSetup } from "./WorkbenchSetup";
import { WorkJournal } from "./WorkJournal";
import { ContinueProject } from "./ProjectsPage";

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

export function WorkbenchHome({
  workspace,
  onOpenMeeting,
  onQuickRecord,
  onOpenTasks,
  onOpenTask,
  onOpenMeetings,
  aiReady, transcriptionReady, onSettings, onReport, onJournal, onProjects,
}: {
  workspace: Workspace;
  onOpenMeeting: (meeting: Meeting) => void;
  onQuickRecord: () => void;
  onOpenTasks: (filter?: TaskFilter) => void;
  onOpenTask: (task: Task) => void;
  onOpenMeetings: () => void;
  aiReady: boolean;
  transcriptionReady: boolean;
  onSettings: () => void;
  onReport: () => void;
  onJournal: () => void;
  onProjects: () => void;
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
  const recentMeetings = workspace.meetings.slice(0, 3);
  return (
    <div className="page-grid home-dashboard">
      <section className="home-command-card">
        <div className="home-command-copy">
          <span className="home-date-label">{todayFullDate()}</span>
          <h2>{greeting()}，从手头的工作开始。</h2>
        </div>
        <div className="home-command-actions">
          <button className="secondary-button record-cta" onClick={onQuickRecord}>
            <Mic size={17} /> 一键开始录音
          </button>
          <button className="secondary-button compact-button" onClick={onReport}>
            <FileDown size={15} /> 生成周报
          </button>
        </div>
      </section>

      <WorkbenchSetup aiReady={aiReady} transcriptionReady={transcriptionReady} onSettings={onSettings} />
      <div className="home-resume-group">
      <ContinueProject onOpen={onProjects} />

      {continueMeeting && (
        <section className="continue-meeting-card">
          <span className="continue-icon"><Clock3 size={19} /></span>
          <div className="continue-copy">
            <small>继续处理会议</small>
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
      </div>
      <WorkJournal workspace={workspace} compact onOpen={onJournal} />

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
            <button onClick={() => onOpenTasks()}>全部待办<ChevronRight size={13} /></button>
          </div>
          <div className="home-task-metrics">
            <button className={overdue.length ? "attention" : ""} onClick={() => onOpenTasks("overdue")}><strong>{overdue.length}</strong><span>已逾期</span></button>
            <button className={dueToday.length ? "today" : ""} onClick={() => onOpenTasks("today")}><strong>{dueToday.length}</strong><span>今天到期</span></button>
            <button onClick={() => onOpenTasks()}><strong>{openTasks.length}</strong><span>待完成</span></button>
          </div>
          <div className="home-task-list">
            {upcomingTasks.map((task) => (
              <button key={task.id} onClick={() => onOpenTask(task)}>
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
      </aside>
    </div>
  );
}
