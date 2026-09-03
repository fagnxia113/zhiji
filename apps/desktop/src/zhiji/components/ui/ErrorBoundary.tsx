import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

// 应用级错误兜底：任何渲染期异常都显示可读信息，避免静默白屏。
// 没有 error boundary 时，React 会直接卸载整棵树变成空白，极难排查
// （v1.2.17 引入的 hooks 顺序违规就曾导致整页白屏且无任何提示）。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("应用渲染异常：", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: "32px",
            fontFamily: "system-ui, sans-serif",
            color: "var(--text-default, #333)",
            background: "var(--bg-app, #f3f3f3)",
            minHeight: "100vh",
            lineHeight: 1.6,
          }}
        >
          <h1 style={{ fontSize: "20px", marginBottom: "12px" }}>知记遇到了问题</h1>
          <p style={{ marginBottom: "12px" }}>
            界面渲染出错，已停止以避免白屏。可点击下方按钮重试；若反复出现请反馈以下错误信息：
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              background: "var(--bg-inset, #f5f5f5)",
              padding: "12px",
              borderRadius: "8px",
              fontSize: "13px",
              overflowX: "auto",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: "16px",
              padding: "8px 16px",
              borderRadius: "8px",
              border: "1px solid var(--border-default, #ccc)",
              background: "var(--bg-surface, #fff)",
              color: "var(--text-default, #333)",
              cursor: "pointer",
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
