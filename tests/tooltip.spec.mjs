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
const assertInViewport = async (trigger, what) => {
  const box = await bubbleOf(trigger).evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
  assert.ok(box.left >= 0 && box.right <= page.viewportSize().width, `${what} 气泡横向越出视口：${JSON.stringify(box)}`);
  assert.ok(box.top >= 0 && box.bottom <= page.viewportSize().height, `${what} 气泡纵向越出视口：${JSON.stringify(box)}`);
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

  // 6. 窄屏（400px）下气泡同样不得被视口裁掉
  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(200);
  const narrowTarget = page.locator(".pane-action.icon-only").first();
  if (await narrowTarget.count()) {
    await narrowTarget.hover();
    await page.waitForTimeout(200);
    await assertInViewport(narrowTarget, "400px 窄屏工具栏按钮");
    await page.screenshot({ path: ".tmp/ui-verification/tooltip-narrow.png" });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  assert.deepEqual(errors, []);
  console.log("PASS: 图标化工具栏无文字且有 aria-label、不再用原生 title；悬停/深色主题气泡文案与配色正确；禁用按钮同样弹提示；待办来源按钮图标化。");
} finally { await browser.close(); }
