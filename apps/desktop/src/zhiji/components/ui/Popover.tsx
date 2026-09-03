import { useEffect, useRef, useState, type ReactNode } from "react";

type PopoverProps = {
  trigger: ReactNode;
  align?: "start" | "end";
  children: (close: () => void) => ReactNode;
};

// 轻量 Popover：触发器 + 弹出面板，点击外部 / Esc 关闭，无障碍 role=dialog。
// 为「说话人改名」等内联操作提供可访问的浮层，不引 Radix，保持零额外依赖。
export function Popover({ trigger, align = "start", children }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={`popover-anchor ${align}`} ref={anchorRef}>
      <button
        type="button"
        className="popover-trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        {trigger}
      </button>
      {open && (
        <div className={`popover-panel ${align}`} role="dialog">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
