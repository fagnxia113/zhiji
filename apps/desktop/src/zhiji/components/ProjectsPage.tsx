import { useEffect, useState } from "react";
import { statuses, useWorkbench, workbenchCall } from "../workbench";
import type { Workspace } from "../types";
import { ProjectHub } from "./ProjectHub";

const recentKey = "zhiji:last-project";
export function lastProjectId() {
  try { return localStorage.getItem(recentKey) || ""; } catch { return ""; }
}

export function ContinueProject({ onOpen }: { onOpen: () => void }) {
  const { data } = useWorkbench();
  const project = data.projects.find(p => p.id === lastProjectId() && !p.archived);
  if (!project) return null;
  let content = "";
  try { content = JSON.parse(localStorage.getItem(`zhiji:project-progress:${project.id}`) || "null")?.content || ""; } catch { /* optional preview */ }
  return <section className="continue-project" aria-label="继续上次项目">
    <div><small>继续上次项目</small><strong>{project.name}</strong><p>{typeof content === "string" && content.trim() ? `未提交的进展：${content}` : "回到项目资料、活动与进展"}</p></div>
    <button className="primary-button compact-button" onClick={onOpen}>继续项目</button>
  </section>;
}

export function ProjectsPage({ workspace, onMeeting }: { workspace: Workspace; onMeeting: (id: string) => void }) {
  const { data, loading, error: loadError, refresh } = useWorkbench();
  const [selected, setSelected] = useState(lastProjectId);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState("");
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const project = data.projects.find(p => p.id === selected);
  useEffect(() => {
    if (!project) return;
    try { localStorage.setItem(recentKey, project.id); }
    catch { setError("无法记住上次项目；已保存的项目资料不受影响。"); }
  }, [project?.id]);
  const saveProject = async () => {
    setBusy(true); setError("");
    try {
      await workbenchCall("save_project", { id: newId, name: name.trim(), archived: false });
      setSelected(newId); setNewId(crypto.randomUUID()); setName(""); setCreating(false); setArchived(false); setQuery("");
      if (!await refresh()) setError("项目已创建，但列表刷新失败，请重新读取，无需重复创建。");
    } catch (cause) { setError(`项目未创建，名称已保留。${String(cause)}`); }
    finally { setBusy(false); }
  };
  const shown = data.projects.filter(p => (archived || !p.archived) && p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const recent = data.entries.filter(e => e.projectId === selected).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.updatedAt.localeCompare(a.updatedAt));
  return <section className="projects-page" aria-label="项目工作区">
    <aside className="project-picker" aria-label="选择项目">
      <div className="hub-section-heading"><h2>我的项目</h2><button className="secondary-button compact-button" aria-expanded={creating} onClick={() => setCreating(v => !v)}>新建项目</button></div>
      {(error || loadError) && <div className="qa-error" role="alert">{error || loadError}<button disabled={busy} onClick={() => void refresh().then(ok => { if (ok) setError(""); })}>重新读取</button></div>}
      {creating && <form className="hub-profile" onSubmit={e => { e.preventDefault(); void saveProject(); }}>
        <label>项目名称<input autoFocus aria-label="新项目名称" required maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <button className="primary-button compact-button" disabled={busy || loading || !!loadError || !name.trim()}>创建项目</button>
      </form>}
      <input aria-label="查找项目" placeholder="查找项目" value={query} onChange={e => setQuery(e.target.value)} />
      <label className="project-archive-filter"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />显示已归档项目</label>
      <nav aria-label="项目列表">{shown.map(p => <button key={p.id} aria-current={selected === p.id ? "page" : undefined} onClick={() => setSelected(p.id)}><strong>{p.name}</strong><small>{p.archived ? "已归档" : "进行中"}</small></button>)}</nav>
      {!shown.length && <p className="capture-hint">{loading ? "正在读取项目…" : query ? "没有匹配项目，试试其他关键词。" : "还没有项目，先为手头的工作建一个。"}</p>}
    </aside>
    <div className="project-detail">{project
      ? <>
        <ProjectHub key={project.id} project={project} workspace={workspace} onChanged={refresh} onMeeting={onMeeting} />
        <section className="project-recent" aria-label="项目最近进展"><h3>最近进展{recent.length > 5 ? " · 最近 5 条" : ""}</h3>
          {recent.slice(0, 5).map(entry => <article key={entry.id}><small>{entry.occurredOn} · {statuses[entry.status]}</small><p>{entry.content}</p></article>)}
          {!recent.length && <p>还没有进展记录。完成一项沟通或交付后，留下一句话即可。</p>}
          {recent.length > 5 && <p>其余记录可在「工作记录」按项目查看。</p>}
        </section>
      </>
      : <div className="project-start"><h2>从一个项目继续工作</h2><p>选择项目，查看相关活动和资料，留下下一步进展。</p><p>临时想法可以先在工作台随手记录，不必立即归类。</p></div>}
    </div>
  </section>;
}
