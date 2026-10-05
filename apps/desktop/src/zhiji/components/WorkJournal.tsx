import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, Pencil, Save } from "lucide-react";
import { kinds, statuses, useWorkbench, workbenchCall, type WorkEntry } from "../workbench";
import type { Workspace } from "../types";
import { localDateKey } from "../workflow";
import { cachedFields, validDate } from "../workbench/cache";
import { Dialog, IconButton } from "./ui";

const draftKey = "zhiji:work-entry-draft";
const fresh = () => ({ id: crypto.randomUUID() as string, content: "", kind: "progress", status: "in_progress", occurredOn: localDateKey(new Date()), projectId: "", sourceLabel: "随手记" });
type Draft = ReturnType<typeof fresh>;
function entryDraft(entry: WorkEntry): Draft {
  return { id: entry.id, content: entry.content, kind: entry.kind, status: entry.status, occurredOn: entry.occurredOn, projectId: entry.projectId || "", sourceLabel: entry.sourceLabel || "" };
}
function sameDraft(left: Draft, right: Draft) {
  return (Object.keys(left) as (keyof Draft)[]).every(key => left[key] === right[key]);
}
function initialDraft(): Draft {
  const defaults = fresh();
  const value = cachedFields(draftKey, defaults);
  if (!value.content.trim()) return { ...defaults, projectId: value.projectId };
  return { ...value, id: value.id || defaults.id, kind: Object.prototype.hasOwnProperty.call(kinds, value.kind) ? value.kind : defaults.kind, status: Object.prototype.hasOwnProperty.call(statuses, value.status) ? value.status : defaults.status, occurredOn: validDate(value.occurredOn) ? value.occurredOn : defaults.occurredOn };
}

export function WorkJournal({ workspace, compact = false, onOpen, onProjects, onMeeting, targetEntry, onClearTarget }: { workspace: Workspace; compact?: boolean; onOpen?: () => void; onProjects?: (id?: string) => void; onMeeting?: (id: string) => void; targetEntry?: { id: string; request: number }; onClearTarget?: () => void }) {
  const { data, error: loadError, loading, refresh } = useWorkbench();
  const [draft, setDraft] = useState(initialDraft);
  const [savedView] = useState(() => compact ? { filter: "", query: "", waiting: "" } : cachedFields("zhiji:journal-view", { filter: "", query: "", waiting: "" }));
  const [filter, setFilter] = useState(savedView.filter);
  const [query, setQuery] = useState(savedView.query);
  const [waiting, setWaiting] = useState(savedView.waiting === "yes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [captureDetails, setCaptureDetails] = useState(false);
  const [draftCached, setDraftCached] = useState(false);
  const contentInput = useRef<HTMLTextAreaElement>(null);
  const captureOptions = useRef<HTMLDetailsElement>(null);
  const entryList = useRef<HTMLDivElement>(null);
  const journalSearch = useRef<HTMLInputElement>(null);
  const operationPending = useRef(false);
  const dateChosen = useRef(!!draft.content.trim());
  const [history, setHistory] = useState<{ sequence: number; recordedAt: string; entry: WorkEntry }[] | null>(null);
  const locatedEntry = targetEntry ? data.entries.find(entry => entry.id === targetEntry.id) : undefined;
  useEffect(() => {
    if (!targetEntry || compact) return;
    const frame = requestAnimationFrame(() => {
      entryList.current?.focus({ preventScroll: true });
      entryList.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [targetEntry?.id, targetEntry?.request, !!locatedEntry, compact]);
  const clearTarget = () => {
    onClearTarget?.();
    requestAnimationFrame(() => journalSearch.current?.focus());
  };
  useEffect(() => { try { localStorage.setItem(draftKey, JSON.stringify(draft)); setDraftCached(true); } catch { setDraftCached(false); setError("临时草稿无法缓存，请及时保存工作记录。"); } }, [draft]);
  useEffect(() => {
    if (compact) return;
    try { localStorage.setItem("zhiji:journal-view", JSON.stringify({ filter, query, waiting: waiting ? "yes" : "" })); }
    catch { /* Filtering remains usable without a persisted preference. */ }
  }, [compact, filter, query, waiting]);
  useEffect(() => { if (!loading && !loadError && filter && !data.projects.some(p => p.id === filter)) setFilter(""); }, [loading, loadError, data.projects, filter]);
  const editingEntry = data.entries.find(entry => entry.id === draft.id);
  const edit = (patch: Partial<Draft>) => { setDraft(d => ({ ...d, ...patch })); setSaved(""); };
  const perform = async (operation: () => Promise<void>, changesData = true) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true); setError("");
    try { await operation(); if (changesData && !await refresh()) setError("操作已保存，但列表刷新失败；请重新加载，无需重复提交。"); } catch (cause) { setError(String(cause)); } finally { operationPending.current = false; setBusy(false); }
  };
  const save = () => perform(async () => { await workbenchCall("save_entry", { ...draft, projectId: draft.projectId || null }); setDraft({ ...fresh(), projectId: draft.projectId }); dateChosen.current = false; setSaved(editingEntry ? "修改已保存，旧版本保留在修改历史中" : "已保存到本地资料库"); });
  const selectEntry = (entry: WorkEntry) => {
    if (draft.id === entry.id) { contentInput.current?.focus(); contentInput.current?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
    if (draft.content.trim() && draft.id !== entry.id && (!editingEntry || !sameDraft(draft, entryDraft(editingEntry)))) { setError(editingEntry ? "请先保存或取消当前修改，再编辑其他记录。" : "请先保存当前草稿，再编辑其他记录。"); return; }
    setDraft(entryDraft(entry)); dateChosen.current = true; setSaved(""); setError(""); setCaptureDetails(true);
    contentInput.current?.focus(); contentInput.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  const cancelEditing = () => {
    setDraft({ ...fresh(), projectId: draft.projectId }); dateChosen.current = false; setSaved(""); setError(""); setCaptureDetails(false);
    contentInput.current?.focus({ preventScroll: true });
  };
  const copyAsNew = () => {
    setDraft({ ...draft, id: crypto.randomUUID(), occurredOn: localDateKey(new Date()) }); dateChosen.current = false; setSaved(""); setError("");
    contentInput.current?.focus({ preventScroll: true });
  };
  const projectSelect = (value: string, change: (next: string) => void, label = "所属项目") => <select aria-label={label} value={value} disabled={busy || loading} onChange={e => change(e.target.value)}>
    <option value="">未归属项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}
  </select>;
  const shown = targetEntry ? (locatedEntry ? [locatedEntry] : []) : data.entries.filter(e => (!filter || e.projectId === filter) && (!waiting || e.status === "waiting") && e.content.toLowerCase().includes(query.toLowerCase()));
  return <section className={`work-journal ${compact ? "compact" : ""}`} aria-label="工作记录">
    <div className="journal-heading"><div><h2>{compact ? "随手记一笔" : "记下本次工作"}</h2>{!compact && <p>记录推进了什么，写周报时直接汇总。</p>}</div>{compact ? <button className="ghost-button" onClick={onOpen}>全部记录<ArrowUpRight size={15} /></button> : <button className="ghost-button" onClick={() => onProjects?.(filter || undefined)}>管理项目<ArrowUpRight size={15} /></button>}</div>
    {(error || loadError) && <div role="alert" className="qa-error">{error || loadError}{loadError && <button disabled={busy} onClick={() => void refresh().then(ok => { if (ok) setError(""); })}>重新加载</button>}</div>}
    <form className="work-capture" onSubmit={e => { e.preventDefault(); void save(); }} onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing && !busy && !loading && !loadError && draft.content.trim()) { e.preventDefault(); e.currentTarget.requestSubmit(); } }}>
      {editingEntry && <div className="capture-editing"><div><strong>正在修改 {editingEntry.occurredOn} 的记录</strong><p>保存修改会保留旧版本；新进展可以转为今天的记录，再点击保存。</p></div><div className="hub-actions"><button type="button" className="secondary-button compact-button" disabled={busy} onClick={copyAsNew}>转为新记录</button><button type="button" className="ghost-button" disabled={busy} onClick={cancelEditing}>取消修改</button></div></div>}
      <textarea ref={contentInput} aria-label="工作内容" placeholder="做了什么？先记一句话，稍后再归类…" value={draft.content} maxLength={20000} rows={compact ? 2 : 3} disabled={busy} onChange={e => edit({ content: e.target.value, ...(!draft.content.trim() && e.target.value.trim() && !dateChosen.current ? { occurredOn: localDateKey(new Date()) } : {}) })} />
      <div className="capture-quick-actions"><span>{draft.occurredOn}{draft.projectId && ` · ${data.projects.find(p => p.id === draft.projectId)?.name || "项目待核对"}`}{draft.status !== "in_progress" && ` · ${statuses[draft.status]}`}</span><button className="primary-button compact-button" disabled={busy || loading || !!loadError || !draft.content.trim()}><Save size={14} />{busy ? "保存中…" : editingEntry ? "保存修改" : "保存记录"}</button></div>
      <details ref={captureOptions} open={captureDetails} onToggle={e => setCaptureDetails(e.currentTarget.open)} className="capture-options"><summary>补充项目、分类与日期</summary>
      <div className="capture-fields form-grid">
        <label>所属项目{projectSelect(draft.projectId, projectId => edit({ projectId }))}</label>
        <label>记录类型<select aria-label="记录类型" value={draft.kind} onChange={e => edit({ kind: e.target.value })} disabled={busy}>{Object.entries(kinds).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label>工作状态<select aria-label="工作状态" value={draft.status} onChange={e => edit({ status: e.target.value })} disabled={busy}>{Object.entries(statuses).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label>
        <label>发生日期<input aria-label="发生日期" type="date" value={draft.occurredOn} required disabled={busy} onInvalid={() => { if (captureOptions.current) captureOptions.current.open = true; setCaptureDetails(true); setError("请补充有效的发生日期，再保存记录。"); }} onChange={e => { dateChosen.current = true; edit({ occurredOn: e.target.value }); if (error === "请补充有效的发生日期，再保存记录。") setError(""); }} /></label>
        {!compact && <label className="form-wide">来源说明<input aria-label="来源说明" placeholder="随手记、客户邮件…" maxLength={200} value={draft.sourceLabel} disabled={busy} onChange={e => edit({ sourceLabel: e.target.value })} /></label>}
      </div>
      </details>
      <div className="capture-hint" role="status">{saved ? <><Check size={13} />{saved}</> : draft.content.trim() && draftCached ? editingEntry ? "修改草稿已保留 · Ctrl+Enter 保存修改" : "草稿已保留 · Ctrl+Enter 保存后进入周报" : "Ctrl+Enter 保存，记录自动成为周报材料。"}</div>
    </form>
    {!compact && !targetEntry && <>
      <div className="journal-toolbar">
        <select aria-label="筛选项目" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部项目</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}</select>
        <input ref={journalSearch} aria-label="搜索工作记录" placeholder="搜索记录内容" value={query} onChange={e => setQuery(e.target.value)} />
        <button className={`secondary-button compact-button ${waiting ? "selected" : ""}`} aria-pressed={waiting} onClick={() => setWaiting(!waiting)}>等待反馈 · {data.entries.filter(e => e.status === "waiting").length}</button>
        {(filter || query || waiting) && <button className="ghost-button" onClick={() => { setFilter(""); setQuery(""); setWaiting(false); }}>清除筛选</button>}
      </div>
    </>}
    {!compact && <div ref={entryList} className={`work-entry-list${targetEntry ? " journal-search-target" : ""}`} role={targetEntry ? "region" : undefined} aria-label={targetEntry ? "定位的工作记录" : undefined} tabIndex={targetEntry ? -1 : undefined}>
      {targetEntry && <div className="journal-location-heading"><strong>已定位工作记录</strong><button className="ghost-button" onClick={clearTarget}>返回记录列表</button></div>}
      {shown.map((entry, index) => <Fragment key={entry.id}>
      {(index === 0 || shown[index - 1].occurredOn !== entry.occurredOn) && <h3 className="journal-date-heading">{entry.occurredOn}</h3>}
      <article className="work-entry">
        <div className="work-entry-meta"><time>{entry.occurredOn}</time><span>{kinds[entry.kind]}</span><span className={`work-status ${entry.status}`}>{statuses[entry.status]}</span>{entry.projectId && data.projects.some(p => p.id === entry.projectId) ? <button className="journal-project-link" aria-label={`打开项目：${data.projects.find(p => p.id === entry.projectId)?.name}`} onClick={() => onProjects?.(entry.projectId || undefined)}>{data.projects.find(p => p.id === entry.projectId)?.name}<ArrowUpRight size={12} /></button> : <span>未归属项目</span>}</div>
        <p>{entry.content}</p><footer><small>{entry.sourceLabel || "随手记"}</small><div className="hub-actions"><button className="ghost-button" disabled={busy} onClick={() => void perform(async () => { setHistory(await workbenchCall("entry_history", { entryId: entry.id })); }, false)}>修改历史</button><IconButton icon={Pencil} size={14} label={`编辑记录：${entry.content.slice(0, 30)}`} disabled={busy} onClick={() => selectEntry(entry)} /></div></footer>
      </article></Fragment>)}
      {!shown.length && <p className="journal-empty">{loading ? "正在读取记录…" : targetEntry ? "这条记录已不在当前资料库中，可返回列表继续查找。" : "还没有符合条件的记录。完成一件事后，记下一句话即可。"}</p>}
    </div>}
    {!compact && !targetEntry && <details className="project-materials"><summary>关联会议与待办 · 按项目整理周报材料</summary>
      <p>会议关联项目后，其行动项自动沿用项目；待办也可以单独调整。</p>
      {workspace.meetings.filter(m => !filter || data.links[`meeting:${m.id}`] === filter).map(m => <div className="project-material-row" key={m.id}><button className="ghost-button" onClick={() => onMeeting?.(m.id)}>{m.title}</button>{projectSelect(data.links[`meeting:${m.id}`] || "", projectId => void perform(async () => { await workbenchCall("link_project", { entityType: "meeting", entityId: m.id, projectId: projectId || null }); }), `会议项目：${m.title}`)}</div>)}
      {workspace.tasks.filter(t => !filter || (data.links[`task:${t.id}`] || (t.sourceType === "meeting" ? data.links[`meeting:${t.sourceId}`] : "")) === filter).map(t => <div className="project-material-row" key={t.id}><span>{t.completed ? "已完成" : "待办"} · {t.title}</span>{projectSelect(data.links[`task:${t.id}`] || "", projectId => void perform(async () => { await workbenchCall("link_project", { entityType: "task", entityId: t.id, projectId: projectId || null }); }), `待办项目：${t.title}`)}</div>)}
    </details>}
    {history && <Dialog onClose={() => setHistory(null)} ariaLabel="工作记录修改历史" className="entry-history"><div className="modal-head"><h2>修改历史</h2><button className="ghost-button" onClick={() => setHistory(null)}>关闭</button></div><p className="capture-hint">修改保留旧版本；新一周的进展请新增记录，不要覆盖上一周的工作。</p>{history.map(h => <article key={h.sequence}><small>{h.recordedAt} · 发生于 {h.entry.occurredOn} · {statuses[h.entry.status]}</small><p>{h.entry.content}</p></article>)}{!history.length && <p>此记录来自旧版备份，尚无修改历史。</p>}</Dialog>}
  </section>;
}
