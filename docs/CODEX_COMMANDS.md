# Codex Telegram command design

**English** · [简体中文](CODEX_COMMANDS.zh-CN.md) · [Home](../README.md) · [Roadmap](ROADMAP.md)

> Status: this is the agreed interaction specification. The Codex adapter is not implemented yet; the current release executes OpenCode commands only.

## Decision

Codex will use the existing Telegram bot, queue engine, and notification UI. Every task carries a `backend` value such as `opencode` or `codex`. Common operations stay unified, while Codex-only capabilities get explicit commands.

The official [`codex app-server` documentation](https://developers.openai.com/zh-Hans/docs/app-server) defines thread listing, creation, resume and read operations; starting, steering and interrupting turns; reviews; terminal completion events; approvals; and user-input requests. The command surface below maps to those supported operations.

## Command surface

| Command | Behavior | Codex mapping | Phase |
|---|---|---|---|
| `/agents` | List connected agent backends and health | Adapter state | 1 |
| `/tasks codex 2` | Show page 2 of Codex tasks | `thread/list` | 1 |
| `/sessions` | Compatibility alias for `/tasks` | `thread/list` | 1 |
| `/find codex keyword` | Search Codex tasks | `thread/list searchTerm` plus local path filtering | 1 |
| `/use 3` | Select task 3 from the current result | Local selection state | 1 |
| `/current` | Show the selected task and backend | `thread/read` | 1 |
| `/show` | Show status, plan, latest reply, and changes | `thread/read` and turn/item events | 1 |
| `/new codex project_alias \| prompt` | Create a task in an approved project | `thread/start` + `turn/start` | 2 |
| `/send prompt` | Start a new turn in an idle task | `thread/resume` + `turn/start` | 1 |
| `/steer instruction` | Add input to the active Codex turn | `turn/steer` | 1 |
| `/add prompt`, `/batch` | Append one or several sequential prompts | Hub queue + `turn/completed` | 1 |
| `/queue`, `/remove 2` | Inspect or edit waiting work | Persisted Hub queue | 1 |
| `/pause`, `/resume`, `/clearqueue` | Control automatic queue progress | Hub queue state | 1 |
| `/stop` | Interrupt the active turn after confirmation | `turn/interrupt` | 1 |
| `/review working` | Review uncommitted changes | `review/start: uncommittedChanges` | 2 |
| `/review branch:main` | Review against a base branch | `review/start: baseBranch` | 2 |
| `/approvals` | Show pending approvals again | App Server approval requests | 1 |
| `/questions` | Show pending Codex questions again | `item/tool/requestUserInput` | 1 |
| `/health`, `/status` | Show detailed or compact aggregated health | Hub diagnostics | 1 |

## Completion and queue rules

The unique completion key is `{backend, threadId, turnId}`. The Hub persists that key before notifying the user or advancing a queue. `turn/completed` has `completed`, `failed`, or `interrupted` terminal states, and each state produces a distinct notification.

`/batch` dispatches the next item only after a terminal turn event. `/steer` modifies the active turn, so it does not create another queue item or completion count.

## Approvals and safety

Telegram buttons reflect only decisions returned by App Server: allow once, allow for session, reject, or cancel. The bridge never invents broader permission choices and never exposes a permanent allow-all action.

- `/new` accepts only project aliases registered locally by the administrator.
- No Telegram shell or arbitrary PowerShell command is exposed.
- Codex keeps its configured sandbox and approval policy.
- Destructive or queue-clearing actions require confirmation.
- App Server uses local `stdio` transport by default; the Hub does not expose it to the public network.

Phase 1 covers listing, selection, inspection, dispatch, steering, interruption, completion notifications, approvals, questions, and queues. Phase 2 adds task creation, reviews, forks, goals, and archival controls.
