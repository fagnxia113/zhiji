import { chromium } from "playwright";
import assert from "node:assert/strict";
import { installFixture } from "./workbench-fixture.mjs";

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
function seed() {
  const m = window.__fixture.workspace.meetings[0];
  Object.assign(m, { audioPath: "C:/fixture/room.wav", minutes: "人工校对的纪要", decisions: "原有决策", notes: "保留笔记", status: "已人工校对" });
  m.speakerSegments = JSON.stringify(Array.from({ length: 4 }, (_, i) => ({ speakerId: 1, speaker: "我", startMs: i * 1200, endMs: i * 1200 + 1000, text: `人工校对的第 ${i + 1} 段` })));
  m.transcript = JSON.parse(m.speakerSegments).map(s => `【我】${s.text}`).join("\n");
  m.speakerNames = '{"1":"旧称呼"}';
}
await page.addInitScript({ content: `(${installFixture.toString()})(); (${seed.toString()})();` });
const dialog = page.getByRole("dialog", { name: "重新区分角色", exact: true });
const getState = () => page.evaluate(() => structuredClone(window.__fixture.workspace));
async function open(count) {
  await page.getByRole("button", { name: "重新区分角色", exact: true }).click();
  await dialog.getByRole("combobox", { name: "实际发言人数" }).selectOption(count);
}
try {
  await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
  await page.getByRole("button", { name: "会议资料", exact: true }).click();
  await page.locator(".meeting-item").first().click();
  await page.getByRole("button", { name: /^原文校对/ }).click();
  await page.getByText("目前只识别到一个声音角色，实际多人时可重新区分。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "修改这段文字", exact: true }).first().click();
  await page.locator(".speaker-inline-edit textarea").fill("刚刚校对的新正文，不能被重算覆盖。");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(window.__fixture.workspace.meetings[0].speakerSegments)[0].text === "刚刚校对的新正文，不能被重算覆盖。");
  const before = await getState();
  for (const count of ["3", "4"]) {
    await open(count);
    await dialog.getByRole("button", { name: "开始区分", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // Wait through autosave so an older queued meeting cannot overwrite new roles.
    await page.waitForTimeout(1700);
    const after = await getState();
    const updated = after.meetings[0];
    const segments = JSON.parse(updated.speakerSegments);
    assert.equal(new Set(segments.map(s => s.speakerId)).size, Number(count));
    assert.deepEqual(segments.map(({ text, startMs, endMs }) => ({ text, startMs, endMs })), JSON.parse(before.meetings[0].speakerSegments).map(({ text, startMs, endMs }) => ({ text, startMs, endMs })));
    for (const field of ["minutes", "notes", "decisions", "status", "audioPath"]) assert.equal(updated[field], before.meetings[0][field]);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.meetings[1], before.meetings[1]);
    assert.equal(updated.speakerNames, "{}");
    assert.deepEqual(await page.evaluate(() => window.__fixture.roleCalls.at(-1)), { meetingId: "m1", speakerCount: Number(count) });
  }
  const corrected = await getState();
  await page.evaluate(() => { window.__fixture.failRoles = true; });
  await open("3");
  await dialog.getByRole("button", { name: "开始区分", exact: true }).click();
  await page.getByText(/角色修正失败/).waitFor();
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByRole("combobox").inputValue(), "3");
  assert.deepEqual(await getState(), corrected, "failed correction must keep existing result");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await page.evaluate(() => { window.__fixture.failRoles = false; window.__fixture.pauseRoles = true; });
  await open("4");
  await dialog.getByRole("button", { name: "开始区分", exact: true }).click();
  await page.getByRole("button", { name: "取消角色修正", exact: true }).click();
  await page.getByRole("dialog", { name: "处理中", exact: true }).waitFor({ state: "hidden" });
  assert.deepEqual(await getState(), corrected, "cancelled correction must keep existing result");
  assert.equal(await page.evaluate(() => window.__fixture.calls.includes("transcribe_meeting_with_speakers")), false);
  await page.screenshot({ path: ".tmp/ui-verification/speaker-correction.png" });
  assert.deepEqual(errors, []);
  console.log("PASS: 3/4 人角色修正保留正文、时间戳、纪要、笔记、决策和待办；失败与取消保留旧结果，且不重新转写。");
} finally { await browser.close(); }
