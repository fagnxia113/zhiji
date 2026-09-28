import { CheckCircle2, FileText, Mic, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Meeting, Task, Workspace } from "../../types";

type SearchResult =
  | { kind: "meeting"; meeting: Meeting; title: string; snippet: string }
  | { kind: "task"; task: Task; title: string; snippet: string };

/** 可搜索字段（含匹配优先级：标题 > 纪要/笔记/会前背景 > 转写）。 */
const MEETING_FIELDS: { key: "title" | "minutes" | "notes" | "context" | "transcript" | "decisions"; label: string }[] = [
  { key: "title", label: "标题" },
  { key: "minutes", label: "纪要" },
  { key: "decisions", label: "决策" },
  { key: "notes", label: "笔记" },
  { key: "context", label: "会前背景" },
  { key: "transcript", label: "转写" },
];

// 全局只有一处搜索框，用固定 id 让 aria-controls / aria-activedescendant 与测试都可直接引用。
const LIST_ID = "global-search-listbox";
const optionId = (index: number) => `global-search-option-${index}`;

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

/** 结果计算：拆出来单独用，方便搜索框与结果列表共用同一份排序。 */
export function useGlobalSearch(query: string, workspace: Workspace) {
  return useMemo(() => {
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
      .filter((task) => tokens.every((token) => `${task.title} ${task.owner ?? ""}`.toLocaleLowerCase().includes(token)))
      .slice(0, 4)
      .map((task) => ({
        kind: "task",
        task,
        title: task.title,
        snippet: task.completed ? "已完成待办" : task.dueDate ? `截止 ${task.dueDate}` : "待完成事项",
      }));

    return { list: [...meetingResults, ...taskResults], total: meetingResults.length + taskResults.length };
  }, [query, workspace]);
}

function resultKey(result: SearchResult) {
  return `${result.kind}-${result.kind === "meeting" ? result.meeting.id : result.task.id}`;
}

/** 结果列表：listbox/option 语义，高亮项由搜索框的方向键驱动（aria-activedescendant）。 */
function GlobalSearchResults({ results, query, activeIndex, onHover, onOpen }: {
  results: { list: SearchResult[]; total: number };
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onOpen: (result: SearchResult) => void;
}) {
  return (
    <div className="global-search-results">
      <div className="global-search-summary">
        <Search size={14} />
        显示 {results.total} 项相关内容（最多 10 项）
      </div>
      {results.list.length ? (
        <ul className="global-search-list" id={LIST_ID} role="listbox" aria-label="全局搜索结果">
          {results.list.map((result, index) => (
            <li
              key={resultKey(result)}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className="global-search-result"
              onMouseMove={() => onHover(index)}
              // 按下时不让输入框失焦，保证光标与方向键导航连续
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onOpen(result)}
            >
              <span className={`round-icon ${result.kind === "meeting" ? "brand" : "purple"}`}>
                {result.kind === "meeting" ? (
                  result.meeting.audioPath ? <Mic size={15} /> : <FileText size={15} />
                ) : (
                  <CheckCircle2 size={15} />
                )}
              </span>
              <span>
                <strong><Highlight text={result.title} query={query} /></strong>
                <small><Highlight text={result.snippet} query={query} /></small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="global-search-empty">没有找到相关会议、笔记或待办</div>
      )}
    </div>
  );
}

/**
 * 全局搜索框：自己持有查询状态与结果面板。
 * 采用 ARIA combobox + listbox 模式（输入框保持焦点，方向键移动高亮、Enter 打开），
 * 并在点击面板外部时收起，避免结果面板一直挂在界面上。
 */
export function GlobalSearchBox({ workspace, onOpenMeeting, onOpenTasks, inputRef }: {
  workspace: Workspace;
  onOpenMeeting: (meeting: Meeting) => void;
  onOpenTasks: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  // 输入保持即时响应，重排/过滤走延迟值，避免长会议列表打字卡顿
  const deferredQuery = useDeferredValue(query);
  const results = useGlobalSearch(deferredQuery, workspace);
  const list = results?.list ?? [];
  const showResults = open && query.trim().length > 0 && results !== null;

  useEffect(() => { setActiveIndex(-1); }, [deferredQuery]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const dismiss = () => { setQuery(""); setOpen(false); setActiveIndex(-1); };

  const openResult = (result: SearchResult) => {
    if (result.kind === "meeting") onOpenMeeting(result.meeting);
    else onOpenTasks();
    dismiss();
  };

  const move = (delta: number) => {
    if (!list.length) return;
    setOpen(true);
    setActiveIndex((current) => {
      const next = current + delta;
      if (next < 0) return list.length - 1;
      if (next >= list.length) return 0;
      return next;
    });
  };

  return (
    <div className="header-search" ref={boxRef}>
      <label className="search-box">
        <Search size={17} />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="搜索会议、笔记与待办"
          aria-expanded={showResults}
          aria-controls={showResults ? LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showResults && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          value={query}
          placeholder="搜索会议、笔记与待办"
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
            if (event.key === "Enter") {
              event.preventDefault();
              const target = list[activeIndex];
              if (target) openResult(target);
              return;
            }
            if (event.key === "Escape") dismiss();
          }}
        />
        {!query && <kbd>Ctrl F</kbd>}
      </label>
      {showResults && results && (
        <GlobalSearchResults
          results={results}
          query={query.trim()}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onOpen={openResult}
        />
      )}
    </div>
  );
}
