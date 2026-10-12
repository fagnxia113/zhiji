import type { View } from "../../types";

const pages = [["home", "工作台"], ["projects", "项目"], ["meetings", "会议"], ["report", "周报"]] as const;

export function AppNavigation({ view, onNavigate }: { view: View; onNavigate: (view: View) => void }) {
  const active = view === "tasks" || view === "journal" ? "home" : view;
  return <header className="app-navigation">
    <button className="app-brand" onClick={() => onNavigate("home")} aria-label="返回工作台">知记</button>
    <nav aria-label="主导航">{pages.map(([id, label]) => <button key={id} aria-current={active === id ? "page" : undefined} aria-label={id === "meetings" ? "会议资料" : label} onClick={() => onNavigate(id)}>{label}</button>)}</nav>
    <button className="app-settings" aria-current={view === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}>设置</button>
  </header>;
}
