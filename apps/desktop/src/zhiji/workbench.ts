import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

export type Project = { id: string; name: string; archived: boolean; createdAt: string };
export type WorkEntry = { id: string; content: string; kind: string; status: string; occurredOn: string; projectId: string | null; sourceLabel: string; createdAt: string; updatedAt: string };
export type WorkbenchData = { projects: Project[]; entries: WorkEntry[]; links: Record<string, string> };
export type ReportSource = { id: string; sourceType: string; title: string; date: string; projectId: string | null; content: string };
export type ReportMaterial = { weekStart: string; weekEnd: string; sources: ReportSource[]; warnings: string[] };
export type WeeklyReport = { id: string; weekStart: string; projectId: string | null; content: string; sources: ReportSource[]; warnings: string[]; createdAt: string; updatedAt: string };
export const kinds: Record<string, string> = { progress: "进展", achievement: "成果", decision: "决策", risk: "风险", note: "参考笔记" };
export const statuses: Record<string, string> = { in_progress: "进行中", waiting: "等待反馈", done: "已完成", recorded: "已记录" };
export const workbenchCall = <T,>(action: string, args: object = {}) => invoke<T>("workbench_call", { action, args });

export function useWorkbench() {
  const [data, setData] = useState<WorkbenchData>({ projects: [], entries: [], links: {} });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setData(await workbenchCall<WorkbenchData>("load")); setError(""); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const subscription = listen("zhiji://workbench-changed", () => void refresh());
    return () => { void subscription.then(stop => stop()).catch(() => undefined); };
  }, [refresh]);
  return { data, error, loading, refresh };
}
