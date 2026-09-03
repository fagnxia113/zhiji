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
  const visibleMeetings = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return meetings;
    return meetings.filter((meeting) =>
      [meeting.title, meeting.context, meeting.transcript]
        .some((value) => value.toLocaleLowerCase().includes(normalized)),
    );
  }, [meetings, query]);

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
      <div className="meeting-list-scroll">
        {visibleMeetings.map((item) => {
          const state = meetingJourney(item).label;
          return (
            <button
              className={`meeting-item ${selectedId === item.id ? "selected" : ""}`}
              onClick={() => onSelect(item)}
              key={item.id}
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
          <Empty label={query ? "没有匹配的会议。" : "还没有会议，点击右上角开始。"} />
        )}
      </div>
    </aside>
  );
}
