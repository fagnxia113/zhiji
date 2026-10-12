import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { installFixture } from "./workbench-fixture.mjs";

function seed() {
  const f = window.__fixture;
  f.work.projects.push({id:"p",name:"数据中心建设",archived:false,themeIds:["data","overseas"]});
  f.work.themes.push({id:"data",name:"数据中心"},{id:"overseas",name:"出海"});
  f.work.links["meeting:m2"]="p";
  const day=f.workspace.meetings[0].startedAt.slice(0,10);
  f.work.entries.push({id:"daily",content:"完成日常协调",kind:"progress",status:"done",occurredOn:day,projectId:null,updatedAt:day},{id:"progress",content:"完成项目方案评审",kind:"progress",status:"done",occurredOn:day,projectId:"p",updatedAt:day});
  f.hub.resources.push({id:"r",title:"建设方案.docx",path:"C:/fixture/建设方案.docx",contentStatus:"metadata_only"});
  f.hub.resourceLinks.push({resourceId:"r",projectId:"p",role:"reference"});
  localStorage.setItem("zhiji:last-project","p");
  const invoke=window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke=async (command,args={})=>{
    if(command==="import_meeting_audio") {
      (f.imports??=[]).push(structuredClone(args));
      const m=f.workspace.meetings.find(m=>m.id===args.meetingId);
      m.audioPath="C:/fixture/imported.webm";m.status="已录音";return structuredClone(m);
    }
    if(command==="save_meeting"&&f.failSave) throw Error("测试：会议保存失败");
    return invoke(command,args);
  };
}
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||"chrome",headless:true});
const page=await browser.newPage({viewport:{width:1200,height:800},locale:"zh-CN",timezoneId:"Asia/Shanghai"});
const errors=[];page.on("pageerror",e=>errors.push(e.message));
await page.addInitScript({content:`(${installFixture.toString()})(); (${seed.toString()})();`});
await mkdir(new URL("../.tmp/ui-verification/",import.meta.url),{recursive:true});
try {
  await page.goto(process.env.TEST_URL||"http://127.0.0.1:1422");
  await page.getByRole("textbox",{name:"工作内容",exact:true}).waitFor();
  const nav=page.getByRole("navigation",{name:"主导航"});
  assert.equal(await nav.getByRole("button").count(),4);
  assert.deepEqual(await nav.getByRole("button").allTextContents(),["工作台","项目","会议","周报"]);
  assert.equal(await page.locator(".icon-rail").count(),0);
  await page.screenshot({animations:"disabled",path:".tmp/ui-verification/page-tabs-home.png"});
  await nav.getByRole("button",{name:"项目",exact:true}).click();
  const hub=page.getByRole("region",{name:"项目详情"});
  await hub.getByRole("heading",{name:"数据中心建设",exact:true}).waitFor();
  assert.equal(await hub.getByRole("tab",{name:"进展",exact:true}).getAttribute("aria-selected"),"true");
  assert.equal(await hub.getByRole("tab").count(),3);
  await page.screenshot({animations:"disabled",path:".tmp/ui-verification/page-tabs-project.png"});
  await hub.getByRole("tab",{name:"资料",exact:true}).click();
  assert.equal(await page.locator(".hub-file-detail").isVisible(),false);
  await hub.getByRole("button",{name:"打开文件",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixture.workCalls.filter(c=>c.action==="open_resource").length),1);
  await hub.getByRole("tab",{name:"会议与活动",exact:true}).click();
  await hub.getByRole("button",{name:"查看纪要",exact:true}).click();
  const embedded=hub.locator(".meeting-shell.is-embedded");
  await embedded.getByRole("textbox",{name:"会议标题",exact:true}).waitFor();
  assert.equal(await nav.getByRole("button",{name:"项目",exact:true}).getAttribute("aria-current"),"page");
  await embedded.locator(".minutes-pane > .markdown-field").getByRole("button",{name:"编辑",exact:true}).click();
  await embedded.getByRole("textbox",{name:"纪要正文",exact:true}).fill("项目内修改的会议纪要");
  await page.waitForFunction(()=>window.__fixture.workspace.meetings.find(m=>m.id==="m2").minutes==="项目内修改的会议纪要");
  await page.evaluate(()=>{window.__fixture.failSave=true;});
  await embedded.getByRole("textbox",{name:"纪要正文",exact:true}).fill("保存失败时仍保留的纪要");
  await embedded.getByRole("button",{name:"收起会议",exact:true}).click();
  await page.getByText(/尚未保存，无法收起/).waitFor();
  assert.equal(await embedded.getByRole("textbox",{name:"纪要正文",exact:true}).inputValue(),"保存失败时仍保留的纪要");
  assert.equal(await page.evaluate(()=>window.__fixture.workspace.meetings.find(m=>m.id==="m2").minutes),"项目内修改的会议纪要");
  await page.evaluate(()=>{window.__fixture.failSave=false;});
  await embedded.getByRole("textbox",{name:"纪要正文",exact:true}).fill("项目内修改的会议纪要");
  await embedded.getByRole("button",{name:"收起会议",exact:true}).click();
  await nav.getByRole("button",{name:"会议资料",exact:true}).click();
  assert.equal(await page.locator(".minutes-pane > .markdown-field > .markdown-body").innerText(),"项目内修改的会议纪要");
  await page.waitForTimeout(220);
  await page.screenshot({animations:"disabled",path:".tmp/ui-verification/page-tabs-meeting.png"});
  await page.getByRole("button",{name:"导入录音",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixture.workspace.meetings.length),3,"canceling file selection does not create an empty meeting");
  await page.evaluate(()=>{window.__fixture.pickedFiles="C:/fixture/first.wav";});
  await page.getByRole("button",{name:"导入录音",exact:true}).click();
  await page.waitForFunction(()=>window.__fixture.imports?.length===1);
  assert.notEqual(await page.evaluate(()=>window.__fixture.imports[0].meetingId),"m2","an existing text record is preserved when importing audio from the page header");
  assert.equal(await page.evaluate(()=>window.__fixture.workspace.meetings.find(m=>m.id==="m2").minutes),"项目内修改的会议纪要");
  await page.waitForFunction(()=>window.__fixture.calls.filter(c=>c==="load_workspace").length>=2);
  await page.evaluate(()=>{window.__fixture.pickedFiles=null;});
  await page.getByRole("button",{name:"导入录音",exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__fixture.workspace.meetings.length),4,"new-meeting import also waits for an actual file selection");
  await page.evaluate(()=>{window.__fixture.pickedFiles="C:/fixture/second.wav";});
  await page.getByRole("button",{name:"导入录音",exact:true}).click();
  await page.waitForFunction(()=>window.__fixture.imports?.length===2);
  assert.equal(await page.evaluate(()=>window.__fixture.workspace.meetings.length),5);
  assert.notEqual(await page.evaluate(()=>window.__fixture.imports[1].meetingId),"m2","a meeting with audio keeps its recording when importing another");
  await nav.getByRole("button",{name:"周报",exact:true}).click();
  const report=page.getByRole("region",{name:"周报工作区"});
  await report.getByRole("checkbox",{name:"纳入周报：完成日常协调",exact:true}).waitFor();
  await report.getByRole("checkbox",{name:"纳入周报：完成项目方案评审",exact:true}).waitFor();
  await report.getByRole("button",{name:"整理草稿",exact:true}).click();
  const editor=report.getByRole("textbox",{name:"周报正文",exact:true});
  await editor.waitFor();await editor.fill("人工补充的周报内容");
  assert.ok(await report.locator(".report-saved").evaluate(e=>e.getBoundingClientRect().width)>await report.locator(".report-compose").evaluate(e=>e.getBoundingClientRect().width));
  await nav.getByRole("button",{name:"项目",exact:true}).click();
  await nav.getByRole("button",{name:"周报",exact:true}).click();
  assert.equal(await editor.inputValue(),"人工补充的周报内容");
  await page.screenshot({animations:"disabled",path:".tmp/ui-verification/page-tabs-report.png"});
  for(const width of [1024,736,400,320]) {
    await page.setViewportSize({width,height:800});
    for(const name of ["工作台","项目","会议资料","周报"]) {
      await nav.getByRole("button",{name,exact:true}).click();
      await page.waitForTimeout(70);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`${width}px ${name} should fit the viewport`);
    }
  }
  await page.setViewportSize({width:400,height:800});
  await page.screenshot({animations:"disabled",path:".tmp/ui-verification/page-tabs-report-narrow.png"});
  await page.evaluate(()=>{document.documentElement.dataset.theme="dark";});
  await page.screenshot({animations:"disabled",path:".tmp/ui-verification/page-tabs-report-dark.png"});
  assert.deepEqual(errors,[]);
  console.log("PASS: four direct pages, project defaults, direct file opening, shared minutes editor, canceled/new recording imports, daily report sources, retained edits and 1024/736/400/320px layouts.");
} finally {await browser.close();}
