import { CheckCircle2, ChevronRight, Mic } from "lucide-react";
import type { Meeting, Task, Workspace } from "../types";
import { meetingJourney, taskDueText } from "../workflow";
import { useWorkbench } from "../workbench";
import type { TaskFilter } from "./tasks/Tasks";
import { WorkbenchSetup } from "./WorkbenchSetup";
import { WorkJournal } from "./WorkJournal";
import { ContinueProject } from "./ProjectsPage";

export function WorkbenchHome({ workspace, onOpenMeeting, onQuickRecord, onOpenTasks, onOpenTask, onToggleTask, aiReady, transcriptionReady, onSettings, onReport, onJournal, onProjects, onOpenEntry }: {
  workspace: Workspace;
  onOpenMeeting: (meeting: Meeting) => void;
  onQuickRecord: () => void;
  onOpenTasks: (filter?: TaskFilter) => void;
  onOpenTask: (task: Task) => void;
  onToggleTask: (task: Task) => void;
  aiReady: boolean; transcriptionReady: boolean;
  onSettings: () => void; onReport: () => void; onJournal: () => void; onProjects: () => void;
  onOpenEntry: (id: string) => void;
}) {
  const { data } = useWorkbench();
  const tasks = workspace.tasks.filter(task => !task.completed).sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || a.createdAt.localeCompare(b.createdAt));
  const meeting = workspace.meetings.find(item => meetingJourney(item).step < 4);
  const recent = [...data.entries].sort((a,b) => b.occurredOn.localeCompare(a.occurredOn) || b.updatedAt.localeCompare(a.updatedAt)).slice(0,3);
  return <div className="home-dashboard home-workspace">
    <div className="home-command-card"><small>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</small><button className="secondary-button compact-button" onClick={onQuickRecord}><Mic size={16} />一键开始录音</button></div>
    <WorkbenchSetup aiReady={aiReady} transcriptionReady={transcriptionReady} onSettings={onSettings} />
    <div className="home-work-area">
      <div className="home-work-main">
        <section className="home-followups" aria-label="需要跟进"><div className="home-section-heading"><h2>需要跟进</h2><button className="text-button" onClick={() => onOpenTasks()}>行动待办</button></div>
          {tasks.slice(0,5).map(task => <article className="home-followup" key={task.id}><input type="checkbox" aria-label={`完成待办：${task.title}`} checked={task.completed} onChange={() => onToggleTask(task)} /><button className="text-button" onClick={() => onOpenTask(task)}><span>{task.title}</span><small>{taskDueText(task)}{task.owner ? ` · ${task.owner}` : ""}</small></button></article>)}
          {!tasks.length && <p className="home-clear"><CheckCircle2 size={16} />暂无待跟进事项</p>}
          {tasks.length > 5 && <button className="text-button" onClick={() => onOpenTasks()}>查看全部 {tasks.length} 项</button>}
        </section>
        <section className="home-continue" aria-label="继续工作"><h2>继续工作</h2><ContinueProject onOpen={onProjects} />
          {meeting && <article className="home-continue-row"><div><strong>{meeting.title}</strong><small>{meetingJourney(meeting).detail}</small></div><button className="secondary-button compact-button" onClick={() => onOpenMeeting(meeting)}>{meetingJourney(meeting).label}<ChevronRight size={14} /></button></article>}
          <article className="home-continue-row"><div><strong>本周周报</strong><small>汇总项目推进与日常事务</small></div><button className="secondary-button compact-button" onClick={onReport}>生成周报</button></article>
        </section>
      </div>
      <aside className="home-capture"><WorkJournal workspace={workspace} compact onOpen={onJournal} /></aside>
    </div>
    <section className="home-recent-work"><div className="home-section-heading"><h2>最近记下的工作</h2><button className="text-button" onClick={onJournal}>工作记录</button></div>{recent.map(entry => <button key={entry.id} className="home-recent-entry" onClick={() => onOpenEntry(entry.id)}><span>{entry.content}</span><small>{entry.occurredOn} · {data.projects.find(p => p.id === entry.projectId)?.name || "日常事务"}</small></button>)}{!recent.length && <p className="capture-hint">记下一句实际进展，写周报时就能直接汇总。</p>}</section>
  </div>;
}
