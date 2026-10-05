import { useLayoutEffect, useRef } from "react";
import type { View } from "../../types";

// Each page keeps its own reading position during this window session.
export function usePagePosition(view: View) {
  const scroller = useRef<HTMLElement>(null);
  const positions = useRef(new Map<View, number>());

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const target = positions.current.get(view) || 0;
    let restoring = true;
    let expected = 0;
    let frame = 0;
    let timeout = 0;
    const anchor = element.style.overflowAnchor;
    element.style.overflowAnchor = "none";
    const finish = () => {
      restoring = false;
      element.style.overflowAnchor = anchor;
      resize.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
    };
    const restore = () => {
      if (!restoring) return;
      expected = Math.min(target, Math.max(0, element.scrollHeight - element.clientHeight));
      element.scrollTop = expected;
      positions.current.set(view, element.scrollTop);
      if (expected >= target - 1) finish();
    };
    const schedule = () => {
      if (!restoring) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(restore);
    };
    const resize = new ResizeObserver(schedule);
    const observeContent = () => {
      resize.disconnect();
      for (const child of element.children) resize.observe(child);
      schedule();
    };
    const mutations = new MutationObserver(observeContent);
    const onScroll = () => {
      if (restoring && Math.abs(element.scrollTop - expected) > 1) finish();
      if (!restoring) positions.current.set(view, element.scrollTop);
    };
    const onInteraction = () => { if (restoring) finish(); };
    element.addEventListener("scroll", onScroll, { passive: true });
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) element.addEventListener(event, onInteraction, { passive: true });
    // Project details may arrive after navigation. Stop restoring as soon as the
    // position is available, or the user starts another action.
    mutations.observe(element, { childList: true, subtree: true });
    observeContent();
    timeout = window.setTimeout(finish, 4000);
    restore();
    return () => {
      finish();
      element.removeEventListener("scroll", onScroll);
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) element.removeEventListener(event, onInteraction);
    };
  }, [view]);

  return scroller;
}
