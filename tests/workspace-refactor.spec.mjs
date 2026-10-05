import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function seed() {
  const f = window.__fixture;
  f.work.projects.push({ id: "p1", name: "季度汇报", archived: false }, { id: "p2", name: "专题调研", archived: false });
  f.work.entries.push({ id: "e1", content: "方案已完成，等待反馈", kind: "progress", status: "waiting", occurredOn: "2026-10-02", projectId: "p1", sourceLabel: "项目进展", updatedAt: "2026-10-02" });
  f.hub.resources.push({ id: "r1", title: "汇报方案.docx", path: "D:\work\汇报方案.docx", contentStatus: "metadata_only" });
  f.hub.resourceLinks.push({ resourceId: "r1", projectId: "p1", role: "output" });
  localStorage.setItem("zhiji:last-project", "p2");
  localStorage.setItem("zhiji:work-entry-draft", JSON.stringify({ id: 17, content: "缓存里保留的内容", kind: {}, status: ["bad"], occurredOn: "invalid", projectId: "p1" }));
  localStorage.setItem("zhiji:project-progress:p1", JSON.stringify({ content: 17, entryId: null, day: "bad", status: {}, activityId: [] }));
  localStorage.setItem("zhiji:project-view:p1", JSON.stringify({ tab: "missing", fileQuery: 17, resourceId: {}, listScroll: [] }));
  const invoke = window.__TAURI_INTERNALS__.invoke;
  f.loadCount = 0; f.saveCount = 0; f.failReads = 0;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === "workbench_call") {
      if (args.action === "load") { f.loadCount++; if (f.failReads) { if (f.failReads > 0) f.failReads--; throw Error("测试：工作记录暂时无法读取"); } }
      if (args.action === "save_entry") {
        f.saveCount++;
        if (f.holdSave) await new Promise(resolve => { f.resumeSave = resolve; });
      }
      const result = await invoke(command, args);
      if (args.action === "save_project" && args.args.archived && f.failAfterArchive) { f.failAfterArchive = false; f.failReads = -1; f.emit("zhiji://workbench-changed"); }
      return result;
    }
    return invoke(command, args);
  };
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seed.toString()})();` });
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  const input = page.getByRole("textbox", { name: "工作内容", exact: true });
  await input.waitFor();
  assert.equal(await input.inputValue(), "缓存里保留的内容", "invalid ancillary cache fields do not discard valid content");
  assert.equal(await page.getByRole("combobox", { name: "工作状态", includeHidden: true }).inputValue(), "in_progress");
  assert.equal(await page.evaluate(() => window.__fixture.loadCount), 1, "home consumers share one initial workbench read");
  await input.fill("");
  await page.getByRole("button", { name: "工作记录", exact: true }).click();
  const filter = page.getByRole("combobox", { name: "筛选项目" });
  const search = page.getByRole("textbox", { name: "搜索工作记录" });
  await filter.selectOption("p1"); await search.fill("方案");
  await page.getByRole("button", { name: /^等待反馈/ }).click();
  await page.getByRole("button", { name: "打开项目：季度汇报", exact: true }).click();
  const hub = page.getByRole("region", { name: "项目详情" });
  await hub.getByRole("heading", { name: "季度汇报", exact: true }).waitFor();
  assert.equal(await hub.getByRole("tab", { name: "概览", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await page.getByRole("navigation", { name: "项目列表" }).isVisible(), true);
  assert.equal(await page.evaluate(() => window.__fixture.loadCount), 1, "route changes do not repeat global data reads");
  const panes = await page.locator(".project-picker, .project-detail").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  assert.ok(panes[0].right < panes[1].left && panes[1].width >= 650, "default desktop window keeps both project navigation and content readable");

  const projects = page.getByRole("navigation", { name: "项目列表" });
  const first = projects.getByRole("button", { name: /季度汇报/ });
  const second = projects.getByRole("button", { name: /专题调研/ });
  await first.focus(); await first.press("ArrowDown");
  assert.equal(await second.evaluate(el => document.activeElement === el), true);
  await second.press("ArrowUp"); await first.press("Enter");
  await page.getByRole("button", { name: "工作记录", exact: true }).click();
  assert.equal(await filter.inputValue(), "p1"); assert.equal(await search.inputValue(), "方案");
  assert.equal(await page.getByRole("button", { name: /^等待反馈/ }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "工作记录", exact: true }).click();
  assert.equal(await filter.inputValue(), "p1", "compact capture does not overwrite full-journal filters");
  assert.equal(await search.inputValue(), "方案");
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();

  await input.fill("两次提交只能保存一条");
  await page.evaluate(() => {
    window.__fixture.holdSave = true;
    const form = document.querySelector(".work-capture");
    form.requestSubmit(); form.requestSubmit();
  });
  await page.waitForFunction(() => !!window.__fixture.resumeSave);
  assert.equal(await page.evaluate(() => window.__fixture.saveCount), 1, "synchronous duplicate submissions share an operation lock");
  await page.evaluate(() => { window.__fixture.holdSave = false; window.__fixture.resumeSave(); });
  await page.waitForFunction(() => window.__fixture.work.entries.length === 2);
  await page.getByText("已保存到本地资料库", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开项目：季度汇报", exact: true }).first().click();
  await hub.getByRole("button", { name: "记录进展", exact: true }).click();
  const progress = hub.getByRole("textbox", { name: "项目进展内容" });
  await progress.fill("尚未提交的项目进展");
  await page.evaluate(() => {
    const f = window.__fixture;
    f.hub.resources.push({ id: "r2", title: "外部登记的参考.pdf", path: "D:\work\外部登记的参考.pdf", contentStatus: "metadata_only" });
    f.hub.resourceLinks.push({ resourceId: "r2", projectId: "p1", role: "reference" });
    f.emit("zhiji://workbench-changed");
  });
  await hub.getByRole("tab", { name: "资料", exact: true }).click();
  await hub.getByRole("button", { name: /^外部登记的参考.pdf/ }).waitFor();
  await hub.getByRole("button", { name: /^汇报方案.docx/ }).click();
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-projects.png", animations: "disabled" });

  await hub.getByRole("tab", { name: "概览", exact: true }).click();
  await hub.getByText("项目设置", { exact: true }).click();
  await page.evaluate(() => { window.__fixture.failAfterArchive = true; });
  await hub.getByRole("button", { name: "归档项目", exact: true }).click();
  await hub.getByRole("alert").getByText(/操作已完成，但列表刷新失败/).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.work.projects[0].archived), true);
  assert.equal(await hub.getByRole("button", { name: "归档项目", exact: true }).isDisabled(), true);
  await page.evaluate(() => { window.__fixture.failReads = 0; });
  await hub.getByRole("button", { name: "重新读取", exact: true }).click();
  await hub.getByRole("button", { name: "恢复项目", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.workCalls.filter(c => c.action === "save_project").length), 1, "retry refreshes both snapshots without repeating the completed mutation");
  await hub.getByRole("tab", { name: "进展", exact: true }).click();
  assert.equal(await progress.inputValue(), "尚未提交的项目进展", "external updates and refresh recovery preserve the editor");
  await page.getByRole("button", { name: "周报", exact: true }).click();
  await page.getByRole("dialog", { name: "生成周报" }).waitFor();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 400, height: 700 });
  await progress.waitFor();
  await projects.waitFor({ state: "hidden" });
  assert.equal(await projects.isVisible(), false);
  assert.equal(await hub.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  const menu = page.getByRole("dialog", { name: "导航菜单" });
  await menu.waitFor();
  assert.equal(await menu.getByRole("button", { name: "工作记录", exact: true }).locator("span").isVisible(), true, "narrow navigation includes readable labels");
  const menuBox = await menu.boundingBox();
  assert.ok(menuBox.x === 0 && menuBox.width < 400 && menuBox.height >= 650);
  await menu.getByRole("button", { name: "设置", exact: true }).focus();
  await page.keyboard.press("Tab");
  assert.equal(await menu.getByRole("button", { name: "收起导航", exact: true }).evaluate(el => document.activeElement === el), true, "drawer traps keyboard focus");
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-navigation-narrow.png", animations: "disabled" });
  await menu.getByRole("button", { name: "工作记录", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await input.waitFor();
  await page.setViewportSize({ width: 1200, height: 700 });
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-journal.png", animations: "disabled" });

  await page.getByRole("button", { name: "行动待办", exact: true }).click();
  const ranges = page.getByRole("group", { name: "待办范围" });
  assert.equal(await ranges.getByRole("button").count(), 6);
  assert.ok(await ranges.evaluate(el => el.getBoundingClientRect().height) < 80, "filters do not dominate the task page");
  const taskSearch = page.getByRole("textbox", { name: "搜索待办" });
  await taskSearch.fill("找不到的待办");
  assert.equal(await page.locator(".task-row").count(), 0);
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  assert.equal(await page.locator(".task-row").count(), 3);
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-tasks.png", animations: "disabled" });

  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  const meetingSearch = page.getByRole("textbox", { name: "搜索会议" });
  const meetingOrder = page.getByRole("combobox", { name: "会议排序" });
  await meetingSearch.fill("客户访谈"); await meetingOrder.selectOption("updated");
  await page.getByRole("button", { name: "工作记录", exact: true }).click();
  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  assert.equal(await meetingSearch.inputValue(), "客户访谈"); assert.equal(await meetingOrder.inputValue(), "updated");
  assert.equal(await page.locator(".meeting-item").count(), 1);
  await page.locator(".meeting-item").click();
  assert.equal(await page.locator(".meeting-review-tools .ai-workflow").count(), 0, "completed meetings combine status and actions in one toolbar");
  assert.ok(await page.locator(".minutes-pane > .pane-head").evaluate(el => el.getBoundingClientRect().top) < 400, "completed meeting content starts earlier in the default window");
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-meeting.png", animations: "disabled" });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  const settings = page.getByRole("navigation", { name: "设置分类导航" });
  assert.match(await settings.getByRole("button").first().innerText(), /使用概览/);
  await settings.getByRole("button", { name: /数据与备份/ }).click();
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  assert.equal(await settings.getByRole("button", { name: /数据与备份/ }).getAttribute("aria-current"), "page");
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-settings.png", animations: "disabled" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  const primary = page.locator(".settings-content .primary-button").first();
  assert.notEqual(await primary.evaluate(el => getComputedStyle(el).color), "rgb(255, 255, 255)", "dark primary buttons keep readable text on the light accent");
  await page.screenshot({ path: ".tmp/ui-verification/workspace-refactor-settings-dark.png", animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log("PASS: shared reads, project panes/links, retained filters, cache recovery, duplicate-submit lock, external updates and retry, fixed report entry, readable narrow navigation/focus, compact task filters, meeting-list recovery, settings recovery and dark contrast.");
} finally { await browser.close(); }
