import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function seed() {
  const f = window.__fixture;
  f.work.projects.push({ id: "p1", name: "年度材料", archived: false });
  for (let index = 1; index <= 20; index++) {
    f.work.entries.push({ id: `e${index}`, content: `第${index}项旧进展：整理访谈和汇报材料。`, kind: "progress", status: "in_progress", occurredOn: "2026-09-28", projectId: "p1", sourceLabel: "随手记", updatedAt: "2026-09-28" });
    f.hub.activities.push({ id: `a${index}`, title: `第${index}场调研`, kind: "research", occurredOn: "2026-09-28" });
    f.hub.activityLinks.push({ activityId: `a${index}`, projectId: "p1" });
  }
  localStorage.setItem("zhiji:last-project", "p1");
  const invoke = window.__TAURI_INTERNALS__.invoke;
  f.hubResolvers = [];
  window.__TAURI_INTERNALS__.invoke = async (command, args = {}) => {
    if (command === "workbench_call" && args.action === "load_project_hub" && args.args.projectId && f.pauseHub) await new Promise(resolve => f.hubResolvers.push(resolve));
    return invoke(command, args);
  };
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 700 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seed.toString()})();` });
const nav = name => name === "工作记录" ? { click:async () => {await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"工作台",exact:true}).click();await page.getByRole("button",{name,exact:true}).click();} } : page.getByRole("button", { name, exact: true });
const input = page.getByRole("textbox", { name: "工作内容", exact: true });
const edit = index => page.getByRole("button", { name: `编辑记录：第${index}项旧进展：整理访谈和汇报材料。`, exact: true });
const scrollTo = top => page.locator(".main-content").evaluate((el, y) => { el.scrollTop = y; }, top);
const atPosition = top => page.waitForFunction(y => Math.abs(document.querySelector(".main-content").scrollTop - y) < 3, top);
const releaseHub = () => page.evaluate(() => { const f = window.__fixture; f.pauseHub = false; f.hubResolvers.splice(0).forEach(resolve => resolve()); });
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await input.waitFor();
  await nav("工作记录").click();
  await page.locator(".work-entry").last().waitFor();
  await scrollTo(980); await atPosition(980);
  await nav("项目").click();
  const hub = page.getByRole("region", { name: "项目详情" });
  await hub.getByRole("heading", { name: "年度材料", exact: true }).waitFor();
  await atPosition(0);
  await hub.getByRole("tab", { name: "会议与活动", exact: true }).click();
  await hub.getByText("第20场调研", { exact: true }).waitFor();
  await scrollTo(600); await atPosition(600);
  await nav("工作记录").click(); await atPosition(980);
  await nav("工作台").click(); await atPosition(0);
  await page.evaluate(() => { window.__fixture.pauseHub = true; });
  await nav("项目").click();
  await page.waitForFunction(() => window.__fixture.hubResolvers.length > 0);
  await releaseHub();
  await hub.getByText("第20场调研", { exact: true }).waitFor();
  await atPosition(600);

  await nav("工作台").click();
  await page.evaluate(() => { window.__fixture.pauseHub = true; });
  await nav("项目").click();
  await page.waitForFunction(() => window.__fixture.hubResolvers.length > 0);
  await page.locator(".main-content").dispatchEvent("wheel", { deltaY: -400 });
  await scrollTo(0);
  await releaseHub();
  await hub.getByText("第20场调研", { exact: true }).waitFor();
  await atPosition(0);
  // Allow pending resize notifications to run before checking that user input won.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator(".main-content").evaluate(el => el.scrollTop), 0);

  await hub.getByText("添加活动", { exact: true }).click();
  await hub.getByRole("textbox", { name: "活动名称", exact: true }).waitFor();
  await hub.getByText("活动日期", { exact: true }).click();
  assert.equal(await hub.getByLabel("活动日期", { exact: true }).evaluate(el => document.activeElement === el), true, "visible date label focuses the date input");
  await hub.getByRole("tab", { name: "进展", exact: true }).click();
  await hub.getByText("补充日期、状态与来源", { exact: true }).click();
  await hub.getByText(/^关联活动（可选）/).waitFor();
  await hub.getByText(/^关联资料（可选）/).waitFor();

  await nav("工作记录").click();
  await edit(1).click();
  await page.getByText("正在修改 2026-09-28 的记录", { exact: true }).waitFor();
  await nav("保存修改").waitFor();
  // A loaded, untouched record can be replaced with another selection.
  await edit(2).click();
  assert.match(await input.inputValue(), /^第2项/);
  await input.fill("未保存的旧记录修改");
  await edit(1).click();
  await page.getByRole("alert").getByText(/保存或取消当前修改/).waitFor();
  assert.equal(await input.inputValue(), "未保存的旧记录修改");
  await edit(2).click();
  assert.equal(await input.inputValue(), "未保存的旧记录修改", "selecting the current record does not discard edits");
  await nav("工作台").click();
  assert.equal(await input.inputValue(), "未保存的旧记录修改");
  await page.getByText("正在修改 2026-09-28 的记录", { exact: true }).waitFor();
  await nav("工作记录").click();
  await nav("取消修改").click();
  assert.equal(await input.inputValue(), "");
  assert.match(await page.evaluate(() => window.__fixture.work.entries.find(e => e.id === "e2").content), /^第2项/, "cancel leaves the stored record untouched");

  await edit(1).click();
  await input.fill("旧进展已经核对修正");
  await input.press("Control+Enter");
  await page.getByText("修改已保存，旧版本保留在修改历史中", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.work.entries.length), 20);
  assert.equal(await page.evaluate(() => window.__fixture.work.entries.find(e => e.id === "e1").occurredOn), "2026-09-28");
  assert.equal(await page.evaluate(() => window.__fixture.work.entries.find(e => e.id === "e1").content), "旧进展已经核对修正");
  const row = page.locator(".work-entry").filter({ has: page.getByText("旧进展已经核对修正", { exact: true }) });
  await row.getByRole("button", { name: "修改历史", exact: true }).click();
  const history = page.getByRole("dialog", { name: "工作记录修改历史" });
  await history.getByText("旧进展已经核对修正", { exact: true }).waitFor();
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: /^编辑记录/ }).click();
  await input.fill("今天继续推进汇报材料");
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  await nav("转为新记录").click();
  assert.equal(await page.getByText("正在修改 2026-09-28 的记录", { exact: true }).count(), 0);
  assert.equal(await page.getByLabel("发生日期", { exact: true }).inputValue(), today);
  assert.equal(await input.inputValue(), "今天继续推进汇报材料");
  assert.equal(await page.evaluate(() => window.__fixture.work.entries.length), 20, "converting a draft does not write before explicit save");
  await input.press("Control+Enter");
  await page.getByText("已保存到本地资料库", { exact: true }).waitFor();
  const entries = await page.evaluate(() => window.__fixture.work.entries);
  assert.equal(entries.length, 21);
  assert.equal(entries.find(e => e.id === "e1").content, "旧进展已经核对修正");
  const added = entries.find(e => e.content === "今天继续推进汇报材料");
  assert.ok(added && added.id !== "e1" && added.occurredOn === today && added.projectId === "p1");

  if (!await page.getByLabel("发生日期", { exact: true }).isVisible()) await page.getByText("补充项目、分类与日期", { exact: true }).click();
  await page.getByText("发生日期", { exact: true }).click();
  assert.equal(await page.getByLabel("发生日期", { exact: true }).evaluate(el => document.activeElement === el), true);
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await row.getByRole("button", { name: /^编辑记录/ }).click();
  await page.screenshot({ path: ".tmp/ui-verification/workspace-continuity-journal.png", animations: "disabled" });
  await page.setViewportSize({ width: 400, height: 700 });
  await page.getByRole("navigation",{name:"主导航"}).getByRole("button",{name:"周报",exact:true}).waitFor();
  await page.screenshot({ path: ".tmp/ui-verification/workspace-continuity-journal-narrow.png", animations: "disabled" });
  const fit = await page.locator(".work-journal").evaluate(el => {
    const right = el.getBoundingClientRect().right;
    return { fits: el.scrollWidth <= el.clientWidth + 1, overflow: [...el.querySelectorAll("*")].filter(child => child.getBoundingClientRect().right > right + 1).slice(0, 8).map(child => ({ tag: child.tagName, class: child.className, text: child.textContent.slice(0, 60), width: child.getBoundingClientRect().width })) };
  });
  assert.equal(fit.fits, true, JSON.stringify(fit.overflow));
  const fields = await page.locator(".work-capture .form-grid > label").evaluateAll(nodes => nodes.map(el => el.getBoundingClientRect().toJSON()));
  assert.ok(fields.every((box, index) => !index || box.top >= fields[index - 1].bottom), "narrow forms show each visible label above its control in one column");
  await edit(20).hover();
  const tooltip = edit(20).locator("..").getByRole("tooltip");
  await tooltip.waitFor();
  const tipBox = await tooltip.boundingBox();
  assert.ok(tipBox.x >= 0 && tipBox.x + tipBox.width <= 400, "long record tooltips stay within the narrow window");
  assert.equal(await page.locator(".work-journal").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, "showing a record tooltip does not widen the journal");
  assert.deepEqual(errors, []);
  console.log("PASS: independent page positions, delayed project restoration, user interaction cancels restoration, visible form labels, safe record switching/cancel, retained editing draft, old-date correction and explicit new-record copy.");
} finally { await browser.close(); }
