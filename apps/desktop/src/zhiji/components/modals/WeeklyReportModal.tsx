import { invoke } from "@tauri-apps/api/core";
import { CalendarRange, Copy, LoaderCircle, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { renderMarkdown } from "../fields/markdown";
import { Dialog } from "../ui/Dialog";

// 本地日期的 YYYY-MM-DD（不用 toISOString，避免时区把日期推回前一天）
function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// 默认取本周一
function defaultWeekStart(): string {
  const today = new Date();
  const day = today.getDay();
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + offset);
  return localDateValue(monday);
}

type WeeklyReportModalProps = {
  onClose: () => void;
};

// 周报汇总：选一周（默认本周），AI 汇总该周所有会议的纪要/决策/待办生成 Markdown 周报，一键复制。
export function WeeklyReportModal({ onClose }: WeeklyReportModalProps) {
  const [weekStart, setWeekStart] = useState(defaultWeekStart);
  const [report, setReport] = useState("");
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const html = useMemo(() => renderMarkdown(report), [report]);

  const generate = async () => {
    setGenerating(true);
    setError("");
    setCopied(false);
    try {
      const result = await invoke<string>("generate_weekly_report", { weekStart });
      setReport(result);
    } catch (cause) {
      setError(String(cause));
      setReport("");
    } finally {
      setGenerating(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (cause) {
      setError(`复制失败：${String(cause)}`);
    }
  };

  return (
    <Dialog onClose={onClose} ariaLabel="生成周报" className="weekly-report-modal">
      <div className="modal-head">
        <div>
          <h2>
            <CalendarRange size={18} />生成周报
          </h2>
          <small>汇总所选一周的全部会议，生成可复制的 Markdown 周报</small>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="关闭">
          <X size={16} />
        </button>
      </div>
      <div className="weekly-controls">
        <label>
          周起始日（周一）
          <input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} disabled={generating} />
        </label>
        <button className="primary-button compact-button" onClick={() => void generate()} disabled={generating || !weekStart}>
          {generating ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}
          {generating ? "正在汇总" : report ? "重新生成" : "生成周报"}
        </button>
      </div>
      {error && <div className="qa-error">{error}</div>}
      {report && (
        <>
          <div className="weekly-result markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
          <div className="weekly-actions">
            <button className="secondary-button compact-button" onClick={() => void copy()}>
              <Copy size={14} />{copied ? "已复制" : "复制 Markdown"}
            </button>
          </div>
        </>
      )}
      {!report && !error && !generating && (
        <div className="tab-panel-empty">选择一周起始日后点击「生成周报」，该周有纪要或转写内容的会议会被汇总。</div>
      )}
    </Dialog>
  );
}
