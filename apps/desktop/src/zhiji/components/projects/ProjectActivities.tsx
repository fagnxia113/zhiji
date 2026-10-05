import type { ProjectWorkspace } from "./useProjectWorkspace";
import { activityKinds } from "./model";

export function ProjectActivities({ model }: { model: ProjectWorkspace }) {
  const { workspace, onMeeting, hub, catalog, ready, catalogReady, catalogLoading, loadCatalog, cacheError, title, setTitle, kind, setKind, activityDay, setActivityDay, meetingId, setMeetingId, existingActivity, setExistingActivity, view, setView, addingActivity, setAddingActivity, disabled, saveActivity, linkExistingActivity, recordActivity } = model;
  return (<><h3>项目活动 · {hub.activities.length}</h3>
    <details className="hub-add" open={addingActivity} onToggle={e => { setAddingActivity(e.currentTarget.open); if (view.tab === "activities" && e.currentTarget.open && !catalogReady) void loadCatalog(); }}><summary>添加活动</summary>
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

      <div className="hub-activity-list">{hub.activities.map(a => <article key={a.id}><strong>{a.title}</strong><small>{activityKinds[a.kind] || a.kind} · {a.occurredOn}</small><div className="hub-actions"><button className="secondary-button compact-button" disabled={disabled} onClick={() => setView(v => ({ ...v, tab: "resources", fileActivityId: a.id, fileQuery: "", resourceId: "", listScroll: "0" }))}>查看活动资料</button><button className="ghost-button" disabled={disabled} onClick={() => recordActivity(a.id)}>记录活动进展</button>{a.meetingId && <button className="ghost-button" onClick={() => onMeeting?.(a.meetingId!)}>打开会议记录</button>}</div></article>)}</div>
      {ready && !hub.activities.length && <p className="journal-empty">还没有活动，可先登记会议、调研或评审。</p>}</>);
}
