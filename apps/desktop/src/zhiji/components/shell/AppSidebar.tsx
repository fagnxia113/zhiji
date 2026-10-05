import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, FileDown, FolderOpen, House, Menu, Pencil, Plus, Settings, UsersRound, X } from "lucide-react";
import type { View } from "../../types";
import { Dialog } from "../ui";
import { RailItem } from "./RailItem";

export function AppSidebar({ view, reportOpen, onNavigate, onNewMeeting, onReport }: {
  view: View; reportOpen: boolean; onNavigate: (view: View) => void;
  onNewMeeting: () => void; onReport: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 901px)");
    const closeOnWide = () => { if (media.matches) setMenuOpen(false); };
    media.addEventListener("change", closeOnWide);
    return () => media.removeEventListener("change", closeOnWide);
  }, []);
  const navigate = (next: View) => { setMenuOpen(false); onNavigate(next); };
  const newMeeting = () => { setMenuOpen(false); onNewMeeting(); };
  const report = () => { setMenuOpen(false); onReport(); };
  const navigation = () => <nav className="rail-nav" aria-label="主导航">
    <span className="rail-group-label">日常工作</span>
    <RailItem active={view === "home"} icon={<House size={20} />} title="工作台" onClick={() => navigate("home")} />
    <RailItem active={view === "journal"} icon={<Pencil size={20} />} title="工作记录" onClick={() => navigate("journal")} />
    <RailItem active={view === "tasks"} icon={<CheckCircle2 size={20} />} title="行动待办" onClick={() => navigate("tasks")} />
    <RailItem active={reportOpen} icon={<FileDown size={20} />} title="周报" onClick={report} />
    <span className="rail-group-label">资料与项目</span>
    <RailItem active={view === "projects"} icon={<FolderOpen size={20} />} title="项目" onClick={() => navigate("projects")} />
    <RailItem active={view === "meetings"} icon={<UsersRound size={20} />} title="会议资料" onClick={() => navigate("meetings")} />
  </nav>;
  const settings = () => <button className={`rail-settings ${view === "settings" ? "active" : ""}`} title="设置" onClick={() => navigate("settings")}><Settings size={20} /><span>设置</span></button>;
  return <>
    <aside className="icon-rail">
      <button className="rail-menu" aria-label="展开导航" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
      <button className="rail-brand" title="返回工作台" onClick={() => navigate("home")}><span>记</span><small>知记<b>个人工作台</b></small></button>
      <button className="rail-new" title="新建会议" onClick={newMeeting}><Plus size={20} /><span>新建会议</span></button>
      {navigation()}
      <div className="rail-local-status"><span /><div>本地资料库<small>记录与成果，留在自己手中</small></div></div>
      {settings()}
    </aside>
    {menuOpen && createPortal(<Dialog ariaLabel="导航菜单" className="navigation-drawer" onClose={() => setMenuOpen(false)}>
      <div className="navigation-drawer-heading"><strong>知记 · 个人工作台</strong><button className="icon-btn" aria-label="收起导航" onClick={() => setMenuOpen(false)}><X size={18} /></button></div>
      <button className="rail-new" onClick={newMeeting}><Plus size={20} /><span>新建会议</span></button>
      {navigation()}{settings()}
    </Dialog>, document.body)}
  </>;
}
