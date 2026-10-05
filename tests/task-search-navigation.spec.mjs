import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function seed() {
  window.__fixture.workspace.tasks.push({ id: "t4", title: "核对已完成的报送材料", sourceType: null, sourceId: null, completed: true, dueDate: null, createdAt: new Date().toISOString(), owner: "林晨" });
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seed.toString()})();` });

try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("button", { name: "行动待办", exact: true }).click();
  const scope = page.getByRole("group", { name: "待办范围", exact: true });
  await scope.getByRole("button", { name: /^今天到期/ }).click();
  const localQuery = page.getByRole("textbox", { name: "搜索待办", exact: true });
  await localQuery.fill("提交");
  await page.getByRole("combobox", { name: "筛选负责人", exact: true }).selectOption("陈雨");
  const originalRow = page.getByRole("group", { name: "待办：提交首次使用流程方案", exact: true });
  await originalRow.getByRole("button", { name: "编辑", exact: true }).click();
  await originalRow.getByRole("textbox", { name: "待办内容", exact: true }).fill("未保存的流程修改");
  await page.getByRole("button", { name: "新建待办", exact: true }).click();
  const composer = page.locator(".task-composer").getByRole("textbox", { name: "待办内容", exact: true });
  await composer.fill("尚未保存的新待办");

  const globalQuery = page.getByRole("combobox", { name: "搜索项目、记录、会议或待办", exact: true });
  const searchResults = page.getByRole("listbox", { name: "全局搜索结果" });
  await globalQuery.fill("核对已完成的报送材料");
  await searchResults.getByRole("option").filter({ hasText: "待办 ·" }).click();
  const completedRow = page.getByRole("group", { name: "待办：核对已完成的报送材料", exact: true });
  await completedRow.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "待办：核对已完成的报送材料");
  assert.equal(await page.locator(".task-row:visible").count(), 1, "search shows a completed task even when excluded by every original filter");
  assert.equal(await scope.isVisible(), false);
  assert.equal(await composer.inputValue(), "尚未保存的新待办", "locating a task preserves the new-task draft");
  await completedRow.getByRole("checkbox", { name: "重新打开待办：核对已完成的报送材料" }).click();
  await completedRow.getByRole("checkbox", { name: "完成待办：核对已完成的报送材料" }).waitFor();
  assert.equal(await completedRow.isVisible(), true, "toggling completion does not hide the located task");
  await completedRow.getByRole("checkbox", { name: "完成待办：核对已完成的报送材料" }).focus();
  await page.keyboard.press("Space");
  await completedRow.getByRole("checkbox", { name: "重新打开待办：核对已完成的报送材料" }).waitFor();
  await page.keyboard.press("Space");
  await completedRow.getByRole("checkbox", { name: "完成待办：核对已完成的报送材料" }).waitFor();

  await globalQuery.fill("整理客户访谈要点");
  await searchResults.waitFor();
  const taskIndex = await searchResults.getByRole("option").evaluateAll(options => options.findIndex(option => option.textContent.includes("待办 ·")));
  assert.ok(taskIndex >= 0, "the search contains a task result");
  for (let index = 0; index <= taskIndex; index++) await globalQuery.press("ArrowDown");
  await globalQuery.press("Enter");
  const nextRow = page.getByRole("group", { name: "待办：整理客户访谈要点", exact: true });
  await nextRow.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "待办：整理客户访谈要点");
  assert.equal(await page.locator(".task-row:visible").count(), 1, "a second search replaces the located result on the same page");
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await page.screenshot({ path: ".tmp/ui-verification/task-search-navigation.png", fullPage: true });

  await page.getByRole("button", { name: "返回待办列表", exact: true }).click();
  await localQuery.waitFor();
  assert.equal(await localQuery.inputValue(), "提交");
  assert.equal(await page.getByRole("combobox", { name: "筛选负责人", exact: true }).inputValue(), "陈雨");
  assert.equal(await scope.getByRole("button", { name: /^今天到期/ }).getAttribute("aria-pressed"), "true");
  assert.equal(await originalRow.getByRole("textbox", { name: "待办内容", exact: true }).inputValue(), "未保存的流程修改", "the original inline edit survives locating other tasks");
  assert.equal(await composer.inputValue(), "尚未保存的新待办");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "搜索待办");

  await globalQuery.fill("整理客户访谈要点");
  await searchResults.getByRole("option").filter({ hasText: "待办 ·" }).click();
  page.once("dialog", dialog => dialog.accept());
  await nextRow.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByText("这条待办已被删除或暂时不可用。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回待办列表", exact: true }).click();
  assert.equal(await localQuery.inputValue(), "提交");
  assert.equal(await originalRow.getByRole("textbox", { name: "待办内容", exact: true }).inputValue(), "未保存的流程修改");
  assert.deepEqual(errors, []);
  console.log("PASS: task search locates completed/filtered targets, restores keyboard focus, switches targets, retains filters and inline/composer drafts, and handles target deletion.");
} finally { await browser.close(); }
