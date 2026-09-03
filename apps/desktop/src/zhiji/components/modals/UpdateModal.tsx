import { Download, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";

type UpdateModalProps = {
  version: string;
  state: "available" | "downloading" | "error";
  progress: number;
  errorMessage: string;
  onInstall: () => void;
  onDismiss: () => void;
};

export function UpdateModal({
  version,
  state,
  progress,
  errorMessage,
  onInstall,
  onDismiss,
}: UpdateModalProps) {
  return (
    <Dialog onClose={onDismiss} className="update-modal">
      <div className="modal-head">
        <span className="round-icon accent">
          <Download size={19} />
        </span>
        <button className="icon-button" onClick={onDismiss} title="关闭">
          <X size={16} />
        </button>
      </div>
      <h2>{state === "error" ? "更新没有完成" : `发现新版本 ${version}`}</h2>
      <p>
        {state === "error"
          ? "安装包尚未应用，当前版本可以继续正常使用。你可以重试，或稍后手动检查更新。"
          : "将从 GitHub 下载更新并校验签名，安装完成后知记会自动重启。"}
      </p>
      {state === "downloading" ? (
        <div className="update-progress">
          <div className="progress-bar">
            <div style={{ width: `${progress}%` }} />
          </div>
          <small>正在下载并安装… {progress}%</small>
        </div>
      ) : (
        <div className="modal-actions">
          <button className="secondary-button" onClick={onDismiss}>
            稍后
          </button>
          <button className="primary-button" onClick={onInstall}>
            <Download size={16} />
            {state === "error" ? "重试更新" : "下载并安装"}
          </button>
        </div>
      )}
      {state === "error" && (
        <small className="runtime-warning">
          {errorMessage || "更新服务暂时不可用，请稍后重试。"}
        </small>
      )}
    </Dialog>
  );
}
