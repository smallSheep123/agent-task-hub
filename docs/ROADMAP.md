# Roadmap / 开发路线

This document distinguishes released behavior from planned work. 本文明确区分已经发布的能力和后续计划。

## Available now / 当前可用

- Bilingual Windows setup and management. / Windows 安装与管理支持中英文。
- Bilingual Telegram commands, buttons, and notifications. / Telegram 命令、按钮和通知支持中英文。
- OpenCode session discovery, control, completion events, approvals, and queues. / OpenCode 会话发现、控制、完成事件、审批和队列。
- Isolated runtime path, plugin name, and scheduled task. / 独立的数据目录、插件名和计划任务。

## Next: common adapter core / 下一步：通用适配层

- Move remaining OpenCode HTTP calls behind a documented adapter interface.
- Use `{backend, instanceId, sessionId}` as the permanent session key.
- Make Telegram views label each task with its backend.
- Add contract tests that can be reused by every adapter.

对应中文：把控制器中剩余的 OpenCode 调用移入适配器；采用包含后端类型的会话主键；在 Telegram 明确显示任务来自哪个智能体；为所有适配器建立统一契约测试。

## Codex integration / Codex 接入

The Codex adapter will be enabled only after its supported local interface and approval semantics are verified. It should provide:

- task discovery, status, recent output, and completion notifications;
- sending follow-up instructions to an existing task;
- approval and user-input notifications without bypassing Codex security decisions;
- the same queue behavior where the underlying interface supports reliable completion events.

Codex 适配器只有在本地接口和审批语义验证完成后才会启用。目标包括任务发现、状态与最近输出、完成通知、向现有任务追加指令，以及在不绕过安全决策的前提下转发审批和用户输入。只有底层接口能可靠提供完成事件时，才启用自动队列。

## Later / 后续

- Additional transports without coupling them to an agent adapter.
- Optional multiple-user roles with explicit policy and per-user audit records.
- More locales through external catalog files and locale contribution checks.

后续可加入更多消息入口、带明确权限策略的多用户模式，以及通过独立语言包扩展更多语言。
