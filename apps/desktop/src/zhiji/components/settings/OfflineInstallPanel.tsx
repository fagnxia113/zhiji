import { useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Copy,
  ExternalLink,
  FolderOpen,
  HardDriveDownload,
  RefreshCw,
} from "lucide-react";
import type { OfflineInstallItem, OfflineInstallManifest } from "../../types";

type Props = {
  manifest: OfflineInstallManifest;
  busy: boolean;
  onOpenFolder: (id: string) => void;
  onImport: (id: string, kind: string) => void;
  onRefresh: () => void;
  onCopy: (text: string) => void;
};

const WHEEL_HINT =
  "pip 离线加速：把 .whl 文件放进上面的 wheels 文件夹，安装说话人引擎时会优先使用本地包，缺的再联网补。";

export function OfflineInstallPanel({
  manifest,
  busy,
  onOpenFolder,
  onImport,
  onRefresh,
  onCopy,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const pending = manifest.items.filter((item) => !item.ready);

  return (
    <section className="settings-card ai-settings">
      <div>
        <h3>手动安装引擎</h3>
        <p>
          下载太慢或反复失败时，可以用浏览器或下载工具自行下载，再放入对应目录；放好后点「重新检测」即可生效，不需要重启知记。
        </p>
      </div>
      <span className={`ai-status ${pending.length === 0 ? "ready" : ""}`}>
        {pending.length === 0 ? "全部就绪" : `${pending.length} 项待安装`}
      </span>
      <div className="settings-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <CircleAlert size={16} /> : <HardDriveDownload size={16} />}
          {expanded ? "收起列表" : "查看手动安装方式"}
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshCw size={16} />
          重新检测
        </button>
      </div>
      {expanded && (
        <div className="offline-install-list">
          {manifest.items.map((item) => (
            <OfflineRow
              key={item.id}
              item={item}
              busy={busy}
              onOpenFolder={onOpenFolder}
              onImport={onImport}
              onCopy={onCopy}
            />
          ))}
          <div className="offline-install-row">
            <div className="offline-install-text">
              <strong>pip 离线包（wheels）</strong>
              <code>{manifest.wheelsDir}</code>
              <small>
                {WHEEL_HINT} 当前已放入 {manifest.wheelsCount} 个 .whl。
              </small>
            </div>
            <div className="settings-actions">
              <button
                className="secondary-button compact-button"
                disabled={busy}
                onClick={() => onOpenFolder("python-embed")}
              >
                <FolderOpen size={15} />
                打开所在目录
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function OfflineRow({
  item,
  busy,
  onOpenFolder,
  onImport,
  onCopy,
}: {
  item: OfflineInstallItem;
  busy: boolean;
  onOpenFolder: (id: string) => void;
  onImport: (id: string, kind: string) => void;
  onCopy: (text: string) => void;
}) {
  return (
    <div className="offline-install-row">
      <div className="offline-install-text">
        <strong>
          {item.label}
          {item.ready && <CheckCircle2 size={15} className="offline-ready-icon" />}
        </strong>
        <small>{item.note}</small>
        <code>{item.targetPath}</code>
        {item.urls.length > 0 && (
          <div className="offline-install-links">
            {item.urls.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                <ExternalLink size={13} />
                {shortLink(url)}
              </a>
            ))}
            <button
              type="button"
              className="offline-copy"
              disabled={busy}
              onClick={() => onCopy(item.urls.join("\n"))}
            >
              <Copy size={13} />
              复制链接
            </button>
          </div>
        )}
      </div>
      <div className="settings-actions">
        <button
          className="secondary-button compact-button"
          disabled={busy}
          onClick={() => onOpenFolder(item.id)}
        >
          <FolderOpen size={15} />
          打开目录
        </button>
        <button
          className="secondary-button compact-button"
          disabled={busy || item.ready}
          onClick={() => onImport(item.id, item.kind)}
        >
          <HardDriveDownload size={15} />
          {item.ready ? "已就绪" : item.kind === "directory" ? "选择文件夹导入…" : "选择文件导入…"}
        </button>
      </div>
    </div>
  );
}

function shortLink(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("modelscope.cn")) return "ModelScope 下载页";
    if (parsed.hostname.includes("hf-mirror.com") || parsed.hostname.includes("huggingface"))
      return "Hugging Face 镜像";
    if (parsed.hostname.includes("python.org")) return "Python 官网";
    return parsed.hostname;
  } catch {
    return url;
  }
}
