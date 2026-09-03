import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, MessageCircleQuestion, SendHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { QaMessage } from "../../types";
import { renderMarkdown } from "../fields/markdown";

type MeetingQaPanelProps = {
  meetingId: string;
  aiConfigured: boolean;
  // 有转写或纪要内容才允许提问（后端也会再校验一次）
  hasContent: boolean;
};

// 会议问答：基于本场会议的转写/纪要/笔记/会前背景向 AI 提问，一问一答持久化，支持追问。
// 自包含组件：自己加载历史、自己管理提问状态，不占用 App 的 processing 通道（问答不改动会议数据）。
export function MeetingQaPanel({ meetingId, aiConfigured, hasContent }: MeetingQaPanelProps) {
  const [messages, setMessages] = useState<QaMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setError("");
    invoke<QaMessage[]>("list_qa_messages", { meetingId })
      .then((list) => {
        if (active) setMessages(list);
      })
      .catch(() => {
        // 历史加载失败不阻塞提问，静默从空白开始
      });
    return () => {
      active = false;
    };
  }, [meetingId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, asking]);

  const canAsk = aiConfigured && hasContent && !asking && draft.trim().length > 0;

  const ask = async () => {
    const question = draft.trim();
    if (!canAsk || !question) return;
    setAsking(true);
    setError("");
    setDraft("");
    try {
      const message = await invoke<QaMessage>("ask_meeting_question", { meetingId, question });
      setMessages((list) => [...list, message]);
    } catch (cause) {
      setError(String(cause));
      setDraft(question);
    } finally {
      setAsking(false);
    }
  };

  const clearHistory = async () => {
    try {
      await invoke("clear_qa_history", { meetingId });
      setMessages([]);
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  };

  const rendered = useMemo(
    () => new Map(messages.map((message) => [message.id, renderMarkdown(message.answer)])),
    [messages],
  );

  return (
    <section className="qa-pane">
      <div className="pane-head">
        <div>
          <h3>会议问答</h3>
          <small>基于本场会议内容提问，回答会保存在这里</small>
        </div>
        {messages.length > 0 && (
          <div className="pane-actions">
            <button className="pane-action secondary" onClick={() => void clearHistory()} disabled={asking} title="清空本场会议的问答记录">
              <Trash2 size={13} />清空记录
            </button>
          </div>
        )}
      </div>
      {!aiConfigured ? (
        <div className="tab-panel-empty">请先到设置中配置智能纪要服务，之后即可就本场会议提问。</div>
      ) : !hasContent ? (
        <div className="tab-panel-empty">完成转写或粘贴会议内容后，就可以在这里提问。</div>
      ) : (
        <>
          <div className="qa-thread" ref={scrollRef}>
            {messages.length === 0 && !asking && (
              <div className="tab-panel-empty">
                <MessageCircleQuestion size={18} />
                试试问：「这场会议定了哪些事？」「我的待办有哪些？」
              </div>
            )}
            {messages.map((message) => (
              <div className="qa-pair" key={message.id}>
                <div className="qa-question">{message.question}</div>
                <div className="qa-answer markdown-body" dangerouslySetInnerHTML={{ __html: rendered.get(message.id) ?? "" }} />
              </div>
            ))}
            {asking && (
              <div className="qa-pair">
                <div className="qa-answer qa-thinking">
                  <LoaderCircle className="spin" size={14} />正在思考…
                </div>
              </div>
            )}
          </div>
          {error && <div className="qa-error">{error}</div>}
          <div className="qa-input-row">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void ask();
                }
              }}
              placeholder="就这场会议提问…（Enter 发送，Shift+Enter 换行）"
              rows={2}
              disabled={asking}
            />
            <button className="primary-button compact-button" onClick={() => void ask()} disabled={!canAsk} title="发送问题">
              {asking ? <LoaderCircle className="spin" size={14} /> : <SendHorizontal size={14} />}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
