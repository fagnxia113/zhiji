import type { Task } from "../../types";
import { Empty } from "../ui";
import { TaskRow } from "./TaskRow";

// 一组待办：带分组标题与空态
export function TaskGroup({
  title,
  tasks,
  onToggle,
  onSave,
  onDelete,
  onOpenSource,
  visibleTaskId,
  focusRequest,
  emptyLabel,
}: {
  title: string;
  tasks: Task[];
  onToggle: (task: Task) => void;
  onSave: (task: Task) => Promise<boolean>;
  onDelete: (task: Task) => void;
  onOpenSource: (task: Task) => void;
  visibleTaskId?: string;
  focusRequest?: number;
  emptyLabel?: string;
}) {
  const visibleCount = visibleTaskId ? tasks.filter(task => task.id === visibleTaskId).length : tasks.length;
  return (
    <section className="task-group">
      <div className="group-heading">
        <h3>{title}</h3>
        <small>{visibleCount} 项</small>
      </div>
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          hidden={Boolean(visibleTaskId && task.id !== visibleTaskId)}
          focusRequest={task.id === visibleTaskId ? focusRequest : undefined}
          onToggle={onToggle}
          onSave={onSave}
          onDelete={onDelete}
          onOpenSource={onOpenSource}
        />
      ))}
      {visibleCount === 0 && <Empty label={emptyLabel || (title === "待完成" ? "没有待办，给自己留一点空白。" : "当前筛选下没有待办。")} />}
    </section>
  );
}
