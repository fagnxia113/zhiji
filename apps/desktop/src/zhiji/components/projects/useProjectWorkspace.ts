import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { workbenchCall, statuses } from "../../workbench";
import { localDateKey } from "../../workflow";
import { activityKinds, cachedFields, progressDraft, tabs, validDate, type HubTab, type ProjectWorkspaceProps } from "./model";
import { useProjectData } from "./useProjectData";

export function useProjectWorkspace({ project, workspace, entries = [], projectLinks = {}, onChanged, onMeeting, meetingContent }: ProjectWorkspaceProps) {
  const [draft] = useState(() => progressDraft(project.id));
  const profileKey = `zhiji:project-profile-draft:${project.id}`;
  const activityKey = `zhiji:activity-draft:${project.id}`;
  const [profileDraft] = useState(() => cachedFields(profileKey, { goal: "", stage: "", dirty: "" }));
  const [activityDraft] = useState(() => {
    const value = cachedFields(activityKey, { id: crypto.randomUUID(), title: "", kind: "meeting", day: localDateKey(new Date()), meetingId: "" });
    return { ...value, id: value.id || crypto.randomUUID(), kind: Object.prototype.hasOwnProperty.call(activityKinds, value.kind) ? value.kind : "meeting", day: validDate(value.day) ? value.day : localDateKey(new Date()) };
  });
  const profileDirty = useRef(profileDraft.dirty === "yes");
  const data = useProjectData(project.id, onChanged);
  const { hub, catalog, ready, loading, busy, error, notice, catalogReady, catalogLoading, catalogError, setError, setNotice, reload, loadCatalog, perform, retry } = data;
  const [cacheError, setCacheError] = useState("");
  const [goal, setGoal] = useState(profileDraft.goal); const [stage, setStage] = useState(profileDraft.stage);
  const [activityId, setActivityId] = useState(draft.activityId || "");
  const [title, setTitle] = useState(activityDraft.title); const [kind, setKind] = useState(activityDraft.kind);
  const [activityDay, setActivityDay] = useState(activityDraft.day);
  const [meetingId, setMeetingId] = useState(activityDraft.meetingId); const [existingActivity, setExistingActivity] = useState("");
  const [resourceId, setResourceId] = useState(""); const [role, setRole] = useState("reference");
  const viewKey = `zhiji:project-view:${project.id}`;
  const [view, setView] = useState(() => {
    const saved = cachedFields(viewKey, { tab: "progress", resourceId: "", fileQuery: "", fileActivityId: "", listScroll: "0" });
    return { ...saved, tab: Object.prototype.hasOwnProperty.call(tabs, saved.tab) ? saved.tab as HubTab : "progress" as HubTab };
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
  const [focused, setFocused] = useState(false);
  const [progressDetails, setProgressDetails] = useState(false);
  const progressOptions = useRef<HTMLDetailsElement>(null);
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
  useEffect(() => {
    if (ready && !profileDirty.current) { setGoal(hub.profiles[0]?.goal || ""); setStage(hub.profiles[0]?.stage || ""); }
  }, [hub, ready]);
  useEffect(() => {
    if (view.tab === "activities" && addingActivity && !catalogReady) void loadCatalog();
  }, [view.tab, addingActivity]);
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
  const directMeetings = workspace.meetings.filter(m => projectLinks[`meeting:${m.id}`] === project.id && !meetingIds.has(m.id)).sort((a,b) => b.startedAt.localeCompare(a.startedAt));
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
    const paths = await open({ multiple: true, directory: false, title: "关联本地资料", defaultPath: project.folderPath || undefined, filters: [{ name: "工作资料", extensions: ["docx","doc","pdf","pptx","ppt","xlsx","xls","txt","md","rtf","csv","png","jpg","jpeg","wav","mp3","m4a","mp4"] }] });
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
  const saveProfile = () => perform(async () => { await workbenchCall("save_project_profile", { projectId: project.id, goal, stage }); profileDirty.current = false; try { localStorage.removeItem(profileKey); } catch { setCacheError("目标已保存，但旧草稿缓存未能清除。"); } setNotice("项目目标已保存"); });
  const chooseFolder = () => perform(async () => {
    const path = await open({ multiple: false, directory: true, title: "选择项目资料文件夹", defaultPath: project.folderPath || undefined });
    if (typeof path !== "string") return false;
    await workbenchCall("set_project_folder", { projectId: project.id, path });
    setNotice("项目文件夹已关联");
  });
  const openFolder = () => perform(async () => { await workbenchCall("open_project_folder", { projectId: project.id }); }, false);
  const unlinkFolder = () => perform(async () => { await workbenchCall("set_project_folder", { projectId: project.id, path: null }); setNotice("文件夹关联已解除，已登记资料保留"); });
  const saveActivity = () => perform(async () => { await workbenchCall("save_activity", { id: activityDraftId, projectId: project.id, title, kind, occurredOn: activityDay, meetingId: meetingId || null }); if (!content.trim()) { setActivityId(activityDraftId); setOutputId(""); } setView(v => ({ ...v, tab: "resources", fileActivityId: activityDraftId, resourceId: "", fileQuery: "", listScroll: "0" })); setAddingActivity(false); setActivityDraftId(crypto.randomUUID()); setTitle(""); setMeetingId(""); setNotice("活动已保存，可以添加本次资料和进展"); });
  const saveProgress = () => perform(async () => {
      await workbenchCall("capture_work",{id:entryId,content,kind:progressStatus==="done"?"achievement":"progress",status:progressStatus,occurredOn:progressDay,projectId:project.id,sourceLabel:"项目进展",activityId:activityId||null,resourceId:outputId||null});
      setContent("");setEntryId(crypto.randomUUID());setProgressDay(localDateKey(new Date()));setProgressStatus("in_progress");progressDateChosen.current = false;setNotice("进展已保存，将按实际发生日期进入周报材料");
     });
  const toggleArchive = () => perform(async () => { await workbenchCall("save_project", { ...project, archived: !project.archived }); setNotice(project.archived ? "项目已恢复" : "项目已归档，资料和记录保留"); });
  const linkExistingActivity = () => perform(async () => { await workbenchCall("link_activity", { activityId: existingActivity, projectId: project.id }); if (!content.trim()) { setActivityId(existingActivity); setOutputId(""); } setView(v => ({ ...v, tab: "resources", fileActivityId: existingActivity, resourceId: "", fileQuery: "", listScroll: "0" })); setExistingActivity(""); });
  const reuseResource = () => perform(async () => { await workbenchCall("link_resource", { resourceId, ...scope, role }); setResourceId(""); setNotice("关联已保存，未复制原文件"); });
  const openSelected = () => { if (selectedResource) return perform(async () => { await workbenchCall("open_resource", { resourceId: selectedResource.id }); }, false); };
  const relocateSelected = () => { if (selectedResource) return perform(async () => { const path = await open({ multiple: false, directory: false, title: "重新定位资料文件" }); if (typeof path !== "string") return false; await workbenchCall("relocate_resource", { resourceId: selectedResource.id, path }); setNotice("文件位置已更新，原有关联和进展历史保留"); }); };
  const unlinkSelected = () => { if (selectedResource) return perform(async () => { await workbenchCall("unlink_resource", { resourceId: selectedResource.id, ...scope }); setNotice("已解除此处关联，原文件和其他关联保留"); }); };
  const recordResource = () => {
    if (!selectedResource) return;
    if (content.trim()) setNotice("已打开现有进展草稿，内容和来源保持原样；请在关联资料中确认本次来源。");
    else { setActivityId(view.fileActivityId); setOutputId(selectedResource.id); }
    progressAction();
  };
  const recordActivity = (id: string) => {
    if (content.trim()) setNotice("已打开现有进展草稿，内容和来源保持原样；请核对活动来源。");
    else { setActivityId(id); setOutputId(""); }
    progressAction();
  };
  return { project, workspace, onMeeting, meetingContent, hub, catalog, ready, loading, busy, error, notice, catalogReady, catalogLoading, catalogError, setError, setNotice, reload, loadCatalog, perform, retry, cacheError, goal, stage, profileDirty, profileKey, setGoal, setStage, activityId, setActivityId, title, setTitle, kind, setKind, activityDay, setActivityDay, meetingId, setMeetingId, existingActivity, setExistingActivity, resourceId, setResourceId, role, setRole, view, setView, resourceList, hubElement, tabButtons, editingProfile, setEditingProfile, addingActivity, setAddingActivity, addingResource, setAddingResource, content, setContent, progressDay, setProgressDay, progressStatus, setProgressStatus, outputId, setOutputId, entryId, activityDraftId, focused, setFocused, progressDetails, setProgressDetails, progressOptions, progressDateChosen, editorPosition, scope, links, visible, searched, selectedResource, selectedLink, recent, tasks, directMeetings, chooseFolder, openFolder, unlinkFolder, changeTab, progressAction, progressInput, toggleFocus, disabled, attach, saveProfile, saveActivity, saveProgress, toggleArchive, linkExistingActivity, reuseResource, openSelected, relocateSelected, unlinkSelected, recordResource, recordActivity };
}
export type ProjectWorkspace = ReturnType<typeof useProjectWorkspace>;
