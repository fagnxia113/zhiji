import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./zhiji/App";
import { ErrorBoundary } from "./zhiji/components";
import "./zhiji/styles/index.css";
import { applyTheme, loadThemePreference } from "./zhiji/theme";

// 渲染前同步应用外观主题（读 localStorage + 系统偏好），避免深色用户启动闪白
applyTheme(loadThemePreference());

const root = document.getElementById("root");

if (!root) {
  throw new Error("找不到应用根节点");
}

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
