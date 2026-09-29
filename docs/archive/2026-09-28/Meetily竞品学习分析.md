> 历史归档 · 2026-09-28。下文保留原始记录，其中的现状、待办、命令和验证结论不代表当前版本；请从 [现行文档入口](../../README.md) 查阅最新说明。

# 知记 × Meetily 竞品学习分析

> 分析对象：Meetily（Zackriya-Solutions，MIT，Tauri + Rust + Next.js，本地优先的 AI 会议助手）
> 目标：找出功能 / 架构 / 设计上可借鉴、且契合"知记"定位（纯个人自用、安全>顺手>便宜>少维护、数据主权、LLM 固定走云端）的升级点。
> 日期：2026-08-08

---

## 0. Meetily 一句话画像

和"知记"几乎同一个赛道：本地优先、隐私优先的会议录音→转写→纪要工具。技术栈也是 **Tauri + Rust 后端 + Web 前端**，但前端用 Next.js + shadcn，而我们是无 UI 库的 React 19 自写 CSS。它的卖点是**全程本地**——本地 Whisper/Parakeet 转写、本地 Ollama 摘要、说话人分离（Pro 版）。商业化靠 Pro/Enterprise（团队、日历、RAG 问答等），社区版永久免费开源。

**关键结论**：它最值得我们学的，恰恰是它做得比我们细的"会后精修"环节（说话人改名/合并/单段重指派、转写分段存储、虚拟滚动、音文同步），而不是它的"本地 LLM / 团队 / 云"那条商业化路线——那条和我们"电脑带不动本地 LLM、纯个人、少维护"的定位相反，不该抄。

---

## 1. 你喜欢的"变更说话人命名"——机制与落地方案

### Meetily 的做法（来自其官方文档）
- 侧边有 **Speaker Panel** 列出所有检测到的说话人标签（Speaker 1 / Speaker 2…）。
- 点铅笔图标 → 标签变成**内联可编辑输入框** → 输入新名 → 回车/点外面 → **整篇转写里该说话人的每一次出现同时更新**（转写、摘要、待办、决策、章节全部同步）。
- 配套能力：**合并**（同一人被拆成两个标签时，把 A 并入 B）、**单段重指派**（只改某一段的归属，不影响其他段）。
- 核心魔法：**说话人身份（稳定 ID）和显示名（可变标签）解耦**。片段存的是 `speaker_id`，改名只改一张"id→名字"的映射表，不碰任何片段。

### 知记现在的痛点（已读代码确认）
- `SpeakerSegment { speaker: String, start_ms, end_ms, text }` —— `speaker` 是**字面字符串**（"说话人1"），不是 ID。
- `transcript` 在 `lib.rs` 里被拼成扁平字符串：`【说话人1】text\n【说话人2】text`（名字直接烤进正文，lib.rs:726）。
- 结果：现在**根本没有改名功能**（P1  backlog 里的"说话人改名"），而且即便要做，也得同时重写整段 `transcript` 字符串 + 每个 `speaker_segments` 的 `speaker` 字段 = O(n) 全文重写，正是 Meetily 用 ID 解耦避开的麻烦。

### 落地方案（推荐）
1. **数据模型改造**（核心）：
   - `SpeakerSegment` 增加稳定 `speaker_id: String`（如 `spk_0`），`speaker` 字段降级为"默认显示名/占位"。
   - 每场会议新增 `speaker_names` 映射：`{ "spk_0": "说话人1", "spk_1": "张三" }`。
   - `transcript` 不再作为"真值"存储，改为**渲染时由 segments + speaker_names 拼出**（`【{speaker_names[id] ?? id}】{text}`）。保留扁平字符串仅用于向后兼容和塞 LLM prompt。
2. **UI（照搬 Meetily 的侧栏模式）**：转写栏左侧/顶部加"说话人"区，列出本场所有 `speaker_id` + 当前名，铅笔图标内联改名。
3. **改名** = 改 `speaker_names` 里一条 → 整篇即时刷新（因为转写是渲染时解析的）。
4. **合并** = 把所有 `spk_A` 的片段 `speaker_id` 改成 `spk_B`，删掉 `spk_A` 映射。
5. **单段重指派** = 点某段说话人名 → 下拉选其他 `speaker_id` → 只改这一段的 `speaker_id`。

> 这一项直接对应你 P1 的"说话人改名"，且是后续"音文同步 / 虚拟滚动 / 结构化纪要"的共同地基——**建议作为下一个升级的 P0**。

---

## 2. 其他可借鉴的功能点（按契合度排序）

| 借鉴点 | Meetily 做法 | 知记现状 | 契合度 | 备注 |
|---|---|---|---|---|
| **转写分段存储 + 虚拟滚动** | transcript 分 chunk 入库，前端分页 + `@tanstack/react-virtual`，加载快、内存省 | 转写是整段字符串，长会议会卡 | 高 | 配合"说话人 ID 解耦"一起做最划算；P1 已有虚拟滚动项 |
| **音文同步 / 词级时间戳** | 片段带 `start_ms/end_ms`，点段落跳音频、播放高亮当前段 | 已有 `SpeakerTimeline` + `seekRequest`/`currentMs` 雏形 | 高 | 我们已有骨架，补全即可；P1 已有"音文同步" |
| **专业音频混音（麦克风+系统音双轨）** | 智能 ducking + 防削波，WASAPI/CoreAudio 双轨采集 | P1 计划 WASAPI loopback 双轨 | 中高 | 直接对齐我们 P1；可学它的"防削波/增益控制"细节 |
| **导入音频重新转写（Enhance）** | 导入已有录音，换模型/语言重转 | 仅支持录制后转写 | 中 | 实用但增维护，可后置；注意"重转会丢说话人改名"要一起处理 |
| **纪要模板（多预设）** | 6 种预设 + Pro 自定义模板 | P1"纪要模板" | 中 | 我们 LLM 固定走云端，做几个预设 prompt 模板成本低 |
| **导出 PDF/DOCX/Markdown（带格式）** | 单会议导出 | P1"整库导出 Markdown" | 中 | 我们偏纯文本，先做单会议 Markdown 导出更稳 |
| **会议问答 / RAG（Chat with meetings）** | Pro 的向量检索问答 | P2"会议问答" | 中（远期） | 个人场景价值有限，等核心稳定再做 |
| **合并重复说话人 / 单段重指派** | 见第 1 节 | 无 | 高（随改名一起） | 必须和改名同批做，否则改名半残 |

---

## 3. 架构上的借鉴（谨慎，别过度工程）

- **后端模块化**：Meetily 把 Audio / Transcription / DB / Summary 拆成独立引擎模块；我们 `lib.rs` 是 ~1090 行单体（含录音、转写、说话人、LLM）。**不建议为拆而拆**——违反"少维护"。但可以把"说话人分离"已经独立成 `speaker_engine.py` 的好做法延续：把即将做的"分段转写/改名"逻辑也收进清晰的函数边界，别再往 `lib.rs` 堆。
- **转写以"片段"为真值**：Meetily 的 transcript 本质是 segment 集合 + 元数据。我们正好借"说话人 ID 解耦"顺手把 `speaker_segments` 升格为转写真值，扁平 `transcript` 退为派生。一举两得。
- **本地优先 / 数据主权**：已经和我们对齐，继续保持（不抄它的本地 LLM，那违反"电脑带不动"）。

---

## 4. 前端 UI / 视觉设计深度拆解（基于 package.json + 截图，非猜测）

> 说明：图片无法在我这边渲染，以下视觉/交互结论来自其 `package.json` 依赖栈（最权威的"设计语言证据"）+ README 截图描述（home/summary/editor/settings/audio）+ 组件命名（Sidebar / MeetingDetails）。

### 4.1 Meetily 的真实前端技术栈
- **Next.js 14（App Router）+ React 18**
- **Tailwind CSS 3.4** + `tailwindcss-animate` + `@tailwindcss/typography`（prose，渲染 Markdown）
- **shadcn/ui**（有 `components.json` + Radix 全套 + `class-variance-authority` + `clsx` + `tailwind-merge`）：整套组件都是 shadcn 风格——中性灰、卡片化、大圆角、细边框、强可访问性
- **Radix UI 全套原语**：dialog / popover / dropdown-menu / tabs / tooltip / select / switch / accordion / scroll-area / progress / separator → 所有弹窗/气泡/标签页/提示都基于 Radix（无障碍）
- **@tanstack/react-virtual**：转写虚拟滚动
- **framer-motion**：过渡动画
- **BlockNote（@blocknote/shadcn）**：Notion 式**块编辑器** → 他们的"纪要/笔记"编辑器是结构化块编辑（可拖拽块、待办勾选、标题层级），不是 textarea（这就是 editor1.png 的真身）
- **TipTap + Remirror**：另外两套富文本（提及/@speaker、markdown、加粗等）
- **react-markdown + remark-gfm**：渲染 Markdown
- **sonner**：Toast 通知
- **cmdk**：⌘K 全局命令面板
- **react-hook-form + zod**：表单校验
- **lucide-react + heroicons**：图标

### 4.2 Meetily 的视觉/交互语言（来自截图 + 组件名）
- 整体：**中性灰底 + 白色卡片 + 细边框 + 大圆角**，典型"专业 SaaS / Pro 工具"质感（和我们的"微信绿消费级"是两种定位，不是谁错）
- 首页：会议**卡片列表** + 醒目"新建会议"CTA + 最近会议
- 会议详情：转写 + 纪要**左右分栏**，纪要用 BlockNote 块编辑器
- 设置：**分章节**弹窗/页（转写、AI 服务商、存储、音频设备选择）
- 说话人：侧栏列出本场说话人，内联改名/合并（第 1 节）
- 空状态、计数徽章、进度条、Tooltip 一应俱全

### 4.3 知记现状对照
- 我们：自写 CSS tokens（已有）、**无 UI 库**、纯 textarea、微信绿图标侧栏、三栏会议详情、已有主题切换
- 差异本质：**产品定位不同**——我们是"自用消费级聊天感"，Meetily 是"专业 SaaS 工具感"

### 4.4 真正值得借鉴的 UI / 设计点（按契合度）
1. ✅ **说话人改名：可访问的内联 Popover / 侧栏**（第 1 节）—— 沿用 Radix Popover 的思路（即便我们自己写 CSS），保证键盘可达 + 焦点管理。P0。
2. ✅ **⌘K 命令面板（cmdk 思路）**：键盘优先的全局命令面板，对"自用顺手"的个人工具是强升级，且自包含、不改视觉语言。值得做（建议 P1）。
3. ✅ **设置按"章节"组织 + 设备选择 UI**：我们设置页可沿用"分组卡片 + 设备下拉"，和双轨录音（P1）配套。
4. ✅ **设计 token 系统化**：我们已有 `tokens.css`，可把"圆角 / 阴影 / 间距 / 状态色"也收进 token（shadcn 的做法），组件一致性更强、换主题只改一处。
5. ✅ **微交互 / 过渡（framer-motion 思路）**：面板切换、Toast、改名反馈加轻量过渡，提升质感；优先级低。
6. ✅ **转写虚拟滚动**：已列 P1，沿用 `@tanstack/react-virtual` 思路。

### 4.5 设计侧明确不抄
- ❌ **BlockNote / TipTap / Remirror 富文本块编辑器**：和"纯 textarea、不硬支持 md/html、少维护"既定决策直接冲突。我们 v1.2.11 已退回纯文本，勿回退。但可吸收其"结构化输出"思想——LLM 直接产出决策/待办/纪要分区（我们已在做）。
- ❌ **整体迁移到 shadcn + Tailwind**：等于重写前端，违反"少维护"；自写 CSS 已够用，且微信绿是刻意定位。只学其"token 系统化 + 组件变体"方法论，不搬框架。
- ❌ **中性 SaaS 灰美学替换微信绿**：定位选择，绿是用户要的，不改。

---

## 5. 你点名的三处 UX 细节：源码级拆解与落地

> 以下结论来自实际读 Meetily 源码（`RecordingControls.tsx` / `RecordingStatusBar.tsx` / `BuiltInModelManager.tsx` / `package.json`）与知记当前代码（`App.tsx` / `lib.rs` / 设置页）的对照，非截图猜测。

### 5.1 转写时的"弹窗 + 可取消" —— Meetily 怎么做，知记差在哪

**Meetily 实际行为（源码确认）**：
- `RecordingControls.tsx`：**没有模态弹窗**。录制中只有 Tooltip（悬浮 Start/Pause/Stop）、行内 Alert（设备错误）、"Processing recording…" 文字 + Spinner。Stop 按钮**无确认对话框**，点了立即 `stop_recording`。
- `RecordingStatusBar.tsx`：顶部一条**细状态条**（脉冲红点 + `Recording • 00:00` 计时），framer-motion 淡入，非阻塞、常驻。
- 你印象里的"弹窗 + 可取消"，最可能是**模型下载卡片的 Cancel 按钮**（`BuiltInModelManager`：下载中显示 Cancel → 调 `builtin_ai_cancel_download`，后端发 `cancelled` 事件，前端清态 + toast）。博客也提到 "Floating Recording Panel" 悬浮控制面板。

**知记现状（代码确认）**：
- `processing` 状态机有 9 个阶段（`transcribing / autoTranscribing / speakerTranscribing / importing / downloading / analyzing / renaming / installingSpeaker / deleting`）。
- 这些阶段期间：**所有相关按钮 `disabled={processing !== null}`**，仅用一行行内文字（如"正在本地转写并区分说话人…"）提示，**没有遮罩 / 进度条 / 取消按钮**。用户只能干等、无法中断。
- 但知记**已有 Modal 组件**（带 `onCancel`、Esc 关闭、X 按钮），可直接复用。

**借鉴 + 落地（建议 P1）**：
1. **复用 Modal 做"进行中"居中遮罩**：把 `transcribing / autoTranscribing / speakerTranscribing / importing` 包进一个醒目 overlay：Spinner + 步骤文案 +（后端能给的话）进度 + **取消**按钮。直接补上"弹窗 + 可取消"。
2. **取消语义**：
   - 本地转写 → 后端加 `AtomicBool` 停止旗标，提前结束并**保留已转写部分**（避免"长会议停录丢尾段"经典坑，Meetily 1.1.1 也专门修过）。
   - 云端转写 → `abort` 在途请求即可。
3. **另加一条 RecordingStatusBar 式状态条**（红点脉冲 + 计时），录制/转写中常驻顶部、不阻塞——轻量、体验提升明显。

### 5.2 摘要"有加粗和列表" —— 这直接撞上我们 v1.2.11 的决策

**Meetily 实际行为**：摘要用 **BlockNote**（Notion 式块编辑器）渲染，天然有加粗、列表、标题层级、待办勾选。存储即结构化块。

**知记现状（关键认知）**：
- `lib.rs` 的 `ANALYSIS_SYSTEM_PROMPT` **本来就叫 LLM 输出 Markdown**（且禁 HTML）；`meeting.minutes` 存的就是 markdown 字符串。
- 但显示端用**纯 textarea**（`EditorField`）→ 用户看到裸 `**粗体**`、`- 列表`、`## 标题` 字符。
- **我们差的不是存储，是"显示渲染"**——这正是你和 Meetily 差距观感的根因。

**轻量折中方案（不违背"少维护"，也不引入重编辑器）**：
- 纪要/笔记面板加 **「预览 / 编辑」切换**：
  - **预览态**：用极小依赖（`marked` 把 md→HTML + `DOMPurify` 兜底净化）渲染成格式化只读视图（加粗 / 列表 / 标题 / 分隔线）——拿到 Meetily 的观感。
  - **编辑态**：回到纯 textarea（裸 markdown），原地改。
- 无 BlockNote/TipTap 复杂度，却解决"加粗和列表"观感；存储仍是 markdown，零数据模型改动。

> ⚠️ **决策冲突提示**：此方案触碰你 v1.2.11「不硬支持 md/html、纯 textarea」的既定决策。但你的新反馈（"摘要有加粗和列表"）说明体验优先级上来了。建议：**先确认是否接受"显示渲染 + 文本编辑"的折中**——接受后我把它排进 P1（低成本、高感知收益）。

### 5.3 本地识别模型"精度/速度可选" —— Meetily 的模型卡片网格

**Meetily 实际行为（`BuiltInModelManager.tsx` 源码确认）**：
- 用**响应式卡片网格**陈列模型，每张卡显示：`display_name`、描述、`size_mb`（MB/GB 自动格式化）、`context_size`（tokens）、状态徽章（Ready 绿 / Selected 蓝 / Corrupted 红）、下载/重试/删除按钮。
- 下载中卡片内嵌**进度条 + 百分比 + 已下/总 MiB + 速度 MiB/s**，并有 **Cancel** 按钮（调 `builtin_ai_cancel_download`，部分文件自动清理）。
- 模型列表由后端 `builtin_ai_list_models` **动态返回**，前端无硬编码。注意：Meetily **没有**显式 "fast vs accurate" 标签——速度/精度差来自模型名（tiny/base/small/medium/large）和 size，前端只展示 size。

**知记现状（代码确认）**：
- 设置页"本地中文语音模型"是**写死的一个按钮**：`SenseVoiceSmall Q8 + FSMN-VAD`（App.tsx:2175）。
- 下载态只有转圈（`LoaderCircle spin`）+ "正在下载模型" 文字，**无百分比、无取消、无尺寸/精度选择**。

**借鉴 + 落地（建议 P1/P2）**：
1. 把单一按钮换成**模型卡片网格**，预设 2–3 档：
   - **快速（默认）**：SenseVoiceSmall Q8，体积小、快、中文够用。
   - **精准**：更大模型（如 Whisper medium / SenseVoice 大档），更准但慢、占算力。
   - 每卡：名称、大小、推荐标、下载/取消、进度% + 速度。
2. 后端：支持多模型 ID + 用户选择持久化（settings）；复用 Meetily 的 `list/cancel` 事件模式。
3. **注意边界**：你"电脑带不动本地 LLM"是指 LLM 推理；语音识别模型（SenseVoice-small）本就能本地跑。大档模型能否流畅取决于你机器——**默认小档、大档作为可选项**，不必强推；真带不动用户自然不选。

### 5.4 其它确认过的 Meetily 小亮点（可选）
- **录音状态条**（红点脉冲 + 计时）：轻量，建议抄（见 5.1）。
- **书签 / 重要时刻标记**（时间戳 marker）：P2。
- **置信度指示 / 音量电平表**：偏过度工程，暂不抄。
- **悬浮录音面板 + 全局快捷键**：你 P2 的"顺手三件套（全局快捷键/托盘/开机自启）"已覆盖。

---

## 6. 明确不建议照搬的（违背定位）

- **本地 LLM（Ollama）**：我们已定"电脑带不动本地 LLM，LLM 固定走云端"，不抄。
- **团队 / 多人协作 / 日历集成 / 自动加入会议**：纯个人软件，无需求。
- **云端上传做说话人分离**：我们坚持本地分离（隐私），不抄它的云端 diarization。
- **Pro 商业化那一套（按席位、GDPR 审计、自托管部署）**：我们是自用，不抄。

---

## 7. 给知记的升级优先级建议

- **P0（下一个就做）**：说话人改名 / 合并 / 单段重指派 —— 需要先把"说话人 ID 解耦 + 转写分段存储"这个地基打好（第 1 节）。这是你点名喜欢、且能立刻提升可用性的项。
- **P1（紧随，含本次三处）**：
  - 转写分段真值化后顺手做 —— 虚拟滚动 + 音文同步补全 + 纪要模板预设 + 单会议 Markdown 导出。
  - **转写/导入"可取消进度遮罩" + 录音状态条**（5.1，复用已有 Modal，高感知）。
  - **本地识别模型"精度/速度可选"卡片网格**（5.3，替换写死的单一下载按钮）。
  - **⌘K 命令面板**（键盘优先，契合"顺手"）。
  - **纪要/笔记"预览/编辑"切换（显示渲染 markdown）**（5.2）—— ⚠️ 需你先确认是否接受，触碰 v1.2.11 既定决策。
- **P2（远期）**：WASAPI 双轨混音、导入重转写、会议问答/RAG、书签时间戳。

> 一句话：Meetily 最值得我们抄的不是"更本地/更商业"，而是它把**会后精修（改名、合并、分段、同步）**做细了——而这正好补上我们 P1 里"说话人改名"那块的缺口，且是后面一系列体验升级的共同地基。本次你点名的三处（可取消进度、格式化纪要、模型精度可选）则偏向"过程体验与设置体验"，同样是高感知、低架构风险的改进。

---

## 8. 实施进度（v1.2.15 已落地）

用户说"开始优化"，把第 5 节里最该落的两项做了：

- ✅ **5.2 纪要/决策 Markdown 预览**：新增 `MarkdownField`（默认预览渲染，可切编辑），`marked`+`DOMPurify` 渲染；智能纪要与决策与共识替换 `EditorField`。**调整了 v1.2.11「纯 textarea」决策**——仅改"显示"，编辑/存储仍是纯 markdown 文本，不引入重编辑器、不回退 TipTap，契合"少维护"。
- ✅ **5.1 可取消进度弹窗**：新增 `ProgressModal`（复用 Modal），9 个长流程阶段弹清晰对话框；后端 `cancel_processing` 命令 + `AppState` 加 `cancel_flag`/`cancel_child`，`run_local_asr` 改 `spawn`+`wait_with_output` 保留子进程句柄并支持 kill。**取消仅对本地语音转写有效**（transcribing/autoTranscribing）；说话人分离走 Python 未跟踪句柄，该阶段弹窗不含取消按钮。
- ⚠️ **5.3 本地模型精度/速度可选：未做**：后端 `SENSEVOICE_MODEL_NAME` 只有 `sensevoice-small-q8.gguf` 单一档，**没有"精确/快速"第二档资产**，无法真实提供选择。仅用 ProgressModal 改善了下载/安装的进度呈现。多档需另行引入其他 GGUF 资产，列为后续。
- ⬜ **P0 说话人改名（ID 解耦）**：仍未做，是下一个首选实施项（也是虚拟滚动/音文同步的共同地基）。
- ⬜ **⌘K 命令面板 / 虚拟滚动 / WASAPI 双轨 / 纪要模板 / 单会议导出**：P1/P2 待排期。
