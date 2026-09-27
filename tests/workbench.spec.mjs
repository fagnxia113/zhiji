import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { installFixture } from "./workbench-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const output = new URL("../.tmp/ui-verification/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
await mkdir(decodeURIComponent(output), { recursive: true });
const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: process.env.BROWSER_CHANNEL || "chrome" }), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
await page.addInitScript(installFixture);
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭并收起到托盘", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__fixture.calls.includes("plugin:window|close")), true);
  await page.evaluate(() => { window.__fixture.failWindow = true; });
  await page.getByRole("button", { name: "关闭并收起到托盘", exact: true }).click();
  await page.getByText(/窗口操作失败/).waitFor();
  await page.evaluate(() => { window.__fixture.failWindow = false; });
  await page.getByRole("button", { name: "关闭并收起到托盘", exact: true }).click();
  await page.screenshot({ path: decodeURIComponent(output) + "workbench-light.png", fullPage: true });
  await page.getByRole("button", { name: "1 今天到期", exact: true }).click();
  assert.equal(await page.locator(".task-row").count(), 1);
  await page.getByRole("button", { name: "新建待办", exact: true }).click();
  await page.getByRole("textbox", { name: "待办内容" }).fill("验证失败时保留输入");
  await page.evaluate(() => { window.__fixture.failTask = true; });
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByText(/添加待办失败，请重试/).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "待办内容" }).inputValue(), "验证失败时保留输入");
  await page.evaluate(() => { window.__fixture.failTask = false; });
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.locator(".task-composer").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => window.__fixture.workspace.tasks.filter(t => t.title === "验证失败时保留输入").length), 1);
  await page.getByRole("button", { name: "行动待办", exact: true }).click();
  await page.getByRole("button", { name: "提交首次使用流程方案", exact: true }).click();
  await page.getByRole("textbox", { name: "负责人", exact: true }).fill("李明");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".task-owner").getByText("李明", { exact: true }).waitFor();
  await page.screenshot({ path: decodeURIComponent(output) + "tasks-light.png", fullPage: true });
  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  assert.equal(await page.locator(".meeting-item").count(), 2);
  await page.getByRole("textbox", { name: "搜索会议", exact: true }).fill("绝无结果");
  await page.getByRole("button", { name: "清除筛选" }).click();
  assert.equal(await page.locator(".meeting-item").count(), 3);
  await page.locator(".meeting-item").first().click();
  await page.screenshot({ path: decodeURIComponent(output) + "meeting-light.png", fullPage: true });
  await page.getByRole("textbox", { name: "完整原文", exact: true }).fill("退出前必须保存的原文");
  await page.evaluate(() => window.__fixture.emit("zhiji://request-exit"));
  await page.waitForFunction(() => window.__fixture.calls.includes("finish_app_exit"));
  assert.equal(await page.evaluate(() => window.__fixture.workspace.meetings[0].transcript), "退出前必须保存的原文");
  // 对照阅读：已有纪要的会议默认并排展示原文与纪要
  await page.locator(".meeting-item").nth(1).click();
  // 已整理完成的会议压成一行进度；纪要生成只保留工作流条一处，不在纪要栏重复
  assert.equal(await page.locator(".meeting-journey-card.is-complete").count(), 1);
  assert.equal(await page.getByRole("button", { name: /生成(新版本|纪要)/ }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /更新智能纪要/ }).count(), 1);
  await page.getByRole("button", { name: "对照阅读", exact: true }).click();
  assert.equal(await page.locator(".meeting-contrast .transcript-pane").count(), 1);
  assert.equal(await page.locator(".meeting-contrast .minutes-pane").count(), 1);
  // 分栏必须真的放得下：两栏并排且各自够宽，否则应退回单列（防止把转写正文压到不可读）
  const widePanes = await page.locator(".meeting-contrast > section").evaluateAll(nodes =>
    nodes.map(node => { const rect = node.getBoundingClientRect(); return { x: Math.round(rect.x), width: Math.round(rect.width) }; }));
  assert.equal(widePanes.length, 2);
  assert.notEqual(widePanes[0].x, widePanes[1].x, `宽屏下两栏应并排，实际 ${JSON.stringify(widePanes)}`);
  assert.ok(widePanes.every(pane => pane.width >= 400), `每栏宽度应不低于 400px，实际 ${JSON.stringify(widePanes)}`);
  await page.screenshot({ path: decodeURIComponent(output) + "meeting-split.png", fullPage: true });
  // 容器不够宽时自动退回单列堆叠，而不是硬挤两栏
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.waitForTimeout(200);
  const narrowPanes = await page.locator(".meeting-contrast > section").evaluateAll(nodes =>
    nodes.map(node => Math.round(node.getBoundingClientRect().x)));
  assert.equal(narrowPanes[0], narrowPanes[1], `窄容器应退回单列，实际 ${JSON.stringify(narrowPanes)}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  // 说话人标签轻量化：时间戳折进标签列，正文不再被「时间 + 标签」两列吃掉宽度
  const speakerRows = await page.locator(".speaker-row").evaluateAll(nodes => nodes.map(node => {
    const meta = node.querySelector(".speaker-meta").getBoundingClientRect();
    const text = node.querySelector(".speaker-row-content > p").getBoundingClientRect();
    const seek = node.querySelector(".speaker-seek");
    return {
      meta: Math.round(meta.width),
      text: Math.round(text.width),
      seekOpacity: getComputedStyle(seek).opacity,
      dot: !!node.querySelector(".speaker-dot"),
    };
  }));
  assert.equal(speakerRows.length, 2);
  assert.ok(speakerRows.every(row => row.meta <= 110), `标签列应折到 110px 以内，实际 ${JSON.stringify(speakerRows)}`);
  assert.ok(speakerRows.every(row => row.text >= 380), `正文列应足够宽，实际 ${JSON.stringify(speakerRows)}`);
  assert.ok(speakerRows.every(row => row.dot), "每个说话人都应有色点标识");
  assert.ok(speakerRows.every(row => row.seekOpacity === "0"), `时间戳默认应收起，实际 ${JSON.stringify(speakerRows)}`);
  await page.screenshot({ path: decodeURIComponent(output) + "meeting-speaker-light.png", fullPage: true });
  await page.locator(".speaker-row").first().hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".speaker-row .speaker-seek")).opacity === "1");
  // 折叠必须是逐行的：悬停一行不能让整列时间戳一起冒出来
  const seekAfterHover = await page.locator(".speaker-row .speaker-seek").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).opacity));
  assert.deepEqual(seekAfterHover, ["1", "0"], `悬停只应显现当前行时间戳，实际 ${JSON.stringify(seekAfterHover)}`);
  const dotColors = await page.locator(".speaker-dot").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  assert.notEqual(dotColors[0], dotColors[1], `不同说话人应有不同色点，实际 ${JSON.stringify(dotColors)}`);
  // GFM 表格：marked 输出的是裸 <table>，必须被包进可横向滚动的容器且有表头样式
  assert.equal(await page.locator(".minutes-pane .markdown-table-wrap > table").count(), 1);
  const tableWrap = await page.locator(".minutes-pane .markdown-table-wrap").evaluate(node => ({
    overflowX: getComputedStyle(node).overflowX,
    thBackground: getComputedStyle(node.querySelector("thead th")).backgroundColor,
    cells: node.querySelectorAll("tbody td").length,
  }));
  assert.equal(tableWrap.overflowX, "auto");
  assert.equal(tableWrap.cells, 6);
  assert.notEqual(tableWrap.thBackground, "rgba(0, 0, 0, 0)", `表头应有底色，实际 ${tableWrap.thBackground}`);
  // 标题去重：纪要标题只出现在 pane-head，决策标题只出现在 section-heading
  assert.equal(await page.locator(".minutes-pane > .pane-head > div > h3").count(), 1);
  assert.equal(await page.locator(".minutes-pane .editor-field h3").count(), 0);
  assert.equal(await page.locator(".minutes-pane .section-heading h3").count(), 2);
  // 我的笔记收进抽屉：从 Tab 行打开、编辑、Esc 关闭、自动保存并还焦
  const notesTrigger = page.getByRole("button", { name: /我的笔记/ });
  await notesTrigger.click();
  const notesDrawer = page.getByRole("dialog", { name: "我的笔记" });
  await notesDrawer.waitFor();
  await notesDrawer.getByRole("textbox", { name: "我的笔记" }).fill("抽屉里的观察：客户更在意首次配置耗时。");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "我的笔记"), true);
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
  await page.screenshot({ path: decodeURIComponent(output) + "meeting-notes-drawer.png", fullPage: true });
  await page.keyboard.press("Escape");
  await notesDrawer.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => /我的笔记/.test(document.activeElement?.textContent || "")), true);
  await page.waitForFunction(() => window.__fixture.workspace.meetings.find(m => m.id === "m2")?.notes === "抽屉里的观察：客户更在意首次配置耗时。");
  await page.getByRole("button", { name: "工作台", exact: true }).click();
  await page.getByRole("button", { name: /每周回顾/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('[role="dialog"]')), true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".recent-row")).backgroundColor === "rgb(35, 41, 46)");
  await page.screenshot({ path: decodeURIComponent(output) + "workbench-dark.png", fullPage: true });
  await page.setViewportSize({ width: 400, height: 800 });
  assert.equal(await page.evaluate(() => document.querySelector(".main-content").scrollWidth <= document.querySelector(".main-content").clientWidth), true);
  await page.screenshot({ path: decodeURIComponent(output) + "workbench-narrow.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: close command/error feedback, exit flush, dashboard navigation, task save failure/retry, owner editing, meeting filters, compact done-state chrome, single minutes-generate entry, split pane width/stack fallback, notes drawer autosave/focus, lightweight speaker labels with folded timestamps, GFM table rendering, de-duplicated pane titles, dialog keyboard focus, 400px layout; no page errors.");
  for (const options of [{ failStartup: true }, { failSettings: true }, { empty: true }]) {
    const statePage = await context.newPage();
    await statePage.addInitScript(installFixture, options);
    await statePage.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
    if (options.failStartup) {
      await statePage.getByRole("heading", { name: "暂时无法打开工作台" }).waitFor();
      await statePage.evaluate(() => { window.__fixture.failStartup = false; });
      await statePage.getByRole("button", { name: "重新加载", exact: true }).click();
    }
    await statePage.getByRole("heading", { name: "工作台", exact: true }).waitFor();
    if (options.failSettings) await statePage.getByText("部分功能需要检查", { exact: true }).waitFor();
    if (options.empty) await statePage.getByText("还没有会议，点「一键开始录音」记录第一场。").waitFor();
    await statePage.close();
  }
  console.log("PASS: startup failure and retry, partial settings failure, empty workspace.");
} finally { await browser.close(); }
