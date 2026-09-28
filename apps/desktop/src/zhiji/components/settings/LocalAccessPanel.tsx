import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Copy, Plug, RefreshCw } from "lucide-react";
import { useWorkbench } from "../../workbench";
import { Tooltip } from "../ui";

type Access = { running: boolean; url?: string; allowCapture?: boolean; projectId?: string | null; mcpConfig?: object; calls?: { at: string; action: string; ok: boolean }[] };
export function LocalAccessPanel() {
  const { data } = useWorkbench();
  const [status, setStatus] = useState<Access>({ running: false });
  const [port, setPort] = useState(17643);
  const [projectId, setProjectId] = useState("");
  const [capture, setCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = async () => { try { setStatus(await invoke<Access>("local_api_status")); setError(""); } catch (cause) { setError(String(cause)); } };
  useEffect(() => { void refresh(); }, []);
  const toggle = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      if (status.running) { await invoke("stop_local_api"); setStatus({ running: false }); }
      else setStatus(await invoke<Access>("start_local_api", { port, allowCapture: capture, projectId: projectId || null }));
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setNotice("已复制，请仅粘贴到你信任的本机客户端"); } catch (cause) { setError(String(cause)); } };
  return <section className="local-access">
    <header><span className="journal-eyebrow">连接你的 AI 与自动化工具</span><h2><Plug size={21} />本地 API / MCP</h2><p>查询项目背景、检索工作资料，也可以让 AI 把完成的工作记回来。</p></header>
    <div className="access-card"><strong>{status.running ? "本地接入已开启" : "本地接入已关闭"}</strong><p>服务仅在知记运行期间可用；收起到托盘仍可调用。退出应用后关闭，重新开启会更换令牌。</p>
      {!status.running && <div className="capture-fields"><label>端口<input type="number" min={1024} max={65535} aria-label="接入端口" value={port} disabled={busy} onChange={e => setPort(Number(e.target.value))} /></label><label>资料范围<select aria-label="接入项目范围" value={projectId} disabled={busy} onChange={e => setProjectId(e.target.value)}><option value="">全部项目与未归属资料</option>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="capture-permission"><input type="checkbox" checked={capture} disabled={busy} onChange={e => setCapture(e.target.checked)} />允许新增工作记录</label></div>}
      {status.running && <p>{status.url} · {status.projectId ? data.projects.find(p => p.id === status.projectId)?.name || "指定项目" : "全部项目与未归属资料"} · {status.allowCapture ? "可查询、可新增记录" : "仅查询"}</p>}
      <button className={status.running ? "secondary-button" : "primary-button"} disabled={busy || !Number.isInteger(port) || port < 1024 || port > 65535} onClick={() => void toggle()}>{busy ? "处理中…" : status.running ? "停止接入" : "开启本地接入"}</button>
    </div>
    {error && <div className="qa-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
    {status.running && <>
      <div className="access-card"><h3>连接 AI 客户端</h3><p>复制配置到支持 stdio MCP 的本机客户端。配置包含当前令牌，请勿分享。接入本地资料后，客户端可能将查询结果发送给其模型服务。</p><button className="secondary-button compact-button" onClick={() => void copy(JSON.stringify(status.mcpConfig, null, 2))}><Copy size={14} />复制 MCP 配置</button><p className="capture-hint">纯云端客户端无法直接访问本机端口。停止或重新开启服务后需更新配置。</p></div>
      <div className="access-card"><h3>通过 API 调用</h3><pre>{`POST ${status.url}/v1/workbench/search_work\nAuthorization: Bearer <MCP 配置中的 ZHIJI_API_TOKEN>\nContent-Type: application/json\n\n{"query":"客户","projectId":"可选项目 ID"}`}</pre><p>读取：list_projects、search_work、get_project_context、list_followups、report_material。写入：capture_work（需开启）。API 与界面共用资料库；不会自动调用云模型。</p></div>
      <div className="access-card"><div className="journal-heading"><h3>最近调用</h3><Tooltip label="重新读取最近的调用记录"><button className="ghost-button icon-only" aria-label="刷新最近调用" onClick={() => void refresh()}><RefreshCw size={14} /></button></Tooltip></div>{status.calls?.length ? status.calls.slice().reverse().map((call, i) => <p key={i}>{new Date(call.at).toLocaleTimeString()} · {call.action} · {call.ok ? "成功" : "未完成"}</p>) : <p>尚无调用。这里只记录操作和结果，不记录正文或令牌。</p>}</div>
    </>}
  </section>;
}
