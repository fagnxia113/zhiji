import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function installReportScenario() {
  const fixture = window.__fixture;
  const today = new Date(); today.setDate(today.getDate() - (today.getDay() + 6) % 7);
  const key = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const start = key(today);
  fixture.workspace.meetings = [];
  fixture.work.projects.push({ id: "p1", name: "客户交付", archived: false }, { id: "p2", name: "产品规划", archived: false });
  fixture.work.entries.push(...[
    { id: "e1", content: "本周完成方案评审", projectId: "p1" },
    { id: "e2", content: "内部参考笔记", projectId: "p1" },
    { id: "e3", content: "下版需求整理完成", projectId: "p2" },
  ].map(e => ({ ...e, occurredOn: start, status: "done", kind: "achievement", sourceLabel: "", createdAt: today.toISOString(), updatedAt: today.toISOString() })));
  fixture.reports.push(...[
    { id: "old-p1", weekStart: "2026-09-21", projectId: "p1", content: "# 客户交付历史周报" },
    { id: "old-p2", weekStart: "2026-09-14", projectId: "p2", content: "# 产品规划历史周报" },
  ].map(r => ({ ...r, sources: [], warnings: [], createdAt: "2026-09-27T12:00:00Z", updatedAt: "2026-09-27T12:00:00Z" })));
  const state = window.__reportScenario = { start, holdMaterial: true, failArchive: true, failMaterial: false, holdGenerate: false, holdSave: false, pendingMaterials: [], writes: [] };
  const original = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command !== "workbench_call") return original(command, args);
    if (args.action === "list_reports" && state.failArchive) throw Error("测试：档案读取失败");
    if (args.action === "report_material") {
      if (state.failMaterial) throw Error("测试：材料暂不可用");
      const result = await original(command, args);
      const end = new Date(args.args.weekStart + "T12:00:00"); end.setDate(end.getDate() + 6); result.weekEnd = key(end);
      result.sources = result.sources.filter(s => s.date >= args.args.weekStart && s.date <= result.weekEnd);
      if (state.holdMaterial) await new Promise(resolve => state.pendingMaterials.push(resolve));
      return result;
    }
    if (["generate_report", "save_report"].includes(args.action)) {
      state.writes.push(structuredClone(args));
      if (args.action === "generate_report" && state.holdGenerate) await new Promise(resolve => { state.resumeGenerate = resolve; });
      if (args.action === "save_report" && state.holdSave) await new Promise(resolve => { state.resumeSave = resolve; });
    }
    return original(command, args);
  };
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
const errors = []; page.on("pageerror", e => errors.push(e.message));
await page.addInitScript(installFixture);
await page.addInitScript(installReportScenario);
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("heading", { name: "工作台", exact: true }).waitFor();
  await page.getByRole("button", { name: "周报", exact: true }).click();
  const dialog = page.getByRole("region", { name: "周报工作区" });
  const compose = dialog.getByRole("complementary", { name: "整理新周报" });
  const draft = dialog.getByRole("button", { name: "整理草稿", exact: true });
  const ai = dialog.getByRole("button", { name: "AI 生成周报", exact: true });
  const date = dialog.getByLabel("起始日期（连续七天）");
  const project = dialog.getByRole("combobox", { name: "周报范围", exact: true });
  const archive = dialog.getByRole("combobox", { name: "周报档案", exact: true });
  const editor = dialog.getByRole("textbox", { name: "周报正文", exact: true });
  const saved = dialog.getByRole("region", { name: "当前周报正文" });
  const start = await page.evaluate(() => window.__reportScenario.start);
  await dialog.getByText("正在读取本次范围的材料…", { exact: true }).waitFor();
  assert.equal(await draft.isDisabled(), true);
  assert.equal(await compose.getByText(/当前范围没有材料/).count(), 0, "loading is not presented as an empty week");
  await dialog.getByRole("alert").getByText(/周报档案读取失败/).waitFor();
  await page.evaluate(() => { const s = window.__reportScenario; s.failArchive = false; s.holdMaterial = false; s.pendingMaterials.splice(0).forEach(resolve => resolve()); });
  await dialog.getByRole("button", { name: "重新读取档案", exact: true }).click();
  await archive.waitFor();
  await compose.getByText("待汇总材料 · 已选 3 / 3 条", { exact: true }).waitFor();

  await archive.selectOption("old-p1");
  await saved.getByText("2026-09-21 至 2026-09-27 · 客户交付", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const body = document.querySelector(".report-saved").getBoundingClientRect();
    const main = document.querySelector(".main-content").getBoundingClientRect();
    return body.top >= main.top - 1 && body.top < main.bottom;
  });
  assert.match(await dialog.locator(".report-range").innerText(), new RegExp(start));
  assert.match(await dialog.locator(".report-range").innerText(), /全部项目/);
  await editor.fill("# 正在核对的旧周报");
  await date.fill("2025-01-06"); await project.selectOption("project:p2");
  await compose.getByText(/当前范围没有材料/).waitFor();
  assert.equal(await draft.isDisabled(), true);
  assert.equal(await editor.inputValue(), "# 正在核对的旧周报", "changing generation range preserves the archived report draft");
  await archive.selectOption("old-p2");
  await dialog.getByRole("alert").getByText("请先保存当前修改，再切换周报。", { exact: true }).waitFor();
  assert.equal(await archive.inputValue(), "old-p1");
  await date.fill(start); await project.selectOption("project:p1");
  await compose.getByText("待汇总材料 · 已选 2 / 2 条", { exact: true }).waitFor();
  await draft.click();
  await dialog.getByRole("alert").getByText("请先保存当前修改，再生成新版本。", { exact: true }).waitFor();
  await page.getByRole("button",{name:"项目",exact:true}).click();
  await page.getByRole("button",{name:"周报",exact:true}).click();
  assert.equal(await editor.inputValue(), "# 正在核对的旧周报", "leaving the report preserves unsaved edits");
  assert.equal(await page.evaluate(() => window.__reportScenario.writes.length), 0);
  await editor.fill("# 客户交付历史周报");

  const excluded = compose.getByRole("checkbox", { name: "纳入周报：内部参考笔记", exact: true });
  await excluded.uncheck();
  await page.evaluate(() => { window.__fixture.emit("zhiji://workbench-changed"); });
  await compose.getByText("待汇总材料 · 已选 1 / 2 条", { exact: true }).waitFor();
  assert.equal(await compose.locator(".report-sources").evaluate(el => el.open), true, "external updates preserve the expanded material list");
  assert.equal(await excluded.isChecked(), false, "external updates preserve exclusions for the same range");
  const included = compose.getByRole("checkbox", { name: "纳入周报：本周完成方案评审", exact: true });
  await included.uncheck();
  await compose.getByText("至少勾选一条材料后再生成周报。", { exact: true }).waitFor();
  assert.equal(await draft.isDisabled(), true); assert.equal(await ai.isDisabled(), true);
  await included.check();
  await page.evaluate(() => { window.__reportScenario.failMaterial = true; window.__fixture.emit("zhiji://workbench-changed"); });
  await compose.getByRole("alert").getByText(/材料读取失败/).waitFor();
  assert.equal(await draft.isDisabled(), true);
  await page.evaluate(() => { window.__reportScenario.failMaterial = false; });
  await compose.getByRole("button", { name: "重新读取材料", exact: true }).click();
  await compose.getByText("待汇总材料 · 已选 1 / 2 条", { exact: true }).waitFor();
  assert.equal(await compose.locator(".report-sources").evaluate(el => el.open), true, "retry keeps the material list open");

  await page.evaluate(() => { window.__reportScenario.holdGenerate = true; });
  await draft.evaluate(el => { el.click(); el.click(); Array.from(document.querySelectorAll("button")).find(b => b.textContent === "AI 生成周报").click(); });
  await page.waitForFunction(() => !!window.__reportScenario.resumeGenerate);
  assert.equal(await page.evaluate(() => window.__reportScenario.writes.filter(w => w.action === "generate_report").length), 1, "synchronous generate requests are mutually exclusive");
  assert.equal(await date.isDisabled(), true); assert.equal(await archive.isDisabled(), true);
  await page.evaluate(() => { const s = window.__reportScenario; s.holdGenerate = false; s.resumeGenerate(); });
  await dialog.getByText("已生成并保存新版本，历史周报保留", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const body = document.querySelector(".report-saved").getBoundingClientRect();
    const main = document.querySelector(".main-content").getBoundingClientRect();
    return body.top >= main.top - 1 && body.top < main.bottom;
  });
  assert.deepEqual(await page.evaluate(() => window.__fixture.reports[0].sources.map(s => s.id)), ["e1"]);
  assert.equal(await page.evaluate(() => window.__fixture.reports.length), 3);

  await editor.fill("# 完成核对的新周报");
  await page.evaluate(() => { window.__reportScenario.holdSave = true; });
  await saved.getByRole("button", { name: "保存修改", exact: true }).evaluate(el => { el.click(); el.click(); Array.from(document.querySelectorAll("button")).find(b => b.textContent === "整理草稿").click(); });
  await page.waitForFunction(() => !!window.__reportScenario.resumeSave);
  assert.equal(await page.evaluate(() => window.__reportScenario.writes.filter(w => w.action === "save_report").length), 1, "synchronous save requests use the same operation lock");
  assert.equal(await page.evaluate(() => window.__reportScenario.writes.filter(w => w.action === "generate_report").length), 1, "generation cannot begin while saving");
  await saved.getByText("正在保存修改…", { exact: true }).waitFor();
  await page.evaluate(() => { const s = window.__reportScenario; s.holdSave = false; s.resumeSave(); });
  await dialog.getByText("修改已保存", { exact: true }).waitFor();
  await date.fill("");
  await dialog.getByText("请选择起始日期，汇总连续七天的工作。", { exact: true }).waitFor();
  assert.equal(await draft.isDisabled(), true);
  await date.fill(start);
  await compose.getByText("待汇总材料 · 已选 2 / 2 条", { exact: true }).waitFor();
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await page.screenshot({ path: ".tmp/ui-verification/weekly-report-workflow.png", fullPage: true });
  await page.setViewportSize({ width: 400, height: 800 });
  assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, "report controls and editor fit a narrow window");
  const draftBounds = await draft.boundingBox(); const aiBounds = await ai.boundingBox();
  await page.screenshot({ path: ".tmp/ui-verification/weekly-report-workflow-narrow.png", fullPage: true });
  assert.ok(aiBounds.width >= 140 && aiBounds.height < 48 && Math.abs(aiBounds.y - draftBounds.y) < 1, `narrow generation buttons remain readable on one row: ${JSON.stringify({ draftBounds, aiBounds })}`);
  assert.deepEqual(errors, []);
  console.log("PASS: report scope identity, material loading/empty/error/retry, archive retry, dirty guards, preserved exclusions, zero-selection guard, synchronous generate/save locks, narrow layout.");
} finally { await browser.close(); }
