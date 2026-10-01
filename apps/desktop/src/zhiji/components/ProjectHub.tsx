import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { workbenchCall, statuses, type Project } from "../workbench";
import type { Workspace } from "../types";
import { localDateKey } from "../workflow";

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

export function ProjectHub({ project, workspace, onChanged, onMeeting }: { project: Project; workspace: Workspace; onChanged: () => Promise<boolean>; onMeeting?: (id: string) => void }) {
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
  const [fileQuery, setFileQuery] = useState("");
  const [content, setContent] = useState(draft.content); const [progressDay, setProgressDay] = useState(draft.day || localDateKey(new Date()));
  const [progressStatus, setProgressStatus] = useState(draft.status && statuses[draft.status] ? draft.status : "in_progress"); const [outputId, setOutputId] = useState(draft.outputId || "");
  const [entryId, setEntryId] = useState<string>(draft.entryId);
  const [activityDraftId, setActivityDraftId] = useState<string>(activityDraft.id);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
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
  const scope = activityId ? { activityId } : { projectId: project.id };
  const links = activityId ? hub.resourceActivities.filter(l => l.activityId === activityId) : hub.resourceLinks;
  const visible = activityId ? hub.resources.filter(r => links.some(l => l.resourceId === r.id)) : hub.resources;
  const searched = visible.filter(r => `${r.title} ${r.path}`.toLocaleLowerCase().includes(fileQuery.trim().toLocaleLowerCase()));
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
  return <section className="project-hub" aria-label="项目详情">
    <header><div><span className="journal-eyebrow">项目详情</span><h2>{project.name}</h2></div><span>{project.archived ? "已归档" : "进行中"}</span></header>
    {error && <div className="qa-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => setAttempt(v => v + 1)}>重新读取</button></div>}
    {notice && <p role="status">{notice}</p>}
    {cacheError && <p role="alert" className="qa-error">{cacheError}</p>}
    {catalogError && <div role="alert" className="qa-error">{catalogError}<button disabled={catalogLoading} onClick={() => void loadCatalog()}>重试读取可复用资料</button></div>}
    {loading && <p role="status">正在读取项目资料…</p>}
    {ready && <div className="hub-overview"><p>{hub.profiles[0]?.goal || "可以先添加资料、记录进展，目标稍后补充。"}</p><small>{hub.profiles[0]?.stage || "尚未设置阶段"} · {hub.activities.length} 次活动 · {hub.resources.length} 份资料</small></div>}
    <details className="hub-add" open={profileDraft.dirty === "yes" || undefined}><summary>编辑目标与阶段</summary>
    <form className="hub-profile" onSubmit={e => { e.preventDefault(); void perform(async () => { await workbenchCall("save_project_profile", { projectId: project.id, goal, stage }); profileDirty.current = false; try { localStorage.removeItem(profileKey); } catch { setCacheError("目标已保存，但旧草稿缓存未能清除。"); } setNotice("项目目标已保存"); }); }}>
      <label>项目目标<textarea aria-label="项目目标" value={goal} onChange={e => { profileDirty.current = true; setGoal(e.target.value); }} maxLength={2000} rows={2} disabled={disabled} /></label>
      <label>当前阶段<input aria-label="项目阶段" value={stage} onChange={e => { profileDirty.current = true; setStage(e.target.value); }} maxLength={100} disabled={disabled} placeholder="例如：初稿评审，等待数据补充" /></label>
      <button className="secondary-button compact-button" disabled={disabled}>保存目标与阶段</button>
      <small className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : "填写内容会保留为本机草稿，点击保存后更新项目。"}</small>
    </form>
    </details>
    <div className="hub-section-heading"><h3>活动与资料</h3><select aria-label="当前活动" value={activityId} disabled={disabled} onChange={e => { setActivityId(e.target.value); setOutputId(""); }}><option value="">项目全部资料</option>{hub.activities.map(a => <option key={a.id} value={a.id}>{a.occurredOn} · {a.title}</option>)}</select></div>
    <details className="hub-add" open={!!activityDraft.title || undefined} onToggle={e => { if (e.currentTarget.open && !catalogReady) void loadCatalog(); }}><summary>添加活动</summary>
      <form className="capture-fields" onSubmit={e => { e.preventDefault(); void perform(async () => { await workbenchCall("save_activity", { id: activityDraftId, projectId: project.id, title, kind, occurredOn: activityDay, meetingId: meetingId || null }); setActivityId(activityDraftId); setActivityDraftId(crypto.randomUUID()); setTitle(""); setMeetingId(""); setOutputId(""); setNotice("活动已保存，可以添加本次资料和进展"); }); }}>
        <input aria-label="活动名称" placeholder="活动名称" value={title} maxLength={200} required disabled={disabled} onChange={e => setTitle(e.target.value)} />
        <select aria-label="活动类型" value={kind} disabled={disabled} onChange={e => setKind(e.target.value)}>{Object.entries(activityKinds).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select>
        <input aria-label="活动日期" type="date" required value={activityDay} disabled={disabled} onChange={e => setActivityDay(e.target.value)} />
        <select aria-label="关联已有会议" value={meetingId} disabled={disabled || catalogLoading || !catalogReady} onChange={e => { setMeetingId(e.target.value); const m=workspace.meetings.find(m=>m.id===e.target.value); if(m) { setTitle(m.title); setActivityDay(m.startedAt.slice(0,10)); setKind("meeting"); } }}><option value="">不关联录音会议</option>{workspace.meetings.filter(m => !catalog.activities.some(a => a.meetingId === m.id)).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select>
        <button className="primary-button compact-button" disabled={disabled || !title.trim()}>保存活动</button>
      </form>
      <div className="capture-fields"><select aria-label="复用现有活动" value={existingActivity} disabled={disabled || catalogLoading || !catalogReady} onChange={e => setExistingActivity(e.target.value)}><option value="">选择其他项目的活动</option>{catalog.activities.filter(a => !hub.activities.some(x => x.id === a.id)).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select><button className="secondary-button compact-button" disabled={disabled || catalogLoading || !catalogReady || !existingActivity} onClick={() => void perform(async () => { await workbenchCall("link_activity", { activityId: existingActivity, projectId: project.id }); setActivityId(existingActivity); setExistingActivity(""); setOutputId(""); })}>关联现有活动</button></div>
      <p className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : "活动草稿会留在本机，切换项目后可继续填写。"}</p>
    </details>
    {activityId && (() => { const a=hub.activities.find(a=>a.id===activityId); return a && <p className="hub-activity-summary">{activityKinds[a.kind]} · {a.occurredOn} · {a.title}{a.meetingId && <button className="ghost-button" onClick={() => onMeeting?.(a.meetingId!)}>打开会议记录</button>}</p>; })()}
    <div className="capture-fields">
      <select aria-label="资料用途" value={role} disabled={disabled} onChange={e=>setRole(e.target.value)}>{Object.entries(roles).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      <button className="secondary-button compact-button" disabled={disabled} onClick={() => void attach()}>选择本地文件</button>
    </div>
    <details className="hub-add" onToggle={e => { if (e.currentTarget.open && !catalogReady) void loadCatalog(); }}><summary>复用已登记资料</summary><div className="capture-fields">
      <select aria-label="复用已登记资料" value={resourceId} disabled={disabled || catalogLoading || !catalogReady} onChange={e=>setResourceId(e.target.value)}><option value="">{catalogLoading ? "正在读取…" : "选择已登记资料"}</option>{catalog.resources.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select>
      <button className="secondary-button compact-button" disabled={disabled || catalogLoading || !catalogReady || !resourceId} onClick={() => void perform(async () => { await workbenchCall("link_resource", { resourceId, ...scope, role }); setResourceId(""); setNotice("关联已保存，未复制原文件"); })}>添加关联</button>
    </div></details>
    <p className="capture-hint">资料继续由原软件编辑；这里只登记关联，正文尚未索引，数据库备份不包含原文件。</p>
    <input aria-label="搜索项目资料" placeholder="按文件名或路径查找资料" value={fileQuery} onChange={e=>setFileQuery(e.target.value)} />
    <ul className="hub-resources">{searched.map(r => {
      const link=links.find(l=>l.resourceId===r.id);
      return <li key={r.id}><div><strong>{r.title}</strong><small>{link ? roles[link.role] : "来自项目活动"} · 仅登记文件</small><small className="hub-path" title={r.path}>{r.path}</small></div><div className="hub-actions"><button className="ghost-button" disabled={disabled} onClick={() => void perform(async()=>{ await workbenchCall("open_resource",{resourceId:r.id}); }, false)}>打开</button><button className="ghost-button" disabled={disabled} onClick={() => void perform(async()=>{ const path=await open({multiple:false,directory:false,title:"重新定位资料文件"}); if(typeof path==="string") { await workbenchCall("relocate_resource",{resourceId:r.id,path}); setNotice("文件位置已更新，原有关联和进展历史保留"); } else return false; })}>重新定位</button>{link && <button className="ghost-button" disabled={disabled} onClick={() => { if(window.confirm("解除此处关联？原文件和其他关联将保留。")) void perform(async()=>{ await workbenchCall("unlink_resource",{resourceId:r.id,...scope}); }); }}>解除关联</button>}</div></li>;
    })}</ul>
    {!searched.length && <p className="journal-empty">{fileQuery ? "未找到匹配文件，可调整关键词；文件正文尚未索引。" : "尚未关联资料，可选择文件或复用已登记资料。"}</p>}
    <form className="hub-progress" onSubmit={e=>{e.preventDefault(); void perform(async()=>{
      await workbenchCall("capture_work",{id:entryId,content,kind:progressStatus==="done"?"achievement":"progress",status:progressStatus,occurredOn:progressDay,projectId:project.id,sourceLabel:"项目进展",activityId:activityId||null,resourceId:outputId||null});
      setContent("");setEntryId(crypto.randomUUID());setNotice("进展已保存，将按实际发生日期进入周报材料");
    });}}>
      <h3>记录本次进展</h3><textarea aria-label="项目进展内容" placeholder="实际推进了什么？形成什么产出？还在等待什么？" required maxLength={20000} rows={3} value={content} disabled={disabled} onChange={e=>setContent(e.target.value)} />
      <div className="capture-fields"><input aria-label="进展日期" type="date" required value={progressDay} disabled={disabled} onChange={e=>setProgressDay(e.target.value)} /><select aria-label="进展状态" value={progressStatus} disabled={disabled} onChange={e=>setProgressStatus(e.target.value)}>{Object.entries(statuses).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select><select aria-label="进展关联资料" value={outputId} disabled={disabled} onChange={e=>setOutputId(e.target.value)}><option value="">无关联资料</option>{visible.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select><button className="primary-button compact-button" disabled={disabled || !content.trim()}>保存本次进展</button></div>
      <p className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : content.trim() ? "进展草稿已保留在本机，保存后才会纳入周报。" : "每次实质进展新增一条，周报以你记录的事实为准。"}</p>
    </form>
  </section>;
}
