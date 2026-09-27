import { CalendarRange, Copy, FileDown, LoaderCircle, Save, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { renderMarkdown } from "../fields/markdown";
import { Dialog } from "../ui/Dialog";
import { localDateKey } from "../../workflow";
import { useWorkbench, workbenchCall, type ReportMaterial, type WeeklyReport } from "../../workbench";

function defaultWeekStart() { const today = new Date(); today.setDate(today.getDate() - (today.getDay() + 6) % 7); return localDateKey(today); }

export function WeeklyReportModal({ onClose }: { onClose: () => void }) {
  const { data, error: loadError } = useWorkbench();
  const [weekStart, setWeekStart] = useState(defaultWeekStart);
  const [projectId, setProjectId] = useState("");
  const [material, setMaterial] = useState<ReportMaterial | null>(null);
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [selected, setSelected] = useState<WeeklyReport | null>(null);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const dirty = !!selected && content !== selected.content;
  const html = useMemo(() => renderMarkdown(content), [content]);
  useEffect(() => { void workbenchCall<WeeklyReport[]>("list_reports").then(setReports).catch(cause => setError(String(cause))); }, []);
  useEffect(() => {
    let active = true; setMaterial(null);
    if (weekStart) void workbenchCall<ReportMaterial>("report_material", { weekStart, projectId: projectId || null })
      .then(result => { if (active) { setMaterial(result); setError(""); } }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [weekStart, projectId, data]);
  const choose = (report: WeeklyReport) => {
    if (dirty) { setError("请先保存当前修改，再切换周报。"); return; }
    setSelected(report); setContent(report.content); setPreview(false); setNotice(""); setError("");
  };
  const save = async (): Promise<boolean> => {
    if (!selected || !dirty) return true;
    setBusy(true); setError("");
    try {
      const result = await workbenchCall<{ updatedAt: string }>("save_report", { id: selected.id, content, updatedAt: selected.updatedAt });
      const next = { ...selected, content, updatedAt: result.updatedAt }; setSelected(next); setReports(old => old.map(r => r.id === next.id ? next : r)); setNotice("修改已保存"); return true;
    } catch (cause) { setError(String(cause)); return false; } finally { setBusy(false); }
  };
  const generate = async (mode: "ai" | "outline") => {
    if (dirty) { setError("请先保存当前修改，再生成新版本。"); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const report = await workbenchCall<WeeklyReport>("generate_report", { weekStart, projectId: projectId || null, mode });
      setSelected(report); setContent(report.content); setReports(old => [report, ...old]); setPreview(false); setNotice("已生成并保存新版本，历史周报保留");
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  const close = () => { if (busy) return; if (dirty) { setError("有未保存的修改，请点击「保存修改」后关闭。"); return; } onClose(); };
  const copy = async () => { try { await navigator.clipboard.writeText(content); setNotice("已复制 Markdown"); } catch (cause) { setError(`复制失败：${String(cause)}`); } };
  const download = () => {
    const sources = selected?.sources.map((s, i) => `## [${i + 1}] ${s.title} · ${s.date}\n\n${s.sourceType}:${s.id}\n\n${s.content}`).join("\n\n") || "";
    const url = URL.createObjectURL(new Blob([content + "\n\n# 来源快照\n\n" + sources], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `工作周报-${selected?.weekStart || weekStart}.md`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Dialog onClose={close} closeOnBackdrop={false} ariaLabel="生成周报" className="weekly-report-modal report-workspace">
    <div className="modal-head"><div><h2><CalendarRange size={18} />周报与回顾</h2><small>融合会议、会外记录与行动进展，保留每一版来源</small></div><button className="icon-btn" onClick={close} disabled={busy} aria-label="关闭"><X size={16} /></button></div>
    <div className="weekly-controls">
      <label>起始日期（连续七天）<input type="date" value={weekStart} disabled={busy} onChange={e => setWeekStart(e.target.value)} /></label>
      <label>项目范围<select aria-label="周报项目" value={projectId} disabled={busy} onChange={e => setProjectId(e.target.value)}><option value="">全部项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}</select></label>
      <button className="secondary-button compact-button" onClick={() => void generate("outline")} disabled={busy || !material?.sources.length}>整理草稿</button>
      <button className="primary-button compact-button" onClick={() => void generate("ai")} disabled={busy || !material?.sources.length}>{busy ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}AI 生成周报</button>
    </div>
    <p className="report-privacy">整理草稿在本机完成；AI 生成会把下方材料发送给你配置的模型服务。</p>
    {(error || loadError) && <div className="qa-error" role="alert">{error || loadError}</div>}
    {notice && <div className="capture-hint" role="status">{notice}</div>}
    <details className="report-sources"><summary>待汇总材料 · {material?.sources.length ?? 0} 条{material ? ` · 截至 ${material.weekEnd}` : ""}</summary>
      {material?.warnings.map(w => <p className="source-warning" key={w}>{w}</p>)}
      {material?.sources.map(s => <details key={`${s.sourceType}:${s.id}`}><summary>{s.date} · {s.title}</summary><pre>{s.content}</pre></details>)}
      {material && !material.sources.length && <p>当前范围没有材料，可先在工作台记下一条工作进展。</p>}
    </details>
    {!!reports.length && <label className="report-history">周报档案<select aria-label="周报档案" disabled={busy} value={selected?.id || ""} onChange={e => { const r = reports.find(r => r.id === e.target.value); if (r) choose(r); }}><option value="" disabled>选择已保存的周报</option>{reports.map(r => <option key={r.id} value={r.id}>{r.weekStart} · {data.projects.find(p => p.id === r.projectId)?.name || "全部项目"} · {new Date(r.createdAt).toLocaleString("zh-CN")}</option>)}</select></label>}
    {selected && <>
      <div className="weekly-actions"><button className="ghost-button" onClick={() => setPreview(!preview)}>{preview ? "编辑正文" : "预览排版"}</button><span role="status">{dirty ? "有未保存修改" : "已保存"}</span><button className="primary-button compact-button" disabled={busy || !dirty} onClick={() => void save()}><Save size={14} />保存修改</button></div>
      {preview ? <div className="weekly-result markdown-body" dangerouslySetInnerHTML={{ __html: html }} /> : <textarea className="report-editor" aria-label="周报正文" value={content} disabled={busy} maxLength={100000} onChange={e => setContent(e.target.value)} />}
      <div className="weekly-actions"><button className="secondary-button compact-button" onClick={() => void copy()}><Copy size={14} />复制 Markdown</button><button className="secondary-button compact-button" onClick={download}><FileDown size={14} />导出含来源的 Markdown</button></div>
      <details className="report-sources"><summary>本版本来源快照 · {selected.sources.length} 条</summary>{selected.warnings.map(w => <p className="source-warning" key={w}>{w}</p>)}{selected.sources.map((s, i) => <details key={`${s.sourceType}:${s.id}`}><summary>[{i + 1}] {s.title} · {s.date}</summary><pre>{s.content}</pre></details>)}</details>
    </>}
  </Dialog>;
}
