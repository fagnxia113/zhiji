import { type ReactNode } from "react";

type TooltipProps = {
  /** 提示文案；同时应由触发器自己作为 aria-label，保证读屏可访问名称一致 */
  label: string;
  placement?: "top" | "bottom";
  align?: "center" | "end";
  children: ReactNode;
};

/**
 * 图标按钮的悬停 / 键盘聚焦提示。
 *
 * 显隐完全由 CSS 驱动（`.tooltip-anchor:hover / :focus-within`），不用 JS 状态，
 * 带来两个原生 `title` 给不了的好处：
 *  1. **disabled 的按钮也能弹提示** —— 禁用元素不派发鼠标事件，原生 title 在禁用态常不触发，
 *     而包裹用的 span 依旧能收到 hover；
 *  2. 样式可控、无需等待系统 ~1s 延迟，且主题切换时跟着令牌走。
 *
 * 语义分工：按钮自身用 `aria-label` 承担可访问名称，提示气泡只做视觉补充，
 * 因此不额外挂 `aria-describedby`（否则同一句话会被读屏重复播报）。
 */
export function Tooltip({ label, placement = "top", align = "center", children }: TooltipProps) {
  return (
    <span className={`tooltip-anchor ${placement} ${align}`}>
      {children}
      <span className="tooltip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}
