import { CheckCircle2, FileText, FolderOpen, Mic, NotebookPen, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Meeting, Task, Workspace } from "../../types";
import { statuses, useWorkbench, type Project, type WorkbenchData, type WorkEntry } from "../../workbench";

type SearchResult =
  | { kind: "project"; project: Project; title: string; snippet: string }
  | { kind: "entry"; entry: WorkEntry; title: string; snippet: string }
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
export function useGlobalSearch(query: string, workspace: Workspace, workbench: WorkbenchData) {
  return useMemo(() => {
    const tokens = tokensOf(query);
    if (!tokens.length) return null;

    const projectsById = new Map(workbench.projects.map(project => [project.id, project.name]));
    const projectName = (id: string | null) => id ? projectsById.get(id) || "未归属项目" : "未归属项目";
    const projectResults: SearchResult[] = workbench.projects
      .filter(project => tokens.every(token => project.name.toLocaleLowerCase().includes(token)))
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name, "zh-CN"))
      .map(project => ({ kind: "project", project, title: project.name, snippet: `项目 · ${project.archived ? "已归档" : "进行中"}` }));
    const entryResults: SearchResult[] = workbench.entries
      .filter(entry => tokens.every(token => `${entry.content} ${entry.sourceLabel || ""} ${projectName(entry.projectId)}`.toLocaleLowerCase().includes(token)))
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .map(entry => ({ kind: "entry", entry, title: excerptAround(entry.content.replace(/\s+/g, " ").trim(), tokens, 18), snippet: `工作记录 · ${entry.occurredOn} · ${projectName(entry.projectId)} · ${statuses[entry.status] || "已记录"}${entry.sourceLabel ? ` · ${entry.sourceLabel}` : ""}` }));
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
      .map(({ meeting, match }) => ({
        kind: "meeting" as const,
        meeting,
        title: meeting.title,
        snippet: `会议 · ${match.snippet}`,
      }));

    const taskResults: SearchResult[] = workspace.tasks
      .filter((task) => tokens.every((token) => `${task.title} ${task.owner ?? ""}`.toLocaleLowerCase().includes(token)))
      .map((task) => ({
        kind: "task",
        task,
        title: task.title,
        snippet: `待办 · ${task.completed ? "已完成" : task.dueDate ? `截止 ${task.dueDate}` : "待完成"}${task.owner ? ` · ${task.owner}` : ""}`,
      }));

    // Reserve results for each matching category so a long meeting list cannot
    // hide the project or record the user is looking for.
    const groups = [projectResults, entryResults, meetingResults, taskResults];
    const selected = groups.map(group => group.slice(0, 2));
    let remaining = 12 - selected.reduce((sum, group) => sum + group.length, 0);
    for (let index = 2; remaining > 0 && groups.some(group => group.length > index); index++) {
      groups.forEach((group, groupIndex) => { if (remaining && group[index]) { selected[groupIndex].push(group[index]); remaining--; } });
    }
    return { list: selected.flat(), total: groups.reduce((sum, group) => sum + group.length, 0) };
  }, [query, workspace, workbench]);
}

function resultKey(result: SearchResult) {
  return `${result.kind}-${result.kind === "meeting" ? result.meeting.id : result.kind === "task" ? result.task.id : result.kind === "project" ? result.project.id : result.entry.id}`;
}

/** 结果列表：listbox/option 语义，高亮项由搜索框的方向键驱动（aria-activedescendant）。 */
function GlobalSearchResults({ results, query, activeIndex, onHover, onOpen, loading, readError, onRetry }: {
  results: { list: SearchResult[]; total: number };
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onOpen: (result: SearchResult) => void;
  loading: boolean;
  readError: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="global-search-results">
      <div className="global-search-summary">
        <Search size={14} />
        {results.total > results.list.length ? `显示 ${results.list.length} 项，共 ${results.total} 项；补充关键词可缩小范围` : `${results.total} 项相关内容`}
      </div>
      {readError ? <div className="global-search-data-status" role="alert">项目与工作记录暂时无法读取<button className="ghost-button" disabled={loading} onClick={onRetry}>重试搜索数据</button></div> : loading && <p className="global-search-data-status" role="status">正在读取项目与工作记录…</p>}
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
                ) : result.kind === "project" ? <FolderOpen size={15} /> : result.kind === "entry" ? <NotebookPen size={15} /> : (
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
      {!results.list.length && !loading && !readError && <div className="global-search-empty">没有找到相关项目、工作记录、会议或待办</div>}
    </div>
  );
}

/**
 * 全局搜索框：自己持有查询状态与结果面板。
 * 采用 ARIA combobox + listbox 模式（输入框保持焦点，方向键移动高亮、Enter 打开），
 * 并在点击面板外部时收起，避免结果面板一直挂在界面上。
 */
export function GlobalSearchBox({ workspace, onOpenMeeting, onOpenTask, onOpenProject, onOpenEntry, inputRef }: {
  workspace: Workspace;
  onOpenMeeting: (meeting: Meeting) => void;
  onOpenTask: (task: Task) => void;
  onOpenProject: (id: string) => void;
  onOpenEntry: (id: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const { data, loading, error, refresh } = useWorkbench();
  // 输入保持即时响应，重排/过滤走延迟值，避免长会议列表打字卡顿
  const deferredQuery = useDeferredValue(query);
  const results = useGlobalSearch(deferredQuery, workspace, data);
  const list = results?.list ?? [];
  const queryReady = query === deferredQuery;
  const showResults = open && query.trim().length > 0 && queryReady && results !== null;
  const active = activeIndex < list.length ? activeIndex : -1;

  useEffect(() => { setActiveIndex(-1); }, [results]);
  useEffect(() => {
    if (showResults && active >= 0) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [showResults, active]);

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
    else if (result.kind === "task") onOpenTask(result.task);
    else if (result.kind === "project") onOpenProject(result.project.id);
    else onOpenEntry(result.entry.id);
    dismiss();
  };

  const move = (delta: number) => {
    if (!list.length || !queryReady) return;
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
          aria-label="搜索项目、记录、会议或待办"
          aria-expanded={showResults}
          aria-controls={showResults ? LIST_ID : undefined}
          aria-autocomplete="list"
          aria-activedescendant={showResults && active >= 0 ? optionId(active) : undefined}
          aria-busy={!queryReady || loading}
          value={query}
          placeholder="搜索项目、记录、会议或待办"
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") { event.preventDefault(); move(1); return; }
            if (event.key === "ArrowUp") { event.preventDefault(); move(-1); return; }
            if (event.key === "Enter") {
              event.preventDefault();
              const target = queryReady ? list[active >= 0 ? active : 0] : undefined;
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
          activeIndex={active}
          onHover={setActiveIndex}
          onOpen={openResult}
          loading={loading}
          readError={error}
          onRetry={() => { void refresh(); }}
        />
      )}
    </div>
  );
}
