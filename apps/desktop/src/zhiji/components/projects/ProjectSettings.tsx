import type { ProjectWorkspace } from "./useProjectWorkspace";

export function ProjectSettings({ model }: { model: ProjectWorkspace }) {
  const { project, cacheError, goal, stage, profileDirty, setGoal, setStage, editingProfile, setEditingProfile, disabled, saveProfile, toggleArchive } = model;
  return (<>    <details className="hub-add" open={editingProfile} onToggle={e => setEditingProfile(e.currentTarget.open)}><summary>项目设置</summary>
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
