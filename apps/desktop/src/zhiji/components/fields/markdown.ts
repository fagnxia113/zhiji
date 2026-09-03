import { marked } from "marked";
import DOMPurify from "dompurify";

// 轻量去除 HTML 标签：智能纪要偶尔会带 <h2>/<p> 等标签，纯文本编辑器下直接剥掉，
// 避免 <h2>会议纪要</h2> 这类字面显示。不做任何渲染，符合「不硬支持 md/html」的取向。
export const stripHtml = (source: string): string => source.replace(/<[^>]+>/g, "");

// 仅渲染 Markdown；DOMPurify 兜底去除任何残留的 <script>/危险标签。
export function renderMarkdown(source: string): string {
  if (!source.trim()) return "";
  const raw = marked.parse(source, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw);
}
