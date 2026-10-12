import type { ReactNode } from "react";
import type { Project, WorkEntry } from "../../workbench";
import type { Workspace } from "../../types";
import { statuses } from "../../workbench";
import { localDateKey } from "../../workflow";
import { cachedFields, validDate } from "../../workbench/cache";
export { cachedFields, validDate } from "../../workbench/cache";

export type Activity = { id: string; title: string; kind: string; occurredOn: string; meetingId: string | null };
export type Resource = { id: string; title: string; path: string; sizeBytes: number; modifiedAt: string; contentStatus: string };
export type Hub = {
  activities: Activity[]; resources: Resource[];
  activityLinks: { activityId: string; projectId: string }[];
  resourceLinks: { resourceId: string; projectId: string; role: string }[];
  resourceActivities: { resourceId: string; activityId: string; role: string }[];
  profiles: { projectId: string; goal: string; stage: string }[];
};
export type ProjectWorkspaceProps = {
  project: Project; workspace: Workspace; entries?: WorkEntry[];
  projectLinks?: Record<string, string>; onChanged: () => Promise<boolean>;
  onMeeting?: (id: string) => void; meetingContent?: ReactNode;
};
export const emptyHub: Hub = { activities: [], resources: [], activityLinks: [], resourceLinks: [], resourceActivities: [], profiles: [] };
export const activityKinds: Record<string, string> = { meeting: "会议", research: "调研", training: "培训", review: "评审", other: "其他活动" };
export const roles: Record<string, string> = { reference: "参考资料", process: "过程记录", output: "工作产出" };
export const tabs = { progress: "进展", activities: "会议与活动", resources: "资料" };
export type HubTab = keyof typeof tabs;

export function progressDraft(projectId: string) {
  const value = cachedFields(`zhiji:project-progress:${projectId}`, {
    content: "", entryId: "", day: "", status: "", activityId: "", outputId: "",
  });
  const hasContent = !!value.content.trim();
  return {
    ...value, entryId: value.entryId || crypto.randomUUID(),
    day: hasContent && validDate(value.day) ? value.day : localDateKey(new Date()),
    status: hasContent && Object.prototype.hasOwnProperty.call(statuses, value.status) ? value.status : "in_progress",
  };
}
