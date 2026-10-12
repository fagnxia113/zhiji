import { useEffect, useRef } from "react";
import type { ProjectWorkspace } from "./useProjectWorkspace";
import { activityKinds } from "./model";

export function ProjectActivities({ model }: { model: ProjectWorkspace }) {
  const { workspace, onMeeting, meetingContent, hub, catalog, ready, catalogReady, catalogLoading, loadCatalog, cacheError, title, setTitle, kind, setKind, activityDay, setActivityDay, meetingId, setMeetingId, existingActivity, setExistingActivity, view, setView, addingActivity, setAddingActivity, disabled, saveActivity, linkExistingActivity, recordActivity } = model;
  const { directMeetings } = model;
  const meetingPanel = useRef<HTMLDivElement>(null);
  const meetingOpen = !!meetingContent;
  useEffect(() => {
    if (!meetingOpen) return;
    const frame = requestAnimationFrame(() => {
      meetingPanel.current?.focus({ preventScroll:true });
      meetingPanel.current?.scrollIntoView({ block:"start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [meetingOpen]);
  const events = [...hub.activities.map(a => ({ id: `activity:${a.id}`, title: a.title, day: a.occurredOn, kind: a.kind, meetingId: a.meetingId, activity: a })), ...directMeetings.map(m => ({ id: `meeting:${m.id}`, title: m.title, day: m.startedAt.slice(0,10), kind: "meeting", meetingId: m.id, activity: null }))].sort((a,b) => b.day.localeCompare(a.day) || a.id.localeCompare(b.id));
  return (<><h3>项目活动 · {hub.activities.length + directMeetings.length}</h3>
    <details className="hub-add" hidden={meetingOpen} open={addingActivity} onToggle={e => { setAddingActivity(e.currentTarget.open); if (view.tab === "activities" && e.currentTarget.open && !catalogReady) void loadCatalog(); }}><summary>添加活动</summary>
      <form className="capture-fields form-grid" onSubmit={e => { e.preventDefault(); void saveActivity(); }}>
        <label className="form-wide">活动名称<input aria-label="活动名称" placeholder="会议、调研或评审的名称" value={title} maxLength={200} required disabled={disabled} onChange={e => setTitle(e.target.value)} /></label>
        <label>活动类型<select aria-label="活动类型" value={kind} disabled={disabled} onChange={e => setKind(e.target.value)}>{Object.entries(activityKinds).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label>活动日期<input aria-label="活动日期" type="date" required value={activityDay} disabled={disabled} onChange={e => setActivityDay(e.target.value)} /></label>
        <label className="form-wide">关联已有会议（可选）<select aria-label="关联已有会议" value={meetingId} disabled={disabled || catalogLoading || !catalogReady} onChange={e => { setMeetingId(e.target.value); const m=workspace.meetings.find(m=>m.id===e.target.value); if(m) { setTitle(m.title); setActivityDay(m.startedAt.slice(0,10)); setKind("meeting"); } }}><option value="">不关联录音会议</option>{workspace.meetings.filter(m => !catalog.activities.some(a => a.meetingId === m.id)).map(m => <option key={m.id} value={m.id}>{m.title}</option>)}</select></label>
        <button className="primary-button compact-button" disabled={disabled || !title.trim()}>保存活动</button>
      </form>
      <div className="capture-fields"><label>复用其他项目的活动<select aria-label="复用现有活动" value={existingActivity} disabled={disabled || catalogLoading || !catalogReady} onChange={e => setExistingActivity(e.target.value)}><option value="">选择其他项目的活动</option>{catalog.activities.filter(a => !hub.activities.some(x => x.id === a.id)).map(a => <option key={a.id} value={a.id}>{a.title}</option>)}</select></label><button className="secondary-button compact-button" disabled={disabled || catalogLoading || !catalogReady || !existingActivity} onClick={() => void linkExistingActivity()}>关联现有活动</button></div>
      <p className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : "活动草稿会留在本机，切换项目后可继续填写。"}</p>
    </details>

      <div className="hub-activity-list" hidden={meetingOpen}>{events.map(e => <article key={e.id}><strong>{e.title}</strong><small>{activityKinds[e.kind] || e.kind} · {e.day}</small><div className="hub-actions">{e.activity && <><button className="secondary-button compact-button" disabled={disabled} onClick={() => setView(v => ({ ...v, tab: "resources", fileActivityId: e.activity!.id, fileQuery: "", resourceId: "", listScroll: "0" }))}>查看活动资料</button><button className="ghost-button" disabled={disabled} onClick={() => recordActivity(e.activity!.id)}>记录活动进展</button></>}{e.meetingId && <button className="ghost-button" onClick={() => onMeeting?.(e.meetingId!)}>查看纪要</button>}</div></article>)}</div>
      <div ref={meetingPanel} tabIndex={-1}>{meetingContent}</div>
      {!meetingOpen && ready && !hub.activities.length && !directMeetings.length && <p className="journal-empty">还没有活动，可在会议页关联此项目，或登记调研、评审。</p>}</>);
}
