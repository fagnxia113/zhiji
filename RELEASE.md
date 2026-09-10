# 知记 (zhiji-desktop) 发布手册

> 适用对象：维护者本人（纯个人自用，非商业化）
> 最后更新：2026-09-08（v2.0.2 发版时同步：签名算法改为 Ed25519/minisign、仓库名改为 zhiji）

## 1. 发布机制概览

知记是 Tauri v2 桌面应用。发版完全由 GitHub Actions 驱动：

- 工作流：`.github/workflows/build-desktop.yml`，使用官方 `tauri-apps/tauri-action@v0`
- 推送 `v*` tag 时：`tauri build` → 用 GitHub Secret 私钥给更新包签名 → 生成 `latest.json` → 在 GitHub Releases 创建 `vX.Y.Z` 并挂上安装包
- 应用内自动更新：前端 `plugin-updater` 启动时静默检查 GitHub Releases 的 `latest.json`，有新版则弹窗提示下载安装

一句话：**改版本号 → commit → 打 tag → push，剩下的 CI 全包**。

## 2. 已配置好的前置条件（通常不用动）

| 项目 | 位置 / 名称 | 说明 |
|------|------------|------|
| 签名私钥（Secret） | GitHub Secrets `TAURI_SIGNING_PRIVATE_KEY` | **Ed25519/minisign** 私钥（Tauri v2 不再支持 RSA），必须是本地 `C:\Users\12207\.tauri\zhiji-ed25519.key` 的完整正文 |
| 私钥本地备份 | `C:\Users\12207\.tauri\zhiji-ed25519.key` | 务必备份，丢失则无法再出新签名包 |
| 对应公钥 | `tauri.conf.json` → `plugins`/ `bundle` 下的 `updater.pubkey` | 与上面私钥配对；改私钥须同步此处 |
| 更新端点 | `tauri.conf.json` → `updater.endpoints` | 指向 `.../releases/latest/download/latest.json` |
| 更新产物开关 | `tauri.conf.json` → `bundle.createUpdaterArtifacts: true` | 必须 true，才会生成 `.sig` |
| CI 工作流 | `.github/workflows/build-desktop.yml` | `tauri-action@v0`，已把私钥以 env 传给构建 |
| npm 入口 | `apps/desktop/package.json` 的 `"tauri": "tauri"` | **必须保留**，tauri-action 固定调用 `npm run tauri` |

## 3. 发版步骤

1. 修改代码并完成本地自测（前端 `tsc --noEmit` + `vite build` 可在本机跑；Rust 编译只能靠 CI）。
2. **同步版本号，三处必须完全一致**：
   - `apps/desktop/src-tauri/tauri.conf.json` 根级 `"version"`
   - `apps/desktop/src-tauri/Cargo.toml` 的 `[package] version`
   - **`Cargo.lock` 里 `[[package]] name = "zhiji-desktop"` 的 `version`**（仓库已提交 Cargo.lock，CI 用 `cargo check --locked`，漏改会直接失败：`cannot update the lock file ... because --locked was passed`）
   - 例如 `2.0.1` → `2.0.2`
3. 提交：
   ```
   git add -A
   git commit -m "你的改动说明"
   ```
4. 打 tag（推送 tag 才触发 Release 构建）：
   ```
   git tag v1.1.3
   ```
5. 推送：
   ```
   git push origin main
   git push origin v1.1.3
   ```
6. 打开 GitHub Actions 等构建完成（通常 10–30 分钟）。

## 4. 发布后验证清单（缺一不可）

- [ ] GitHub Actions 本次 run 全绿（install → tauri build → 签名 → 打包）
- [ ] Releases 页 `vX.Y.Z` 资产**必须包含三项**：
      `知记_X.Y.Z_x64_zh-CN.exe`（或 `_X.Y.Z_x64-setup.exe`）+ `*.sig` + `latest.json`
      ⚠️ 只有 `.exe` 不代表成功——没有 `.sig`/`latest.json` 时自动更新是坏的，但 build 仍会显示 success
- [ ] 访问 `https://github.com/fagnxia113/zhiji/releases/latest/download/latest.json` 应返回 JSON（不是 404）
      （国内直连常被墙，用 `https://ghproxy.net/https://github.com/fagnxia113/zhiji/releases/latest/download/latest.json` 验证）
- [ ] 安装新包后：启动自动弹出「发现新版本」提示
- [ ] 设置页「检查更新」按钮可用、能正确报告「已是最新」
- [ ] 从旧版本打开：自动更新链路（下载 → `.sig` 校验 → 安装重启）正常
- [ ] 设置页「检查更新」**不再报 `not allowed by ACL`**（确认 `src-tauri/capabilities/default.json` 已授权 `updater:default` + `process:default`；漏授权会直接导致检查更新被 Tauri 运行时拒绝）

## 5. 踩坑速查（都已实际踩过，勿再犯）

1. **`tauri` npm script 不能删**：`tauri-action` 固定执行 `npm run tauri build`。项目若只写 `tauri:dev`/`tauri:build` 会报 `Missing script: "tauri"`。
2. **CI install 用 `--no-frozen-lockfile`**：本机无 pnpm，前端新增依赖靠 CI 自动解析 lockfile；若改了 `package.json` 依赖，不用手动碰 `pnpm-lock.yaml`。
3. **Rust 依赖无 Cargo.lock**：仓库未提交 `Cargo.lock`，CI 每次把 `= "2"` 解析为最新 `2.x`，补丁版本可能改 API。已踩：`tauri-plugin-updater` 2.x 已移除自由函数 `init()`，须用 `tauri_plugin_updater::Builder::new().build()`（不要凭 `dialog`/`process` 插件有 `init()` 类推）。
4. **版本号两处必须同步**：只改一处会导致 NSIS 安装包版本与 updater 期望版本不一致，自动更新可能不触发或混乱。
5. **签名密钥配对（最隐蔽的坑）**：
   - ⚠️ **Tauri v2 的 updater 只认 Ed25519/minisign，早期 v1 用的 RSA 密钥体系在这里完全无效**（表现：签名步骤直接失败或静默跳过）。现用密钥由 `tauri signer generate` 生成，私钥在 `C:\Users\12207\.tauri\zhiji-ed25519.key`，公钥已写入 `tauri.conf.json` 的 `plugins.updater.pubkey`（不是 `bundle` 下）。
   - Secret `TAURI_SIGNING_PRIVATE_KEY` 的内容**必须是私钥文件的完整正文**（末尾换行保留、无 BOM、无多余空格）。
   - 密钥是**空密码**生成的，但 minisign 仍带 KDF，所以 workflow 里**必须**同时传 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""`，漏了 CI 签名会失败。
   - 内容不完整/不对时，Tauri 签名会**静默失败（仅 warning）**，build 照样 success，但 Release 里**只有 `.exe`、没有 `.sig` 也没有 `latest.json`**——自动更新等于没接上，且 CI 不会报错。
   - ⚠️ **新建的 GitHub 仓库不继承 Actions secrets**：`fagnxia113/zhiji` 是 2026-09-03 新建的，首次打包前必须由本人在网页 Settings → Secrets 里补 `TAURI_SIGNING_PRIVATE_KEY`（v2.0.0 首发时踩过）。
6. **SmartScreen 警告**：NSIS 安装包没有 Authenticode 代码签名证书，Windows 首次安装可能弹「未知发布者」。这与 Tauri 的 `.sig`（仅防更新包被篡改）是两回事，点「仍要运行」即可，不影响自动更新链路。
7. **插件 capability 授权（隐藏的 ACL 坑）**：Tauri v2 对**插件命令默认 deny**，必须在 `src-tauri/capabilities/default.json` 的 `permissions` 里显式 allow。每注册一个插件（updater / process / dialog 等），都要加对应的 `<plugin>:default` 或具体 `allow-*` 权限，否则运行时报 `Command plugin:xxx|yyy not allowed by ACL`。应用**自己的** `#[tauri::command]` 默认 allow（所以录音/保存一直正常），唯独插件命令会被卡。已踩：v1.1.4 之前漏了 `updater:default` + `process:default`，导致「检查更新」直接报 ACL 错。改完权限必须发新版本号（updater 按版本号判更新）。

## 6. 重生成签名密钥（仅在私钥泄露/丢失时）

1. 生成新密钥对（Tauri v2 = Ed25519/minisign，不要用 openssl RSA）：
   ```
   pnpm tauri signer generate -- -w C:\Users\12207\.tauri\zhiji-ed25519.key
   ```
   命令会同时打印公钥（base64，形如 `dW50cnVzdGVkIGNvbW1lbnQ6...`）。
2. 把公钥写入 `tauri.conf.json` 的 `plugins.updater.pubkey`（替换原值）。
3. 把私钥**全文**复制到 GitHub 仓库 Settings → Secrets → Actions，覆盖 `TAURI_SIGNING_PRIVATE_KEY`；并确保 workflow 里有 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ""`（空密码也要传）。
5. 重新走第 3 节发版步骤打 tag 出新包。

## 7. 版本历史

- **v1.1.0**：整体换 Win11 Fluent 2 皮肤 + 窗口响应式 + 首个 GitHub Release 发行版
- **v1.1.1**：UI 减字收敛 + 本地说话人引擎下载修复（超时/重试/HF 镜像）
- **v1.1.2**：应用内自动更新（GitHub Releases 驱动）；CI 经多轮修复（lockfile、`tauri` script、updater `Builder` API）后稳定。
  注意：v1.1.2 首次发布时因 GitHub Secret 私钥内容不完整，Release 仅有 `.exe`，缺 `.sig`/`latest.json`，自动更新当时不可用；须修正 Secret 后重新发版补全。
- **v1.1.3**：微信风重设计（图标栏 + 微信绿 #07C160 + 首页瘦身 + 状态圆点 + 删渐变）。
- **v1.1.4**：修复「检查更新」报 `not allowed by ACL`——`capabilities/default.json` 补 `updater:default` + `process:default` 授权。
- **v2.0.0**（2026-09-03）：迁移到全新仓库 `fagnxia113/zhiji`（历史压缩为单提交），定位「个人工作台」，重签名体系为 Ed25519。
- **v2.0.1**（2026-09-05）：关闭=隐藏到托盘（替换原先不可靠的 confirm 兜底）；禁用 WebView 后台节流，根治「最小化后录音丢约 20 分钟」。
- **v2.0.2**（2026-09-08）：修复关闭窗口可能直接退出应用（JS `onCloseRequested` 缺 `preventDefault` 导致包装器销毁窗口）；托盘不可用时也正确隐藏而非最小化；关闭前先落盘当前会议。CI 新增原生「关闭到托盘」冒烟测试。
- **v2.0.3**（2026-09-08）：托盘图标左键单击/双击即可唤回窗口（原先只有右键菜单「打开界面」）。
- **v2.0.4**（2026-09-08）：新增「手动安装引擎」面板（下载链接、目标目录、整目录导入、断点续传、pip 离线 wheels）；单实例互斥锁——重复启动唤起已有窗口（修复任务栏固定图标点出白闪后闪退）；下载链接改走系统浏览器（WebView 内 `target=_blank` 不生效）。
- **v2.0.5**（2026-09-10）：修复实时字幕精校转写乱码——会议背景/标题中残留的 `<s>`、`<|zh|>` 等转写特殊符号被切成热词喂给 SeACo 模型，带偏整句解码；Rust 切词与 Python 引擎双侧过滤含尖括号的 token，转写文本清理同步移除 `<s>`/`</s>` 残留。
