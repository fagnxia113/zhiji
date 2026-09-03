import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { Processing } from "../../types";
import { Dialog } from "../ui/Dialog";

type ProcessingDescription = {
  title: string;
  detail: string;
  keepOpen: boolean;
};

const PROCESSING_DETAILS: Record<Exclude<Processing, null>, ProcessingDescription> = {
  downloading: { title: "正在下载本地语音模型", detail: "首次下载文件较大，完成后可离线使用。", keepOpen: true },
  transcribing: { title: "正在生成完整原文", detail: "正在分析本地录音；原录音不会被修改。", keepOpen: true },
  analyzing: { title: "正在生成智能纪要", detail: "正在整理重点、决策和行动项；超长会议会自动分段处理，耗时稍长。", keepOpen: true },
  applyingAnalysis: { title: "正在保存智能纪要", detail: "正在写入你刚刚确认的版本。", keepOpen: true },
  regeneratingMinutes: { title: "正在重写智能纪要", detail: "决策和待办会保持不变。", keepOpen: true },
  regeneratingDecisions: { title: "正在重新提取决策", detail: "原文和纪要正文会保持不变。", keepOpen: true },
  regeneratingTasks: { title: "正在重新提取行动项", detail: "手工添加的待办不会被覆盖。", keepOpen: true },
  renaming: { title: "正在整理会议标题", detail: "会议内容和录音不会改变。", keepOpen: true },
  installingSpeaker: { title: "正在准备实时会议引擎", detail: "首次准备约需数分钟，具体时间取决于网络。", keepOpen: true },
  checkingLiveEngine: { title: "正在检查实时字幕", detail: "将验证流式识别、句末校正和热词能力。", keepOpen: true },
  speakerTranscribing: { title: "正在区分说话人并转写", detail: "正在使用高精度本地模型处理完整录音。", keepOpen: true },
  importing: { title: "正在导入录音", detail: "正在复制并读取录音信息。", keepOpen: true },
  deleting: { title: "正在删除会议", detail: "正在清理会议数据和受管理的录音文件。", keepOpen: true },
  autoTranscribing: { title: "录音已安全保存", detail: "正在后台生成完整原文并区分说话人。", keepOpen: true },
};

type ProgressModalProps = {
  stage: Exclude<Processing, null>;
  canCancel: boolean;
  onCancel: () => void;
};

function elapsedLabel(seconds: number) {
  if (seconds < 60) return `已处理 ${seconds} 秒`;
  return `已处理 ${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
}

export function ProgressModal({ stage, canCancel, onCancel }: ProgressModalProps) {
  const [elapsed, setElapsed] = useState(0);
  const [canceling, setCanceling] = useState(false);
  const detail = PROCESSING_DETAILS[stage];
  const cancelable = canCancel
    && (stage === "transcribing" || stage === "speakerTranscribing" || stage === "autoTranscribing");

  useEffect(() => {
    setElapsed(0);
    setCanceling(false);
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [stage]);

  return (
    <Dialog closeOnEsc={false} closeOnBackdrop={false} className="progress-modal" ariaLabel="处理中">
      <div className="progress-modal-body">
        <LoaderCircle size={26} className="spin" />
        <div>
          <h3>{canceling ? "正在安全停止" : detail.title}</h3>
          <p>{canceling ? "正在结束本地转写进程，已保存的录音不会丢失。" : detail.detail}</p>
        </div>
      </div>
      <div className="processing-runtime" aria-live="polite">
        <span>{elapsedLabel(elapsed)}</span>
        <small>{detail.keepOpen ? "处理完成前请保持知记打开" : "可以继续使用其他页面"}</small>
      </div>
      {cancelable && (
        <div className="modal-actions">
          <button
            className="secondary-button"
            disabled={canceling}
            onClick={() => {
              setCanceling(true);
              onCancel();
            }}
          >
            {canceling ? "正在取消…" : "取消转写"}
          </button>
        </div>
      )}
    </Dialog>
  );
}
