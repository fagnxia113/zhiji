import { chromium } from "playwright";
import assert from "node:assert/strict";
import { installFixture } from "./workbench-fixture.mjs";

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
try {
  for (const modelsReady of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ["microphone"], locale: "zh-CN" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.addInitScript({ content: `(${installFixture.toString()})(); window.__fixture.noAsrModels = ${!modelsReady};` });
    await page.goto(process.env.TEST_URL || "http://127.0.0.1:1422");
    await page.getByRole("button", { name: "会议资料", exact: true }).click();
    await page.locator(".meeting-item").first().click();
    await page.getByRole("button", { name: "开始录音", exact: true }).click();
    const check = page.getByRole("dialog");
    await check.getByRole("button", { name: "开始录音", exact: true }).click();
    const stage = page.getByRole("region", { name: "录音进行中", exact: true });
    await stage.getByRole("textbox", { name: "会议笔记", exact: true }).waitFor();
    assert.equal(await page.getByText("实时字幕", { exact: true }).count(), 0);
    await page.waitForFunction(() => window.__fixture.audioChunks?.length > 0);
    assert.equal(await page.evaluate(() => window.__fixture.calls.includes("transcribe_meeting_with_speakers")), false, "Recognition must wait until recording ends");
    await stage.getByRole("button", { name: "标记重点", exact: true }).click();
    assert.match(await stage.getByRole("textbox").inputValue(), /\[重点 \d+:\d+\]/);
    await stage.getByRole("textbox").fill("刚写的协调结果，结束录音时必须保留。");
    if (modelsReady) await page.screenshot({ path: ".tmp/ui-verification/recording-after-meeting.png" });
    await stage.getByRole("button", { name: "结束并转写", exact: true }).click();
    await page.locator(".global-recording-banner").waitFor({ state: "hidden" });
    await page.waitForTimeout(1700);
    const result = await page.evaluate(() => ({ f: window.__fixture.workspace.meetings[0], notes: window.__fixture.notesAtFinalize, calls: window.__fixture.calls, chunks: window.__fixture.audioChunks }));
    assert.equal(result.notes, "刚写的协调结果，结束录音时必须保留。");
    assert.equal(result.f.notes, result.notes);
    assert.notEqual(result.f.id,"m1","page recording creates a new meeting rather than overwriting an existing transcript");
    assert.match(await page.evaluate(()=>window.__fixture.workspace.meetings.find(m=>m.id==="m1").transcript),/客户反馈/);
    assert.equal(result.f.audioPath, "C:/fixture/new-recording.webm");
    assert.ok(result.chunks.every(c => c.meetingId === result.f.id && c.length > 0));
    for (const command of ["append_live_audio", "check_live_engine"]) assert.equal(result.calls.includes(command), false);
    assert.equal(result.calls.includes("transcribe_meeting_with_speakers"), modelsReady);
    if (modelsReady) {
      assert.ok(result.calls.indexOf("transcribe_meeting_with_speakers") > result.calls.indexOf("finalize_recording"));
      assert.equal(new Set(JSON.parse(result.f.speakerSegments).map(s => s.speakerId)).size, 3);
    } else {
      assert.equal(result.f.status, "已录音");
      assert.equal(result.f.transcript, "");
    }
    await page.getByRole("button", { name: "设置", exact: true }).click();
    assert.equal(await page.getByText("实时字幕", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: 未配置模型仍可录音、持续保存及标记重点；结束前保存最后笔记，会后才转写并区分角色；新录音路径经过自动保存仍保留，无实时字幕调用。");
} finally { await browser.close(); }
