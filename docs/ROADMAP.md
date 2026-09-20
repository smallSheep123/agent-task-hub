# Roadmap / 开发路线

This document distinguishes released behavior from planned work. 本文明确区分已经发布的能力和后续计划。

The planned Telegram command contract is documented in [Codex command design](CODEX_COMMANDS.md) and [Codex 命令设计](CODEX_COMMANDS.zh-CN.md).

## Available now / 当前可用

- Bilingual Windows setup and management. / Windows 安装与管理支持中英文。
- Bilingual Telegram commands, buttons, and notifications. / Telegram 命令、按钮和通知支持中英文。
- OpenCode session discovery, control, completion events, approvals, and queues. / OpenCode 会话发现、控制、完成事件、审批和队列。
- Codex task discovery, inspection, dispatch, interruption, terminal monitoring, approvals, questions, and queues over local app-server stdio. / 通过本机 app-server stdio 支持 Codex 任务发现、查看、发布、中断、完成监控、审批、提问和队列。
- Isolated runtime path, plugin name, and scheduled task. / 独立的数据目录、插件名和计划任务。
- Aggregated home, OpenCode/Codex entrances, automatic mode switching after session selection, backend labels, and backend-aware queue/recovery keys. / 聚合首页、OpenCode/Codex 双入口、选择会话后自动切换模式、后端标签，以及带后端身份的队列与恢复键。

## Next: adapter cleanup / 下一步：适配器整理

- Move remaining OpenCode HTTP calls behind a documented adapter interface.
- Add contract tests that can be reused by every adapter.

对应中文：把控制器中剩余的 OpenCode 调用移入适配器，并为所有适配器建立统一契约测试。

## Codex additions / Codex 后续能力

The core Codex adapter is available. Later additions may provide:

- creating tasks from administrator-approved project aliases;
- steering an active turn;
- review, fork, goal, archive, and richer diff actions;
- optional managed-daemon support when Codex exposes a shared local control socket.

Codex 核心适配器已经可用。后续可加入基于管理员项目别名的新建任务、运行中补充要求、审查、派生、目标、归档，以及在 Codex 提供共享本机控制套接字后接入托管守护进程。

## Later / 后续

- Additional transports without coupling them to an agent adapter.
- Optional multiple-user roles with explicit policy and per-user audit records.
- More locales through external catalog files and locale contribution checks.

后续可加入更多消息入口、带明确权限策略的多用户模式，以及通过独立语言包扩展更多语言。
