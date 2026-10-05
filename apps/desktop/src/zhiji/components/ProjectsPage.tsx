import { focusListItem } from "./ui/keyboardNavigation";
import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { useWorkbench, workbenchCall } from "../workbench";
import type { Workspace } from "../types";
import { ProjectHub } from "./ProjectHub";
import { IconButton } from "./ui";

const recentKey = "zhiji:last-project";
const shortcutsKey = "zhiji:project-shortcuts";
function projectShortcuts(): { favorites: string[]; recent: string[] } {
  try {
    const saved = JSON.parse(localStorage.getItem(shortcutsKey) || "null");
    const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && !!id))] : [];
    return { favorites: ids(saved?.favorites), recent: ids(saved?.recent).slice(0, 6) };
  } catch { return { favorites: [], recent: [] }; }
}
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
    <button className="primary-button compact-button" onClick={() => onOpen()}>继续项目</button>
  </section>;
}

export function ProjectsPage({ workspace, onMeeting, initialProjectId = "" }: { workspace: Workspace; onMeeting: (id: string) => void; initialProjectId?: string }) {
  const { data, loading, error: loadError, refresh } = useWorkbench();
  const [selected, setSelected] = useState(() => initialProjectId || lastProjectId());
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [listScope, setListScope] = useState<"all" | "favorites" | "recent">("all");
  const [name, setName] = useState("");
  const [newId, setNewId] = useState(() => crypto.randomUUID());
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(!initialProjectId && !lastProjectId());
  const switchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const wasCreating = useRef(false);
  const [shortcuts, setShortcuts] = useState(projectShortcuts);
  const [shortcutError, setShortcutError] = useState("");
  const project = data.projects.find(p => p.id === selected);
  const pickerVisible = wide || picking || (!loading && !project);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1100px)");
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => { if (initialProjectId) { setSelected(initialProjectId); setPicking(false); } }, [initialProjectId]);
  useEffect(() => {
    const returnedFromCreate = wasCreating.current && !creating;
    wasCreating.current = creating;
    if (!pickerVisible || creating || wide && project && !returnedFromCreate) return;
    searchInput.current?.focus();
  }, [pickerVisible, creating, wide, project?.id]);
  useEffect(() => {
    try { localStorage.setItem(shortcutsKey, JSON.stringify(shortcuts)); setShortcutError(""); }
    catch { setShortcutError("收藏与最近项目暂时无法保留到下次打开，已保存的项目资料不受影响。"); }
  }, [shortcuts]);
  useEffect(() => {
    if (!project) return;
    setShortcuts(previous => previous.recent[0] === project.id ? previous : { ...previous, recent: [project.id, ...previous.recent.filter(id => id !== project.id)].slice(0, 6) });
    try { localStorage.setItem(recentKey, project.id); }
    catch { setError("无法记住上次项目；已保存的项目资料不受影响。"); }
  }, [project?.id]);
  const saveProject = async () => {
    setBusy(true); setError("");
    try {
      await workbenchCall("save_project", { id: newId, name: name.trim(), archived: false });
      setSelected(newId); setNewId(crypto.randomUUID()); setName(""); setCreating(false); setPicking(false); setArchived(false); setQuery("");
      if (!await refresh()) setError("项目已创建，但列表刷新失败，请重新读取，无需重复创建。");
    } catch (cause) { setError(`项目未创建，名称已保留。${String(cause)}`); }
    finally { setBusy(false); }
  };
  const shown = data.projects.filter(p => (archived || !p.archived) && p.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (listScope === "all" || shortcuts[listScope].includes(p.id)));
  if (listScope === "recent") shown.sort((a, b) => shortcuts.recent.indexOf(a.id) - shortcuts.recent.indexOf(b.id));
  const chooseProject = (id: string) => { setSelected(id); setPicking(false); if (!wide) switchButton.current?.focus(); };
  return <section className={`projects-page ${creating ? "is-creating" : ""}`} aria-label="项目工作区">
    <header className="project-workspace-toolbar"><div className="project-switch-actions"><button ref={switchButton} className="secondary-button compact-button" aria-expanded={pickerVisible} aria-controls="project-picker" onClick={() => { setCreating(false); if (wide) searchInput.current?.focus(); else setPicking(v => !v); }}>切换项目</button>{project && <IconButton icon={Star} primary={shortcuts.favorites.includes(project.id)} label={shortcuts.favorites.includes(project.id) ? "取消收藏当前项目" : "收藏当前项目"} onClick={() => setShortcuts(v => ({ ...v, favorites: v.favorites.includes(project.id) ? v.favorites.filter(id => id !== project.id) : [...v.favorites, project.id] }))} />}</div><button className="ghost-button" aria-expanded={creating} onClick={() => { setPicking(true); setCreating(v => !v); }}>{creating ? "取消新建" : "新建项目"}</button></header>
    {shortcutError && <p className="qa-error" role="alert">{shortcutError}</p>}
    {(error || loadError) && <div className="qa-error" role="alert">{error || loadError}<button disabled={busy} onClick={() => void refresh().then(ok => { if (ok) setError(""); })}>重新读取</button></div>}
    <aside id="project-picker" className="project-picker" aria-label="选择项目" hidden={!pickerVisible} onKeyDown={e => { if (e.key !== "Escape") return; if (creating) { e.preventDefault(); setCreating(false); } else if (project) { e.preventDefault(); setPicking(false); switchButton.current?.focus(); } }}>
      <div className="hub-section-heading"><h2>{creating ? "新建项目" : "我的项目"}</h2>{project && (!wide || creating) && <button className="ghost-button" onClick={() => { setCreating(false); setPicking(false); switchButton.current?.focus(); }}>返回当前项目</button>}</div>
      {creating && <form className="hub-profile" onSubmit={e => { e.preventDefault(); void saveProject(); }}>
        <label>项目名称<input autoFocus aria-label="新项目名称" required maxLength={80} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <button className="primary-button compact-button" disabled={busy || loading || !!loadError || !name.trim()}>创建项目</button>
      </form>}
      <div hidden={creating}><input ref={searchInput} aria-label="查找项目" placeholder="查找项目" value={query} onChange={e => setQuery(e.target.value)} />
      <label className="project-archive-filter"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} />显示已归档项目</label>
      <div className="project-list-filters" role="group" aria-label="项目列表范围">{([ ["all", "全部"], ["favorites", "收藏"], ["recent", "最近"] ] as const).map(([id, label]) => <button key={id} className="ghost-button" aria-pressed={listScope === id} onClick={() => setListScope(id)}>{label}</button>)}</div>
      <nav aria-label="项目列表" onKeyDown={focusListItem}>{shown.map(p => <button key={p.id} aria-current={selected === p.id ? "page" : undefined} onClick={() => chooseProject(p.id)}><strong>{p.name}</strong><small>{p.archived ? "已归档" : "进行中"}</small></button>)}</nav>
      {!shown.length && <p className="capture-hint">{loading ? "正在读取项目…" : query ? "没有匹配项目，试试其他关键词。" : listScope === "favorites" ? "还没有收藏项目，打开项目后点星标即可收藏。" : listScope === "recent" ? "还没有访问过项目，先从全部项目中选择。" : "还没有项目，先为手头的工作建一个。"}{listScope !== "all" && <button className="ghost-button" onClick={() => setListScope("all")}>查看全部项目</button>}</p>}
      </div>
    </aside>
    <div className="project-detail" hidden={creating || pickerVisible && !wide}>{project
      ? <ProjectHub key={project.id} project={project} workspace={workspace} entries={data.entries} projectLinks={data.links} onChanged={refresh} onMeeting={onMeeting} />
      : <div className="project-start"><h2>从一个项目继续工作</h2><p>选择项目，查看相关活动和资料，留下下一步进展。</p><p>临时想法可以先在工作台随手记录，不必立即归类。</p></div>}
    </div>
  </section>;
}
