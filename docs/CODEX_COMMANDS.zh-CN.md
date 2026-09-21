# Codex Telegram 交互设计

[English](CODEX_COMMANDS.md) · **简体中文** · [项目首页](README.zh-CN.md) · [开发路线](ROADMAP.md)

> 状态：Codex 核心适配器已经实现，支持官方 App Server 的私有 `stdio` 或本机回环共享 WebSocket。`/codex` 可浏览、选择、查看和控制现有任务。

## 最终交互

只使用一个 Telegram Bot。通知保持聚合，会话在同一列表中浏览；操作时先进入 OpenCode 或 Codex，再使用该 Agent 的子操作。

```text
/home 聚合首页
  ├─ OpenCode ── 选择会话 ── 查看、发送、队列、停止、审批
  └─ Codex    ── 选择任务 ── 查看、发送、队列、停止、审批/提问
```

选择会话后会自动进入对应模式。按钮携带 Agent 类型、会话和动作，用户不需要记 ID，也不会把 Codex 指令误发给旧的 OpenCode 会话。两个 Agent 的完成与失败通知仍进入同一个聊天，并显示 `[OpenCode]` 或 `[Codex]`。

## 主菜单

主菜单只保留日常命令，降低使用成本：

| 命令 | 作用 |
|---|---|
| `/home` | 聚合首页和两个 Agent 入口 |
| `/sessions` | 聚合浏览所有 Agent 会话 |
| `/opencode` | 直接进入 OpenCode 会话列表 |
| `/codex` | 直接进入 Codex 任务列表 |
| `/current` | 当前模式与会话 |
| `/show` | 当前会话进度、最近回复和改动 |
| `/send 内容` | 立即发送给当前会话 |
| `/add 内容` | 追加一条串行队列指令 |
| `/batch` | 用单独一行的 `---` 拆分多条队列指令 |
| `/queue` | 查看当前会话的运行项与等待项 |
| `/help` | 显示简明帮助 |

`/find`、`/use`、`/remove`、`/pause`、`/resume`、`/clearqueue`、`/stop`、`/approvals`、`/questions`、`/answer`、`/health` 和 `/status` 继续可用，只是不占主菜单。

## 统一操作与 Codex 扩展

选择 Codex 任务后，优先复用 `/show`、`/send`、`/add`、`/batch`、`/queue` 和 `/stop`，不再要求用户学习 `/tasks codex 2` 这类额外语法。

Codex 提问、按项目新建会话和运行中补充要求已经实现；审查命令仍在后续阶段：

| 命令 | 作用 | App Server 映射 |
|---|---|---|
| `/steer 内容` | 给正在运行的轮次补充要求（已实现） | `turn/steer` |
| `/questions` | 重新显示等待回答的问题（已实现） | `item/tool/requestUserInput` |
| `/answer 内容` | 回答当前任务下一条自由文本问题（已实现） | `item/tool/requestUserInput` response |
| `/new 项目别名 \| 指令` | 在预先登记的项目中建立新任务（已实现） | `thread/start` + `turn/start` |
| `/review working` | 审查未提交改动 | `review/start: uncommittedChanges` |
| `/review branch:main` | 与指定基础分支比较 | `review/start: baseBranch` |

官方 `codex app-server` 提供任务列表、读取、恢复、轮次启动与中断、运行中追加输入、审查、完成事件、审批和用户提问接口：[Codex App Server 官方文档](https://developers.openai.com/zh-Hans/docs/app-server)。

## 队列与通知

所有持久状态都使用带 Agent 身份的键。当前实现以 `{backend, serverUrl/instanceId, sessionId}` 隔离队列、运行中任务、恢复状态和事件去重；Codex 完成事件使用 `{backend, threadId, turnId}` 去重。

`/batch` 只在上一条收到终态后发送下一条。每条完成先通知，再推进队列；最后发送“全部完成”。电脑端手动启动的任务会通知，但不会推进不相关队列。重启后会根据保存状态、会话状态、事件和最近消息决定继续等待、恢复完成或重新入队。

## 审批与安全

审批按钮只显示 app-server 明确提供的决定，例如“仅允许这次”“本会话持续允许”“拒绝”和“取消任务”，不创造“全部永久放行”。Codex 提问会作为单独通知显示选项，也可以用 `/answer` 回复自由文本。

私有模式下，这些实时请求适用于由 Hub 发起的 Codex 任务。共享模式下，Desktop 与 Hub 使用同一个 App Server writer，因此 Hub 可以接收该服务上任务的实时审批、提问与完成事件。

- `/new` 只接受本机配置中登记的项目别名。
- 不提供 Telegram `/shell` 或任意 PowerShell 命令。
- `/stop`、`/clearqueue` 和未来的归档操作需要确认。
- 每个更新都校验私聊、Telegram 用户 ID 和聊天 ID。
- 私有模式通过本机 `stdio` 连接；共享模式只绑定 `127.0.0.1`，不开放局域网或公网端口。

## 实现顺序

1. 已完成：聚合首页、双入口、模式切换、后端标签、状态隔离、兼容旧 OpenCode 状态。
2. 已完成：Codex 任务列表、选择、新建、查看、发送、运行中补充、停止、完成提醒、外部任务完成轮询、审批、提问、队列和断电恢复。
3. 下一步：把现有 OpenCode HTTP 操作收进统一适配器接口，并增加更多契约测试。
4. 后续：审查、派生、目标和面向用户的归档操作。
