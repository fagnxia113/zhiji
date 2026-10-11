import { useRef, useState } from "react";
import { useWorkbench, workbenchCall } from "../workbench";

export function MeetingProject({ meetingId, disabled, onProject }: { meetingId: string; disabled: boolean; onProject?: (id: string) => void }) {
  const { data, loading, error: readError, refresh } = useWorkbench();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const projectId = data.links[`meeting:${meetingId}`] || "";
  const project = data.projects.find(p => p.id === projectId);
  const assign = async (next: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    let saved = false;
    try {
      await workbenchCall("link_project", { entityType: "meeting", entityId: meetingId, projectId: next || null });
      saved = true;
      if (!await refresh()) throw Error("项目列表暂时无法读取");
    } catch (cause) { setError(saved ? `关联已保存，请重新读取。${String(cause)}` : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="meeting-project" aria-label="会议项目关联">
    <label>所属项目<select aria-label="会议所属项目" value={projectId} disabled={disabled || busy || loading || !!readError} onChange={e => void assign(e.target.value)}>
      <option value="">不关联项目</option>
      {data.projects.map(p => <option key={p.id} value={p.id}>{p.name}{p.archived ? "（已归档）" : ""}</option>)}
    </select></label>
    {project && onProject && <button className="ghost-button" disabled={disabled || busy} onClick={() => onProject(project.id)}>进入项目</button>}
    {(error || readError) && <span role="alert">{error || readError}<button className="ghost-button" disabled={busy} onClick={() => void refresh().then(ok => { if (ok) setError(""); })}>重新读取</button></span>}
  </div>;
}
