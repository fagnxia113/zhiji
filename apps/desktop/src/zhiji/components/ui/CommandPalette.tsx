import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  placeholder?: string;
};

// ⌘K 命令面板：键盘优先的全局命令入口，契合「顺手」的个人工具定位。
// 支持 ↑/↓ 移动、Enter 执行、Esc 关闭、鼠标悬停同步高亮、输入实时过滤。
export function CommandPalette({
  open,
  onClose,
  commands,
  placeholder = "输入命令…",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? commands.filter((command) => command.label.toLowerCase().includes(normalized))
    : commands;

  // 每次打开或过滤结果变化时，选中项归零，避免越界
  useEffect(() => {
    if (open) setActive(0);
  }, [open, normalized]);

  // 选中项滚入可视区
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // 键盘：Esc 关闭，↑/↓ 移动，Enter 执行
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (filtered.length ? (i + 1) % filtered.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (filtered.length ? (i - 1 + filtered.length) % filtered.length : 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[active];
        if (command) {
          command.run();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, filtered, active]);

  if (!open) return null;

  return (
    <div className="modal-overlay command-palette-overlay" onClick={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="command-palette-input">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={placeholder}
          />
        </div>
        <ul className="command-palette-list" ref={listRef}>
          {filtered.map((command, index) => (
            <li key={command.id} data-cmd-index={index}>
              <button
                type="button"
                className={index === active ? "active" : ""}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  command.run();
                  onClose();
                }}
              >
                {command.icon}
                <span>{command.label}</span>
                {command.hint && <small>{command.hint}</small>}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="command-palette-empty">无匹配命令</li>
          )}
        </ul>
      </div>
    </div>
  );
}
