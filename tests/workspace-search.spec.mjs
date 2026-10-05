import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function seed() {
  const f = window.__fixture;
  f.work.projects.push({ id: "p1", name: "季度汇报", archived: false }, { id: "p2", name: "专题调研", archived: false }, { id: "p3", name: "历史交付档案", archived: true });
  const record = (id, content, projectId, status = "in_progress") => ({ id, content, projectId, status, kind: "progress", occurredOn: "2026-10-02", sourceLabel: "客户邮件", createdAt: "2026-10-02", updatedAt: "2026-10-02" });
  f.work.entries.push(record("e1", "已完成预算口径核对", "p1", "waiting"), record("e2", "已收到技术方案，准备补充评审意见", "p2", "done"), record("e3", "确认下周跨部门评审的时间", "p1"));
  for (let index = 0; index < 8; index++) f.work.projects.push({ id: `bulk-p${index}`, name: `资料总览项目${index}`, archived: false });
  for (let index = 0; index < 16; index++) f.work.entries.push(record(`bulk-e${index}`, `资料总览进展${index}`, "p1"));
  f.workspace.meetings[2].title = "资料总览复盘会议";
  f.workspace.tasks.push({ id: "bulk-task", title: "资料总览资料校验", completed: true, owner: "", dueDate: null, sourceType: null, sourceId: null, createdAt: "2026-10-02" });
  localStorage.setItem("zhiji:last-project", "p2");
  localStorage.setItem("zhiji:journal-view", JSON.stringify({ filter: "p1", query: "预算", waiting: "yes" }));
  localStorage.setItem("zhiji:work-entry-draft", JSON.stringify({ id: "draft-1", content: "还没写完的本周材料", kind: "progress", status: "in_progress", occurredOn: "2026-10-02", projectId: "p2", sourceLabel: "随手记" }));
  const invoke = window.__TAURI_INTERNALS__.invoke;
  f.globalReads = 0;
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === "workbench_call" && args.action === "load") { f.globalReads++; if (f.failSearchLoad) throw Error("测试：搜索资料读取失败"); }
    return invoke(command, args);
  };
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seed.toString()})();` });
const box = page.getByRole("combobox", { name: "搜索项目、记录、会议或待办", exact: true });
const list = page.getByRole("listbox", { name: "全局搜索结果" });
const input = page.getByRole("textbox", { name: "工作内容", exact: true });
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await input.waitFor();
  await page.getByRole("button", { name: "工作记录", exact: true }).click();
  assert.equal(await page.locator(".work-entry").count(), 1);
  await box.fill("技术方案 调研");
  const entryOption = list.getByRole("option").filter({ hasText: "工作记录 ·" });
  await entryOption.waitFor();
  assert.match(await entryOption.innerText(), /专题调研/);
  await box.press("Enter");
  const located = page.getByRole("region", { name: "定位的工作记录", exact: true });
  await located.getByText("已收到技术方案，准备补充评审意见", { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "定位的工作记录");
  assert.equal(await input.inputValue(), "还没写完的本周材料", "search locates the record without replacing the active capture draft");
  assert.equal(await page.getByRole("combobox", { name: "筛选项目", exact: true }).count(), 0, "the temporary target view does not show conflicting filters");
  assert.equal(await page.locator(".work-entry").count(), 1);
  assert.equal(await page.evaluate(() => window.__fixture.workCalls.filter(call => call.action === "save_entry").length), 0);
  await box.fill("跨部门评审");
  await list.getByRole("option").waitFor();
  await box.press("Enter");
  await located.getByText("确认下周跨部门评审的时间", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回记录列表", exact: true }).click();
  assert.equal(await page.getByRole("combobox", { name: "筛选项目", exact: true }).inputValue(), "p1");
  assert.equal(await page.getByRole("textbox", { name: "搜索工作记录", exact: true }).inputValue(), "预算");
  assert.equal(await page.getByRole("button", { name: /^等待反馈/ }).getAttribute("aria-pressed"), "true");
  await page.locator(".work-entry").getByText("已完成预算口径核对", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "还没写完的本周材料");

  await box.fill("季度汇报");
  await list.getByRole("option").filter({ hasText: "项目 · 进行中" }).click();
  const hub = page.getByRole("region", { name: "项目详情", exact: true });
  await hub.getByRole("heading", { name: "季度汇报", exact: true }).waitFor();
  await box.fill("历史交付档案");
  await list.getByRole("option").filter({ hasText: "项目 · 已归档" }).click();
  await hub.getByRole("heading", { name: "历史交付档案", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.globalReads), 1, "expanded search reuses the window snapshot rather than loading another copy on each route");

  await box.fill("资料总览");
  await list.getByRole("option").first().waitFor();
  assert.equal(await list.getByRole("option").count(), 12);
  await page.getByText("显示 12 项，共 26 项；补充关键词可缩小范围", { exact: true }).waitFor();
  for (const type of ["项目 ·", "工作记录 ·", "会议 ·", "待办 ·"]) assert.ok(await list.getByRole("option").filter({ hasText: type }).count() > 0, `mixed results retain ${type}`);
  for (let index = 0; index < 12; index++) await box.press("ArrowDown");
  const last = list.getByRole("option").last();
  assert.equal(await last.getAttribute("aria-selected"), "true");
  const popupBox = await page.locator(".global-search-results").boundingBox();
  const lastBox = await last.boundingBox();
  assert.ok(lastBox.y >= popupBox.y && lastBox.y + lastBox.height <= popupBox.y + popupBox.height + 1, "keyboard navigation scrolls the selected result into view");
  const summaryBox = await page.locator(".global-search-summary").boundingBox();
  assert.ok(summaryBox.y >= popupBox.y && summaryBox.y + summaryBox.height <= lastBox.y, "result count remains visible above the scrolling list");
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await box.press("ArrowDown");
  await page.screenshot({ path: ".tmp/ui-verification/workspace-search.png", animations: "disabled" });
  await page.setViewportSize({ width: 400, height: 700 });
  await page.getByRole("button", { name: "展开导航", exact: true }).waitFor();
  await list.waitFor();
  const narrowBox = await page.locator(".global-search-results").boundingBox();
  assert.ok(narrowBox.x >= 0 && narrowBox.x + narrowBox.width <= 400);
  assert.equal(await page.locator(".global-search-results").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({ path: ".tmp/ui-verification/workspace-search-narrow.png", animations: "disabled" });

  await page.evaluate(() => { window.__fixture.failSearchLoad = true; window.__fixture.emit("zhiji://workbench-changed"); });
  await page.getByRole("button", { name: "重试搜索数据", exact: true }).waitFor();
  assert.equal(await list.getByRole("option").count(), 12, "a refresh failure keeps previously readable results");
  await page.evaluate(() => { window.__fixture.failSearchLoad = false; });
  await page.getByRole("button", { name: "重试搜索数据", exact: true }).click();
  await page.getByRole("button", { name: "重试搜索数据", exact: true }).waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log("PASS: project/record search, multi-keyword context, archived projects, exact record location, retained draft/filters, shared reads, fair mixed results and real totals, keyboard scrolling, narrow layout and read retry.");
} finally { await browser.close(); }
