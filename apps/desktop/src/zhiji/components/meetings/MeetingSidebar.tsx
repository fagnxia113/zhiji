import { CalendarDays, CalendarRange, ChevronRight, Mic, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { Meeting } from "../../types";
import { meetingJourney } from "../../workflow";
import { Empty, StatusDot } from "../ui";

type MeetingSidebarProps = {
  meetings: Meeting[];
  selectedId?: string;
  onSelect: (meeting: Meeting) => void;
  onCreate: () => void;
  onWeeklyReport: () => void;
  formatDate: (value: string) => string;
};

export function MeetingSidebar({
  meetings,
  selectedId,
  onSelect,
  onCreate,
  onWeeklyReport,
  formatDate,
}: MeetingSidebarProps) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const [order, setOrder] = useState("newest");
  const visibleMeetings = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return meetings.filter((meeting) => {
      const step = meetingJourney(meeting).step;
      if (stage === "pending" && step === 4) return false;
      if (stage === "done" && step !== 4) return false;
      return [meeting.title, meeting.context, meeting.transcript, meeting.minutes, meeting.notes, meeting.decisions]
        .some((value) => value.toLocaleLowerCase().includes(normalized));
    }).sort((a, b) => order === "oldest" ? a.startedAt.localeCompare(b.startedAt)
      : order === "updated" ? b.updatedAt.localeCompare(a.updatedAt) : b.startedAt.localeCompare(a.startedAt));
  }, [meetings, query, stage, order]);

  return (
    <aside className="meeting-sidebar" aria-label="会议列表">
      <div className="meeting-sidebar-head">
        <div>
          <h2>会议</h2>
          <small>{meetings.length} 场记录</small>
        </div>
        <div className="meeting-sidebar-actions">
          <button className="round-add subtle" onClick={onWeeklyReport} title="汇总一周会议生成周报" aria-label="生成周报">
            <CalendarRange size={16} />
          </button>
          <button className="round-add" onClick={onCreate} title="新建会议" aria-label="新建会议">
            <Plus size={18} />
          </button>
        </div>
      </div>
      <label className="meeting-list-search">
        <Search size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题或内容"
          aria-label="搜索会议"
        />
      </label>
      <div className="meeting-filter-tabs" aria-label="按整理状态筛选">
        {[["all", "全部"], ["pending", "待整理"], ["done", "已完成"]].map(([value, label]) =>
          <button key={value} aria-pressed={stage === value} className={stage === value ? "active" : ""} onClick={() => setStage(value)}>{label}</button>)}
      </div>
      <div className="meeting-list-order"><small>{visibleMeetings.length} 场会议</small><select aria-label="会议排序" value={order} onChange={event => setOrder(event.target.value)}>
        <option value="newest">最新会议优先</option><option value="oldest">最早会议优先</option><option value="updated">最近修改优先</option>
      </select></div>
      <div className="meeting-list-scroll">
        {visibleMeetings.map((item) => {
          const state = meetingJourney(item).label;
          return (
            <button
              className={`meeting-item ${selectedId === item.id ? "selected" : ""}`}
              onClick={() => onSelect(item)}
              key={item.id}
              aria-current={selectedId === item.id ? "true" : undefined}
            >
              <span className={`meeting-date ${item.audioPath ? "has-audio" : ""}`}>
                {item.audioPath ? <Mic size={14} /> : <CalendarDays size={14} />}
              </span>
              <span className="meeting-item-copy">
                <strong>{item.title}</strong>
                <small>{formatDate(item.startedAt)}</small>
                <em><StatusDot status={item.status} />{state}</em>
              </span>
              <ChevronRight size={14} />
            </button>
          );
        })}
        {visibleMeetings.length === 0 && (
          <Empty label={query || stage !== "all" ? "当前筛选下没有会议。" : "还没有会议，点击右上角开始。"} />
        )}
        {visibleMeetings.length === 0 && (query || stage !== "all") && <button className="meeting-clear-filter" onClick={() => { setQuery(""); setStage("all"); }}>清除筛选</button>}
      </div>
    </aside>
  );
}
