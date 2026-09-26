# Agent Task Hub

[English](../README.md) · **简体中文** · [架构说明](ARCHITECTURE.md) · [Codex 命令设计](CODEX_COMMANDS.zh-CN.md) · [开发路线](ROADMAP.md) · [安全说明](../SECURITY.md)

Agent Task Hub 是面向 Windows 本机编码智能体的多语言 Telegram 控制中心。当前版本已经通过一个机器人支持 OpenCode Desktop、Codex、ZCode 和 Pi，并隔离各自的会话、队列、事件与审批。

> 当前状态：OpenCode、Codex 与 ZCode 适配器均已实现。Codex 支持私有 `stdio`，也可以选择只绑定 `127.0.0.1` 的官方共享 App Server；ZCode 使用桌面端自带的 App Server，通过私有 `stdio` 通信。

## 已有能力

- OpenCode、Codex 或 ZCode 任务完成、失败或中断时发送 Telegram 通知。
- 一个聚合首页提供 OpenCode、Codex 和 ZCode 三个入口；选择会话后自动进入对应 Agent 模式。
- 聚合首页作为实时运行看板，分别显示 OpenCode、Codex 正在执行的会话、运行时间、项目目录、排队数量和审批/选择阻塞状态。
- 分页浏览会话，并按标题或项目目录搜索。
- 立即发送指令，或用 `/add`、`/batch` 为每个会话建立串行队列。
- 重启后恢复队列，过滤重复事件，避免重复通知和重复执行。
- 转发所有已登记 OpenCode 本机会话的审批与选择题，以及由 Hub 发起的 Codex、ZCode 任务审批和提问；只显示底层 Agent 明确支持的决定。
- 查看会话进度、最近回复、文件改动、队列和服务健康状态。
- OpenCode 通信只走本机回环地址，不开放任何入站端口。
- 安装、管理、Telegram 命令、按钮和通知均支持简体中文与英文。

## 快速开始

需要 Windows 10/11、Node.js 22 或更新版本、通过 [@BotFather](https://t.me/BotFather) 创建的 Telegram Bot，以及至少一个本机 Agent：OpenCode Desktop、Codex Desktop/CLI 或 ZCode Desktop。

1. 下载或克隆本仓库。
2. 双击 `Bridge-Manager.cmd`。
3. 选择“简体中文”或“English”。程序会记住选择，也可以在主菜单输入 `L` 随时切换。
4. 选择“首次配置并启动”，粘贴 Bot Token，给机器人发送 `/start`，确认检测到的 Telegram 账号。
5. 重启一次 OpenCode Desktop，然后给机器人发送 `/home` 并进入 **OpenCode**。

安装程序会把适配器复制到 `%USERPROFILE%\.config\opencode\plugins\agent-task-hub.js`，把运行数据保存到 `%USERPROFILE%\.config\agent-task-hub`，并创建名为 `Agent Task Hub` 的计划任务。这些名称和旧的 OpenCode Telegram Bridge 完全分开，不会共用配置、运行状态或自启任务。

### Pi 终端接入

运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-pi-extension.ps1`，将扩展安装到 `%USERPROFILE%\.pi\agent\extensions\agent-task-hub.js`。新开的 Pi 终端会自动加载；已打开的每个终端需要输入一次 `/reload`。随后在 Telegram 发送 `/pi`，选择一个正在运行的 Pi 终端。可对所选终端使用 `/send`、`/add`、`/batch`、`/queue` 和 `/stop`；电脑端手动执行的任务也会发送完成通知。每个终端进程单独登记，即使打开同一份会话文件也不会混淆。通信只使用本机文件，不监听网络端口，也不复制 Pi 凭证。Pi 的审批仍在终端处理。如果网关重启后无法确认某条 Pi 队列指令是否完成，队列会暂停等待人工核对，避免重复执行。

## Telegram 命令

| 命令 | 作用 |
|---|---|
| `/home` | 打开聚合首页 |
| `/opencode`、`/codex`、`/zcode`、`/pi` | 进入对应 Agent 的会话列表 |
| `/new 项目别名 \| 指令` | 在当前 Codex 或 ZCode 模式中新建会话 |
| `/sessions` 或 `/sessions 2` | 分页浏览所有已连接 Agent 的会话 |
| `/find 关键词` | 搜索标题和项目目录 |
| `/use 1` | 选择当前页面中的会话 |
| `/current`、`/show` | 查看当前模式、会话、状态、改动、待办和最近回复 |
| `/send 内容` | 发送独立可见轮次；Codex 忙碌时自动等待 |
| `/steer 内容` | 立即补充正在运行的 Codex 轮次，不生成独立用户气泡 |
| `/add 内容` | 向当前 Agent 会话队列追加一条指令 |
| `/batch` | 按单独一行的 `---` 拆分多条指令 |
| `/queue`、`/remove 2` | 查看队列或删除等待项 |
| `/pause`、`/resume`、`/clearqueue` | 控制自动队列 |
| `/stop` | 二次确认后停止当前任务 |
| `/approvals` | 重新显示待处理的 OpenCode、Codex 与 ZCode 审批 |
| `/questions`、`/answer 内容` | 查看或回答 OpenCode、Codex 与 ZCode 等待中的问题 |
| `/health`、`/status` | 查看完整或简要健康状态 |

批量示例：

```text
/batch
检查失败的测试
---
修复根因并重新运行测试
---
写一份维护说明
```

上一条完成后才会启动下一条。机器人会先发送每条任务的完成消息，队列清空后再发送一次“全部完成”。电脑上手动启动的任务也会通知，但不会误触发无关队列。

`/new` 只接受 `%USERPROFILE%\.config\agent-task-hub\config.json` 中登记的别名。Codex 使用 `codexProjects`，ZCode 使用 `zcodeProjects`，例如：`"zcodeProjects": { "hub": "D:\\AIGC\\agent-task-hub" }`。

主命令菜单保持精简，高级队列、审批和诊断命令仍然可以直接输入。按钮携带操作、Agent 类型和会话身份，切换模式后不需要反复输入会话 ID。

首页每个 Agent 最多展示 3 个正在执行的会话，并为活跃会话提供直接进入按钮。点击“刷新”重新计算运行时间和阻塞状态；历史任务和空闲会话继续放在“全部会话”中。

OpenCode 提问不受 Telegram 当前 Agent 模式影响：单选点击后直接继续，多选选好后点击“提交选择”，自由输入使用 `/answer 内容`。

由 Hub 发起的 Codex 任务保持实时 app-server 连接，因此可以在 Telegram 处理审批和提问。若任务从另一个 Codex 客户端发起，Hub 会检测并聚合最终完成通知；运行中的审批和提问仍由持有该 app-server 连接的客户端处理。

ZCode 使用已安装桌面端自带的 App Server。适配器在运行时读取现有 ZCode 账户配置，只在内存中按 ZCode 本机格式解密；不会把供应商凭证复制到 Hub 配置、状态、日志或仓库。Telegram 新建或继续的任务会同步到 ZCode Desktop 的本地任务索引，Hub 也会同时显示普通会话与 fork 会话。Telegram 发起的会话会保持实时订阅，用于完成通知、审批和问题处理；服务重启后由轮询作为恢复通道。

会话发现会并行执行，在网关启动时预热，并使用短缓存。首次请求对每个 Agent 最多等待 1.2 秒，已有结果会先显示，后台继续刷新。Telegram 交互会暂时让后台恢复扫描让路；ZCode 在定期恢复检查之间只轮询活跃或发生变化的会话；失效的 OpenCode 本机端口使用有上限的指数退避。这样可以提升交互速度，同时保留完成通知和重启恢复能力。

### Codex 共享后端

0.3 版本新增可选的 Codex 共享后端。它在 `ws://127.0.0.1:9234` 运行官方 Codex App Server，让 Agent Task Hub 和兼容的 Codex 客户端连接同一个服务进程，共用同一个会话 writer。监听地址仅限本机回环，不会暴露到局域网或公网。

启用前先运行兼容性探测：

```powershell
.\bridge.ps1 -Action codex-probe -Language zh-CN
.\bridge.ps1 -Action codex-shared -Language zh-CN
.\bridge.ps1 -Action restart -Language zh-CN
```

启用后需要完全退出并重新打开 Codex Desktop。需要恢复 0.2 版本的稳定连接方式时执行：

```powershell
.\bridge.ps1 -Action codex-private -Language zh-CN
.\bridge.ps1 -Action restart -Language zh-CN
```

连接方式保存在现有受保护配置目录的 `codexTransport` 与 `codexWsUrl` 字段中。共享服务每次启动都会自动发现最新的 Codex Desktop runtime，使协议版本与界面保持一致；官方 standalone 包只作为备用。

## 管理

平时双击 `Bridge-Manager.cmd` 即可，也可以在 PowerShell 中执行：

```powershell
.\bridge.ps1 -Action status -Language zh-CN
.\bridge.ps1 -Action doctor -Language zh-CN
.\bridge.ps1 -Action restart -Language zh-CN
.\bridge.ps1 -Action install-plugin -Language zh-CN
.\bridge.ps1 -Action codex-probe -Language zh-CN
.\bridge.ps1 -Action codex-shared -Language zh-CN
.\bridge.ps1 -Action codex-private -Language zh-CN
```

语言可设为 `zh-CN`、`en-US` 或 `auto`。交互管理器会把偏好保存到 `%USERPROFILE%\.config\agent-task-hub\ui.json`。

如果 Telegram 直连不稳定，可在 `config.json` 中把 `outboundProxy` 设为本机 HTTP 代理，例如 `http://127.0.0.1:7897`，然后重启服务。启动器会把它传给 Node，同时把 `127.0.0.1`、`localhost` 和 `::1` 保留在 `NO_PROXY` 中，因此各 Agent 的本机通信不会绕代理。已有的 `HTTPS_PROXY` 环境变量优先；否则仍会尝试已启用的 Windows 系统代理。

## 开发测试

运行时没有 npm 依赖：

```powershell
npm test
npm run check
npm run stress
npm run stress:codex
npm run smoke:codex
npm run smoke:zcode
```

`npm run smoke:zcode` 默认只读；追加 `-- --send` 会创建一个临时真实任务、等待回复并验证完整发送链路。

真实 E2E 会创建并运行 Codex 测试轮次，因此需要显式启用；两个脚本结束时都会归档临时会话：

```powershell
$env:AGENT_TASK_HUB_LIVE_E2E = '1'
npm run e2e:codex
npm run e2e:hub
```

适配器边界见[架构说明](ARCHITECTURE.md)，手机端正式命令见[Codex 交互说明](CODEX_COMMANDS.zh-CN.md)，后续功能见[开发路线](ROADMAP.md)。

## 许可证

[MIT](../LICENSE)
