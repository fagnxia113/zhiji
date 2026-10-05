import { focusListItem } from "../ui/keyboardNavigation";
import { File, FolderOpen, Plus, Search } from "lucide-react";
import type { ProjectWorkspace } from "./useProjectWorkspace";
import { roles } from "./model";

export function ProjectResources({ model }: { model: ProjectWorkspace }) {
  const { hub, catalog, ready, catalogReady, catalogLoading, loadCatalog, resourceId, setResourceId, role, setRole, view, setView, resourceList, addingResource, setAddingResource, links, searched, selectedResource, selectedLink, disabled, attach, reuseResource, openSelected, relocateSelected, unlinkSelected, recordResource } = model;
  const clearSelection = () => {
    const index = searched.findIndex(r => r.id === selectedResource?.id);
    setView(v => ({ ...v, resourceId: "" }));
    requestAnimationFrame(() => resourceList.current?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus({ preventScroll: true }));
  };
  return <>
    <div className="hub-resource-toolbar">
      <div className="hub-section-heading">
        <h3>项目资料 <small>{searched.length} 份</small></h3>
        <button className="primary-button compact-button" disabled={disabled} onClick={() => void attach()}><Plus size={14} />添加资料</button>
      </div>
      <div className="hub-resource-filters">
        <label className="hub-file-search"><Search size={15} aria-hidden="true" /><input aria-label="搜索项目资料" placeholder="查找文件名或路径" value={view.fileQuery} onChange={e => setView(v => ({ ...v, fileQuery: e.target.value, resourceId: "", listScroll: "0" }))} /></label>
        <select aria-label="资料所属活动" value={view.fileActivityId} disabled={disabled} onChange={e => setView(v => ({ ...v, fileActivityId: e.target.value, resourceId: "", listScroll: "0" }))}>
          <option value="">项目全部资料</option>{hub.activities.map(a => <option key={a.id} value={a.id}>{a.occurredOn} · {a.title}</option>)}
        </select>
      </div>
    </div>
    <div className={`hub-file-browser ${selectedResource ? "has-selection" : ""}`}>
      <div className="hub-file-list" ref={resourceList} onScroll={e => {
        if (!e.currentTarget.clientHeight) return;
        const top = String(e.currentTarget.scrollTop);
        setView(v => v.listScroll === top ? v : { ...v, listScroll: top });
      }} onKeyDown={focusListItem}>
        <ul className="hub-resources" aria-label="项目资料列表">{searched.map(r => {
          const link = links.find(l => l.resourceId === r.id);
          return <li key={r.id}><button className="hub-file-choice" aria-pressed={selectedResource?.id === r.id} onClick={() => setView(v => ({ ...v, resourceId: r.id, listScroll: String(resourceList.current?.scrollTop || 0) }))}>
            <File size={19} aria-hidden="true" /><span><strong>{r.title}</strong><small>{link ? roles[link.role] : "来自项目活动"} · 仅登记文件</small></span>
          </button></li>;
        })}</ul>
        {ready && !searched.length && <p className="journal-empty">{view.fileQuery ? "未找到匹配文件，可调整关键词；文件正文尚未索引。" : "尚未关联资料，可选择文件或复用已登记资料。"}</p>}
      </div>
      <section className="hub-file-detail" aria-label="资料详情">
        {selectedResource ? <>
          <button className="ghost-button hub-file-back" onClick={clearSelection}>返回资料列表</button>
          <h3>{selectedResource.title}</h3>
          <p className="capture-hint">仅登记文件 · 正文尚未索引，AI 尚不能读取这份文件的内容。</p>
          <div className="hub-actions hub-file-primary-actions">
            <button className="primary-button compact-button" disabled={disabled} onClick={() => void openSelected()}><FolderOpen size={14} />打开原文件</button>
            <button className="secondary-button compact-button" disabled={disabled} onClick={recordResource}>记录相关进展</button>
          </div>
          <dl><dt>文件位置</dt><dd className="hub-path">{selectedResource.path}</dd><dt>此处用途</dt><dd>{selectedLink ? roles[selectedLink.role] : "来自项目活动"}</dd><dt>关联活动</dt><dd>{hub.activities.filter(a => hub.resourceActivities.some(l => l.resourceId === selectedResource.id && l.activityId === a.id)).map(a => a.title).join("、") || "未关联活动"}</dd></dl>
          <div className="hub-actions hub-file-maintenance">
            <button className="ghost-button" disabled={disabled} onClick={() => void relocateSelected()}>重新定位</button>
            {selectedLink && <button className="ghost-button" disabled={disabled} onClick={() => { if (window.confirm("解除此处关联？原文件和其他关联将保留。")) void unlinkSelected(); }}>解除关联</button>}
          </div>
        </> : <div className="hub-file-placeholder"><FolderOpen size={28} aria-hidden="true" /><h3>选择一份资料</h3><p>查看关联活动，或用原软件打开文件。</p></div>}
      </section>
    </div>
    <details className="hub-add hub-resource-options" open={addingResource} onToggle={e => setAddingResource(e.currentTarget.open)}>
      <summary>资料选项与复用 · {roles[role]}</summary>
      <div className="capture-fields"><label>新资料用途<select aria-label="资料用途" value={role} disabled={disabled} onChange={e => setRole(e.target.value)}>{Object.entries(roles).map(([v, label]) => <option key={v} value={v}>{label}</option>)}</select></label></div>
      <details className="hub-add" onToggle={e => { if (e.currentTarget.open && !catalogReady) void loadCatalog(); }}>
        <summary>复用已登记资料</summary>
        <div className="capture-fields"><select aria-label="复用已登记资料" value={resourceId} disabled={disabled || catalogLoading || !catalogReady} onChange={e => setResourceId(e.target.value)}><option value="">{catalogLoading ? "正在读取…" : "选择已登记资料"}</option>{catalog.resources.map(r => <option key={r.id} value={r.id}>{r.title}</option>)}</select><button className="secondary-button compact-button" disabled={disabled || catalogLoading || !catalogReady || !resourceId} onClick={() => void reuseResource()}>添加关联</button></div>
      </details>
      <p className="capture-hint">资料继续由原软件编辑；这里只登记关联，数据库备份不包含原文件。</p>
    </details>
  </>;
}