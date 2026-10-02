import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { workbenchCall, statuses, type Project, type WorkEntry } from "../workbench";
import type { Workspace } from "../types";
import { localDateKey } from "../workflow";
import { Dialog } from "./ui";

type Activity = { id: string; title: string; kind: string; occurredOn: string; meetingId: string | null };
type Resource = { id: string; title: string; path: string; sizeBytes: number; modifiedAt: string; contentStatus: string };
type Hub = {
  activities: Activity[]; resources: Resource[];
  activityLinks: { activityId: string; projectId: string }[];
  resourceLinks: { resourceId: string; projectId: string; role: string }[];
  resourceActivities: { resourceId: string; activityId: string; role: string }[];
  profiles: { projectId: string; goal: string; stage: string }[];
};
const empty: Hub = { activities: [], resources: [], activityLinks: [], resourceLinks: [], resourceActivities: [], profiles: [] };
const activityKinds: Record<string, string> = { meeting: "会议", research: "调研", training: "培训", review: "评审", other: "其他活动" };
const roles: Record<string, string> = { reference: "参考资料", process: "过程记录", output: "工作产出" };
const tabs = { overview: "概览", resources: "资料", activities: "活动", progress: "进展" };
type HubTab = keyof typeof tabs;
function progressDraft(projectId: string) {
  try { const value = JSON.parse(localStorage.getItem(`zhiji:project-progress:${projectId}`) || "null"); if (value && typeof value.content === "string" && typeof value.entryId === "string") return { ...value, day: value.content.trim() ? value.day : undefined, status: value.content.trim() ? value.status : undefined } as { content: string; entryId: string; day?: string; status?: string; activityId?: string; outputId?: string }; } catch { /* keep the editor usable */ }
  return { content: "", entryId: crypto.randomUUID(), day: undefined, status: undefined, activityId: undefined, outputId: undefined };
}

function cachedFields<T extends Record<string, string>>(key: string, defaults: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    if (value && Object.keys(defaults).every(k => typeof value[k] === "string")) return { ...defaults, ...value };
  } catch { /* invalid or unavailable cache */ }
  return defaults;
}

export function ProjectHub({ project, workspace, entries = [], projectLinks = {}, onChanged, onMeeting }: { project: Project; workspace: Workspace; entries?: WorkEntry[]; projectLinks?: Record<string, string>; onChanged: () => Promise<boolean>; onMeeting?: (id: string) => void }) {
  const [draft] = useState(() => progressDraft(project.id));
  const profileKey = `zhiji:project-profile-draft:${project.id}`;
  const activityKey = `zhiji:activity-draft:${project.id}`;
  const [profileDraft] = useState(() => cachedFields(profileKey, { goal: "", stage: "", dirty: "" }));
  const [activityDraft] = useState(() => cachedFields(activityKey, { id: crypto.randomUUID(), title: "", kind: "meeting", day: localDateKey(new Date()), meetingId: "" }));
  const profileDirty = useRef(profileDraft.dirty === "yes");
  const [hub, setHub] = useState<Hub>(empty);
  const [catalog, setCatalog] = useState<Hub>(empty);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const catalogPending = useRef(false);
  const [catalogError, setCatalogError] = useState("");
  const [ready, setReady] = useState(false);
  const [cacheError, setCacheError] = useState("");
  const [goal, setGoal] = useState(profileDraft.goal); const [stage, setStage] = useState(profileDraft.stage);
  const [activityId, setActivityId] = useState(draft.activityId || "");
  const [title, setTitle] = useState(activityDraft.title); const [kind, setKind] = useState(activityDraft.kind);
  const [activityDay, setActivityDay] = useState(activityDraft.day);
  const [meetingId, setMeetingId] = useState(activityDraft.meetingId); const [existingActivity, setExistingActivity] = useState("");
  const [resourceId, setResourceId] = useState(""); const [role, setRole] = useState("reference");
  const viewKey = `zhiji:project-view:${project.id}`;
  const [view, setView] = useState(() => {
    const saved = cachedFields(viewKey, { tab: "overview", resourceId: "", fileQuery: "", fileActivityId: "", listScroll: "0" });
    return { ...saved, tab: Object.prototype.hasOwnProperty.call(tabs, saved.tab) ? saved.tab as HubTab : "overview" as HubTab };
  });
  const resourceList = useRef<HTMLDivElement>(null);
  const hubElement = useRef<HTMLElement>(null);
  const latestView = useRef(view);
  latestView.current = view;
  const tabButtons = useRef<Partial<Record<HubTab, HTMLButtonElement | null>>>({});
  const [editingProfile, setEditingProfile] = useState(profileDraft.dirty === "yes");
  const [addingActivity, setAddingActivity] = useState(!!activityDraft.title);
  const [addingResource, setAddingResource] = useState(false);
  const [content, setContent] = useState(draft.content); const [progressDay, setProgressDay] = useState(draft.day || localDateKey(new Date()));
  const [progressStatus, setProgressStatus] = useState(draft.status && statuses[draft.status] ? draft.status : "in_progress"); const [outputId, setOutputId] = useState(draft.outputId || "");
  const [entryId, setEntryId] = useState<string>(draft.entryId);
  const [activityDraftId, setActivityDraftId] = useState<string>(activityDraft.id);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [focused, setFocused] = useState(false);
  const progressDateChosen = useRef(!!draft.content.trim());
  const editorPosition = useRef<{ start: number; end: number; scroll: number } | null>(null);
  useLayoutEffect(() => {
    const input = progressInput.current;
    const position = editorPosition.current;
    if (!input || !position) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(position.start, position.end);
    input.scrollTop = position.scroll;
  }, [focused]);
  useEffect(() => {
    try { localStorage.setItem(viewKey, JSON.stringify(view)); }
    catch { setCacheError("查看位置无法缓存，已保存的项目资料不受影响。"); }
  }, [viewKey, view]);
  useLayoutEffect(() => {
    if (view.tab === "resources" && resourceList.current) {
      const top = Number(view.listScroll);
      resourceList.current.scrollTop = Number.isFinite(top) && top > 0 ? top : 0;
    }
  }, [view.tab, view.resourceId, ready, hub.resources.length]);
  useEffect(() => {
    const list = resourceList.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      if (!list.clientHeight) return;
      const top = Number(latestView.current.listScroll);
      list.scrollTop = Number.isFinite(top) && top > 0 ? top : 0;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!ready || busy || loading) return;
    setView(v => {
      const fileActivityId = hub.activities.some(a => a.id === v.fileActivityId) ? v.fileActivityId : "";
      const resourceId = hub.resources.some(r => r.id === v.resourceId) ? v.resourceId : "";
      return fileActivityId === v.fileActivityId && resourceId === v.resourceId ? v : { ...v, fileActivityId, resourceId };
    });
    const missingActivity = activityId && !hub.activities.some(a => a.id === activityId);
    const missingResource = outputId && !hub.resources.some(r => r.id === outputId);
    if (missingActivity) setActivityId("");
    if (missingResource) setOutputId("");
    if (content.trim() && (missingActivity || missingResource)) setNotice("草稿内容已保留，但原关联活动或资料已不在此项目中，请核对进展来源后保存。");
  }, [ready, busy, loading, hub, activityId, outputId]);
  useEffect(() => {
    try { localStorage.setItem(`zhiji:project-progress:${project.id}`, JSON.stringify({ content, entryId, day: progressDay, status: progressStatus, activityId, outputId })); }
    catch { setCacheError("进展草稿无法缓存，请先保存再切换项目。"); }
  }, [project.id, content, entryId, progressDay, progressStatus, activityId, outputId]);
  useEffect(() => {
    if (!profileDirty.current) return;
    try { localStorage.setItem(profileKey, JSON.stringify({ goal, stage, dirty: "yes" })); }
    catch { setCacheError("目标草稿无法缓存，请先保存再切换项目。"); }
  }, [profileKey, goal, stage]);
  useEffect(() => {
    try {
      if (title.trim() || meetingId) localStorage.setItem(activityKey, JSON.stringify({ id: activityDraftId, title, kind, day: activityDay, meetingId }));
      else localStorage.removeItem(activityKey);
    }
    catch { setCacheError("活动草稿无法缓存，请先保存再切换项目。"); }
  }, [activityKey, activityDraftId, title, kind, activityDay, meetingId]);
  const loadCatalog = async () => {
    if (catalogPending.current) return;
    catalogPending.current = true; setCatalogLoading(true); setCatalogError("");
    try { setCatalog(await workbenchCall<Hub>("load_project_hub")); setCatalogReady(true); }
    catch (cause) { setCatalogReady(false); setCatalogError(`可复用资料暂时无法读取。${String(cause)}`); }
    finally { catalogPending.current = false; setCatalogLoading(false); }
  };
  const reload = async () => {
    try { setHub(await workbenchCall<Hub>("load_project_hub", { projectId: project.id })); setReady(true); }
    catch (cause) { setReady(false); throw cause; }
    if (catalogReady) await loadCatalog();
  };
  useEffect(() => {
    if (view.tab === "activities" && addingActivity && !catalogReady) void loadCatalog();
  }, [view.tab, addingActivity]);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    void workbenchCall<Hub>("load_project_hub", { projectId: project.id })
      .then(next => { if (active) { setHub(next); setReady(true); if (!profileDirty.current) { const profile = next.profiles[0]; setGoal(profile?.goal || ""); setStage(profile?.stage || ""); } } })
      .catch(cause => { if (active) { setReady(false); setError(String(cause)); } }).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [project.id, attempt]);
  const perform = async (operation: () => Promise<void | boolean>, changesData = true) => {
    setBusy(true); setError(""); setNotice("");
    let completed = false;
    try {
      if (await operation() === false) return;
      completed = true;
      if (changesData) { await reload(); if (!await onChanged()) throw Error("工作记录列表暂时无法读取"); }
    } catch (cause) { setError(completed ? `操作已完成，但列表刷新失败；请重新读取，无需重复提交。${String(cause)}` : String(cause)); }
    finally { setBusy(false); }
  };
  // Browsing files must not silently change the source of a progress draft.
  const scope = view.fileActivityId ? { activityId: view.fileActivityId } : { projectId: project.id };
  const links = view.fileActivityId ? hub.resourceActivities.filter(l => l.activityId === view.fileActivityId) : hub.resourceLinks;
  const fileResources = view.fileActivityId ? hub.resources.filter(r => links.some(l => l.resourceId === r.id)) : hub.resources;
  const visible = activityId ? hub.resources.filter(r => hub.resourceActivities.some(l => l.activityId === activityId && l.resourceId === r.id)) : hub.resources;
  const searched = fileResources.filter(r => `${r.title} ${r.path}`.toLocaleLowerCase().includes(view.fileQuery.trim().toLocaleLowerCase()));
  const selectedResource = searched.find(r => r.id === view.resourceId);
  const selectedLink = links.find(l => l.resourceId === selectedResource?.id);
  const recent = entries.filter(e => e.projectId === project.id).sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.updatedAt.localeCompare(a.updatedAt));
  const meetingIds = new Set(hub.activities.flatMap(a => a.meetingId ? [a.meetingId] : []));
  const tasks = workspace.tasks.filter(t => !t.completed && (projectLinks[`task:${t.id}`] || (t.sourceType === "meeting" ? projectLinks[`meeting:${t.sourceId}`] || (meetingIds.has(t.sourceId || "") ? project.id : "") : "")) === project.id);
  const changeTab = (tab: HubTab) => {
    const scroller = hubElement.current?.closest<HTMLElement>(".main-content");
    const top = scroller && hubElement.current ? scroller.scrollTop + hubElement.current.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16 : 0;
    setView(v => ({ ...v, tab }));
    requestAnimationFrame(() => { if (scroller) scroller.scrollTop = Math.min(scroller.scrollTop, Math.max(0, top)); });
  };
  const progressAction = () => { changeTab("progress"); requestAnimationFrame(() => progressInput.current?.focus()); };
  const progressInput = useRef<HTMLTextAreaElement>(null);
  const toggleFocus = () => {
    const input = progressInput.current;
    if (input) editorPosition.current = { start: input.selectionStart, end: input.selectionEnd, scroll: input.scrollTop };
    setFocused(v => !v);
  };
  const disabled = busy || loading || !ready;
  const attach = () => perform(async () => {
    const paths = await open({ multiple: true, directory: false, title: "关联本地资料", filters: [{ name: "工作资料", extensions: ["docx","doc","pdf","pptx","ppt","xlsx","xls","txt","md","rtf","csv","png","jpg","jpeg","wav","mp3","m4a","mp4"] }] });
    if (!paths) return false;
    let count = 0;
    try {
      for (const path of Array.isArray(paths) ? paths : [paths]) { await workbenchCall("register_resource", { path, ...scope, role }); count++; }
    } catch (cause) {
      if (count) { try { await reload(); } catch { /* keep original registration failure */ } }
      throw Error(`已关联 ${count} 份资料，其余未完成。${String(cause)}`);
    }
    setNotice(`已关联 ${count} 份资料，原文件位置保持不变`);
  });
  const renderProgress = () => <form className="hub-progress" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing && !disabled && content.trim()) { e.preventDefault(); e.currentTarget.requestSubmit(); } }} onSubmit={e=>{e.preventDefault(); void perform(async()=>{
      await workbenchCall("capture_work",{id:entryId,content,kind:progressStatus==="done"?"achievement":"progress",status:progressStatus,occurredOn:progressDay,projectId:project.id,sourceLabel:"项目进展",activityId:activityId||null,resourceId:outputId||null});
      setContent("");setEntryId(crypto.randomUUID());setProgressDay(localDateKey(new Date()));setProgressStatus("in_progress");progressDateChosen.current = false;setNotice("进展已保存，将按实际发生日期进入周报材料");
    });}}>
      <div className="hub-section-heading"><h3>记录本次进展</h3><button type="button" className="ghost-button" onClick={toggleFocus}>{focused ? "退出专注" : "专注录入"}</button></div><textarea ref={progressInput} aria-label="项目进展内容" placeholder="实际推进了什么？形成什么产出？还在等待什么？" required maxLength={20000} rows={3} value={content} disabled={disabled} onChange={e => { if (!content.trim() && e.target.value.trim() && !progressDateChosen.current) setProgressDay(localDateKey(new Date())); setContent(e.target.value); }} />
      <div className="capture-fields"><select aria-label="当前活动" value={activityId} disabled={disabled} onChange={e => { setActivityId(e.target.value); setOutputId(""); }}><option value="">不关联活动</option>{hub.activities.map(a => <option key={a.id} value={a.id}>{a.occurredOn} · {a.title}</option>)}</select><input aria-label="进展日期" type="date" required value={progressDay} disabled={disabled} onChange={e => { progressDateChosen.current = true; setProgressDay(e.target.value); }} /><select aria-label="进展状态" value={progressStatus} disabled={disabled} onChange={e=>setProgressStatus(e.target.value)}>{Object.entries(statuses).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><select aria-label="进展关联资料" value={outputId} disabled={disabled} onChange={e=>setOutputId(e.target.value)}><option value="">无关联资料</option>{visible.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select><button className="primary-button compact-button" disabled={disabled || !content.trim()}>保存本次进展</button></div>
      <p className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : content.trim() ? "进展草稿已保留在本机，保存后才会纳入周报。" : "每次实质进展新增一条，周报以你记录的事实为准。"}</p>
    </form>;
  const renderRecent = (limit?: number) => <section className="project-recent" aria-label="项目最近进展"><h3>{limit ? "最近进展" : "进展记录"}</h3>
    {(limit ? recent.slice(0, limit) : recent).map(entry => <article key={entry.id}><small>{entry.occurredOn} · {statuses[entry.status] || entry.status}</small><p>{entry.content}</p></article>)}
    {!recent.length && <p>还没有进展记录。完成一项沟通或交付后，留下一句话即可。</p>}
    {limit && recent.length > limit && <button className="ghost-button" onClick={() => changeTab("progress")}>查看全部 {recent.length} 条进展</button>}
  </section>;
  return <section ref={hubElement} className="project-hub" aria-label="项目详情">
    <header><div><span className="journal-eyebrow">项目工作区</span><h2>{project.name}</h2></div><span>{project.archived ? "已归档" : "进行中"}</span></header>
    {error && <div className="qa-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => setAttempt(v => v + 1)}>重新读取</button></div>}
    {notice && <p role="status">{notice}</p>}
    {cacheError && <p role="alert" className="qa-error">{cacheError}</p>}
    {catalogError && <div role="alert" className="qa-error">{catalogError}<button disabled={catalogLoading} onClick={() => void loadCatalog()}>重试读取可复用资料</button></div>}
    {loading && <p role="status">正在读取项目资料…</p>}
    <div className="hub-tabs" role="tablist" aria-label="项目视图">{(Object.entries(tabs) as [HubTab, string][]).map(([id, label]) => <button type="button" key={id} role="tab" id={`project-${project.id}-tab-${id}`} aria-controls={`project-${project.id}-panel-${id}`} aria-selected={view.tab === id} tabIndex={view.tab === id ? 0 : -1} ref={el => { tabButtons.current[id] = el; }} onClick={() => changeTab(id)} onKeyDown={e => {
      const ids = Object.keys(tabs) as HubTab[];
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault(); const next = e.key === "Home" ? ids[0] : e.key === "End" ? ids[ids.length - 1] : ids[(ids.indexOf(id) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
      changeTab(next); tabButtons.current[next]?.focus();
    }}>{label}</button>)}</div>
    <div role="tabpanel" id={`project-${project.id}-panel-overview`} aria-labelledby={`project-${project.id}-tab-overview`} hidden={view.tab !== "overview"}>
      <div className="hub-section-heading"><h3>继续推进这个项目</h3><button className="primary-button compact-button" disabled={disabled} onClick={progressAction}>{content.trim() ? "继续进展草稿" : "记录进展"}</button></div>
      {content.trim() && <p className="hub-draft-preview">未提交的进展：{content}</p>}
      {ready && <div className="hub-overview"><p>{hub.profiles[0]?.goal || "可以先添加资料、记录进展，目标稍后补充。"}</p><small>{hub.profiles[0]?.stage || "尚未设置阶段"} · {hub.activities.length} 次活动 · {hub.resources.length} 份资料</small></div>}
    <details className="hub-add" open={editingProfile} onToggle={e => setEditingProfile(e.currentTarget.open)}><summary>编辑目标与阶段</summary>
    <form className="hub-profile" onSubmit={e => { e.preventDefault(); void perform(async () => { await workbenchCall("save_project_profile", { projectId: project.id, goal, stage }); profileDirty.current = false; try { localStorage.removeItem(profileKey); } catch { setCacheError("目标已保存，但旧草稿缓存未能清除。"); } setNotice("项目目标已保存"); }); }}>
      <label>项目目标<textarea aria-label="项目目标" value={goal} onChange={e => { profileDirty.current = true; setGoal(e.target.value); }} maxLength={2000} rows={2} disabled={disabled} /></label>
      <label>当前阶段<input aria-label="项目阶段" value={stage} onChange={e => { profileDirty.current = true; setStage(e.target.value); }} maxLength={100} disabled={disabled} placeholder="例如：初稿评审，等待数据补充" /></label>
      <button className="secondary-button compact-button" disabled={disabled}>保存目标与阶段</button>
      <small className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : "填写内容会保留为本机草稿，点击保存后更新项目。"}</small>
    </form>
    </details>

      <section className="hub-current-tasks" aria-label="项目当前行动"><h3>当前行动</h3>{tasks.slice(0, 5).map(task => <article key={task.id}><strong>{task.title}</strong><small>{task.dueDate ? `截止：${task.dueDate}` : "未设截止日期"}{task.owner ? ` · ${task.owner}` : ""}</small>{task.sourceType === "meeting" && task.sourceId && <button className="ghost-button" onClick={() => onMeeting?.(task.sourceId!)}>查看来源会议</button>}</article>)}{!tasks.length && <p className="capture-hint">暂无关联的未完成待办；可在工作记录中关联已有待办。</p>}{tasks.length > 5 && <p className="capture-hint">另有 {tasks.length - 5} 项行动，可在待办页查看。</p>}</section>
      {renderRecent(3)}
    </div>
    <div role="tabpanel" id={`project-${project.id}-panel-activities`} aria-labelledby={`project-${project.id}-tab-activities`} hidden={view.tab !== "activities"}>
      <h3>项目活动 · {hub.activities.length}</h3>
    <details className="hub-add" open={addingActivity} onToggle={e => { setAddingActivity(e.currentTarget.open); if (view.tab === "activities" && e.currentTarget.open && !catalogReady) void loadCatalog(); }}><summary>添加活动</summary>
      <form className="capture-fields" onSubmit={e => { e.preventDefault(); void perform(async () => { await workbenchCall("save_activity", { id: activityDraftId, projectId: project.id, title, kind, occurredOn: activityDay, meetingId: meetingId || null }); if (!content.trim()) { setActivityId(activityDraftId); setOutputId(""); } setView(v => ({ ...v, tab: "resources", fileActivityId: activityDraftId, resourceId: "", fileQuery: "", listScroll: "0" })); setAddingActivity(false); setActivityDraftId(crypto.randomUUID()); setTitle(""); setMeetingId(""); setNotice("活动已保存，可以添加本次资料和进展"); }); }}>
        <input aria-label="活动名称" placeholder="活动名称" value={title} maxLength={200} required disabled={disabled} onChange={e => setTitle(e.target.value)} />
        <select aria-label="活动类型" value={kind} disabled={disabled} onChange={e => setKind(e.target.value)}>{Object.entries(activityKinds).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input aria-label="活动日期" type="date" required value={activityDay} disabled={disabled} onChange={e => setActivityDay(e.target.value)} />
        <select aria-label="关联已有会议" value={meetingId} disabled={disabled || catalogLoading || !catalogReady} onChange={e => { setMeetingId(e.target.value); const m=workspace.meetings.find(m=>m.id===e.target.value); if(m) { setTitle(m.title); setActivityDay(m.startedAt.slice(0,10)); setKind("meeting"); } }}><option value="">不关联录音会议</option>{workspace.meetings.filter(m => !catalog.activities.some(a => a.meetingId === m.id)).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select>
        <button className="primary-button compact-button" disabled={disabled || !title.trim()}>保存活动</button>
      </form>
      <div className="capture-fields"><select aria-label="复用现有活动" value={existingActivity} disabled={disabled || catalogLoading || !catalogReady} onChange={e => setExistingActivity(e.target.value)}><option value="">选择其他项目的活动</option>{catalog.activities.filter(a => !hub.activities.some(x => x.id === a.id)).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select><button className="secondary-button compact-button" disabled={disabled || catalogLoading || !catalogReady || !existingActivity} onClick={() => void perform(async () => { await workbenchCall("link_activity", { activityId: existingActivity, projectId: project.id }); if (!content.trim()) { setActivityId(existingActivity); setOutputId(""); } setView(v => ({ ...v, tab: "resources", fileActivityId: existingActivity, resourceId: "", fileQuery: "", listScroll: "0" })); setExistingActivity(""); })}>关联现有活动</button></div>
      <p className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : "活动草稿会留在本机，切换项目后可继续填写。"}</p>
    </details>

      <div className="hub-activity-list">{hub.activities.map(a => <article key={a.id}><strong>{a.title}</strong><small>{activityKinds[a.kind] || a.kind} · {a.occurredOn}</small><div className="hub-actions"><button className="secondary-button compact-button" disabled={disabled} onClick={() => setView(v => ({ ...v, tab: "resources", fileActivityId: a.id, fileQuery: "", resourceId: "", listScroll: "0" }))}>查看活动资料</button><button className="ghost-button" disabled={disabled} onClick={() => { setActivityId(a.id); setOutputId(""); progressAction(); }}>记录活动进展</button>{a.meetingId && <button className="ghost-button" onClick={() => onMeeting?.(a.meetingId!)}>打开会议记录</button>}</div></article>)}</div>
      {ready && !hub.activities.length && <p className="journal-empty">还没有活动，可先登记会议、调研或评审。</p>}
    </div>
    <div className={`hub-resources-panel ${selectedResource ? "has-selection" : ""}`} role="tabpanel" id={`project-${project.id}-panel-resources`} aria-labelledby={`project-${project.id}-tab-resources`} hidden={view.tab !== "resources"}>
      <div className="hub-section-heading"><h3>项目资料</h3><select aria-label="资料所属活动" value={view.fileActivityId} disabled={disabled} onChange={e => setView(v => ({ ...v, fileActivityId: e.target.value, resourceId: "", listScroll: "0" }))}><option value="">项目全部资料</option>{hub.activities.map(a => <option key={a.id} value={a.id}>{a.occurredOn} · {a.title}</option>)}</select></div>
      <details className="hub-add" open={addingResource} onToggle={e => setAddingResource(e.currentTarget.open)}><summary>添加资料</summary>
    <div className="capture-fields">
      <select aria-label="资料用途" value={role} disabled={disabled} onChange={e=>setRole(e.target.value)}>{Object.entries(roles).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      <button className="secondary-button compact-button" disabled={disabled} onClick={() => void attach()}>选择本地文件</button>
    </div>
    <details className="hub-add" onToggle={e => { if (e.currentTarget.open && !catalogReady) void loadCatalog(); }}><summary>复用已登记资料</summary><div className="capture-fields">
      <select aria-label="复用已登记资料" value={resourceId} disabled={disabled || catalogLoading || !catalogReady} onChange={e=>setResourceId(e.target.value)}><option value="">{catalogLoading ? "正在读取…" : "选择已登记资料"}</option>{catalog.resources.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select>
      <button className="secondary-button compact-button" disabled={disabled || catalogLoading || !catalogReady || !resourceId} onClick={() => void perform(async () => { await workbenchCall("link_resource", { resourceId, ...scope, role }); setResourceId(""); setNotice("关联已保存，未复制原文件"); })}>添加关联</button>
    </div></details>

        <p className="capture-hint">资料继续由原软件编辑；这里只登记关联，数据库备份不包含原文件。</p>
      </details>
      <p className="capture-hint">文件正文尚未索引；当前按文件名和路径查找。</p>
      <label className="hub-file-search">查找资料<input aria-label="搜索项目资料" placeholder="按文件名或路径查找资料" value={view.fileQuery} onChange={e => setView(v => ({ ...v, fileQuery: e.target.value, resourceId: "", listScroll: "0" }))} /></label>
      <div className={`hub-file-browser ${selectedResource ? "has-selection" : ""}`}>
        <div className="hub-file-list" ref={resourceList} onScroll={e => { if (!e.currentTarget.clientHeight) return; const top = String(e.currentTarget.scrollTop); setView(v => v.listScroll === top ? v : { ...v, listScroll: top }); }}>
          <ul className="hub-resources" aria-label="项目资料列表">{searched.map(r => { const link = links.find(l => l.resourceId === r.id); return <li key={r.id}><button className="hub-file-choice" aria-pressed={selectedResource?.id === r.id} onClick={() => { const top = String(resourceList.current?.scrollTop || 0); setView(v => ({ ...v, resourceId: r.id, listScroll: top })); }}><strong>{r.title}</strong><small>{link ? roles[link.role] : "来自项目活动"} · 仅登记文件</small></button></li>; })}</ul>
          {ready && !searched.length && <p className="journal-empty">{view.fileQuery ? "未找到匹配文件，可调整关键词；文件正文尚未索引。" : "尚未关联资料，可选择文件或复用已登记资料。"}</p>}
        </div>
        <section className="hub-file-detail" aria-label="资料详情">
          {selectedResource ? <><button className="ghost-button hub-file-back" onClick={() => { const id = selectedResource.id; setView(v => ({ ...v, resourceId: "" })); requestAnimationFrame(() => { const choices = resourceList.current?.querySelectorAll<HTMLButtonElement>("button"); choices?.[searched.findIndex(r => r.id === id)]?.focus({ preventScroll: true }); }); }}>返回资料列表</button><h3>{selectedResource.title}</h3><p className="capture-hint">仅登记文件 · 正文尚未索引，AI 尚不能读取这份文件的内容。</p><dl><dt>文件位置</dt><dd className="hub-path">{selectedResource.path}</dd><dt>此处用途</dt><dd>{selectedLink ? roles[selectedLink.role] : "来自项目活动"}</dd><dt>关联活动</dt><dd>{hub.activities.filter(a => hub.resourceActivities.some(l => l.resourceId === selectedResource.id && l.activityId === a.id)).map(a => a.title).join("、") || "未关联活动"}</dd></dl>
            <div className="hub-actions"><button className="primary-button compact-button" disabled={disabled} onClick={() => void perform(async () => { await workbenchCall("open_resource", { resourceId: selectedResource.id }); }, false)}>打开原文件</button><button className="secondary-button compact-button" disabled={disabled} onClick={() => { if (content.trim()) { setNotice("已打开现有进展草稿，内容和来源保持原样；请在关联资料中确认本次来源。"); } else { setActivityId(view.fileActivityId); setOutputId(selectedResource.id); } progressAction(); }}>记录相关进展</button><button className="ghost-button" disabled={disabled} onClick={() => void perform(async () => { const path = await open({ multiple: false, directory: false, title: "重新定位资料文件" }); if (typeof path !== "string") return false; await workbenchCall("relocate_resource", { resourceId: selectedResource.id, path }); setNotice("文件位置已更新，原有关联和进展历史保留"); })}>重新定位</button>{selectedLink && <button className="ghost-button" disabled={disabled} onClick={() => { if (window.confirm("解除此处关联？原文件和其他关联将保留。")) void perform(async () => { await workbenchCall("unlink_resource", { resourceId: selectedResource.id, ...scope }); setNotice("已解除此处关联，原文件和其他关联保留"); }); }}>解除关联</button>}</div>
          </> : <p className="capture-hint">选择一份资料，查看用途、关联活动并用原软件打开。</p>}
        </section>
      </div>
    </div>
    <div role="tabpanel" id={`project-${project.id}-panel-progress`} aria-labelledby={`project-${project.id}-tab-progress`} hidden={view.tab !== "progress"}>
      {!focused && renderProgress()}

      <div hidden={focused}>{renderRecent()}</div>
    </div>
    {focused && createPortal(<Dialog ariaLabel="专注记录项目进展" className="progress-focus" onClose={toggleFocus} closeOnBackdrop={false}>
      <p className="progress-focus-project">{project.name}</p>
      {error && <div className="qa-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => setAttempt(v => v + 1)}>重新读取</button></div>}
      {notice && <p role="status">{notice}</p>}
      {cacheError && <p className="qa-error" role="alert">{cacheError}</p>}
      {renderProgress()}
    </Dialog>, document.body)}
  </section>;
}
