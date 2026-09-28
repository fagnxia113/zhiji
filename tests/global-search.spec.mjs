import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";
await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const page = await context.newPage(); const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.addInitScript(installFixture);
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();

  // 全局搜索框必须是 combobox：初始收起、无 listbox、无活动项
  const box = page.getByRole("combobox", { name: "搜索会议、笔记与待办", exact: true });
  assert.equal(await box.getAttribute("aria-expanded"), "false");
  assert.equal(await box.getAttribute("aria-activedescendant"), null);
  assert.equal(await page.getByRole("listbox", { name: "全局搜索结果" }).count(), 0);

  // 输入后展开 listbox，并把 combobox 与结果列表用 aria-controls 关联
  await box.fill("客户");
  const list = page.getByRole("listbox", { name: "全局搜索结果" });
  await list.waitFor();
  assert.equal(await box.getAttribute("aria-expanded"), "true");
  assert.equal(await box.getAttribute("aria-controls"), "global-search-listbox");
  assert.equal(await box.getAttribute("aria-activedescendant"), null);
  const options = list.getByRole("option");
  assert.ok(await options.count() >= 2, `「客户」应命中会议与待办，实际 ${await options.count()} 项`);

  // 方向键移动活动项：aria-activedescendant 跟随，且高亮项同步 aria-selected
  await box.press("ArrowDown");
  assert.equal(await box.getAttribute("aria-activedescendant"), "global-search-option-0");
  assert.equal(await page.locator("#global-search-option-0").getAttribute("aria-selected"), "true");
  await box.press("ArrowDown");
  assert.equal(await box.getAttribute("aria-activedescendant"), "global-search-option-1");
  await box.press("ArrowUp");
  assert.equal(await box.getAttribute("aria-activedescendant"), "global-search-option-0");
  // 循环：从首项再向上应回到末项
  await box.press("ArrowUp");
  const lastIndex = (await options.count()) - 1;
  assert.equal(await box.getAttribute("aria-activedescendant"), `global-search-option-${lastIndex}`);
  // 视觉凭据：结果面板打开且首项高亮
  await box.press("ArrowDown");
  await page.screenshot({ path: ".tmp/ui-verification/global-search-open.png", fullPage: true });

  // Escape 清空查询并收起面板
  await box.press("Escape");
  await list.waitFor({ state: "detached" });
  assert.equal(await box.inputValue(), "");

  // 点击面板外部应收起，但保留已输入的关键词（只收面板不丢输入）
  await box.fill("客户");
  await list.waitFor();
  await page.locator(".page-heading-copy h1").click();
  await list.waitFor({ state: "detached" });
  assert.equal(await box.inputValue(), "客户");
  await box.press("Escape");

  // 键盘打开会议：方向键选中后 Enter 进入会议详情并保焦清空
  await box.fill("九月项目");
  await list.waitFor();
  await box.press("ArrowDown");
  await box.press("Enter");
  await list.waitFor({ state: "detached" });
  assert.equal(await box.inputValue(), "");
  await page.getByRole("textbox", { name: "会议标题" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "会议标题" }).inputValue(), "九月项目推进与交付计划");
  await page.screenshot({ path: ".tmp/ui-verification/global-search-meeting.png", fullPage: true });

  // 鼠标点击待办结果：切到「待办」视图（仅命中待办，不含同名的会议纪要表格）
  await box.fill("安排下周项目复盘");
  await list.waitFor();
  assert.equal(await list.getByRole("option").count(), 1);
  await list.getByRole("option").first().click();
  await page.getByRole("heading", { name: "待办", exact: true }).waitFor();
  await list.waitFor({ state: "detached" });

  assert.deepEqual(errors, []);
  console.log("PASS: global search combobox semantics, aria-controls/activedescendant, arrow-key highlight with wrap, Escape clear, outside-click dismiss keeping query, Enter opens meeting, click opens task view.");
} finally { await browser.close(); }
