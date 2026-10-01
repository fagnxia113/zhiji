import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
function seedProjects() {
  if (!localStorage.getItem("zhiji:work-entry-draft")) localStorage.setItem("zhiji:work-entry-draft", JSON.stringify({ id: "empty-old-draft", content: "", occurredOn: "1999-01-01" }));
  window.__fixture.work.projects.push({ id: "p1", name: "季度汇报", archived: false }, { id: "p2", name: "专题调研", archived: false });
  window.__fixture.hub.profiles.push({ projectId: "p1", goal: "完成季度汇报", stage: "初稿" });
  window.__fixture.hub.resources.push({ id: "r1", title: "参考资料.docx", path: "D:\\work\\参考资料.docx", contentStatus: "metadata_only" });
  window.__fixture.hub.resourceLinks.push({ resourceId: "r1", projectId: "p1", role: "reference" });
}
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seedProjects.toString()})();` });
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  const capture = page.getByRole("textbox", { name: "工作内容", exact: true });
  assert.equal(await page.getByRole("combobox", { name: "所属项目", exact: true }).isVisible(), false);
  await capture.fill("临时想法不必先归类");
  await capture.press("Control+Enter");
  await page.waitForFunction(() => window.__fixture.work.entries.length === 1);
  assert.equal(await page.evaluate(() => window.__fixture.work.entries[0].projectId), null);
  assert.notEqual(await page.evaluate(() => window.__fixture.work.entries[0].occurredOn), "1999-01-01");

  await page.getByRole("button", { name: "项目", exact: true }).click();
  const list = page.getByRole("navigation", { name: "项目列表" });
  await list.getByRole("button", { name: /季度汇报/ }).click();
  const hub = page.getByRole("region", { name: "项目详情" });
  await hub.locator(".hub-overview").getByText("完成季度汇报", { exact: true }).waitFor();
  assert.equal(await hub.getByRole("textbox", { name: "项目目标" }).isVisible(), false);
  assert.equal(await page.evaluate(() => window.__fixture.workCalls.filter(c => c.action === "load_project_hub" && !c.args.projectId).length), 0);

  const reads = () => page.evaluate(() => window.__fixture.workCalls.filter(c => c.action === "load_project_hub").length);
  const before = await reads();
  await hub.getByRole("button", { name: "打开", exact: true }).click();
  await page.waitForFunction(() => window.__fixture.workCalls.some(c => c.action === "open_resource"));
  await hub.getByRole("button", { name: "打开", exact: true }).waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector('.hub-resources button').disabled);
  assert.equal(await reads(), before, "opening an existing file must not reload data");
  await hub.getByRole("button", { name: "选择本地文件", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.hub-resources button').disabled);
  assert.equal(await reads(), before, "cancelled file picker must not reload data");

  await hub.getByText("编辑目标与阶段", { exact: true }).click();
  await hub.getByRole("textbox", { name: "项目目标" }).fill("目标草稿尚未提交");
  await hub.getByText("添加活动", { exact: true }).click();
  await hub.getByRole("textbox", { name: "活动名称" }).fill("准备汇报评审");
  await hub.getByRole("textbox", { name: "项目进展内容" }).fill("下次从第三部分继续");
  await list.getByRole("button", { name: /专题调研/ }).click();
  await list.getByRole("button", { name: /季度汇报/ }).click();
  assert.equal(await hub.getByRole("textbox", { name: "项目目标" }).inputValue(), "目标草稿尚未提交");
  assert.equal(await hub.getByRole("textbox", { name: "活动名称" }).inputValue(), "准备汇报评审");
  assert.equal(await hub.getByRole("textbox", { name: "项目进展内容" }).inputValue(), "下次从第三部分继续");

  await page.getByRole("button", { name: "工作台", exact: true }).click();
  const resume = page.getByRole("region", { name: "继续上次项目" });
  await resume.getByText(/下次从第三部分继续/).waitFor();
  await page.reload();
  await resume.getByRole("button", { name: "继续项目" }).click();
  await hub.getByRole("heading", { name: "季度汇报", exact: true }).waitFor();
  assert.equal(await hub.getByRole("textbox", { name: "项目目标" }).inputValue(), "目标草稿尚未提交");
  assert.equal(await hub.getByRole("textbox", { name: "活动名称" }).inputValue(), "准备汇报评审");
  assert.equal(await hub.getByRole("textbox", { name: "项目进展内容" }).inputValue(), "下次从第三部分继续");

  await page.evaluate(() => { window.__fixture.failHubAfterWrite = true; });
  await hub.getByRole("button", { name: "保存目标与阶段" }).click();
  await hub.getByRole("alert").getByText(/操作已完成，但列表刷新失败/).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.hub.profiles[0].goal), "目标草稿尚未提交");
  assert.equal(await hub.getByRole("button", { name: "保存目标与阶段" }).isDisabled(), true);
  await page.evaluate(() => { window.__fixture.failHub = false; window.__fixture.failHubAfterWrite = false; });
  await hub.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.hub-profile button').disabled);
  assert.equal(await page.evaluate(() => window.__fixture.workCalls.filter(c => c.action === "save_project_profile").length), 1);

  // An initial read failure must not allow blank values to overwrite a project.
  await page.evaluate(() => { window.__fixture.failHub = true; });
  await list.getByRole("button", { name: /专题调研/ }).click();
  await hub.getByRole("alert").getByText(/项目读取失败/).waitFor();
  await hub.getByText("编辑目标与阶段", { exact: true }).click();
  assert.equal(await hub.getByRole("textbox", { name: "项目目标" }).isDisabled(), true);
  await page.evaluate(() => { window.__fixture.failHub = false; });
  await hub.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.hub-profile button').disabled);

  // A retry must preserve edited fields even if the saved profile differs.
  await hub.getByRole("textbox", { name: "项目目标" }).fill("重读也要保留这份草稿");
  await page.evaluate(() => { window.__fixture.missingFile = true; window.__fixture.hub.resources.push({id:"r2",title:"失联.pdf",path:"D:\\gone.pdf"}); window.__fixture.hub.resourceLinks.push({projectId:"p2",resourceId:"r2",role:"reference"}); });
  // Return to restore draft and fetch the newly attached resource.
  await list.getByRole("button", { name: /季度汇报/ }).click();
  await list.getByRole("button", { name: /专题调研/ }).click();
  await hub.getByRole("button", { name: "打开", exact: true }).click();
  await hub.getByRole("alert").getByText(/文件不存在/).waitFor();
  await hub.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.hub-profile button').disabled);
  assert.equal(await hub.getByRole("textbox", { name: "项目目标" }).inputValue(), "重读也要保留这份草稿");
  // Lazy catalog failure does not prevent ordinary project progress from being saved.
  await page.evaluate(() => { window.__fixture.failCatalog = true; });
  await hub.getByText("复用已登记资料", { exact: true }).click();
  await hub.getByRole("alert").getByText(/可复用资料暂时无法读取/).waitFor();
  await hub.getByRole("textbox", { name: "项目进展内容" }).fill("已核对调研数据");
  await hub.getByRole("button", { name: "保存本次进展" }).click();
  await page.getByRole("region", { name: "项目最近进展" }).getByText("已核对调研数据", { exact: true }).waitFor();
  await page.evaluate(() => { window.__fixture.failCatalog = false; });
  await hub.getByRole("button", { name: "重试读取可复用资料" }).click();
  await page.waitForFunction(() => !document.querySelector('[aria-label="复用已登记资料"]').disabled);

  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByRole("textbox", { name: "新项目名称" }).fill("  年度总结  ");
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await hub.getByRole("heading", { name: "年度总结", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__fixture.work.projects.filter(p => p.name === "年度总结").length), 1);
  await page.getByRole("textbox", { name: "查找项目" }).fill("季度");
  assert.equal(await list.getByRole("button").count(), 1);
  await page.getByRole("textbox", { name: "查找项目" }).fill("");
  await list.getByRole("button", { name: /季度汇报/ }).click();
  await mkdir(new URL("../.tmp/ui-verification/", import.meta.url), { recursive: true });
  await page.screenshot({ path: ".tmp/ui-verification/projects-usability.png", fullPage: true });
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.getByRole("region", { name: "项目工作区" }).evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  await page.screenshot({ path: ".tmp/ui-verification/projects-usability-narrow.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log("PASS: direct projects, quick capture, lazy catalog, no reload on open/cancel, draft navigation/reload recovery, resume, read failure guard, save/refresh distinction and narrow layout.");
} finally { await browser.close(); }
