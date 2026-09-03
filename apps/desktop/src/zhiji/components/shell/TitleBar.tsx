import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, Minimize2, X } from "lucide-react";

export function TitleBar() {
  const appWindow = getCurrentWindow();
  return (
    <div className="title-bar" data-tauri-drag-region>
      <span data-tauri-drag-region>知记 · 本地资料库</span>
      <div className="window-controls" data-tauri-drag-region="false">
        <button onClick={() => void appWindow.minimize()} title="最小化">
          <Minimize2 size={15} />
        </button>
        <button onClick={() => void appWindow.toggleMaximize()} title="最大化">
          <Maximize2 size={14} />
        </button>
        <button
          className="close-window"
          onClick={() => void appWindow.close()}
          title="关闭"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
