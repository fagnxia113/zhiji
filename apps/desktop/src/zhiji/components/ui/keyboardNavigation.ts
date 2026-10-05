import type { KeyboardEvent } from "react";

// Lists share the same desktop convention: arrows move focus, Enter selects.
export function focusListItem(event: KeyboardEvent<HTMLElement>, selector = "button:not(:disabled)") {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(selector));
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
  items[next]?.focus();
}
