import { CalendarRange, Copy, FileDown, LoaderCircle, Save, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "../fields/markdown";
import { Dialog } from "../ui/Dialog";
import { localDateKey } from "../../workflow";
import { validDate } from "../../workbench/cache";
import { useWorkbench, workbenchCall, type ReportMaterial, type WeeklyReport } from "../../workbench";

function defaultWeekStart() { const today = new Date(); today.setDate(today.getDate() - (today.getDay() + 6) % 7); return localDateKey(today); }
function rangeEnd(start: string) { if (!validDate(start)) return ""; const end = new Date(start + "T12:00:00"); end.setDate(end.getDate() + 6); return localDateKey(end); }
type MaterialState = { scope: string; status: "loading" | "ready" | "error"; value: ReportMaterial | null; error: string };
type Operation = "ai" | "outline" | "save";

export function WeeklyReportModal({ onClose }: { onClose: () => void }) {
  const { data, error: loadError } = useWorkbench();
  const [weekStart, setWeekStart] = useState(defaultWeekStart);
  const [projectId, setProjectId] = useState("");
  const scope = weekStart + ":" + projectId;
  const [materialState, setMaterialState] = useState<MaterialState>({ scope: "", status: "loading", value: null, error: "" });
  const [materialRetry, setMaterialRetry] = useState(0);
  const [reports, setReports] = useState<WeeklyReport[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(true);
  const [archiveError, setArchiveError] = useState("");
  const [archiveRetry, setArchiveRetry] = useState(0);
  const [selected, setSelected] = useState<WeeklyReport | null>(null);
  const reportBodyRef = useRef<HTMLElement>(null);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [content, setContent] = useState("");
  const [operation, setOperation] = useState<Operation | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const busy = operation !== null;
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<{ scope: string; excluded: Set<string> }>({ scope, excluded: new Set() });
  const dirty = !!selected && content !== selected.content;
  const html = useMemo(() => renderMarkdown(content), [content]);
  const dateValid = validDate(weekStart);
  const materialCurrent = materialState.scope === scope;
  const materialLoading = dateValid && (!materialCurrent || materialState.status === "loading");
  const material = materialCurrent && materialState.status === "ready" ? materialState.value : null;
  const materialError = materialCurrent && materialState.status === "error" ? materialState.error : "";
  const selectedSources = material?.sources.map(s => s.sourceType + ":" + s.id).filter(key => selection.scope !== scope || !selection.excluded.has(key)) || [];
  const projectName = (id: string | null) => id ? data.projects.find(p => p.id === id)?.name || "原项目（当前不可用）" : "全部项目";
  const generationReady = dateValid && !!material && selectedSources.length > 0;

  useEffect(() => { setSourcesExpanded(false); }, [scope]);
  useEffect(() => {
    if (!selected?.id) return;
    const frame = requestAnimationFrame(() => reportBodyRef.current?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [selected?.id]);
  useEffect(() => {
    let active = true;
    setArchiveLoading(true); setArchiveError("");
    void workbenchCall<WeeklyReport[]>("list_reports").then(result => {
      if (!active) return;
      // A newly generated report may already exist while the initial archive read is still pending.
      setReports(old => [...old, ...result.filter(report => !old.some(current => current.id === report.id))]);
    }).catch(cause => { if (active) setArchiveError(String(cause)); }).finally(() => { if (active) setArchiveLoading(false); });
    return () => { active = false; };
  }, [archiveRetry]);
  useEffect(() => {
    let active = true;
    setMaterialState({ scope, status: "loading", value: null, error: "" });
    // Only a range change resets exclusions. Refreshing this range keeps the user's selection.
    setSelection(old => old.scope === scope ? old : { scope, excluded: new Set() });
    if (dateValid) void workbenchCall<ReportMaterial>("report_material", { weekStart, projectId: projectId || null })
      .then(value => { if (active) setMaterialState({ scope, status: "ready", value, error: "" }); })
      .catch(cause => { if (active) setMaterialState({ scope, status: "error", value: null, error: String(cause) }); });
    return () => { active = false; };
  }, [weekStart, projectId, scope, dateValid, data, materialRetry]);
  const choose = (report: WeeklyReport) => {
    if (operationRef.current) return;
    if (dirty) { setError("请先保存当前修改，再切换周报。"); return; }
    setSelected(report); setContent(report.content); setPreview(false); setNotice(""); setError("");
  };
  const startOperation = (next: Operation) => {
    if (operationRef.current) return false;
    operationRef.current = next; setOperation(next); setError(""); setNotice(""); return true;
  };
  const finishOperation = () => { operationRef.current = null; setOperation(null); };
  const save = async () => {
    if (!selected || !dirty || !startOperation("save")) return;
    try {
      const result = await workbenchCall<{ updatedAt: string }>("save_report", { id: selected.id, content, updatedAt: selected.updatedAt });
      const next = { ...selected, content, updatedAt: result.updatedAt }; setSelected(next); setReports(old => old.map(r => r.id === next.id ? next : r)); setNotice("修改已保存");
    } catch (cause) { setError(String(cause)); } finally { finishOperation(); }
  };
  const generate = async (mode: "ai" | "outline") => {
    if (operationRef.current) return;
    if (dirty) { setError("请先保存当前修改，再生成新版本。"); return; }
    if (!generationReady || !startOperation(mode)) return;
    try {
      const report = await workbenchCall<WeeklyReport>("generate_report", { weekStart, projectId: projectId || null, mode, selectedSources });
      setSelected(report); setContent(report.content); setReports(old => [report, ...old.filter(r => r.id !== report.id)]); setPreview(false); setNotice("已生成并保存新版本，历史周报保留");
    } catch (cause) { setError(String(cause)); } finally { finishOperation(); }
  };
  const close = () => { if (operationRef.current) return; if (dirty) { setError("有未保存的修改，请点击「保存修改」后关闭。"); return; } onClose(); };
  const copy = async () => { try { await navigator.clipboard.writeText(content); setNotice("已复制 Markdown"); } catch (cause) { setError("复制失败：" + String(cause)); } };
  const download = () => {
    const sources = selected?.sources.map((s, i) => "## [" + (i + 1) + "] " + s.title + " · " + s.date + "\n\n" + s.sourceType + ":" + s.id + "\n\n" + s.content).join("\n\n") || "";
    const url = URL.createObjectURL(new Blob([content + "\n\n# 来源快照\n\n" + sources], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "工作周报-" + (selected?.weekStart || weekStart) + ".md"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <Dialog onClose={close} closeOnBackdrop={false} ariaLabel="生成周报" className="weekly-report-modal report-workspace">
    <div className="modal-head"><div><h2><CalendarRange size={18} />周报与回顾</h2><small>融合会议、会外记录与行动进展，保留每一版来源</small></div><button className="icon-btn" onClick={close} disabled={busy} aria-label="关闭"><X size={16} /></button></div>
    <section className="report-compose" aria-label="整理新周报">
      <h3>整理新周报</h3>
      <div className="weekly-controls">
        <label>起始日期（连续七天）<input type="date" value={weekStart} disabled={busy} onChange={e => setWeekStart(e.target.value)} /></label>
        <label>项目范围<select aria-label="周报项目" value={projectId} disabled={busy} onChange={e => setProjectId(e.target.value)}><option value="">全部项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}</select></label>
        <button className="secondary-button compact-button" onClick={() => void generate("outline")} disabled={busy || !generationReady}>{operation === "outline" && <LoaderCircle className="spin" size={14} />}整理草稿</button>
        <button className="primary-button compact-button" onClick={() => void generate("ai")} disabled={busy || !generationReady}>{operation === "ai" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}AI 生成周报</button>
      </div>
      <p className="report-range">{dateValid ? weekStart + " 至 " + rangeEnd(weekStart) + " · " + projectName(projectId) : "请选择起始日期，汇总连续七天的工作。"}</p>
      <p className="report-privacy">整理草稿在本机完成；AI 生成会把下方材料发送给你配置的模型服务。</p>
      {materialLoading && <p className="report-material-state" role="status"><LoaderCircle className="spin" size={14} />正在读取本次范围的材料…</p>}
      {materialError && <div className="report-material-state qa-error" role="alert"><span>材料读取失败：{materialError}</span><button className="secondary-button compact-button" onClick={() => setMaterialRetry(value => value + 1)}>重新读取材料</button></div>}
      {material && !material.sources.length && <p className="report-material-state" role="status">当前范围没有材料，可先记下一条工作进展，或调整日期和项目。</p>}
      {material && !!material.sources.length && <details className="report-sources" open={sourcesExpanded} onToggle={e => setSourcesExpanded(e.currentTarget.open)}><summary>待汇总材料 · 已选 {selectedSources.length} / {material.sources.length} 条</summary>
        <p>取消勾选不相关材料；活动登记和文件关联不自动代表已完成成果。</p>
        {material.warnings.map(w => <p className="source-warning" key={w}>{w}</p>)}
        {material.sources.map(s => { const key = s.sourceType + ":" + s.id; return <div key={key}><label><input type="checkbox" aria-label={"纳入周报：" + s.title} checked={selection.scope !== scope || !selection.excluded.has(key)} disabled={busy} onChange={e => { const checked = e.target.checked; setSelection(old => { const excluded = new Set(old.scope === scope ? old.excluded : []); if (checked) excluded.delete(key); else excluded.add(key); return { scope, excluded }; }); }} />纳入周报</label><details><summary>{s.date} · {s.title}</summary><pre>{s.content}</pre></details></div>; })}
      </details>}
      {material && !!material.sources.length && !selectedSources.length && <p className="report-material-state" role="status">至少勾选一条材料后再生成周报。</p>}
    </section>
    {(error || loadError) && <div className="qa-error" role="alert">{error || loadError}</div>}
    {notice && <div className="capture-hint" role="status">{notice}</div>}
    {archiveLoading && <p className="report-material-state" role="status">正在读取周报档案…</p>}
    {archiveError && <div className="report-material-state qa-error" role="alert"><span>周报档案读取失败：{archiveError}</span><button className="secondary-button compact-button" onClick={() => setArchiveRetry(value => value + 1)}>重新读取档案</button></div>}
    {!!reports.length && <label className="report-history">周报档案<select aria-label="周报档案" disabled={busy} value={selected?.id || ""} onChange={e => { const r = reports.find(r => r.id === e.target.value); if (r) choose(r); }}><option value="" disabled>选择已保存的周报</option>{reports.map(r => <option key={r.id} value={r.id}>{r.weekStart} · {projectName(r.projectId)} · {new Date(r.createdAt).toLocaleString("zh-CN")}</option>)}</select></label>}
    {selected && <section ref={reportBodyRef} className="report-saved" aria-label="当前周报正文">
      <div className="report-saved-heading"><h3>编辑已保存周报</h3><p>{selected.weekStart} 至 {rangeEnd(selected.weekStart)} · {projectName(selected.projectId)}</p></div>
      <div className="weekly-actions"><button className="ghost-button" onClick={() => setPreview(!preview)}>{preview ? "编辑正文" : "预览排版"}</button><span role="status">{operation === "save" ? "正在保存修改…" : dirty ? "有未保存修改" : "已保存"}</span><button className="primary-button compact-button" disabled={busy || !dirty} onClick={() => void save()}>{operation === "save" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存修改</button></div>
      {preview ? <div className="weekly-result markdown-body" dangerouslySetInnerHTML={{ __html: html }} /> : <textarea className="report-editor" aria-label="周报正文" value={content} disabled={busy} maxLength={100000} onChange={e => setContent(e.target.value)} />}
      <div className="weekly-actions"><button className="secondary-button compact-button" onClick={() => void copy()}><Copy size={14} />复制 Markdown</button><button className="secondary-button compact-button" onClick={download}><FileDown size={14} />导出含来源的 Markdown</button></div>
      <details className="report-sources"><summary>本版本来源快照 · {selected.sources.length} 条</summary>{selected.warnings.map(w => <p className="source-warning" key={w}>{w}</p>)}{selected.sources.map((s, i) => <details key={s.sourceType + ":" + s.id}><summary>[{i + 1}] {s.title} · {s.date}</summary><pre>{s.content}</pre></details>)}</details>
    </section>}
  </Dialog>;
}
