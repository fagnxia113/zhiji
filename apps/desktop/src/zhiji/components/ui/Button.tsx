import { LoaderCircle, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";
import { Tooltip } from "./Tooltip";

type IconButtonProps = {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  primary?: boolean;
  loading?: boolean;
  size?: number;
};

// 图标按钮统一走 Tooltip 气泡（不再用原生 title）：样式可控、无系统延迟，且禁用态也能弹提示。
// label 同时作为可访问名称与提示文案，两者保持一致。
export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
  primary,
  loading,
  size = 16,
}: IconButtonProps) {
  return (
    <Tooltip label={label}>
      <button
        className={`icon-btn${danger ? " icon-danger" : ""}${primary ? " primary" : ""}`}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
      >
        {loading ? <LoaderCircle className="spin" size={size} /> : <Icon size={size} />}
      </button>
    </Tooltip>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
};

// 文本按钮原语：复用既有 primary-button / secondary-button 样式，后续替换行内 <button> 时用。
export function Button({ children, onClick, disabled, variant = "secondary", type = "button" }: ButtonProps) {
  return (
    <button type={type} className={`${variant}-button`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}
