import type { ProjectWorkspace } from "./useProjectWorkspace";
import { ProjectProgressHistory } from "./ProjectProgressHistory";

export function ProjectOverview({ model }: { model: ProjectWorkspace }) {
  const { project, onMeeting, hub, ready, cacheError, goal, stage, profileDirty, setGoal, setStage, editingProfile, setEditingProfile, content, tasks, progressAction, disabled, saveProfile, toggleArchive } = model;
  return (<><div className="hub-section-heading"><h3>继续推进这个项目</h3><button className="primary-button compact-button" disabled={disabled} onClick={progressAction}>{content.trim() ? "继续进展草稿" : "记录进展"}</button></div>
      {content.trim() && <p className="hub-draft-preview">未提交的进展：{content}</p>}
      {ready && <div className="hub-overview">{hub.profiles[0]?.goal && <p>{hub.profiles[0].goal}</p>}<small>{hub.profiles[0]?.stage && `${hub.profiles[0].stage} · `}{hub.activities.length} 次活动 · {hub.resources.length} 份资料</small></div>}


      <div className="hub-overview-grid"><section className="hub-current-tasks" aria-label="项目当前行动"><h3>当前行动</h3>{tasks.slice(0, 5).map(task => <article key={task.id}><strong>{task.title}</strong><small>{task.dueDate ? `截止：${task.dueDate}` : "未设截止日期"}{task.owner ? ` · ${task.owner}` : ""}</small>{task.sourceType === "meeting" && task.sourceId && <button className="ghost-button" onClick={() => onMeeting?.(task.sourceId!)}>查看来源会议</button>}</article>)}{!tasks.length && <p className="capture-hint">暂无关联的未完成待办；可在工作记录中关联已有待办。</p>}{tasks.length > 5 && <p className="capture-hint">另有 {tasks.length - 5} 项行动，可在待办页查看。</p>}</section>
      <ProjectProgressHistory model={model} limit={3} /></div>
    <details className="hub-add" open={editingProfile} onToggle={e => setEditingProfile(e.currentTarget.open)}><summary>项目设置</summary>
    <form className="hub-profile" onSubmit={e => { e.preventDefault(); void saveProfile(); }}>
      <label>项目目标<textarea aria-label="项目目标" value={goal} onChange={e => { profileDirty.current = true; setGoal(e.target.value); }} maxLength={2000} rows={2} disabled={disabled} /></label>
      <label>当前阶段<input aria-label="项目阶段" value={stage} onChange={e => { profileDirty.current = true; setStage(e.target.value); }} maxLength={100} disabled={disabled} placeholder="例如：初稿评审，等待数据补充" /></label>
      <button className="secondary-button compact-button" disabled={disabled}>保存目标与阶段</button>
      <small className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : "填写内容会保留为本机草稿，点击保存后更新项目。"}</small>
      <button type="button" className="ghost-button" disabled={disabled} onClick={() => void toggleArchive()}>{project.archived ? "恢复项目" : "归档项目"}</button>
    </form>
    </details>
</>);
}
