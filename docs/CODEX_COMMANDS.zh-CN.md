# Codex Telegram 命令设计

[English](CODEX_COMMANDS.md) · **简体中文** · [项目首页](README.zh-CN.md) · [开发路线](ROADMAP.md)

> 状态：这是已经确定的交互规范，Codex 适配器尚未实现。当前发布版仍只执行 OpenCode 命令。

## 设计结论

Codex 不单独建立第二个机器人。Agent Task Hub 使用同一个 Telegram Bot、同一套队列和通知界面，通过任务的 `backend` 字段区分 `opencode` 与 `codex`。普通操作保持统一，只有 Codex 独有能力使用额外命令。

官方 `codex app-server` 已提供线程列表、创建、恢复、读取、启动轮次、运行中追加输入、中断、代码审查、完成事件和审批请求，因此下面的核心命令有明确接口依据：[Codex App Server 官方文档](https://developers.openai.com/zh-Hans/docs/app-server)。

## 正式命令表

| 命令 | 作用 | Codex 映射 | 计划阶段 |
|---|---|---|---|
| `/agents` | 查看已连接的 OpenCode、Codex 和健康状态 | 适配器连接状态 | 第一阶段 |
| `/tasks codex 2` | 查看 Codex 任务第 2 页 | `thread/list` | 第一阶段 |
| `/sessions` | 保留为 `/tasks` 的兼容别名 | `thread/list` | 第一阶段 |
| `/find codex 关键词` | 按标题或项目搜索 Codex 任务 | `thread/list searchTerm`，本地补充路径筛选 | 第一阶段 |
| `/use 3` | 选择当前列表第 3 个任务 | 本地选择状态 | 第一阶段 |
| `/current` | 查看当前任务及所属智能体 | `thread/read` | 第一阶段 |
| `/show` | 查看状态、计划、最近回复和改动摘要 | `thread/read`、轮次与条目事件 | 第一阶段 |
| `/new codex 项目别名 \| 指令` | 在预先登记的项目中创建 Codex 任务 | `thread/start` + `turn/start` | 第二阶段 |
| `/send 指令` | 向空闲任务启动一个新轮次 | `thread/resume` + `turn/start` | 第一阶段 |
| `/steer 补充要求` | 给正在运行的 Codex 轮次追加要求 | `turn/steer` | 第一阶段 |
| `/add 指令` | 向当前任务队列追加一条指令 | Hub 队列 + `turn/start` | 第一阶段 |
| `/batch` | 按 `---` 分隔多条串行指令 | Hub 队列 + `turn/completed` | 第一阶段 |
| `/queue` | 查看当前任务正在运行和等待的指令 | Hub 持久化队列 | 第一阶段 |
| `/remove 2` | 删除第 2 条等待指令 | Hub 持久化队列 | 第一阶段 |
| `/pause`、`/resume` | 暂停或恢复自动发送下一条 | Hub 队列状态 | 第一阶段 |
| `/clearqueue` | 二次确认后清空等待指令 | Hub 持久化队列 | 第一阶段 |
| `/stop` | 二次确认后中断当前 Codex 轮次 | `turn/interrupt` | 第一阶段 |
| `/review working` | 审查未提交改动 | `review/start: uncommittedChanges` | 第二阶段 |
| `/review branch:main` | 与指定基础分支比较并审查 | `review/start: baseBranch` | 第二阶段 |
| `/approvals` | 重新显示待处理审批 | App Server 审批请求 | 第一阶段 |
| `/questions` | 重新显示 Codex 等待回答的问题 | `item/tool/requestUserInput` | 第一阶段 |
| `/health` | 查看 Telegram、各适配器、任务、队列和错误 | Hub 诊断聚合 | 第一阶段 |
| `/status` | 查看简要在线状态 | Hub 诊断聚合 | 第一阶段 |

## 手机端示例

列出 Codex 任务并选择：

```text
/tasks codex 1
/use 2
/show
```

给空闲任务发布需求：

```text
/send 修复登录页偶发的重复提交，并运行相关测试
```

任务运行过程中补充要求：

```text
/steer 先不要改接口协议，优先寻找前端重复绑定事件
```

提交自动队列：

```text
/batch
分析失败测试和根因
---
修复后运行完整测试
---
整理改动说明并更新文档
```

创建新任务时只允许使用管理员预先登记的项目别名：

```text
/new codex website | 检查构建失败并完成修复
```

机器人不会接受手机发来的任意磁盘路径。

## 通知规则

Codex 每个轮次的唯一完成键为 `{backend, threadId, turnId}`。收到 `turn/completed` 后先持久化完成标记，再发送通知和推进队列，避免断线重连产生重复通知或重复执行。

通知分为：

- `completed`：任务完成，显示耗时、改动和最近回复；
- `failed`：任务失败，显示可安全公开的错误摘要；
- `interrupted`：用户或系统中断，不自动当作成功；
- approval required：命令、文件、网络或额外权限等待审批；
- input required：Codex 正在等待用户回答；
- queue complete：当前任务的所有排队指令已经完成。

`/batch` 只在当前轮次收到终态后发送下一条。`/steer` 属于当前轮次，不创建新的队列项，也不会额外计算一次完成。

## 审批按钮

根据 App Server 返回的 `availableDecisions` 动态显示按钮：

- **仅允许这次 / Allow once**
- **本会话持续允许 / Allow for session**
- **拒绝 / Reject**
- **取消 / Cancel**

桥接只转发 Codex 明确提供的决定，不自行扩大权限，也不提供“全部永久放行”。`request_permissions` 请求只允许用户从请求的文件系统或网络权限中选择子集。

## 安全边界

- `/new` 只能使用本地配置中登记的项目别名和固定工作目录。
- 不提供 Telegram `/shell` 或任意 PowerShell 命令。
- 默认使用 Codex 的 `workspaceWrite` 沙盒；审批策略由本机配置决定。
- `/stop`、`/clearqueue` 以及未来的归档操作需要按钮确认。
- 机器人仍同时校验私聊类型、Telegram 用户 ID 和聊天 ID。
- Codex App Server 默认通过本机 `stdio` 连接，不对公网开放端口。

## 实现顺序

第一阶段先完成任务列表、选择、查看、发送、运行中补充、停止、完成提醒、审批、提问转发和队列。第二阶段再加入新建任务、审查、派生任务、目标和归档，避免首版命令过多。
