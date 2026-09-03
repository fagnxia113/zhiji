import { CalendarDays, Check, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { Task } from "../../types";
import { taskDueState } from "../../workflow";
import { IconButton } from "../ui";

export function formatDue(d: string) {
  const parts = d.split("-");
  if (parts.length < 3) return d;
  const [, m, day] = parts;
  return `${Number(m)}月${Number(day)}日`;
}

// 单条待办：可勾选完成、内联编辑标题与截止日期、删除、跳转来源
export function TaskRow({
  task,
  onToggle,
  onSave,
  onDelete,
  onOpenSource,
}: {
  task: Task;
  onToggle: (task: Task) => void;
  onSave: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpenSource?: (task: Task) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState(task.dueDate ?? "");
  const overdue = taskDueState(task) === "overdue";

  const startEdit = () => {
    setTitle(task.title);
    setDue(task.dueDate ?? "");
    setEditing(true);
  };
  const commit = () => {
    const next = title.trim();
    if (!next) {
      setEditing(false);
      return;
    }
    onSave({ ...task, title: next, dueDate: due || null });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className={`task-row editing${task.completed ? " done" : ""}`}>
        <input
          className="task-edit-title"
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <input
          className="task-edit-due"
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
        />
        <IconButton icon={Check} label="保存" onClick={commit} />
        <IconButton icon={X} label="取消" onClick={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className={`task-row${task.completed ? " done" : ""}`}>
      <label className="task-check">
        <input type="checkbox" checked={task.completed} onChange={() => onToggle(task)} />
        <span className="checkmark">{task.completed && <Check size={13} />}</span>
      </label>
      <button className="task-title" onClick={startEdit} title="点击编辑">
        {task.title}
      </button>
      {task.dueDate && (
        <span className={`task-due${overdue ? " overdue" : ""}`} title={overdue ? "已逾期" : "截止日期"}>
          <CalendarDays size={13} />
          {formatDue(task.dueDate)}
        </span>
      )}
      {task.sourceType && (
        onOpenSource ? (
          <button className="task-source" onClick={() => onOpenSource(task)} disabled={!task.sourceId} title="打开来源">
            {task.sourceType === "meeting" ? "查看会议" : "查看笔记"}
          </button>
        ) : <small className="task-source">{task.sourceType === "meeting" ? "会议" : "笔记"}</small>
      )}
      <IconButton icon={Pencil} label="编辑" onClick={startEdit} />
      <IconButton icon={Trash2} label="删除" danger onClick={() => onDelete(task)} />
    </div>
  );
}
