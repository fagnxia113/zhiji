import { useEffect, useRef, useState } from "react";
import { useWorkbench, workbenchCall, type Project, type Theme } from "../../workbench";
import { cachedFields } from "../../workbench/cache";

export function ProjectThemes({ project }: { project: Project }) {
  const { data, loading, error: loadError, refresh } = useWorkbench();
  const themes = data.themes || [];
  const cacheKey = `zhiji:project-themes-draft:${project.id}`;
  const [draft] = useState(()=>cachedFields(cacheKey, {selected:"",expected:"",name:""}));
  const ids = (value:string) => { try { const parsed:unknown=JSON.parse(value); return Array.isArray(parsed) && parsed.every(v=>typeof v==="string") ? [...new Set(parsed as string[])] : project.themeIds || []; } catch { return project.themeIds || []; } };
  const current = JSON.stringify(project.themeIds || []);
  const [selected, setSelected] = useState<string[]>(()=>ids(draft.selected));
  const [expected, setExpected] = useState<string[]>(()=>ids(draft.expected));
  const [editing, setEditing] = useState(!!draft.selected || !!draft.name);
  const [name, setName] = useState(draft.name);
  const newId = useRef(crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cacheError, setCacheError] = useState("");
  const dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...expected].sort());
  useEffect(() => { if (!dirty) { setSelected(project.themeIds || []); setExpected(project.themeIds || []); } }, [current]);
  useEffect(()=>{ try { if(dirty || name) localStorage.setItem(cacheKey,JSON.stringify({selected:JSON.stringify(selected),expected:JSON.stringify(expected),name})); else localStorage.removeItem(cacheKey); setCacheError(""); } catch { setCacheError("主题选择暂时无法保留到下次打开，请及时保存。"); } },[cacheKey,JSON.stringify(selected),JSON.stringify(expected),name]);
  const retry = () => run(async()=>{const projects=await workbenchCall<Project[]>("list_projects",{projectId:project.id});setExpected(projects.find(p=>p.id===project.id)?.themeIds || []);if(!await refresh()) setError("主题重新读取失败，选择仍保留。");else setNotice("已读取最新关联，请核对当前选择后保存。");});
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setError(String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  const create = () => run(async () => {
    const theme = await workbenchCall<Theme>("save_theme", { id: newId.current, name });
    setSelected(old => [...new Set([...old, theme.id])]); setName(""); newId.current = crypto.randomUUID();
    if (!await refresh()) setError("主题已创建，列表刷新失败，请重新读取后保存关联，无需重复创建。");
    else setNotice("主题已创建并选中，点击保存主题后关联当前项目。");
  });
  const save = () => run(async () => {
    const ids = await workbenchCall<string[]>("save_project_themes", { projectId: project.id, themeIds: selected, expectedThemeIds: expected });
    setExpected(ids); setSelected(ids);
    if (!await refresh()) setError("主题关联已保存，刷新失败，请重新读取，无需重复提交。");
    else { setNotice("主题已保存，项目内容可从这些主题共同查看。"); setEditing(false); }
  });
  return <section className="project-themes" aria-label="项目主题">
    <div className="project-theme-heading"><span>主题</span>{(project.themeIds || []).map(id => <span className="theme-tag" key={id}>{themes.find(t => t.id === id)?.name || "主题"}</span>)}{!project.themeIds?.length && <small>未分主题</small>}<button className="ghost-button" aria-expanded={editing} onClick={() => setEditing(v => !v)}>{editing ? "收起主题" : "设置主题"}</button></div>
    {editing && <div className="project-theme-editor"><p className="capture-hint">可以选择多个主题。解除主题关联会保留项目、会议和资料。</p><div className="theme-choices" role="group" aria-label="选择项目主题">{themes.map(t => <label key={t.id}><input type="checkbox" checked={selected.includes(t.id)} disabled={busy || loading || !!loadError} onChange={e => setSelected(old => e.target.checked ? [...old,t.id] : old.filter(id => id !== t.id))} />{t.name}</label>)}</div>
    <form className="theme-create" onSubmit={e => { e.preventDefault(); void create(); }}><label>新主题<input aria-label="新主题名称" maxLength={60} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="例如：出海、数据中心" /></label><button className="secondary-button compact-button" disabled={busy || loading || !!loadError || !name.trim()}>添加主题</button></form>
    <button className="primary-button compact-button" disabled={busy || loading || !!loadError || !dirty} onClick={() => void save()}>保存主题</button></div>}
    {(error || loadError) && <div className="qa-error" role="alert">{error || loadError}<button disabled={busy} onClick={() => void retry()}>重新读取主题</button></div>}
    {cacheError && <p className="qa-error" role="alert">{cacheError}</p>}
    {notice && <p className="capture-hint" role="status">{notice}</p>}
  </section>;
}
