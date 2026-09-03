// 外观主题：浅色 / 深色 / 跟随系统。
// 纯前端偏好（localStorage 持久化），不入后端 settings 表。
// CSS 侧 tokens.css 已备好 [data-theme="dark"] 全套令牌，这里只负责：
//   1) 计算当前生效主题（跟随系统时读 prefers-color-scheme）
//   2) 把 data-theme 挂到 <html> 上（触发令牌切换）
//   3) 监听系统主题变化（仅"跟随系统"时需要）

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "zhiji:theme";
const MEDIA = "(prefers-color-scheme: dark)";

/** 读取用户偏好；从未设置过则默认跟随系统。 */
export function loadThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage 不可用时静默回退默认
  }
  return "system";
}

export function saveThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // 忽略：偏好丢失不致命
  }
}

/** 计算某偏好下当前实际生效的主题（light/dark）。 */
export function resolveTheme(pref: ThemePreference): "light" | "dark" {
  if (pref === "system") {
    return typeof window !== "undefined" && window.matchMedia(MEDIA).matches
      ? "dark"
      : "light";
  }
  return pref;
}

/** 把主题挂到 <html data-theme>；返回是否切到了深色（便于联动其它 UI）。 */
export function applyTheme(pref: ThemePreference): "light" | "dark" {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = resolved;
  // color-scheme 让原生控件（滚动条/输入框/弹层）跟随，而不是靠浏览器猜
  root.style.colorScheme = resolved;
  return resolved;
}

/**
 * 订阅系统主题变化，返回取消函数。
 * 仅当偏好为 system 时应保持监听；切到固定主题后请取消以省资源。
 */
export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const media = window.matchMedia(MEDIA);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}
