import { LoaderCircle, type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

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
    <button
      className={`icon-btn${danger ? " icon-danger" : ""}${primary ? " primary" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {loading ? <LoaderCircle className="spin" size={size} /> : <Icon size={size} />}
    </button>
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
