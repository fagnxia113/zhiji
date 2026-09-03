import { AlertTriangle, Check, ClipboardList, FileText, Sparkles, Target } from "lucide-react";
import type { AnalysisPreview, Meeting, MeetingTemplate } from "../../types";
import { Dialog } from "../ui/Dialog";

const TEMPLATES: { id: MeetingTemplate; label: string; description: string }[] = [
  { id: "general", label: "通用会议", description: "议题、结论、决策与下一步" },
  { id: "weekly", label: "团队周会", description: "进展、阻塞和下周计划" },
  { id: "project", label: "项目推进", description: "里程碑、风险、依赖与负责人" },
  { id: "decision", label: "决策评审", description: "方案、分歧、取舍和最终决定" },
  { id: "interview", label: "访谈调研", description: "观点、痛点、需求与原话证据" },
  { id: "review", label: "复盘总结", description: "结果、根因和改进措施" },
];

function timeLabel(timeMs: number) {
  const seconds = Math.max(0, Math.floor(timeMs / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function GenerationModal({
  meeting,
  template,
  preview,
  onTemplateChange,
  onGenerate,
  onApply,
  onClose,
}: {
  meeting: Meeting;
  template: MeetingTemplate;
  preview: AnalysisPreview | null;
  onTemplateChange: (template: MeetingTemplate) => void;
  onGenerate: () => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const replacing = Boolean(meeting.minutes.trim() || meeting.decisions.trim());
  return (
    <Dialog onClose={onClose} className="generation-modal" ariaLabel="生成会议纪要">
      <div className="generation-head">
        <span className="round-icon accent"><Sparkles size={20} /></span>
        <div><small>智能整理</small><h2>{preview ? "确认生成结果" : "选择纪要模板"}</h2></div>
      </div>
      {!preview ? (
        <>
          <p className="generation-intro">模板只影响内容结构，不会改变原始转写和你的个人笔记。</p>
          <div className="generation-templates">
            {TEMPLATES.map((item) => (
              <button
                key={item.id}
                className={template === item.id ? "selected" : ""}
                onClick={() => onTemplateChange(item.id)}
              >
                <span>{item.id === "decision" ? <Target size={17} /> : item.id === "interview" ? <FileText size={17} /> : <ClipboardList size={17} />}</span>
                <div><strong>{item.label}</strong><small>{item.description}</small></div>
                {template === item.id && <Check size={16} />}
              </button>
            ))}
          </div>
          {replacing && (
            <div className="generation-warning"><AlertTriangle size={16} /><span>当前已有纪要内容。先生成预览，只有确认采用后才会替换；原始转写、个人笔记和手工待办不会被覆盖。</span></div>
          )}
        </>
      ) : (
        <div className="generation-preview">
          <section><h3>智能纪要</h3><div className="generation-preview-text">{preview.minutes}</div></section>
          <section><h3>决策与共识</h3><div className="generation-preview-text compact">{preview.decisions || "没有提取到明确决策"}</div></section>
          <section>
            <h3>行动项（{preview.actionItems.length}）</h3>
            {preview.actionItems.length ? preview.actionItems.map((item, index) => (
              <div className="generation-action" key={`${item.title}-${index}`}>
                <span>{item.assignee || "待确认"}</span><strong>{item.title}</strong><small>{item.dueDate || "未明确日期"}</small>
              </div>
            )) : <div className="generation-empty">没有发现明确的行动项</div>}
          </section>
          {preview.sourceHighlights.length > 0 && (
            <section><h3>录音来源（{preview.sourceHighlights.length}）</h3>{preview.sourceHighlights.slice(0, 6).map((source, index) => (
              <div className="generation-source" key={`${source.timeMs}-${index}`}><span>{timeLabel(source.timeMs)}</span><div><strong>{source.label}</strong><small>{source.quote}</small></div></div>
            ))}</section>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="secondary-button" onClick={onClose}>取消</button>
        {preview ? (
          <><button className="secondary-button" onClick={onGenerate}>重新生成</button><button className="primary-button" onClick={onApply}>确认采用</button></>
        ) : (
          <button className="primary-button" onClick={onGenerate}><Sparkles size={15} />生成预览</button>
        )}
      </div>
    </Dialog>
  );
}
