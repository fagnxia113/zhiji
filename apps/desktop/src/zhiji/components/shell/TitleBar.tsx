import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, X } from "lucide-react";
import { useState } from "react";

export function TitleBar() {
  const appWindow = getCurrentWindow();
  const [error, setError] = useState("");
  const run = async (action: () => Promise<void>) => {
    setError("");
    try { await action(); } catch (cause) { setError(`窗口操作失败：${String(cause)}`); }
  };
  return (
    <div className="title-bar" data-tauri-drag-region>
      <span data-tauri-drag-region>知记 · 本地资料库</span>
      {error && <span className="window-error" role="alert">{error}</span>}
      <div className="window-controls">
        <button onClick={() => void run(() => appWindow.minimize())} title="最小化" aria-label="最小化">
          <Minimize2 size={15} />
        </button>
        <button onClick={() => void run(() => appWindow.toggleMaximize())} title="最大化或还原" aria-label="最大化或还原">
          <Maximize2 size={14} />
        </button>
        <button
          className="close-window"
          onClick={() => void run(() => appWindow.close())}
          title="关闭窗口，收起到系统托盘"
          aria-label="关闭并收起到托盘"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
