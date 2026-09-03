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
}: {
  title: string;
  tasks: Task[];
  onToggle: (task: Task) => void;
  onSave: (task: Task) => void;
  onDelete: (task: Task) => void;
  onOpenSource: (task: Task) => void;
}) {
  return (
    <section className="task-group">
      <div className="group-heading">
        <h3>{title}</h3>
        <small>{tasks.length} 项</small>
      </div>
      {tasks.length > 0 ? (
        tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onToggle={onToggle}
            onSave={onSave}
            onDelete={onDelete}
            onOpenSource={onOpenSource}
          />
        ))
      ) : (
        <Empty label={title === "待完成" ? "没有待办，给自己留一点空白。" : "当前筛选下没有待办。"} />
      )}
    </section>
  );
}
