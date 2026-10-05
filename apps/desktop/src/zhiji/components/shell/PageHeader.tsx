import type { RefObject } from "react";
import type { Meeting, Task, View, Workspace } from "../../types";
import { GlobalSearchBox } from "../ui";
import { pageCopy } from "./navigation";

export function PageHeader({ view, workspace, searchInput, onMeeting, onTask, onProject, onEntry }: {
  view: View; workspace: Workspace; searchInput: RefObject<HTMLInputElement | null>;
  onMeeting: (meeting: Meeting) => void; onTask: (task: Task) => void;
  onProject: (id: string) => void; onEntry: (id: string) => void;
}) {
  const copy = pageCopy[view];
  return <header className="page-header">
    <div className="page-heading-copy"><h1>{copy.title}</h1><p>{copy.subtitle}</p></div>
    <GlobalSearchBox workspace={workspace} inputRef={searchInput} onOpenMeeting={onMeeting} onOpenTask={onTask} onOpenProject={onProject} onOpenEntry={onEntry} />
  </header>;
}
