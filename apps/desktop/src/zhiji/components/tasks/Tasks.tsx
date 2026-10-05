import { ArrowLeft, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Task } from "../../types";
import { taskDueState } from "../../workflow";
import { TaskComposer } from "./TaskComposer";
import { TaskGroup } from "./TaskGroup";

export type TaskFilter = "open" | "today" | "overdue" | "stale" | "done" | "all";

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
  initialFilter = "open",
  targetTask,
  onClearTarget,
}: {
  tasks: Task[];
  onAdd: (title: string, due: string | null) => Promise<boolean>;
  onToggle: (task: Task) => void;
  onSave: (task: Task) => Promise<boolean>;
  onDelete: (task: Task) => void;
  onOpenSource: (task: Task) => void;
  initialFilter?: TaskFilter;
  targetTask?: { id: string; request: number };
  onClearTarget?: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>(initialFilter);
  const [taskQuery, setTaskQuery] = useState("");
  const [assignee, setAssignee] = useState("all");
  const searchInput = useRef<HTMLInputElement>(null);
  const locationNotice = useRef<HTMLDivElement>(null);
  const targetExists = Boolean(targetTask && tasks.some(task => task.id === targetTask.id));
  useEffect(() => {
    if (!targetTask || targetExists) return;
    locationNotice.current?.focus();
  }, [targetTask?.id, targetTask?.request, targetExists]);
  const clearTarget = () => {
    onClearTarget?.();
    requestAnimationFrame(() => searchInput.current?.focus());
  };
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
    if (taskQuery.trim() && !`${task.title} ${taskAssignee(task)}`.toLowerCase().includes(taskQuery.trim().toLowerCase())) return false;
    if (assignee !== "all" && taskAssignee(task) !== assignee) return false;
    if (filter === "open" && task.completed) return false;
    if (filter === "today" && taskDueState(task) !== "today") return false;
    if (filter === "overdue" && taskDueState(task) !== "overdue") return false;
    if (filter === "stale" && (task.completed || Boolean(task.dueDate) || task.createdAt >= staleBefore)) return false;
    if (filter === "done" && !task.completed) return false;
    return true;
  }).sort((a, b) => Number(a.completed) - Number(b.completed) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999") || b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="tasks-page">
      <div className="tasks-intro">
        <button className="primary-button" onClick={() => setComposing((v) => !v)}>
          <Plus size={16} />
          新建待办
        </button>
      </div>
      {targetTask && (
        <div className="task-location" ref={locationNotice} tabIndex={-1}>
          <div><strong>{targetExists ? "已定位待办" : "待办暂不可用"}</strong><p>返回列表后继续使用原来的筛选。</p></div>
          <button className="ghost-button" onClick={clearTarget}><ArrowLeft size={14} />返回待办列表</button>
        </div>
      )}
      {composing && (
        <TaskComposer
          autoFocus
          onAdd={async (title, due) => {
            const saved = await onAdd(title, due || null);
            if (saved) setComposing(false);
            return saved;
          }}
          onCancel={() => setComposing(false)}
        />
      )}
      <div hidden={Boolean(targetTask)}>
      <div className="task-dashboard" role="group" aria-label="待办范围">
        {([
          ["open", "待完成", counts.open], ["today", "今天到期", counts.today], ["overdue", "已逾期", counts.overdue],
          ["stale", "长期未处理", counts.stale], ["done", "已完成", counts.done], ["all", "全部", tasks.length],
        ] as const).map(([id, label, count]) => (
          <button key={id} aria-pressed={filter === id} className={`${filter === id ? "active" : ""}${id === "overdue" && count ? " attention" : ""}`} onClick={() => setFilter(id)}>
            <span>{label}</span><strong>{count}</strong>
          </button>
        ))}
      </div>
      <div className="task-toolbar">
        <label><Search size={14} /><input ref={searchInput} aria-label="搜索待办" value={taskQuery} onChange={(event) => setTaskQuery(event.target.value)} placeholder="搜索待办或负责人" /></label>
        {assignees.length > 0 && (
          <select aria-label="筛选负责人" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
            <option value="all">全部负责人</option>
            {assignees.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        )}
        {(taskQuery || assignee !== "all") && <button className="ghost-button" onClick={() => { setTaskQuery(""); setAssignee("all"); }}>清除筛选</button>}
      </div>
      </div>
      <TaskGroup
        title={targetTask ? "定位结果" : FILTER_LABEL[filter]}
        tasks={targetTask ? tasks : filtered}
        visibleTaskId={targetTask?.id}
        focusRequest={targetTask?.request}
        emptyLabel={targetTask ? "这条待办已被删除或暂时不可用。" : undefined}
        onToggle={onToggle}
        onSave={onSave}
        onDelete={onDelete}
        onOpenSource={onOpenSource}
      />
    </div>
  );
}
