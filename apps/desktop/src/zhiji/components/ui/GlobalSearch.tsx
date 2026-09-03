import { CheckCircle2, FileText, Mic, Search } from "lucide-react";
import { useMemo } from "react";
import type { Meeting, Task, Workspace } from "../../types";

type SearchResult =
  | { kind: "meeting"; meeting: Meeting; title: string; snippet: string }
  | { kind: "task"; task: Task; title: string; snippet: string };

/** 可搜索字段（含匹配优先级：标题 > 纪要/笔记/会前背景 > 转写）。 */
const MEETING_FIELDS: { key: "title" | "minutes" | "notes" | "context" | "transcript"; label: string }[] = [
  { key: "title", label: "标题" },
  { key: "minutes", label: "纪要" },
  { key: "notes", label: "笔记" },
  { key: "context", label: "会前背景" },
  { key: "transcript", label: "转写" },
];

function plainText(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** 按空白拆词（AND 语义：每个词都需命中，支持多关键词精确过滤）。 */
function tokensOf(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 多词高亮：正则一次性把所有关键词包进 <mark>。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const words = tokensOf(query);
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
      )}
    </>
  );
}

/** 围绕首个命中词截取片段；无命中则从头截。 */
function excerptAround(text: string, tokens: string[], pad = 34) {
  const lower = text.toLocaleLowerCase();
  let first = -1;
  for (const token of tokens) {
    const at = lower.indexOf(token);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first < 0) return text.slice(0, 96);
  const start = Math.max(0, first - pad);
  const end = Math.min(text.length, first + 66);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** 会议是否命中：每个关键词都需在至少一个字段中出现（可分散在不同字段）。 */
function meetingMatches(meeting: Meeting, tokens: string[]) {
  const lowerByField = MEETING_FIELDS.map((field) => ({
    ...field,
    lower: plainText(meeting[field.key] ?? "").toLocaleLowerCase(),
  }));
  const allMatch = tokens.every((token) => lowerByField.some((field) => field.lower.includes(token)));
  if (!allMatch) return null;

  // 排名：标题命中词数越多越靠前（0 全中标题、1 部分中标题、2 仅正文）
  const titleHits = tokens.filter((token) => lowerByField[0].lower.includes(token)).length;
  const rank = titleHits === tokens.length ? 0 : titleHits > 0 ? 1 : 2;

  // 片段来源：优先取「首个命中词出现的非标题浓缩字段」；仅标题命中则显示会议日期上下文
  const source = lowerByField.find(
    (field, index) => index > 0 && tokens.some((token) => field.lower.includes(token)),
  );
  const snippet = source
    ? `${source.label} · ${excerptAround(plainText(meeting[source.key] ?? ""), tokens)}`
    : `会议标题命中（${meetingDateLabel(meeting.startedAt)}）`;

  return { rank, startedAt: meeting.startedAt, snippet };
}

/** 会议日期标签：YYYY-MM-DD（会议标题命中时的补充上下文）。 */
function meetingDateLabel(startedAt: string) {
  const date = startedAt.slice(0, 10);
  return date.replace(/-/g, "/");
}

export function GlobalSearch({
  query,
  workspace,
  onOpenMeeting,
  onOpenTasks,
  onClose,
}: {
  query: string;
  workspace: Workspace;
  onOpenMeeting: (meeting: Meeting) => void;
  onOpenTasks: () => void;
  onClose: () => void;
}) {
  const results = useMemo(() => {
    const tokens = tokensOf(query);
    if (!tokens.length) return null;

    const meetingResults: SearchResult[] = workspace.meetings
      .map((meeting) => ({ meeting, match: meetingMatches(meeting, tokens) }))
      .filter((entry): entry is { meeting: Meeting; match: NonNullable<ReturnType<typeof meetingMatches>> } =>
        entry.match !== null,
      )
      .sort(
        (a, b) =>
          a.match.rank - b.match.rank ||
          b.match.startedAt.localeCompare(a.match.startedAt),
      )
      .slice(0, 6)
      .map(({ meeting, match }) => ({
        kind: "meeting" as const,
        meeting,
        title: meeting.title,
        snippet: match.snippet,
      }));

    const taskResults: SearchResult[] = workspace.tasks
      .filter((task) => tokens.every((token) => task.title.toLocaleLowerCase().includes(token)))
      .slice(0, 4)
      .map((task) => ({
        kind: "task",
        task,
        title: task.title,
        snippet: task.completed ? "已完成待办" : task.dueDate ? `截止 ${task.dueDate}` : "待完成事项",
      }));

    return { list: [...meetingResults, ...taskResults], total: meetingResults.length + taskResults.length };
  }, [query, workspace]);

  if (!results) return null;

  return (
    <div className="global-search-results" role="listbox" aria-label="全局搜索结果">
      <div className="global-search-summary">
        <Search size={14} />
        找到 {results.total} 项相关内容
      </div>
      {results.list.length ? (
        results.list.map((result) => (
          <button
            type="button"
            className="global-search-result"
            key={`${result.kind}-${result.kind === "meeting" ? result.meeting.id : result.task.id}`}
            onClick={() => {
              if (result.kind === "meeting") onOpenMeeting(result.meeting);
              else onOpenTasks();
              onClose();
            }}
          >
            <span className={`round-icon ${result.kind === "meeting" ? "brand" : "purple"}`}>
              {result.kind === "meeting" ? (
                result.meeting.audioPath ? <Mic size={15} /> : <FileText size={15} />
              ) : (
                <CheckCircle2 size={15} />
              )}
            </span>
            <span>
              <strong><Highlight text={result.title} query={query.trim()} /></strong>
              <small><Highlight text={result.snippet} query={query.trim()} /></small>
            </span>
          </button>
        ))
      ) : (
        <div className="global-search-empty">没有找到相关会议、笔记或待办</div>
      )}
    </div>
  );
}
