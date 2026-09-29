// 回归：会议详情的两个 sticky 元素不得互相遮挡。
// 会议头部（z-index 12）与内容 Tab 行（z-index 6）都在 .meeting-detail 滚动容器里，
// 若 Tab 行也用 top:0，滚动后会被头部整个盖住 —— 导航直接消失。
// 用 elementFromPoint 做命中测试，比只比坐标更能反映「用户点不到」。
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { installFixture } from "./workbench-fixture.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 700 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.addInitScript(installFixture);
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  await page.locator(".meeting-item").first().click();
  await page.waitForTimeout(250);

  const probe = () => page.evaluate(() => {
    const h = document.querySelector(".meeting-detail-header").getBoundingClientRect();
    const t = document.querySelector(".meeting-workspace-tabs").getBoundingClientRect();
    const at = document.elementFromPoint(t.left + t.width / 2, Math.max(1, Math.min(t.top + t.height / 2, innerHeight - 1)));
    return {
      headerBottom: Math.round(h.bottom),
      tabsTop: Math.round(t.top),
      // Tab 行折叠到头部底下时，命中点会落到标题输入框上
      hitsTabs: at ? Boolean(at.closest(".meeting-workspace-tabs")) : false,
      hit: at ? `${at.tagName}.${String(at.className || "").slice(0, 30)}` : null,
    };
  });

  for (const width of [1440, 1280, 1024, 800, 760, 640]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(150);
    await page.mouse.move(Math.min(width - 40, 600), 500);
    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(200);
    const r = await probe();
    assert.ok(r.tabsTop >= r.headerBottom - 1, `${width}px 滚动后 Tab 行应贴在头部下沿，实际 ${JSON.stringify(r)}`);
    assert.equal(r.hitsTabs, true, `${width}px 滚动后 Tab 行被头部遮挡，命中点落在 ${r.hit}`);
  }
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.screenshot({ path: ".tmp/ui-verification/meeting-sticky-tabs.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: 会议详情滚动后内容 Tab 行始终贴在头部下沿且可命中（1440/1280/1024/800/760/640）。");
} finally { await browser.close(); }
