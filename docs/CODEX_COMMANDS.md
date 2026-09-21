# Codex Telegram interaction design

**English** · [简体中文](CODEX_COMMANDS.zh-CN.md) · [Home](../README.md) · [Roadmap](ROADMAP.md)

> Status: the core Codex adapter supports the official local App Server over private `stdio` or a shared loopback WebSocket. `/codex` browses, selects, inspects, and controls existing tasks.

## Final interaction model

Agent Task Hub uses one Telegram bot. Notifications and session browsing stay aggregated, while actions happen after entering the OpenCode or Codex mode.

```text
/home aggregated home
  ├─ OpenCode ── select session ── inspect, send, queue, stop, approve
  └─ Codex    ── select task    ── inspect, send, queue, stop, approve/answer
```

Selecting a session automatically enters its backend mode. Buttons carry the backend, session, and action, so users do not need to copy IDs and a Codex action cannot target a previously selected OpenCode session. Completion and failure notifications share one chat and display `[OpenCode]` or `[Codex]`.

## Main menu

The visible command menu contains only routine actions:

| Command | Behavior |
|---|---|
| `/home` | Aggregated home and both agent entrances |
| `/sessions` | Browse sessions from every connected agent |
| `/opencode` | Enter the OpenCode session list |
| `/codex` | Enter the Codex task list |
| `/current` | Show the current mode and session |
| `/show` | Show progress, latest output, and changes |
| `/send prompt` | Send immediately to the selected session |
| `/add prompt` | Append one sequential queue item |
| `/batch` | Split queue items with a line containing `---` |
| `/queue` | Show active and waiting work for the selected session |
| `/help` | Show concise help |

`/find`, `/use`, `/remove`, `/pause`, `/resume`, `/clearqueue`, `/stop`, `/approvals`, `/questions`, `/answer`, `/health`, and `/status` remain accepted without occupying the main menu.

## Common actions and Codex extensions

After selecting a Codex task, the Hub reuses `/show`, `/send`, `/add`, `/batch`, `/queue`, and `/stop`. Users do not need a separate `/tasks codex 2` grammar.

Codex questions, project-based task creation, and active-turn steering are implemented. Review commands remain planned:

| Command | Behavior | App Server mapping |
|---|---|---|
| `/steer instruction` | Add input to an active turn (implemented) | `turn/steer` |
| `/questions` | Show unanswered Codex questions (implemented) | `item/tool/requestUserInput` |
| `/answer text` | Answer the next free-text question for the selected task (implemented) | `item/tool/requestUserInput` response |
| `/new project_alias \| prompt` | Create work in an approved project (implemented) | `thread/start` + `turn/start` |
| `/review working` | Review uncommitted changes | `review/start: uncommittedChanges` |
| `/review branch:main` | Review against a base branch | `review/start: baseBranch` |

The official [`codex app-server` documentation](https://developers.openai.com/docs/app-server) defines task listing and reading, turn start and interruption, steering, reviews, completion events, approvals, and user-input requests.

## Queues and notifications

Persistent state uses a backend-aware identity. The current implementation separates queues, in-flight items, recovery, and event deduplication with `{backend, serverUrl/instanceId, sessionId}`. Codex terminal events deduplicate with `{backend, threadId, turnId}`.

`/batch` dispatches the next item only after the previous item reaches a terminal state. Every item is reported before the queue advances, followed by one queue-complete notification. Work started on the computer is reported without advancing an unrelated queue. Restart recovery compares persisted state, current session status, pending events, and recent messages.

## Approvals and safety

Buttons expose only decisions returned by app-server, such as allow once, allow for session, reject, and cancel. The Hub does not invent a permanent allow-all decision. Codex user-input requests appear as separate notifications with option buttons and `/answer` support.

In private mode, these live requests are available for Codex turns started through the Hub. In shared mode, Desktop and the Hub use the same App Server writer, so the Hub can receive live approvals, questions, and completion events from work on that server.

- `/new` accepts only locally registered project aliases.
- Telegram never exposes a shell or arbitrary PowerShell execution.
- Stop, queue clearing, and future archive actions require confirmation.
- Every update must match private chat, bound Telegram user ID, and bound chat ID.
- Private mode uses local `stdio`. Shared mode binds the official App Server only to `127.0.0.1`; the Hub opens no LAN or public port.

## Delivery order

1. Done: aggregated home, two entrances, automatic mode selection, backend labels, backend-aware state, and legacy OpenCode state migration.
2. Done: Codex list, select, create, inspect, send, steer, stop, terminal notifications, external-completion polling, approvals, questions, queues, and restart recovery.
3. Next: move existing OpenCode HTTP operations behind a common adapter interface and expand contract tests.
4. Later: review, fork, goal, and user-facing archive operations.
