import { Check, X } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../ui";

// 新建待办输入行：标题 + 截止日期
export function TaskComposer({
  autoFocus,
  onAdd,
  onCancel,
}: {
  autoFocus?: boolean;
  onAdd: (title: string, due: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const submit = () => {
    const next = title.trim();
    if (!next) return;
    onAdd(next, due);
    setTitle("");
    setDue("");
  };
  return (
    <div className="task-composer">
      <input
        className="task-edit-title"
        placeholder="待办内容…"
        value={title}
        autoFocus={autoFocus}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
      />
      <input
        className="task-edit-due"
        type="date"
        value={due}
        title="截止日期"
        onChange={(e) => setDue(e.target.value)}
      />
      <IconButton icon={Check} label="添加" primary onClick={submit} />
      <IconButton icon={X} label="取消" onClick={onCancel} />
    </div>
  );
}
