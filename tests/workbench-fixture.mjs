// In-memory IPC adapter for UI regression tests. Never imported by the application.
export function installFixture({ failStartup = false, failSettings = false, empty = false } = {}) {
  localStorage.setItem("zhiji:onboarding-complete", "1");
  localStorage.setItem("zhiji:task-reminder-date", "2099-01-01");
  const date = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const meeting = (id, title, offset, finished) => ({
    id, notebookId: null, title, startedAt: `${date(offset)}T09:30:00+08:00`, durationSeconds: 1820,
    status: finished ? "已分析" : "已转写", transcript: "林晨：我们本周先完成客户反馈的分类。\n陈雨：周五前提交产品方案，重点优化首次使用流程。",
    minutes: finished ? "## 会议概要\n本周围绕客户反馈与产品体验开展工作。\n\n## 关键结论\n优先完善首次使用流程，下周安排验证。" : "",
    decisions: finished ? "周五前完成方案评审。" : "", speakerSegments: "[]", speakerNames: "{}", audioPath: null,
    updatedAt: `${date(offset)}T11:00:00+08:00`, context: "对齐本周工作重点和交付安排", notes: "客户希望缩短首次配置时间。",
  });
  // 已整理完成的会议额外带上说话人分段与一张 Markdown 表格：
  // 时间线只在有分段时渲染，表格用来回归 GFM 表格的滚动容器与样式。
  const withTranscriptDetail = (m) => ({
    ...m,
    speakerSegments: JSON.stringify([
      { startMs: 0, endMs: 4200, speakerId: 0, speaker: "说话人1", text: "我们本周先完成客户反馈的分类。" },
      { startMs: 4200, endMs: 9600, speakerId: 1, speaker: "说话人2", text: "周五前提交产品方案，重点优化首次使用流程。" },
    ]),
    speakerNames: JSON.stringify({ "0": "林晨", "1": "陈雨" }),
    minutes: "## 会议概要\n本周围绕客户反馈与产品体验开展工作。\n\n## 行动项\n\n| 负责人 | 事项 | 截止 |\n| --- | --- | --- |\n| 林晨 | 整理客户访谈要点 | 已逾期 |\n| 陈雨 | 提交首次使用流程方案 | 本周五 |\n\n## 关键结论\n优先完善首次使用流程，下周安排验证。",
  });
  const workspace = { meetings: empty ? [] : [meeting("m1", "产品体验优化 · 周例会", 0, false), withTranscriptDetail(meeting("m2", "客户访谈 · 工作流与使用反馈", -1, true)), meeting("m3", "九月项目推进与交付计划", -3, true)], tasks: empty ? [] : [
    { id: "t1", title: "整理客户访谈要点", sourceType: "meeting", sourceId: "m2", completed: false, dueDate: date(-1), createdAt: `${date(-3)}T12:00:00+08:00`, owner: "林晨" },
    { id: "t2", title: "提交首次使用流程方案", sourceType: "meeting", sourceId: "m1", completed: false, dueDate: date(), createdAt: `${date()}T12:00:00+08:00`, owner: "陈雨" },
    { id: "t3", title: "安排下周项目复盘", sourceType: null, sourceId: null, completed: false, dueDate: date(3), createdAt: `${date()}T12:00:00+08:00`, owner: "" },
  ] };
  window.__fixture = { workspace, failStartup, failSettings, failTask: false, calls: [] };
  const work = { projects: [], entries: [], links: {} };
  const reports = [];
  const hub = { activities: [], resources: [], activityLinks: [], resourceLinks: [], resourceActivities: [], profiles: [] };
  const entryHistory = [];
  window.__fixture.hub = hub;
  const visibleHub = (projectId) => {
    if (!projectId) return structuredClone(hub);
    const activityLinks = hub.activityLinks.filter(l => l.projectId === projectId);
    const activities = hub.activities.filter(a => activityLinks.some(l => l.activityId === a.id));
    const resourceLinks = hub.resourceLinks.filter(l => l.projectId === projectId);
    const resourceActivities = hub.resourceActivities.filter(l => activities.some(a => a.id === l.activityId));
    return structuredClone({ activities, activityLinks, resourceLinks, resourceActivities, profiles: hub.profiles.filter(p => p.projectId === projectId), resources: hub.resources.filter(r => [...resourceLinks,...resourceActivities].some(l => l.resourceId === r.id)) });
  };
  let access = { running: false };
  window.__fixture.work = work;
  window.__fixture.reports = reports;
  const callbacks = new Map(); const listeners = new Map(); let callbackId = 0;
  window.__fixture.emit = (event, payload = null) => {
    for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ event, id, payload });
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: callback => { const id = ++callbackId; callbacks.set(id, callback); return id; },
    unregisterCallback: id => callbacks.delete(id),
    convertFileSrc: path => path,
    invoke: async (command, args = {}) => {
      window.__fixture.calls.push(command);
      if (command === "plugin:dialog|open") return window.__fixture.pickedFiles ?? null;
      if (command === "local_api_status") return structuredClone(access);
      if (command === "start_local_api") { access = { running: true, url: `http://127.0.0.1:${args.port}`, allowCapture: args.allowCapture, projectId: args.projectId, mcpConfig: { mcpServers: {} }, calls: [] }; return structuredClone(access); }
      if (command === "stop_local_api") { access = { running: false }; return null; }
      if (command === "workbench_call") {
        const a = args.args;
        const material = () => ({ weekStart: a.weekStart, weekEnd: a.weekStart, warnings: ["团队成果不自动视为个人成果"], sources: work.entries.filter(e => !a.projectId || e.projectId === a.projectId).map(e => ({ id: e.id, sourceType: "entry", title: e.content, date: e.occurredOn, projectId: e.projectId, content: `${e.content} · ${e.status}` })).concat(workspace.meetings.filter(m => !a.projectId || work.links[`meeting:${m.id}`] === a.projectId).map(m => ({ id: m.id, sourceType: "meeting", title: m.title, date: m.startedAt.slice(0, 10), projectId: null, content: m.minutes || m.transcript }))) });
        if (args.action === "load") return structuredClone(work);
        if (args.action === "load_project_hub") return visibleHub(a.projectId);
        if (args.action === "save_project_profile") { const i=hub.profiles.findIndex(p=>p.projectId===a.projectId); if(i<0) hub.profiles.push(a); else hub.profiles[i]=a; return true; }
        if (args.action === "save_activity") { if(window.__fixture.failActivity) throw Error("测试：活动保存失败"); hub.activities.push({...a,meetingId:a.meetingId||null}); hub.activityLinks.push({activityId:a.id,projectId:a.projectId}); return true; }
        if (args.action === "link_activity") { hub.activityLinks.push({activityId:a.activityId,projectId:a.projectId}); return true; }
        if (["register_resource","link_resource","unlink_resource"].includes(args.action)) {
          let rid=a.resourceId;
          if(args.action==="register_resource") { let r=hub.resources.find(r=>r.path===a.path); if(!r) {r={id:crypto.randomUUID(),path:a.path,title:a.path.split(/[\\/]/).pop(),sizeBytes:24,modifiedAt:"version-1",contentStatus:"metadata_only"};hub.resources.push(r);} rid=r.id; }
          const list=a.activityId?hub.resourceActivities:hub.resourceLinks;
          const key=a.activityId?"activityId":"projectId";
          const i=list.findIndex(l=>l.resourceId===rid&&l[key]===a[key]);
          if(args.action==="unlink_resource") {if(i>=0) list.splice(i,1);} else {const l={resourceId:rid,[key]:a[key],role:a.role||"reference"};if(i<0)list.push(l);else list[i]=l;}
          return {id:rid};
        }
        if(args.action==="open_resource") { if(window.__fixture.missingFile) throw Error("文件不存在或无法读取，请重新选择文件");return true; }
        if(args.action==="relocate_resource") {const r=hub.resources.find(r=>r.id===a.resourceId);r.path=a.path;r.title=a.path.split(/[\\/]/).pop();return true;}
        if(args.action==="entry_history") return structuredClone(entryHistory.filter(h=>h.entry.id===a.entryId).reverse());
        if (args.action === "save_entry" || args.action === "capture_work") {
          if (window.__fixture.failEntry) throw Error("测试：工作记录写入失败");
          const entry = { ...a, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          const i = work.entries.findIndex(e => e.id === entry.id); if (i < 0) work.entries.unshift(entry); else work.entries[i] = entry;
          entryHistory.push({sequence:entryHistory.length+1,recordedAt:new Date().toISOString(),entry:structuredClone(entry)});
          return structuredClone(entry);
        }
        if (args.action === "save_project") { const i = work.projects.findIndex(p => p.id === a.id); if (i < 0) work.projects.push(a); else work.projects[i] = a; return structuredClone(work.projects); }
        if (args.action === "link_project") { if (a.projectId) work.links[`${a.entityType}:${a.entityId}`] = a.projectId; else delete work.links[`${a.entityType}:${a.entityId}`]; return structuredClone(work.links); }
        if (args.action === "report_material") return material();
        if (args.action === "list_reports") return structuredClone(reports);
        if (args.action === "generate_report") {
          if (window.__fixture.failReport) throw Error("测试：生成失败，已有周报保留");
          const sources=material().sources.filter(s=>!a.selectedSources||a.selectedSources.includes(`${s.sourceType}:${s.id}`));
          if(!sources.length) throw Error("这一周没有可用材料");
          const report = { id: crypto.randomUUID(), weekStart: a.weekStart, projectId: a.projectId, content: `# 工作周报\n\n${sources.map((s, i) => `${s.content} [${i + 1}]`).join("\n")}`, sources, warnings: material().warnings, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          reports.unshift(report); return structuredClone(report);
        }
        if (args.action === "save_report") { if (window.__fixture.failReport) throw Error("测试：周报保存失败"); const r = reports.find(r => r.id === a.id); r.content = a.content; r.updatedAt = new Date().toISOString(); return { updatedAt: r.updatedAt }; }
        throw Error(`Unimplemented workbench action: ${args.action}`);
      }
      if (command === "recover_interrupted_recordings") { if (window.__fixture.failStartup) throw Error("测试：资料库暂不可用"); return 0; }
      if (command === "load_workspace") return structuredClone(workspace);
      if (command === "get_ai_settings") { if (window.__fixture.failSettings) throw Error("测试：配置暂不可用"); return { baseUrl: "https://api.openai.com/v1", analysisModel: "gpt-4o-mini", isConfigured: true }; }
      if (command === "get_local_asr_status") return { installed: true, runtimeAvailable: true, modelSizeMb: 240 };
      if (command === "get_speaker_engine_status") return { installed: true, modelsReady: true };
      if (command === "get_asr_engine_settings") return { provider: "local", cloudBaseUrl: "", cloudModel: "", cloudKeySaved: false, localHotwords: "" };
      if (command === "get_recording_settings") return { captureSystemAudio: false };
      if (command === "list_backups") return [];
      if (command === "plugin:app|version") return "2.0.1";
      if (command === "plugin:updater|check") return null;
      if (command === "plugin:event|listen") { const id = ++callbackId; listeners.set(id, args); return id; }
      if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return null; }
      if (command === "plugin:window|close" && window.__fixture.failWindow) throw Error("测试：窗口操作权限不足");
      if (command.startsWith("plugin:window|")) return null;
      if (command === "finish_app_exit") return null;
      if (command === "plugin:autostart|is_enabled") return false;
      if (command === "upsert_task") {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (window.__fixture.failTask) throw Error("测试：磁盘写入失败");
        const i = workspace.tasks.findIndex(t => t.id === args.task.id);
        if (i < 0) workspace.tasks.unshift(args.task); else workspace.tasks[i] = args.task;
        return null;
      }
      if (command === "save_meeting") { const i = workspace.meetings.findIndex(m => m.id === args.meeting.id); if (i >= 0) workspace.meetings[i] = args.meeting; return null; }
      if (command === "create_meeting") { const m = { ...meeting(crypto.randomUUID(), "未命名会议", 0, false), transcript: "", durationSeconds: 0, status: "草稿" }; workspace.meetings.unshift(m); return m; }
      if (command === "delete_task") { workspace.tasks = workspace.tasks.filter(t => t.id !== args.taskId); return null; }
      if (command === "list_qa_messages") return [];
      if (command === "generate_weekly_report") return "# 本周工作回顾\n\n完成客户访谈，推进产品体验优化。\n\n## 下周计划\n验证首次使用流程。";
      if (command.startsWith("get_")) return null;
      throw Error(`Unimplemented test IPC: ${command}`);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}
