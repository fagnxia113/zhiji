import { useEffect, useRef, useState, type ReactNode } from "react";
import { useWorkbench, workbenchCall, statuses, type Project, type Theme, type WorkEntry } from "../../workbench";
import type { Task } from "../../types";
import type { Hub } from "./model";

type Context = { projects: Project[]; entries: WorkEntry[]; tasks: Task[]; meetings: {id:string; title:string; startedAt:string}[]; total:number; projectHub:Hub; followups:{entries:WorkEntry[];tasks:Task[]} };
export function ThemeOverview({ theme, onProject, onMeeting, meetingContent }: { theme:Theme; onProject:(id:string)=>void; onMeeting:(id:string)=>void; meetingContent?: ReactNode }) {
  const { data, refresh } = useWorkbench();
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(theme.name);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  useEffect(()=>{setEditing(false);setName(theme.name);},[theme.id]);
  useEffect(()=>{if(!editing) setName(theme.name);},[theme.name,editing]);
  const rename = async()=>{if(pending.current) return;pending.current=true;setSaving(true);setError("");try {await workbenchCall("save_theme",{id:theme.id,name});setEditing(false);if(!await refresh())setError("主题已改名，刷新失败，请重新读取，无需重复提交。");}catch(cause){setError(String(cause));}finally{pending.current=false;setSaving(false);}};
  const recentEntries = context?.entries.slice(0,5) || [];
  const waitingEntries = context?.followups.entries.filter(e=>!recentEntries.some(r=>r.id===e.id)) || [];
  useEffect(() => {
    let active = true; setLoading(true); setError(""); setContext(null);
    void workbenchCall<Context>("get_project_context", { themeId:theme.id }).then(value => { if(active) setContext(value); }).catch(cause => { if(active) setError(String(cause)); }).finally(() => { if(active) setLoading(false); });
    return () => { active=false; };
  }, [theme.id,data,retry]);
  const openResource = async (id:string) => { setOpening(true); setError(""); try { await workbenchCall("open_resource", {resourceId:id}); } catch(cause) { setError(String(cause)); } finally { setOpening(false); } };
  return <section className="project-hub theme-overview" aria-label="主题概览">
    <header><h2>{theme.name}</h2><span>主题</span></header>
    <details className="hub-add" open={editing} onToggle={e=>setEditing(e.currentTarget.open)}><summary>主题设置</summary><form className="theme-create" onSubmit={e=>{e.preventDefault();void rename();}}><label>主题名称<input aria-label="主题名称" value={name} maxLength={60} disabled={saving} onChange={e=>setName(e.target.value)} /></label><button className="secondary-button compact-button" disabled={saving || !name.trim() || name.trim()===theme.name}>保存主题名称</button></form></details>
    <p className="capture-hint">汇总关联项目的同一份内容，包含已归档项目。资料仅登记元信息，AI 尚不能读取文件正文。</p>
    {loading && <p role="status">正在汇总主题内容…</p>}
    {error && <div className="qa-error" role="alert">{error}<button disabled={loading} onClick={()=>setRetry(v=>v+1)}>重新读取主题概览</button></div>}
    {context && <div className="theme-content-grid"><section aria-label="主题关联项目"><h3>相关项目 · {context.projects.length}</h3><div className="theme-project-links">{context.projects.map(p=><button key={p.id} className="secondary-button compact-button" onClick={()=>onProject(p.id)}>{p.name}{p.archived ? "（已归档）" : ""}</button>)}</div>{!context.projects.length && <p className="capture-hint">这个主题还没有关联项目。打开项目后，在“设置主题”中勾选即可。</p>}</section>
    <section aria-label="主题最新进展"><h3>最近记录的进展</h3>{recentEntries.map(e=><article key={e.id}><p>{e.content}</p><small>{e.occurredOn} · {statuses[e.status]} · {context.projects.find(p=>p.id===e.projectId)?.name}</small>{e.projectId && <button className="ghost-button" onClick={()=>onProject(e.projectId!)}>查看项目进展</button>}</article>)}{!context.entries.length && <p className="capture-hint">还没有记录进展，会议或文件变动不会自动成为成果。</p>}</section>
    <section aria-label="主题待协调事项"><h3>待协调与行动</h3>{waitingEntries.slice(0,5).map(e=><article key={e.id}><p>{e.content}</p>{e.projectId && <button className="ghost-button" onClick={()=>onProject(e.projectId!)}>继续协调</button>}</article>)}{context.followups.tasks.slice(0,5).map(t=><article key={t.id}><p>{t.title}</p><small>{t.owner || "未设负责人"}{t.dueDate ? ` · 截止：${t.dueDate}` : ""}</small>{t.sourceType==="meeting" && t.sourceId && <button className="ghost-button" onClick={()=>onMeeting(t.sourceId!)}>查看来源会议</button>}</article>)}{!context.followups.tasks.length && !waitingEntries.length && <p className="capture-hint">{recentEntries.some(e=>e.status==="waiting") ? "等待反馈事项已在上方进展中列出。" : "暂无记录的等待事项或未完成行动。"}</p>}</section>
    <section aria-label="主题会议与资料"><h3>会议与资料</h3>{context.meetings.slice(0,5).map(m=><button key={m.id} className="ghost-button" onClick={()=>onMeeting(m.id)}>{m.title}</button>)}{context.projectHub.resources.slice(0,8).map(r=><button key={r.id} disabled={opening} className="ghost-button" onClick={()=>void openResource(r.id)}>{r.title} · 打开原文件</button>)}{!context.meetings.length && !context.projectHub.resources.length && <p className="capture-hint">暂无关联会议或资料。</p>}</section>
    <p className="capture-hint">概览展示部分近期内容，更多记录可进入相关项目查看。</p></div>}
    {meetingContent}
  </section>;
}
