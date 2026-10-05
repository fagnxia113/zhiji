import type { ProjectWorkspace } from "./useProjectWorkspace";
import { statuses } from "../../workbench";
import { localDateKey } from "../../workflow";

export function ProjectProgress({ model }: { model: ProjectWorkspace }) {
  const { hub, error, setError, cacheError, activityId, setActivityId, content, setContent, progressDay, setProgressDay, progressStatus, setProgressStatus, outputId, setOutputId, focused, progressDetails, setProgressDetails, progressOptions, progressDateChosen, visible, progressInput, toggleFocus, disabled, saveProgress } = model;
  return (<form className="hub-progress" onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing && !disabled && content.trim()) { e.preventDefault(); e.currentTarget.requestSubmit(); } }} onSubmit={e => { e.preventDefault(); void saveProgress(); }}>
      <div className="hub-section-heading"><h3>记录本次进展</h3><button type="button" className="ghost-button" onClick={toggleFocus}>{focused ? "退出专注" : "专注录入"}</button></div><textarea ref={progressInput} aria-label="项目进展内容" placeholder="实际推进了什么？形成什么产出？还在等待什么？" required maxLength={20000} rows={3} value={content} disabled={disabled} onChange={e => { if (!content.trim() && e.target.value.trim() && !progressDateChosen.current) setProgressDay(localDateKey(new Date())); setContent(e.target.value); }} />
      <div className="capture-quick-actions"><span className="hub-progress-context">{progressDay} · {statuses[progressStatus]}{activityId && ` · ${hub.activities.find(a => a.id === activityId)?.title || "活动来源待核对"}`}{outputId && ` · ${hub.resources.find(r => r.id === outputId)?.title || "资料来源待核对"}`}</span><button className="primary-button compact-button" disabled={disabled || !content.trim()}>保存本次进展</button></div>
      <details ref={progressOptions} className="capture-options" open={progressDetails} onToggle={e => setProgressDetails(e.currentTarget.open)}><summary>补充日期、状态与来源</summary>
      <div className="capture-fields form-grid">
        <label>进展日期<input aria-label="进展日期" type="date" required value={progressDay} disabled={disabled} onInvalid={e => { e.preventDefault(); if (progressOptions.current) progressOptions.current.open = true; setProgressDetails(true); setError("请补充有效的进展日期，草稿内容已保留。"); }} onChange={e => { progressDateChosen.current = true; setProgressDay(e.target.value); if (e.target.value && error === "请补充有效的进展日期，草稿内容已保留。") setError(""); }} /></label>
        <label>进展状态<select aria-label="进展状态" value={progressStatus} disabled={disabled} onChange={e=>setProgressStatus(e.target.value)}>{Object.entries(statuses).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label>关联活动（可选）<select aria-label="当前活动" value={activityId} disabled={disabled} onChange={e => { setActivityId(e.target.value); setOutputId(""); }}><option value="">不关联活动</option>{hub.activities.map(a => <option key={a.id} value={a.id}>{a.occurredOn} · {a.title}</option>)}</select></label>
        <label>关联资料（可选）<select aria-label="进展关联资料" value={outputId} disabled={disabled} onChange={e=>setOutputId(e.target.value)}><option value="">无关联资料</option>{visible.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select></label>
      </div>
      </details>
      <p className="capture-hint">{cacheError ? "草稿缓存异常，请先保存。" : content.trim() ? "草稿已保留 · Ctrl+Enter 保存后进入周报" : "写一句话即可，Ctrl+Enter 保存。"}</p>
    </form>);
}
