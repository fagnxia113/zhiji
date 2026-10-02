import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function seed() {
  const f = window.__fixture;
  f.work.projects.push({ id: "p1", name: "季度汇报", archived: false }, { id: "p2", name: "专题调研", archived: false });
  f.hub.profiles.push({ projectId: "p1", goal: "准备季度汇报", stage: "初稿评审" });
  f.hub.activities.push({ id: "a1", title: "成果评审", kind: "review", occurredOn: "2026-10-02", meetingId: "m1" });
  f.hub.activityLinks.push({ activityId: "a1", projectId: "p1" });
  for (let i = 0; i < 45; i++) {
    const id = `r${i}`;
    f.hub.resources.push({ id, title: `参考资料${i}.docx`, path: `D:\\资料\\参考资料${i}.docx`, contentStatus: "metadata_only" });
    f.hub.resourceLinks.push({ resourceId: id, projectId: "p1", role: "reference" });
  }
  f.hub.resourceActivities.push({ resourceId: "r0", activityId: "a1", role: "output" });
  for (let i = 0; i < 7; i++) f.work.entries.push({ id: `e${i}`, projectId: "p1", content: `已核对第${i + 1}部分`, occurredOn: "2026-10-02", updatedAt: `2026-10-02T0${i}:00:00`, status: "in_progress" });
  localStorage.setItem("zhiji:last-project", "p1");
  if (!localStorage.getItem("zhiji:project-view:p1")) localStorage.setItem("zhiji:project-view:p1", JSON.stringify({ tab: "removed-tab", resourceId: "removed-file", fileQuery: "", fileActivityId: "removed-activity", listScroll: "NaN" }));
}

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seed.toString()})();` });
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  const resume = page.getByRole("region", { name: "继续上次项目" });
  assert.ok(await resume.evaluate(el => el.getBoundingClientRect().top) < await page.locator(".home-command-card").evaluate(el => el.getBoundingClientRect().top));
  await resume.getByRole("button", { name: "继续项目" }).click();
  const hub = page.getByRole("region", { name: "项目详情" });
  const tab = name => hub.getByRole("tab", { name, exact: true });
  await hub.locator(".hub-overview").getByText("准备季度汇报", { exact: true }).waitFor();
  assert.equal(await tab("概览").getAttribute("aria-selected"), "true", "invalid saved tabs fall back safely");
  assert.equal(await page.getByRole("navigation", { name: "项目列表" }).isVisible(), false, "project list does not consume the normal workspace");
  assert.equal(await hub.getByRole("textbox", { name: "项目进展内容" }).isVisible(), false);
  await hub.getByRole("region", { name: "项目当前行动" }).getByText("提交首次使用流程方案", { exact: true }).waitFor();
  assert.equal(await hub.getByRole("region", { name: "项目最近进展" }).locator("article").count(), 3);

  // Arrow keys follow desktop tab conventions; all history is available in the progress view.
  await tab("概览").focus();
  await tab("概览").press("End");
  assert.equal(await tab("进展").getAttribute("aria-selected"), "true");
  assert.equal(await hub.getByRole("region", { name: "项目最近进展" }).locator("article").count(), 7);
  await hub.getByRole("textbox", { name: "项目进展内容" }).fill("已整理评审反馈，准备修改第三部分");
  await hub.getByRole("combobox", { name: "当前活动", exact: true }).selectOption("a1");
  await hub.getByRole("combobox", { name: "进展关联资料" }).selectOption("r0");
  await tab("活动").click();
  await hub.getByText("添加活动", { exact: true }).click();
  await hub.getByRole("textbox", { name: "活动名称" }).fill("下次汇报准备");
  await hub.getByRole("button", { name: "保存活动", exact: true }).click();
  await hub.getByText("活动已保存，可以添加本次资料和进展", { exact: true }).waitFor();
  await tab("进展").click();
  assert.equal(await hub.getByRole("combobox", { name: "当前活动", exact: true }).inputValue(), "a1", "creating another activity does not reassign a nonempty progress draft");
  assert.equal(await hub.getByRole("combobox", { name: "进展关联资料" }).inputValue(), "r0");
  await tab("资料").click();
  await hub.getByRole("combobox", { name: "资料所属活动" }).selectOption("");
  await hub.getByRole("textbox", { name: "搜索项目资料" }).fill("参考资料");
  const fileList = hub.locator(".hub-file-list");
  const choice = hub.getByRole("button", { name: /^参考资料20.docx/ });
  await choice.click();
  const detail = hub.getByRole("region", { name: "资料详情" });
  await detail.getByRole("heading", { name: "参考资料20.docx", exact: true }).waitFor();
  await detail.getByText(/AI 尚不能读取/).waitFor();
  const position = await fileList.evaluate(el => el.scrollTop);
  assert.ok(position > 0);
  const chooseProject = async name => { await page.getByRole("button", { name: /^切换项目/ }).click(); await page.getByRole("navigation", { name: "项目列表" }).getByRole("button", { name }).click(); };
  await chooseProject(/专题调研/);
  assert.equal(await tab("概览").getAttribute("aria-selected"), "true");
  await chooseProject(/季度汇报/);
  assert.equal(await tab("资料").getAttribute("aria-selected"), "true");
  await detail.getByRole("heading", { name: "参考资料20.docx", exact: true }).waitFor();
  assert.equal(await hub.getByRole("textbox", { name: "搜索项目资料" }).inputValue(), "参考资料");
  assert.ok(Math.abs(await fileList.evaluate(el => el.scrollTop) - position) < 2);

  // File browsing scope is independent from the event and output in an unsaved progress draft.
  await hub.getByRole("combobox", { name: "资料所属活动" }).selectOption("a1");
  assert.equal(await hub.locator(".hub-resources li").count(), 1);
  await tab("进展").click();
  assert.equal(await hub.getByRole("combobox", { name: "当前活动", exact: true }).inputValue(), "a1");
  assert.equal(await hub.getByRole("combobox", { name: "进展关联资料" }).inputValue(), "r0");
  assert.match(await hub.getByRole("textbox", { name: "项目进展内容" }).inputValue(), /第三部分/);
  await tab("资料").click();
  await hub.getByRole("combobox", { name: "资料所属活动" }).selectOption("");
  await choice.click();
  const savedPosition = await fileList.evaluate(el => el.scrollTop);
  await page.reload();
  await resume.getByRole("button", { name: "继续项目" }).click();
  await detail.getByRole("heading", { name: "参考资料20.docx", exact: true }).waitFor();
  assert.ok(Math.abs(await fileList.evaluate(el => el.scrollTop) - savedPosition) < 2);

  // A narrow window shows one pane. Resizing and returning preserve the selection and list position.
  await page.setViewportSize({ width: 400, height: 700 });
  assert.equal(await fileList.isVisible(), false);
  assert.equal(await detail.isVisible(), true);
  assert.ok(await detail.getByRole("button", { name: "打开原文件" }).evaluate(el => el.getBoundingClientRect().bottom) < 700, "file actions remain visible in the narrow detail view");
  assert.equal(await hub.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await page.screenshot({ path: ".tmp/ui-verification/project-layout-narrow-detail.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.equal(await fileList.isVisible(), true);
  assert.ok(Math.abs(await fileList.evaluate(el => el.scrollTop) - savedPosition) < 2);
  await page.screenshot({ path: ".tmp/ui-verification/project-layout-files.png", fullPage: true });
  await page.setViewportSize({ width: 400, height: 700 });
  await detail.getByRole("button", { name: "返回资料列表" }).click();
  assert.equal(await detail.isVisible(), false);
  assert.equal(await fileList.isVisible(), true);
  assert.ok(Math.abs(await fileList.evaluate(el => el.scrollTop) - savedPosition) < 2);
  assert.equal(await choice.evaluate(el => el === document.activeElement), true);
  await choice.click();
  await tab("进展").click();
  await hub.getByRole("textbox", { name: "项目进展内容" }).press("Control+Enter");
  await hub.getByText("进展已保存，将按实际发生日期进入周报材料", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.work.entries[0].activityId), "a1");
  assert.equal(await page.evaluate(() => window.__fixture.work.entries[0].resourceId), "r0");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await tab("概览").click();
  await page.screenshot({ path: ".tmp/ui-verification/project-layout-overview.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: project tabs/keyboard, overview actions, complete history, invalid-cache fallback, per-project selection/filter/scroll recovery, reload, independent draft sources and adaptive single-pane navigation.");
} finally { await browser.close(); }
