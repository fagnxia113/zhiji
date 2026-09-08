import { Check, X } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "../ui";

// 新建待办输入行：标题 + 截止日期
export function TaskComposer({
  autoFocus,
  onAdd,
  onCancel,
}: {
  autoFocus?: boolean;
  onAdd: (title: string, due: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const submit = async () => {
    const next = title.trim();
    if (!next || busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      if (await onAdd(next, due)) { setTitle(""); setDue(""); }
    } finally { busy.current = false; setSaving(false); }
  };
  return (
    <div className="task-composer">
      <input
        className="task-edit-title"
        placeholder="待办内容…"
        value={title}
        autoFocus={autoFocus}
        disabled={saving}
        aria-label="待办内容"
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") void submit();
          if (e.key === "Escape" && !saving) onCancel();
        }}
      />
      <input
        className="task-edit-due"
        type="date"
        value={due}
        title="截止日期"
        aria-label="截止日期"
        disabled={saving}
        onChange={(e) => setDue(e.target.value)}
      />
      <IconButton icon={Check} label="添加" primary loading={saving} disabled={saving || !title.trim()} onClick={() => void submit()} />
      <IconButton icon={X} label="取消" disabled={saving} onClick={onCancel} />
    </div>
  );
}
