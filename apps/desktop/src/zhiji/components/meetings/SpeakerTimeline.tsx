import { Pencil, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import type { SpeakerSegment } from "../../types";
import { speakerDisplayName } from "../../types";
import { duration } from "../../format";
import { Popover } from "../ui";

// 说话人时间线：逐段展示转写，支持按说话人/内容筛选、点击跳转音频、改名、内联修正文字。
// 为配合音频联动，startMs/endMs 为毫秒；onSeek 向上抛毫秒，由父组件交给 AudioPlayer。
export function SpeakerTimeline({
  segments,
  currentMs,
  onSeek,
  names,
  onRename,
  onEdit,
}: {
  segments: string;
  currentMs: number;
  onSeek: (ms: number) => void;
  names: Record<string, string>;
  onRename: (speakerId: number, name: string) => void;
  onEdit: (index: number, text: string) => void;
}) {
  const [items, setItems] = useState<SpeakerSegment[]>([]);
  const [visible, setVisible] = useState(80);
  const [filter, setFilter] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  const deferredFilter = useDeferredValue(filter);
  useEffect(() => {
    try {
      setItems(JSON.parse(segments) as SpeakerSegment[]);
    } catch {
      setItems([]);
    }
    setVisible(80);
    setFilter("");
    setEditingIndex(null);
    setEditingText("");
  }, [segments]);
  useEffect(() => setVisible(80), [deferredFilter]);
  const filteredItems = useMemo(() => {
    const normalized = deferredFilter.trim().toLocaleLowerCase();
    const indexed = items.map((item, sourceIndex) => ({ item, sourceIndex }));
    if (!normalized) return indexed;
    return indexed.filter(({ item, sourceIndex }) => {
      const id = item.speakerId ?? (() => {
        const match = item.speaker?.match(/\d+/);
        return match ? Number(match[0]) - 1 : sourceIndex;
      })();
      const label = speakerDisplayName({ ...item, speakerId: id }, names);
      return `${label} ${item.text}`.toLocaleLowerCase().includes(normalized);
    });
  }, [deferredFilter, items, names]);
  const commitEdit = (index: number, text: string) => {
    if (!text.trim()) return;
    onEdit(index, text);
    setItems((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, text: text.trim() } : item
    ));
    setEditingIndex(null);
    setEditingText("");
  };
  if (!items.length) return null;
  return (
    <section className="speaker-timeline">
      <div className="speaker-timeline-head">
        <h3>说话人时间线</h3>
        <small>点击片段可听原声；点击说话人名称可改名，右侧按钮可直接修正识别文字。</small>
        {items.length > 20 && (
          <label className="speaker-filter">
            <Search size={14} />
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选说话人或片段内容" />
            {filter && <button type="button" onClick={() => setFilter("")} title="清除筛选"><X size={13} /></button>}
          </label>
        )}
      </div>
      {filteredItems.slice(0, visible).map(({ item, sourceIndex }, index) => {
        const id =
          item.speakerId ??
          (() => {
            const m = item.speaker?.match(/\d+/);
            return m ? Number(m[0]) - 1 : sourceIndex;
          })();
        const label = speakerDisplayName(item, names);
        const active =
          currentMs >= 0 && currentMs >= item.startMs && currentMs < item.endMs;
        return (
          <div className={`speaker-row ${active ? "active" : ""}`} key={`${item.startMs}-${index}`}>
            <Popover
              trigger={
                <span className="speaker-chip" title="点击修改说话人名称">
                  {label}
                </span>
              }
            >
              {(close) => (
                <div className="speaker-rename">
                  <input
                    className="speaker-rename-input"
                    defaultValue={label}
                    placeholder="输入说话人名称"
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        onRename(id, (event.target as HTMLInputElement).value);
                        close();
                      } else if (event.key === "Escape") {
                        close();
                      }
                    }}
                  />
                  <div className="speaker-rename-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        onRename(id, "");
                        close();
                      }}
                    >
                      清除
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      onClick={(event) => {
                        const input = (event.currentTarget.closest(".speaker-rename") as HTMLElement)?.querySelector("input");
                        if (input) onRename(id, (input as HTMLInputElement).value);
                        close();
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              )}
            </Popover>
            <button
              type="button"
              className="speaker-seek"
              onClick={() => onSeek(item.startMs)}
              title={`跳转到 ${duration(Math.floor(item.startMs / 1000))}`}
            >
              <small>
                {duration(Math.floor(item.startMs / 1000))}–
                {duration(Math.floor(item.endMs / 1000))}
              </small>
            </button>
            {editingIndex === sourceIndex ? (
              <div className="speaker-inline-edit">
                <textarea
                  autoFocus
                  value={editingText}
                  onChange={(event) => setEditingText(event.target.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && editingText.trim()) {
                      commitEdit(sourceIndex, editingText);
                    } else if (event.key === "Escape") {
                      setEditingIndex(null);
                    }
                  }}
                />
                <span>
                  <button className="text-button" onClick={() => setEditingIndex(null)}>取消</button>
                  <button
                    className="primary-button compact-button"
                    disabled={!editingText.trim()}
                    onClick={() => {
                      commitEdit(sourceIndex, editingText);
                    }}
                  >
                    保存修改
                  </button>
                </span>
              </div>
            ) : (
              <div className="speaker-row-content">
                <p onClick={() => onSeek(item.startMs)}>{item.text}</p>
                <button
                  className="icon-btn"
                  title="修改这段文字"
                  onClick={() => {
                    setEditingIndex(sourceIndex);
                    setEditingText(item.text);
                  }}
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
          </div>
        );
      })}
      {filteredItems.length === 0 && <div className="speaker-filter-empty">没有匹配的说话片段</div>}
      {filteredItems.length > visible && (
        <button
          type="button"
          className="speaker-load-more"
          onClick={() => setVisible((value) => value + 80)}
        >
          显示更多（剩余 {filteredItems.length - visible} 条）
        </button>
      )}
    </section>
  );
}
