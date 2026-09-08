import { ArrowUpRight, CalendarRange, CheckCircle2, FileText, ShieldCheck, Sparkles } from "lucide-react";
import type { Workspace } from "../types";
import { localDateKey, meetingJourney } from "../workflow";

export function WorkbenchOverview({ workspace, aiReady, transcriptionReady, onMeetings, onTasks, onSettings, onReport }: {
  workspace: Workspace;
  aiReady: boolean;
  transcriptionReady: boolean;
  onMeetings: () => void;
  onTasks: () => void;
  onSettings: () => void;
  onReport: () => void;
}) {
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  const weekMeetings = workspace.meetings.filter(m => new Date(m.startedAt) >= monday && new Date(m.startedAt) <= new Date());
  const completed = workspace.meetings.filter(m => meetingJourney(m).step === 4).length;
  const pending = workspace.tasks.filter(t => !t.completed).length;
  return <>
    <section className="workbench-metrics" aria-label="工作概览">
      <button onClick={onMeetings}><span><CalendarRange size={17} />本周会议</span><strong>{weekMeetings.length}<small>场</small></strong><em>从 {localDateKey(monday).slice(5).replace("-", "/")} 开始<ArrowUpRight size={15} /></em></button>
      <button onClick={onMeetings}><span><FileText size={17} />已整理纪要</span><strong>{completed}<small>篇</small></strong><em>让每次讨论都有据可查<ArrowUpRight size={15} /></em></button>
      <button onClick={onTasks}><span><CheckCircle2 size={17} />待办事项</span><strong>{pending}<small>项</small></strong><em>把决定变成下一步行动<ArrowUpRight size={15} /></em></button>
      <button className="weekly-shortcut" onClick={onReport}><span><Sparkles size={17} />每周回顾</span><strong>生成周报<ArrowUpRight size={20} /></strong><em>汇总会议成果与行动项</em></button>
    </section>
    {(!aiReady || !transcriptionReady) && <section className="workbench-setup" aria-label="工作台配置状态">
      <ShieldCheck size={22} />
      <div><strong>准备好你的工作台</strong><p>本地资料库已就绪。{!transcriptionReady && "配置语音引擎后即可转写；"}{!aiReady && "连接 AI 服务后可生成纪要和周报。"}录音与手动记录可直接使用。</p></div>
      <button className="secondary-button compact-button" onClick={onSettings}>完善配置<ArrowUpRight size={14} /></button>
    </section>}
  </>;
}
