import { useMemo, useState } from "react";
import { renderMarkdown } from "./markdown";

type MarkdownFieldProps = {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
};

export function MarkdownField({ label, hint, value, onChange, placeholder }: MarkdownFieldProps) {
  // 默认预览：让 AI 生成的加粗/列表/标题直接可见（用户之前抱怨裸字符）
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const html = useMemo(() => renderMarkdown(value), [value]);
  return (
    <div className="editor-field markdown-field">
      <div className="editor-field-head">
        <div>
          <h3>{label}</h3>
          <small>{hint}</small>
        </div>
        <div className="md-toggle" role="group" aria-label="编辑或预览">
          <button
            type="button"
            className={mode === "edit" ? "active" : ""}
            onClick={() => setMode("edit")}
          >
            编辑
          </button>
          <button
            type="button"
            className={mode === "preview" ? "active" : ""}
            onClick={() => setMode("preview")}
          >
            预览
          </button>
        </div>
      </div>
      {mode === "edit" ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
        />
      ) : value.trim() ? (
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div className="tab-panel-empty">{placeholder}</div>
      )}
    </div>
  );
}
