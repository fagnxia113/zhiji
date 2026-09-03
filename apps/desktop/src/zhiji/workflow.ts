import type { Meeting, Task } from "./types";

export type MeetingJourney = {
  step: 1 | 2 | 3 | 4;
  label: string;
  detail: string;
  action: "record" | "transcript" | "summary" | "review";
};

export function meetingJourney(meeting: Meeting): MeetingJourney {
  if (!meeting.audioPath && !meeting.transcript.trim()) {
    return { step: 1, label: "等待录音", detail: "补充议程后即可开始", action: "record" };
  }
  if (!meeting.transcript.trim()) {
    return { step: 2, label: "等待转写", detail: "录音已安全保存", action: "transcript" };
  }
  if (!meeting.minutes.trim()) {
    return { step: 3, label: "等待整理", detail: "先校对原文，再生成纪要", action: "summary" };
  }
  return { step: 4, label: "整理完成", detail: "纪要、决策与待办已生成", action: "review" };
}

export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function taskDueState(task: Task) {
  if (task.completed || !task.dueDate) return "none" as const;
  const today = localDateKey();
  if (task.dueDate < today) return "overdue" as const;
  if (task.dueDate === today) return "today" as const;
  return "upcoming" as const;
}

export function taskDueText(task: Task) {
  const state = taskDueState(task);
  if (state === "overdue") return `已逾期 · ${task.dueDate}`;
  if (state === "today") return "今天到期";
  if (state === "upcoming") return `${task.dueDate} 到期`;
  return task.sourceType === "meeting" ? "来自会议" : "未设置日期";
}
