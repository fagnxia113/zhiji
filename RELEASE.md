# 知记发布手册

最后核对：2026-10-02。以当前 [Desktop CI](.github/workflows/build-desktop.yml) 和 [Tauri 配置](apps/desktop/src-tauri/tauri.conf.json) 为准。历史排障与版本记录已移入 [归档](docs/archive/2026-09-28/发布手册-旧版.md)。所有命令在知记仓库根目录执行。

## 当前构建流程

- 推送到 main、codex/**、refactor/**，向 main 提 PR，或手动触发工作流，会运行前端、界面、Rust 和引擎检查。
- 非 tag 运行构建候选 NSIS 包，执行原生标题栏、最小化/最大化/还原、尺寸调整及关闭到托盘冒烟测试并上传 artifact；候选配置关闭更新签名产物，不发布 Release。
- 推送 v* tag 时构建并发布正式包；工作流随后规范资产名，生成和核验 latest.json。tag 路径不运行候选包关闭窗口测试，应先通过同一源码的候选验收。
- JS 使用已提交的 pnpm-lock.yaml 和 pnpm install --frozen-lockfile；Rust 使用已提交的 Cargo.lock 和 --locked。更新依赖时同步更新锁文件，不在 CI 临时绕开检查。

## 发布前

1. 完成 [产品验收](docs/产品验收.md)，核对准备发布的差异及候选包证据。
2. 选定本次版本 X.Y.Z，同步以下三处：
   - [tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json) 的根级 version。
   - [Cargo.toml](apps/desktop/src-tauri/Cargo.toml) 的 zhiji-desktop package version。
   - [Cargo.lock](Cargo.lock) 中 name = "zhiji-desktop" 对应的 version。
3. 更新工作流中 releaseBody 的版本与说明，改成这次实际交付的内容。它不会跟着 tag 自动变，忘了改就会出现「Release 标题是 v2.1.0、正文还在讲 2.0.10」这种对不上的情况。发布前用 `grep -n "releaseBody" -A 20 .github/workflows/build-desktop.yml` 核对一遍。
4. 核对 GitHub Secret TAURI_SIGNING_PRIVATE_KEY、对应密码配置与 plugins.updater.pubkey 的配对关系。当前工作流传入空密码；如密钥使用密码，工作流须引用相应 Secret。不要输出、提交或写入文档中的私钥正文。
5. 确认 bundle.createUpdaterArtifacts 已开启，更新端点有效，capabilities 包含 updater / process 所需权限。

前端 package version 目前不承担安装包版本来源；发布版本以以上三处和 tag 一致为准。

## 发布步骤

以下 X.Y.Z 是占位符，执行前替换为实际版本。先审阅并仅暂存本次要发布的文件，再提交，避免把无关未提交工作打进版本。

```bash
git diff --cached
git commit -m "release: vX.Y.Z"
git push origin main
```

等待该提交的非 tag 工作流和候选包验收通过，再在同一提交上打 tag：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

等待 tag 对应的 Desktop CI 完成。仅本地构建或非 tag 工作流通过不表示正式包已发布。

## 查看构建状态（本机无 gh CLI）

仓库是 public，直接走 REST API 即可，无需 token。列出某分支最近几次运行：

```bash
curl -s "https://api.github.com/repos/fagnxia113/zhiji/actions/runs?branch=codex/personal-workbench-mcp&per_page=10"
```

拿某次运行的 job 与每步结论（定位红在哪一步最快）：

```bash
curl -s "https://api.github.com/repos/fagnxia113/zhiji/actions/runs/<run_id>/jobs"
```

两个坑：

- 按提交筛选用 `head_sha` 时必须给**完整** SHA，传短 SHA 会返回空列表。
- `GET /actions/jobs/<job_id>/logs` **拿不到日志**，未认证返回 403「Must have admin rights」；`check-runs` 的 annotations 只有 Node 20 弃用之类的 warning，不含测试失败信息。要看失败输出只能人工打开 run 页面展开那一步。

本地没有任何 Rust 工具链，`cargo test` 无法复现；而且 `cargo check` **不编译 `#[cfg(test)]` 代码**，所以「Check desktop native code」这步绿不代表测试代码能编译。改过 `apps/desktop/src-tauri/src/storage_tests.rs` 就只能等 CI 验证。

## 发布后验证

- [ ] Release 对应正确 tag / 提交，说明与实际交付一致。
- [ ] 资产同时包含 ZhiJi_X.Y.Z_x64-setup.exe、对应 .exe.sig 和 latest.json。
- [ ] latest.json 的 version、windows-x86_64 下载地址、signature 与本版资产一致；下载文件是有效 Windows 安装程序。CI 已有相关检查，仍须核对结果。
- [ ] 全新安装正常，设置页“检查更新”可用；最新版应显示已是最新。
- [ ] 从旧版检查更新、下载、签名校验、安装重启和资料保留均正常。

Tauri 的 .sig 用于验证更新包，与 Windows Authenticode 代码签名是两回事。缺少 .sig 或 latest.json 即未完成更新链路，不能仅以安装包上传成功宣告发布成功。

## 密钥变更

常规发布沿用原签名密钥。丢失或轮换密钥时，不能只修改新包公钥就假定旧客户端能自动升级：旧客户端仍持有旧公钥。须单独设计兼容迁移或提供手动安装路径，并实际验证。历史手册的密钥重建步骤不作为当前自动更新迁移方案。
