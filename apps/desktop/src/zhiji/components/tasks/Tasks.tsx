import { Plus, Search } from "lucide-react";
import { useState } from "react";
import type { Task } from "../../types";
import { taskDueState } from "../../workflow";
import { TaskComposer } from "./TaskComposer";
import { TaskGroup } from "./TaskGroup";

type TaskFilter = "open" | "today" | "overdue" | "stale" | "done" | "all";

const FILTER_LABEL: Record<TaskFilter, string> = {
  open: "待完成",
  today: "今天到期",
  overdue: "已逾期",
  stale: "超过 14 天未处理",
  done: "已完成",
  all: "全部待办",
};

// 待办首页：分组筛选、负责人过滤、新建待办
export function Tasks({
  tasks,
  onAdd,
  onToggle,
  onSave,
  onDelete,
  onOpenSource,
}: {
  tasks: Task[];
  onAdd: (title: string, due: string | null) => void;
  onToggle: (task: Task) => void;
  onSave: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpenSource: (task: Task) => void;
}) {
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [taskQuery, setTaskQuery] = useState("");
  const [assignee, setAssignee] = useState("all");
  const staleBefore = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const taskAssignee = (task: Task) => task.owner?.trim() || task.title.match(/^([^：:]{1,16})[：:]/)?.[1]?.trim() || "";
  const assignees = Array.from(new Set(tasks.map(taskAssignee).filter(Boolean))).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const counts = {
    open: tasks.filter((task) => !task.completed).length,
    today: tasks.filter((task) => taskDueState(task) === "today").length,
    overdue: tasks.filter((task) => taskDueState(task) === "overdue").length,
    stale: tasks.filter((task) => !task.completed && !task.dueDate && task.createdAt < staleBefore).length,
    done: tasks.filter((task) => task.completed).length,
  };
  const filtered = tasks.filter((task) => {
    if (taskQuery && !task.title.toLowerCase().includes(taskQuery.toLowerCase())) return false;
    if (assignee !== "all" && taskAssignee(task) !== assignee) return false;
    if (filter === "open" && task.completed) return false;
    if (filter === "today" && taskDueState(task) !== "today") return false;
    if (filter === "overdue" && taskDueState(task) !== "overdue") return false;
    if (filter === "stale" && (task.completed || Boolean(task.dueDate) || task.createdAt >= staleBefore)) return false;
    if (filter === "done" && !task.completed) return false;
    return true;
  });
  return (
    <div className="tasks-page">
      <div className="tasks-intro">
        <div>
          <h2>专注下一步</h2>
          <p>智能纪要提取的行动项，会自动出现在这里。</p>
        </div>
        <button className="primary-button" onClick={() => setComposing((v) => !v)}>
          <Plus size={16} />
          新建待办
        </button>
      </div>
      {composing && (
        <TaskComposer
          autoFocus
          onAdd={(title, due) => {
            onAdd(title, due || null);
            setComposing(false);
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      <div className="task-dashboard">
        {([
          ["open", "待完成", counts.open], ["today", "今天到期", counts.today], ["overdue", "已逾期", counts.overdue],
          ["stale", "长期未处理", counts.stale], ["done", "已完成", counts.done], ["all", "全部", tasks.length],
        ] as const).map(([id, label, count]) => (
          <button key={id} className={`${filter === id ? "active" : ""}${id === "overdue" && count ? " attention" : ""}`} onClick={() => setFilter(id)}>
            <strong>{count}</strong><span>{label}</span>
          </button>
        ))}
      </div>
      <div className="task-toolbar">
        <label><Search size={14} /><input value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder="搜索待办" /></label>
        {assignees.length > 0 && (
          <select value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="all">全部负责人</option>
            {assignees.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
      </div>
      <TaskGroup
        title={FILTER_LABEL[filter]}
        tasks={filtered}
        onToggle={onToggle}
        onSave={onSave}
        onDelete={onDelete}
        onOpenSource={onOpenSource}
      />
    </div>
  );
}
