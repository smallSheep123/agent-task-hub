# Agent Task Hub

[English](../README.md) · **简体中文** · [架构说明](ARCHITECTURE.md) · [Codex 命令设计](CODEX_COMMANDS.zh-CN.md) · [开发路线](ROADMAP.md) · [安全说明](../SECURITY.md)

Agent Task Hub 是面向 Windows 本机编码智能体的多语言 Telegram 控制中心。当前版本已经支持 OpenCode Desktop；项目通过独立适配器接入不同智能体，为以后加入 Codex 和其他模型保留清晰边界。

> 当前状态：OpenCode 适配器已经可用；Codex 接入仍在开发路线中，当前版本不会假装已经支持。

## 已有能力

- 每个 OpenCode 会话完成或失败时发送 Telegram 通知。
- 分页浏览会话，并按标题或项目目录搜索。
- 立即发送指令，或用 `/add`、`/batch` 为每个会话建立串行队列。
- 重启后恢复队列，过滤重复事件，避免重复通知和重复执行。
- OpenCode 等待权限审批时提供“仅允许这次”“本会话持续允许”“拒绝”按钮。
- 查看会话进度、最近回复、文件改动、队列和服务健康状态。
- OpenCode 通信只走本机回环地址，不开放任何入站端口。
- 安装、管理、Telegram 命令、按钮和通知均支持简体中文与英文。

## 快速开始

需要 Windows 10/11、OpenCode Desktop、Node.js 20 或更新版本，以及通过 [@BotFather](https://t.me/BotFather) 创建的 Telegram Bot。

1. 下载或克隆本仓库。
2. 双击 `Bridge-Manager.cmd`。
3. 选择“简体中文”或“English”。程序会记住选择，也可以在主菜单输入 `L` 随时切换。
4. 选择“首次配置并启动”，粘贴 Bot Token，给机器人发送 `/start`，确认检测到的 Telegram 账号。
5. 重启一次 OpenCode Desktop，然后给机器人发送 `/sessions`。

安装程序会把适配器复制到 `%USERPROFILE%\.config\opencode\plugins\agent-task-hub.js`，把运行数据保存到 `%USERPROFILE%\.config\agent-task-hub`，并创建名为 `Agent Task Hub` 的计划任务。这些名称和旧的 OpenCode Telegram Bridge 完全分开，不会共用配置、运行状态或自启任务。

## Telegram 命令

| 命令 | 作用 |
|---|---|
| `/sessions` 或 `/sessions 2` | 分页浏览会话 |
| `/find 关键词` | 搜索标题和项目目录 |
| `/use 1` | 选择当前页面中的会话 |
| `/show` | 查看状态、改动、待办和最近回复 |
| `/send 内容` | 立即发送一条指令 |
| `/add 内容` | 向当前会话队列追加一条指令 |
| `/batch` | 按单独一行的 `---` 拆分多条指令 |
| `/queue`、`/remove 2` | 查看队列或删除等待项 |
| `/pause`、`/resume`、`/clearqueue` | 控制自动队列 |
| `/stop` | 二次确认后停止当前任务 |
| `/approvals` | 重新显示待处理的 OpenCode 审批 |
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

## 管理

平时双击 `Bridge-Manager.cmd` 即可，也可以在 PowerShell 中执行：

```powershell
.\bridge.ps1 -Action status -Language zh-CN
.\bridge.ps1 -Action doctor -Language zh-CN
.\bridge.ps1 -Action restart -Language zh-CN
.\bridge.ps1 -Action install-plugin -Language zh-CN
```

语言可设为 `zh-CN`、`en-US` 或 `auto`。交互管理器会把偏好保存到 `%USERPROFILE%\.config\agent-task-hub\ui.json`。

## 开发测试

运行时没有 npm 依赖：

```powershell
npm test
npm run check
```

适配器边界见[架构说明](ARCHITECTURE.md)，手机端正式命令见[Codex 命令设计](CODEX_COMMANDS.zh-CN.md)，交付阶段见[开发路线](ROADMAP.md)。

## 许可证

[MIT](../LICENSE)
