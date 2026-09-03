import { useEffect, type ReactNode } from "react";

type DialogProps = {
  children: ReactNode;
  onClose?: () => void;
  closeOnBackdrop?: boolean;
  closeOnEsc?: boolean;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  className?: string;
};

// 模态基类：统一管理遮罩、Esc 关闭、点击遮罩关闭、焦点语义。
// 业务弹窗（更新、进度、未来命令面板）均复用它，避免每处手写 overlay/事件。
export function Dialog({
  children,
  onClose,
  closeOnBackdrop = true,
  closeOnEsc = true,
  ariaLabel,
  ariaLabelledBy,
  className = "",
}: DialogProps) {
  useEffect(() => {
    if (!onClose || !closeOnEsc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, closeOnEsc]);

  return (
    <div
      className="modal-overlay"
      onClick={onClose && closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={`modal ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
