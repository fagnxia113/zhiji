import type { ProjectWorkspace } from "./useProjectWorkspace";
import { statuses } from "../../workbench";

export function ProjectProgressHistory({ model, limit }: { model: ProjectWorkspace; limit?: number }) {
  const { recent, changeTab } = model;
  return (<section className="project-recent" aria-label="项目最近进展"><h3>{limit ? "最近进展" : "进展记录"}</h3>
    {(limit ? recent.slice(0, limit) : recent).map(entry => <article key={entry.id}><small>{entry.occurredOn} · {statuses[entry.status] || entry.status}</small><p>{entry.content}</p></article>)}
    {!recent.length && <p>还没有进展记录。完成一项沟通或交付后，留下一句话即可。</p>}
    {limit && recent.length > limit && <button className="ghost-button" onClick={() => changeTab("progress")}>查看全部 {recent.length} 条进展</button>}
  </section>);
}
