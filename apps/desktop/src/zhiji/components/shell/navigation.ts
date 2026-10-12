import type { View } from "../../types";

export const pageCopy: Record<View, { title: string; subtitle: string }> = {
  home: { title: "工作台", subtitle: "继续手头的工作，记下今天的进展" },
  meetings: { title: "会议", subtitle: "录音、原文、纪要与行动项" },
  tasks: { title: "待办", subtitle: "跟进会内与会外的下一步行动" },
  journal: { title: "工作记录", subtitle: "日常进展按时间归纳，随时关联项目" },
  projects: { title: "项目", subtitle: "资料、活动与进展，围绕同一项工作" },
  report: { title: "周报", subtitle: "核对本周材料，整理实际推进与日常工作" },
  settings: { title: "设置", subtitle: "调整使用习惯、智能服务和资料存储" },
};
