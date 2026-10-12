import { createPortal } from "react-dom";
import { Dialog } from "./ui";
import { tabs, type HubTab, type ProjectWorkspaceProps } from "./projects/model";
import { useProjectWorkspace } from "./projects/useProjectWorkspace";
import { ProjectSettings } from "./projects/ProjectSettings";
import { ProjectActivities } from "./projects/ProjectActivities";
import { ProjectResources } from "./projects/ProjectResources";
import { ProjectProgress } from "./projects/ProjectProgress";
import { ProjectProgressHistory } from "./projects/ProjectProgressHistory";
import { ProjectThemes } from "./projects/ProjectThemes";

export function ProjectHub(props: ProjectWorkspaceProps) {
  const model = useProjectWorkspace(props);
  const { project, loading, busy, error, notice, catalogLoading, catalogError, loadCatalog, retry, cacheError, view, hubElement, tabButtons, focused, selectedResource, changeTab, toggleFocus } = model;
  return <section ref={hubElement} className="project-hub" aria-label="项目详情">
    <header><h2>{project.name}</h2><span>{project.archived ? "已归档" : "进行中"}</span></header>
    <ProjectThemes project={project} />
    <ProjectSettings model={model} />
    {error && <div className="qa-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void retry()}>重新读取</button></div>}
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
    <div role="tabpanel" id={`project-${project.id}-panel-activities`} aria-labelledby={`project-${project.id}-tab-activities`} hidden={view.tab !== "activities"}><ProjectActivities model={model} /></div>
    <div className={`hub-resources-panel ${selectedResource ? "has-selection" : ""}`} role="tabpanel" id={`project-${project.id}-panel-resources`} aria-labelledby={`project-${project.id}-tab-resources`} hidden={view.tab !== "resources"}><ProjectResources model={model} /></div>
    <div role="tabpanel" id={`project-${project.id}-panel-progress`} aria-labelledby={`project-${project.id}-tab-progress`} hidden={view.tab !== "progress"}>
      <section className="project-current-state" aria-label="项目目前进展"><small>{model.recent[0] ? `最近确认 · ${model.recent[0].occurredOn}` : "目前进展"}</small><h3>{model.recent[0]?.content || "尚未记录实际进展"}</h3>{model.hub.profiles[0]?.goal && <p>目标：{model.hub.profiles[0].goal}</p>}{model.hub.profiles[0]?.stage && <p>阶段：{model.hub.profiles[0].stage}</p>}{model.tasks.length > 0 && <div className="project-next-actions"><small>待跟进</small>{model.tasks.slice(0,3).map(task => <p key={task.id}>{task.title}{task.owner ? ` · ${task.owner}` : ""}{task.dueDate ? ` · ${task.dueDate}` : ""}</p>)}</div>}</section>
      {!focused && <ProjectProgress model={model} />}
      <div hidden={focused}><ProjectProgressHistory model={model} /></div>
    </div>
    {focused && createPortal(<Dialog ariaLabel="专注记录项目进展" className="progress-focus" onClose={toggleFocus} closeOnBackdrop={false}>
      <p className="progress-focus-project">{project.name}</p>
      {error && <div className="qa-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void retry()}>重新读取</button></div>}
      {notice && <p role="status">{notice}</p>}
      {cacheError && <p className="qa-error" role="alert">{cacheError}</p>}
      <ProjectProgress model={model} />
    </Dialog>, document.body)}
  </section>;
}
