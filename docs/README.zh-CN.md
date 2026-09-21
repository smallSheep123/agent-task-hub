# Agent Task Hub

[English](../README.md) · **简体中文** · [架构说明](ARCHITECTURE.md) · [Codex 命令设计](CODEX_COMMANDS.zh-CN.md) · [开发路线](ROADMAP.md) · [安全说明](../SECURITY.md)

Agent Task Hub 是面向 Windows 本机编码智能体的多语言 Telegram 控制中心。当前版本已经通过一个机器人支持 OpenCode Desktop 和 Codex，并隔离各自的会话、队列、事件与审批。

> 当前状态：OpenCode 与 Codex 适配器均已实现。Codex 支持私有 `stdio`，也可以选择只绑定 `127.0.0.1` 的官方共享 App Server。

## 已有能力

- OpenCode 会话或受监控的 Codex 轮次完成、失败或中断时发送 Telegram 通知。
- 一个聚合首页提供 OpenCode 和 Codex 两个入口；选择会话后自动进入对应 Agent 模式。
- 聚合首页作为实时运行看板，分别显示 OpenCode、Codex 正在执行的会话、运行时间、项目目录、排队数量和审批/选择阻塞状态。
- 分页浏览会话，并按标题或项目目录搜索。
- 立即发送指令，或用 `/add`、`/batch` 为每个会话建立串行队列。
- 重启后恢复队列，过滤重复事件，避免重复通知和重复执行。
- 转发所有已登记 OpenCode 本机会话的审批与选择题，以及由 Hub 发起的 Codex 任务审批和提问；只显示底层 Agent 明确支持的决定。
- 查看会话进度、最近回复、文件改动、队列和服务健康状态。
- OpenCode 通信只走本机回环地址，不开放任何入站端口。
- 安装、管理、Telegram 命令、按钮和通知均支持简体中文与英文。

## 快速开始

需要 Windows 10/11、Node.js 22 或更新版本、通过 [@BotFather](https://t.me/BotFather) 创建的 Telegram Bot，以及至少一个本机 Agent：OpenCode Desktop 或 Codex Desktop/CLI。

1. 下载或克隆本仓库。
2. 双击 `Bridge-Manager.cmd`。
3. 选择“简体中文”或“English”。程序会记住选择，也可以在主菜单输入 `L` 随时切换。
4. 选择“首次配置并启动”，粘贴 Bot Token，给机器人发送 `/start`，确认检测到的 Telegram 账号。
5. 重启一次 OpenCode Desktop，然后给机器人发送 `/home` 并进入 **OpenCode**。

安装程序会把适配器复制到 `%USERPROFILE%\.config\opencode\plugins\agent-task-hub.js`，把运行数据保存到 `%USERPROFILE%\.config\agent-task-hub`，并创建名为 `Agent Task Hub` 的计划任务。这些名称和旧的 OpenCode Telegram Bridge 完全分开，不会共用配置、运行状态或自启任务。

## Telegram 命令

| 命令 | 作用 |
|---|---|
| `/home` | 打开聚合首页 |
| `/opencode`、`/codex` | 进入对应 Agent 的会话列表 |
| `/sessions` 或 `/sessions 2` | 分页浏览所有已连接 Agent 的会话 |
| `/find 关键词` | 搜索标题和项目目录 |
| `/use 1` | 选择当前页面中的会话 |
| `/current`、`/show` | 查看当前模式、会话、状态、改动、待办和最近回复 |
| `/send 内容` | 向当前 Agent 会话立即发送一条指令 |
| `/add 内容` | 向当前 Agent 会话队列追加一条指令 |
| `/batch` | 按单独一行的 `---` 拆分多条指令 |
| `/queue`、`/remove 2` | 查看队列或删除等待项 |
| `/pause`、`/resume`、`/clearqueue` | 控制自动队列 |
| `/stop` | 二次确认后停止当前任务 |
| `/approvals` | 重新显示待处理的 OpenCode 与 Codex 审批 |
| `/questions`、`/answer 内容` | 查看或回答 OpenCode 与 Codex 等待中的问题 |
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

主命令菜单保持精简，高级队列、审批和诊断命令仍然可以直接输入。按钮携带操作、Agent 类型和会话身份，切换模式后不需要反复输入会话 ID。

首页每个 Agent 最多展示 3 个正在执行的会话，并为活跃会话提供直接进入按钮。点击“刷新”重新计算运行时间和阻塞状态；历史任务和空闲会话继续放在“全部会话”中。

OpenCode 提问不受 Telegram 当前 Agent 模式影响：单选点击后直接继续，多选选好后点击“提交选择”，自由输入使用 `/answer 内容`。

由 Hub 发起的 Codex 任务保持实时 app-server 连接，因此可以在 Telegram 处理审批和提问。若任务从另一个 Codex 客户端发起，Hub 会检测并聚合最终完成通知；运行中的审批和提问仍由持有该 app-server 连接的客户端处理。

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

连接方式保存在现有受保护配置目录的 `codexTransport` 与 `codexWsUrl` 字段中。共享模式使用官方 standalone Codex 完整包；Desktop 自带的单个可执行文件不包含完整 daemon 包。

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

## 开发测试

运行时没有 npm 依赖：

```powershell
npm test
npm run check
npm run stress
npm run stress:codex
npm run smoke:codex
```

适配器边界见[架构说明](ARCHITECTURE.md)，手机端正式命令见[Codex 交互说明](CODEX_COMMANDS.zh-CN.md)，后续功能见[开发路线](ROADMAP.md)。

## 许可证

[MIT](../LICENSE)
