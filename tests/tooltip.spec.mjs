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

// 取某个提示触发器的气泡状态（气泡是触发器的兄弟节点）
const bubbleOf = (trigger) => trigger.locator("xpath=..").locator(".tooltip-bubble");
// 气泡不得越出视口：hover 到的触发器只要贴边就可能被裁掉
const assertBubbleInViewport = async (bubble, what) => {
  const box = await bubble.evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  assert.ok(box.left >= 0 && box.right <= page.viewportSize().width, `${what} 气泡横向越出视口：${JSON.stringify(box)}`);
  assert.ok(box.top >= 0 && box.bottom <= page.viewportSize().height, `${what} 气泡纵向越出视口：${JSON.stringify(box)}`);
};
const assertInViewport = (trigger, what) => assertBubbleInViewport(bubbleOf(trigger), what);

// 系统性扫描：把当前页面所有可见触发器逐个悬停并断言气泡没被裁掉。
// 比逐个手写断言更能捕获「靠边触发器忘了对齐」这类遗漏。
const sweepTooltips = async (what) => {
  const anchors = page.locator(".tooltip-anchor:visible");
  const total = await anchors.count();
  assert.ok(total > 0, `${what} 应存在提示触发器`);
  const labels = [];
  for (let i = 0; i < total; i++) {
    const anchor = anchors.nth(i);
    const label = (await anchor.locator(".tooltip-bubble").evaluate(el => el.textContent.trim())) || "(空)";
    await anchor.hover();
    await page.waitForTimeout(60);
    await assertBubbleInViewport(anchor.locator(".tooltip-bubble"), `${what}·${label}`);
    labels.push(label);
  }
  return labels;
};

try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  await page.locator(".meeting-item").filter({ hasText: "客户访谈" }).first().click();
  await page.locator(".minutes-pane .pane-head").first().waitFor();

  // 1. 工具栏已图标化：按钮无文字、有可访问名称、且**不再依赖原生 title**
  const iconButtons = page.locator(".pane-action.icon-only");
  assert.ok(await iconButtons.count() >= 4, `会议详情工具栏应有 ≥4 个图标按钮，实际 ${await iconButtons.count()}`);
  const meta = await iconButtons.evaluateAll(ns => ns.map(n => ({
    text: n.textContent.trim(),
    aria: n.getAttribute("aria-label"),
    hasTitle: n.hasAttribute("title"),
  })));
  assert.ok(meta.every(m => m.text === ""), `图标按钮不应再有可见文字，实际 ${JSON.stringify(meta.map(m => m.text))}`);
  assert.ok(meta.every(m => m.aria), `图标按钮必须有 aria-label，实际 ${JSON.stringify(meta.map(m => m.aria))}`);
  assert.ok(meta.every(m => !m.hasTitle), "提示不应再用原生 title（改为气泡）");

  // 2. 悬停弹出气泡，文案与配色走令牌
  const copyBtn = page.locator(".pane-action.icon-only").first();
  assert.equal((await bubbleOf(copyBtn).evaluate(el => getComputedStyle(el).visibility)), "hidden", "未悬停时气泡应隐藏");
  await copyBtn.hover();
  await page.waitForTimeout(200);
  const light = await bubbleOf(copyBtn).evaluate(el => ({
    text: el.textContent.trim(),
    visibility: getComputedStyle(el).visibility,
    opacity: getComputedStyle(el).opacity,
    bg: getComputedStyle(el).backgroundColor,
    fg: getComputedStyle(el).color,
  }));
  assert.equal(light.visibility, "visible");
  assert.equal(light.opacity, "1");
  assert.equal(light.text, "复制完整原文到剪贴板");
  assert.equal(light.bg, "rgb(43, 43, 43)");
  assert.equal(light.fg, "rgb(255, 255, 255)");
  // 视口级截图（fullPage 会重置 hover 状态，看不到气泡）
  await page.screenshot({ path: ".tmp/ui-verification/tooltip-light.png" });
  // 会议详情全量扫描：任何靠边的图标按钮都不许被裁掉
  await sweepTooltips("会议详情");

  // 2b. 窄屏（400px）下工具栏气泡同样不得被视口裁掉
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(200);
  await sweepTooltips("会议详情·400px");
  await page.screenshot({ path: ".tmp/ui-verification/tooltip-narrow.png" });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(200);

  // 3. 禁用按钮同样能弹提示——原生 title 在 disabled 上不触发，这是改用气泡的核心理由
  await page.getByRole("button", { name: /会议问答/ }).click();
  const send = page.getByRole("button", { name: "发送问题" });
  await send.waitFor();
  assert.equal(await send.isDisabled(), true, "空输入时发送按钮应为禁用");
  await send.hover();
  await page.waitForTimeout(200);
  assert.equal(await bubbleOf(send).evaluate(el => getComputedStyle(el).visibility), "visible", "禁用按钮也应弹出提示");
  assert.equal(await bubbleOf(send).evaluate(el => el.textContent.trim()), "发送问题（Enter）");
  await assertInViewport(send, "问答面板发送按钮");

  // 4. 深色主题下气泡反转为浅底深字
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.style.colorScheme = "dark";
  });
  await send.hover();
  await page.waitForTimeout(200);
  const dark = await bubbleOf(send).evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, fg: getComputedStyle(el).color }));
  assert.equal(dark.bg, "rgb(239, 239, 239)", "深色主题气泡应为浅底");
  assert.equal(dark.fg, "rgb(27, 27, 27)", "深色主题气泡应为深字");
  await page.screenshot({ path: ".tmp/ui-verification/tooltip-dark.png" });
  await page.evaluate(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  // 5. 待办行的「来源」也图标化并带提示
  await page.getByRole("button", { name: "行动待办", exact: true }).click();
  const source = page.locator("button.task-source.icon-only").first();
  await source.waitFor();
  assert.equal((await source.innerText()).trim(), "");
  await source.hover();
  await page.waitForTimeout(200);
  const tip = await bubbleOf(source).evaluate(el => el.textContent.trim());
  assert.ok(/打开来源(会议|笔记)/.test(tip), `来源按钮提示应说明去向，实际「${tip}」`);

  // 6. IconButton 全量改用气泡：图标按钮不再挂原生 title（否则原生提示与气泡会重复弹）
  const iconBtnTitle = await page.locator(".icon-btn").evaluateAll(ns => ns.map(n => n.getAttribute("title")));
  assert.ok(iconBtnTitle.length > 0, "待办页应存在图标按钮");
  assert.ok(iconBtnTitle.every(t => t === null), `图标按钮不应再有原生 title，实际 ${JSON.stringify(iconBtnTitle)}`);
  const rowEdit = page.locator(".task-row .icon-btn").first();
  await rowEdit.hover();
  await page.waitForTimeout(200);
  assert.ok((await bubbleOf(rowEdit).evaluate(el => el.textContent.trim())).length > 0, "图标按钮应弹出气泡");
  await sweepTooltips("待办列表");

  // 7. 说话人行「修改这段文字」：补上原先缺失的 aria-label，且 hover 显隐机制未被包裹层破坏。
  // 回到会议资料后先前选中的会议仍在详情面板，无需再点列表项。
  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  await page.locator(".speaker-row:visible").first().waitFor();
  // 转写面板在 DOM 里可能同时存在宽/窄两份副本，断言一律限定可见实例
  const editSeg = page.locator(".speaker-row:visible .speaker-row-content .icon-btn").first();
  assert.equal(await editSeg.getAttribute("aria-label"), "修改这段文字", "说话人文段按钮应有可访问名称");
  assert.equal(await editSeg.evaluate(el => getComputedStyle(el).opacity), "0", "默认应收起");
  await page.locator(".speaker-row:visible").first().hover();
  // `:visible` 是 Playwright 专有语法，页面内只能用原生的尺寸判据
  await page.waitForFunction(() => {
    const shown = [...document.querySelectorAll(".speaker-row-content .icon-btn")].find(b => b.getBoundingClientRect().width > 0);
    return Boolean(shown) && getComputedStyle(shown).opacity === "1";
  });
  await editSeg.hover();
  await page.waitForTimeout(200);
  assert.equal(await bubbleOf(editSeg).evaluate(el => el.textContent.trim()), "修改这段文字");

  // 8. 工作记录行「编辑」按钮图标化 + 气泡
  await page.getByRole("button", { name: "工作记录", exact: true }).click();
  await page.getByRole("textbox", { name: "工作内容" }).fill("记录一条用于验证提示的进展");
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await page.locator(".work-entry").first().waitFor();
  const entryEdit = page.locator(".work-entry footer .icon-btn").first();
  assert.equal(await entryEdit.getAttribute("title"), null, "记录行编辑按钮不应有原生 title");
  await entryEdit.hover();
  await page.waitForTimeout(200);
  const entryTip = await bubbleOf(entryEdit).evaluate(el => el.textContent.trim());
  assert.ok(/^编辑记录：/.test(entryTip), `记录行编辑提示应说明对象，实际「${entryTip}」`);
  await page.screenshot({ path: ".tmp/ui-verification/tooltip-journal.png" });
  // 工作记录页全量扫描（含最右侧的记录行编辑按钮）
  await sweepTooltips("工作记录");

  // 9. 设置页：本地接入面板的图标按钮也走气泡，并全量扫描
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /本地 API \/ MCP/ }).click();
  await page.getByRole("button", { name: "开启本地接入", exact: true }).click();
  const refreshCalls = page.getByRole("button", { name: "刷新最近调用" });
  await refreshCalls.waitFor();
  assert.equal(await refreshCalls.getAttribute("title"), null, "设置页图标按钮不应有原生 title");
  await refreshCalls.hover();
  await page.waitForTimeout(200);
  assert.equal(await bubbleOf(refreshCalls).evaluate(el => el.textContent.trim()), "重新读取最近的调用记录");
  await sweepTooltips("设置·本地接入");

  assert.deepEqual(errors, []);
  console.log("PASS: 工具栏/待办/说话人/工作记录/设置 图标按钮无文字且有 aria-label、不再用原生 title；气泡文案与配色（含深色主题）正确；禁用按钮同样弹提示；气泡自动避让，全量扫描无越界（含 400px）。");
} finally { await browser.close(); }
