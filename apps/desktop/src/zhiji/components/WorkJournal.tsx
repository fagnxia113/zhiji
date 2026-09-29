import { useEffect, useState } from "react";
import { Archive, ArchiveRestore, ArrowUpRight, Check, FolderPlus, Pencil, Plus, Save } from "lucide-react";
import { kinds, statuses, useWorkbench, workbenchCall, type WorkEntry } from "../workbench";
import type { Workspace } from "../types";
import { localDateKey } from "../workflow";
import { Dialog, IconButton, Tooltip } from "./ui";
import { ProjectHub } from "./ProjectHub";

const draftKey = "zhiji:work-entry-draft";
const fresh = () => ({ id: crypto.randomUUID() as string, content: "", kind: "progress", status: "in_progress", occurredOn: localDateKey(new Date()), projectId: "", sourceLabel: "随手记" });
type Draft = ReturnType<typeof fresh>;
function initialDraft(): Draft {
  try { const value = JSON.parse(localStorage.getItem(draftKey) || "null"); if (value && typeof value.content === "string" && typeof value.id === "string") return { ...fresh(), ...value }; } catch { /* ignore invalid draft */ }
  return fresh();
}

export function WorkJournal({ workspace, compact = false, onOpen, onMeeting }: { workspace: Workspace; compact?: boolean; onOpen?: () => void; onMeeting?: (id: string) => void }) {
  const { data, error: loadError, loading, refresh } = useWorkbench();
  const [draft, setDraft] = useState(initialDraft);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [history, setHistory] = useState<{ sequence: number; recordedAt: string; entry: WorkEntry }[] | null>(null);
  useEffect(() => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); } catch { setError("临时草稿无法缓存，请及时保存工作记录。"); } }, [draft]);
  const edit = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setSaved(false); };
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); await refresh(); } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  const save = () => perform(async () => { await workbenchCall("save_entry", { ...draft, projectId: draft.projectId || null }); setDraft(fresh()); setSaved(true); });
  const selectEntry = (entry: WorkEntry) => {
    if (draft.content.trim() && draft.id !== entry.id) { setError("请先保存当前草稿，再编辑其他记录。"); return; }
    setDraft({ ...entry, projectId: entry.projectId || "" }); setSaved(false);
  };
  const projectSelect = (value: string, change: (next: string) => void, label = "所属项目") => <select aria-label={label} value={value} disabled={busy || loading} onChange={e => change(e.target.value)}>
    <option value="">未归属项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}
  </select>;
  const shown = data.entries.filter(e => (!filter || e.projectId === filter) && (!waiting || e.status === "waiting") && e.content.toLowerCase().includes(query.toLowerCase()));
  return <section className={`work-journal ${compact ? "compact" : ""}`} aria-label="工作记录">
    <div className="journal-heading"><div><span className="journal-eyebrow">记录工作中的每一步</span><h2>{compact ? "随手记一笔" : "工作记录与项目"}</h2><p>把交付、沟通、决策留下来，周报会一起汇总。</p></div>{compact && <button className="ghost-button" onClick={onOpen}>全部记录<ArrowUpRight size={15} /></button>}</div>
    {(error || loadError) && <div role="alert" className="qa-error">{error || loadError}{loadError && <button onClick={() => void refresh()}>重新加载</button>}</div>}
    <form className="work-capture" onSubmit={e => { e.preventDefault(); void save(); }}>
      <textarea aria-label="工作内容" placeholder="例如：已修改 A 项目报价并发送客户，等待确认…" value={draft.content} maxLength={20000} rows={compact ? 2 : 3} disabled={busy} onChange={e => edit({ content: e.target.value })} />
      <div className="capture-fields">
        {projectSelect(draft.projectId, projectId => edit({ projectId }))}
        <select aria-label="记录类型" value={draft.kind} onChange={e => edit({ kind: e.target.value })} disabled={busy}>{Object.entries(kinds).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
        <select aria-label="工作状态" value={draft.status} onChange={e => edit({ status: e.target.value })} disabled={busy}>{Object.entries(statuses).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select>
        <input aria-label="发生日期" type="date" value={draft.occurredOn} required disabled={busy} onChange={e => edit({ occurredOn: e.target.value })} />
        {!compact && <input aria-label="来源说明" placeholder="来源：随手记、客户邮件…" maxLength={200} value={draft.sourceLabel} disabled={busy} onChange={e => edit({ sourceLabel: e.target.value })} />}
        <button className="primary-button compact-button" disabled={busy || loading || !!loadError || !draft.content.trim()}><Save size={14} />{busy ? "保存中…" : "保存记录"}</button>
      </div>
      <div className="capture-hint" role="status">{saved ? <><Check size={13} />已保存到本地资料库</> : "按实际进展选择状态；计划和等待反馈不会被当作已完成。"}</div>
    </form>
    {!compact && <>
      <div className="journal-toolbar">
        <select aria-label="筛选项目" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}</select>
        <input aria-label="搜索工作记录" placeholder="搜索记录内容" value={query} onChange={e => setQuery(e.target.value)} />
        <button className={`secondary-button compact-button ${waiting ? "selected" : ""}`} aria-pressed={waiting} onClick={() => setWaiting(!waiting)}>等待反馈 · {data.entries.filter(e => e.status === "waiting").length}</button>
      </div>
      <form className="project-create" onSubmit={e => { e.preventDefault(); void perform(async () => { await workbenchCall("save_project", { id: crypto.randomUUID(), name: projectName, archived: false }); setProjectName(""); }); }}>
        <FolderPlus size={16} /><input aria-label="新项目名称" value={projectName} onChange={e => setProjectName(e.target.value)} maxLength={80} placeholder="新建项目，例如：客户交付" disabled={busy} />
        <button className="secondary-button compact-button" disabled={busy || !projectName.trim()}><Plus size={14} />创建项目</button>
        {filter && (() => {
          const project = data.projects.find(p => p.id === filter);
          const archived = Boolean(project?.archived);
          return (
            <Tooltip label={archived ? "恢复该项目，重新计为进行中" : "归档该项目，保留全部记录"}>
              <button
                type="button"
                className="ghost-button icon-only"
                aria-label={archived ? "恢复项目" : "归档项目"}
                disabled={busy}
                onClick={() => void perform(async () => { if (project) await workbenchCall("save_project", { ...project, archived: !archived }); })}
              >
                {archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              </button>
            </Tooltip>
          );
        })()}
      </form>
    </>}
    {!compact && (filter && data.projects.find(p => p.id === filter)
      ? <ProjectHub key={filter} project={data.projects.find(p => p.id === filter)!} workspace={workspace} onChanged={refresh} onMeeting={onMeeting} />
      : <p className="capture-hint">选择一个项目，集中查看活动、关联本地资料并记录进展。</p>)}
    <div className="work-entry-list">
      {shown.slice(0, compact ? 3 : shown.length).map(entry => <article className="work-entry" key={entry.id}>
        <div className="work-entry-meta"><time>{entry.occurredOn}</time><span>{kinds[entry.kind]}</span><span className={`work-status ${entry.status}`}>{statuses[entry.status]}</span><span>{data.projects.find(p => p.id === entry.projectId)?.name || "未归属项目"}</span></div>
        <p>{entry.content}</p><footer><small>{entry.sourceLabel || "随手记"}</small><div className="hub-actions"><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => { setHistory(await workbenchCall("entry_history", { entryId: entry.id })); })}>修改历史</button><IconButton icon={Pencil} size={14} label={`编辑记录：${entry.content.slice(0, 30)}`} disabled={busy} onClick={() => selectEntry(entry)} /></div></footer>
      </article>)}
      {!shown.length && <p className="journal-empty">{loading ? "正在读取记录…" : "还没有符合条件的记录。完成一件事后，记下一句话即可。"}</p>}
    </div>
    {!compact && <details className="project-materials"><summary>关联会议与待办 · 按项目整理周报材料</summary>
      <p>会议关联项目后，其行动项自动沿用项目；待办也可以单独调整。</p>
      {workspace.meetings.filter(m => !filter || data.links[`meeting:${m.id}`] === filter).map(m => <div className="project-material-row" key={m.id}><button className="ghost-button" onClick={() => onMeeting?.(m.id)}>{m.title}</button>{projectSelect(data.links[`meeting:${m.id}`] || "", projectId => void perform(async () => { await workbenchCall("link_project", { entityType: "meeting", entityId: m.id, projectId: projectId || null }); }), `会议项目：${m.title}`)}</div>)}
      {workspace.tasks.filter(t => !filter || (data.links[`task:${t.id}`] || (t.sourceType === "meeting" ? data.links[`meeting:${t.sourceId}`] : "")) === filter).map(t => <div className="project-material-row" key={t.id}><span>{t.completed ? "已完成" : "待办"} · {t.title}</span>{projectSelect(data.links[`task:${t.id}`] || "", projectId => void perform(async () => { await workbenchCall("link_project", { entityType: "task", entityId: t.id, projectId: projectId || null }); }), `待办项目：${t.title}`)}</div>)}
    </details>}
    {history && <Dialog onClose={() => setHistory(null)} ariaLabel="工作记录修改历史" className="entry-history"><div className="modal-head"><h2>修改历史</h2><button className="ghost-button" onClick={() => setHistory(null)}>关闭</button></div><p className="capture-hint">修改保留旧版本；新一周的进展请新增记录，不要覆盖上一周的工作。</p>{history.map(h => <article key={h.sequence}><small>{h.recordedAt} · 发生于 {h.entry.occurredOn} · {statuses[h.entry.status]}</small><p>{h.entry.content}</p></article>)}{!history.length && <p>此记录来自旧版备份，尚无修改历史。</p>}</Dialog>}
  </section>;
}
