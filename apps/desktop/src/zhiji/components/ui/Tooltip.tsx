import { useCallback, useRef, useState, type ReactNode } from "react";

type TooltipProps = {
  /** 提示文案；触发器自身应同时用 aria-label 表达同一语义 */
  label: string;
  /** 首选方位，贴边时自动翻到另一侧 */
  placement?: "top" | "bottom";
  children: ReactNode;
};

const GAP = 8;

/**
 * 图标按钮的悬停 / 键盘聚焦提示。
 *
 * **显隐**完全由 CSS 驱动（`.tooltip-anchor:hover / :focus-within`），不用 JS 状态，
 * 因此带来原生 `title` 给不了的两个好处：
 *  1. **disabled 的按钮也能弹提示** —— 禁用元素不派发鼠标事件，原生 title 在禁用态常不触发，
 *     而包裹用的 span 依旧能收到 hover；
 *  2. 样式可控、无需等待系统 ~1s 延迟，且主题切换时跟着令牌走。
 *
 * **方位**用一次轻量测量做碰撞避让：贴到视口左/右/上边缘时自动改成 start / end 或翻到另一侧。
 * 纯 CSS 做不到这件事（没有可靠的边距查询），所以只把「对齐」交给 JS，「显隐」仍留给 CSS，
 * 禁用态可弹提示的特性因此不受影响。
 *
 * 语义分工：触发器自身用 `aria-label` 承担可访问名称，气泡只做视觉补充，
 * 因此不额外挂 `aria-describedby`（否则同一句话会被读屏重复播报）。
 */
export function Tooltip({ label, placement = "top", children }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ side: "top" | "bottom"; align: "start" | "center" | "end" }>({
    side: placement,
    align: "center",
  });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    // 气泡虽是 visibility:hidden，但仍有布局尺寸，可以直接量
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const half = b.width / 2;
    const center = a.left + a.width / 2;

    let align: "start" | "center" | "end" = "center";
    if (center - half < GAP) align = "start";
    else if (center + half > window.innerWidth - GAP) align = "end";

    // 纵向：首选那侧放不下就翻到另一侧
    let side = placement;
    if (placement === "top" && a.top - b.height - GAP < GAP) side = "bottom";
    else if (placement === "bottom" && a.bottom + b.height + GAP > window.innerHeight - GAP) side = "top";

    setPos(current => (current.side === side && current.align === align ? current : { side, align }));
  }, [placement]);

  return (
    <span
      ref={anchorRef}
      className={`tooltip-anchor ${pos.side} ${pos.align}`}
      onMouseEnter={reposition}
      onFocus={reposition}
    >
      {children}
      <span ref={bubbleRef} className="tooltip-bubble" role="tooltip">
        {label}
      </span>
    </span>
  );
}
