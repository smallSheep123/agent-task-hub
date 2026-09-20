# Architecture

[English](../README.md) · [简体中文](README.zh-CN.md) · [Codex commands](CODEX_COMMANDS.md) · [Codex 命令设计](CODEX_COMMANDS.zh-CN.md) · [Roadmap](ROADMAP.md)

## Product boundary

Agent Task Hub separates transport, orchestration, and coding-agent integration:

```text
Telegram private chat
        │
        ▼
Transport + authorization
        │
        ▼
Task controller
  ├─ aggregated home + agent modes
  ├─ backend-aware session index
  ├─ per-agent-session queues
  ├─ event deduplication
  ├─ completion notifications
  └─ approval routing
        │
        ▼
Agent adapter contract
  ├─ OpenCode adapter  ← implemented
  ├─ Codex adapter     ← planned
  └─ future adapters
```

The controller currently contains OpenCode-oriented API calls. The Telegram interaction and persistent identities are already backend-aware; later releases will move transport calls behind the common adapter contract without changing the mode, command, button, or queue semantics.

## Adapter contract

Each adapter is expected to provide these capabilities where the backend supports them:

| Capability | Meaning |
|---|---|
| `discover` | List local instances and sessions |
| `inspect` | Read state, recent output, todos, and change summaries |
| `dispatch` | Send a prompt asynchronously |
| `abort` | Stop active work |
| `events` | Publish completion and failure events |
| `approvals` | List and answer explicit permission requests |

Backend records carry a `backend` identifier. Queue, in-flight work, recovery, deduplication, and button callbacks use a backend-aware session identity. This prevents equal OpenCode and Codex session IDs from colliding.

## Telegram interaction model

```text
/home (aggregated notifications and health)
  ├─ OpenCode entry ── select session ── OpenCode actions
  └─ Codex entry    ── select task    ── Codex actions
```

`/sessions` is the aggregated browser. `/opencode` and `/codex` are direct entrances. Selecting an item enters its backend mode. Common commands such as `/show`, `/send`, `/add`, `/batch`, `/queue`, and `/stop` operate only on the selected session in the active mode. Notifications from every adapter remain aggregated and always show their backend. The Codex entry currently reports that the adapter is unavailable.

## Current OpenCode flow

```text
OpenCode Desktop
  └─ adapters/opencode.js (installed as agent-task-hub.js)
       ├─ registers loopback OpenCode instances
       └─ writes session.idle and session.error events

Controller
  ├─ long-polls Telegram Bot API
  ├─ discovers OpenCode sessions over loopback HTTP
  ├─ persists queues, approval mappings, and deduplication state
  ├─ consumes adapter events
  └─ sends localized notifications and buttons

Windows Task Scheduler
  └─ starts the proxy-aware PowerShell launcher at logon
```

The adapter never reads the Telegram token. The controller never listens on a TCP port. They exchange registrations and events through an ACL-restricted local directory.

## Local data and isolation

Runtime data is stored under:

```text
%USERPROFILE%\.config\agent-task-hub
├─ config.json
├─ state.json
├─ ui.json
├─ controller.lock
├─ instances\
├─ events\
└─ logs\
```

The installed OpenCode adapter is `%USERPROFILE%\.config\opencode\plugins\agent-task-hub.js`, and the startup task is named `Agent Task Hub`. These identifiers do not overlap the earlier bridge project.

`config.json` stores the selected locale, Telegram identity binding, and a DPAPI-protected token. Instance records contain loopback connection metadata and a DPAPI-protected temporary OpenCode credential. `state.json` stores Telegram offsets, selected sessions, queues, recovery metadata, processed-event fingerprints, and short approval callback mappings.

## Queue lifecycle

1. `/add` or `/batch` appends work to the selected session queue.
2. When the session is idle, the controller marks one item as dispatching and sends it asynchronously.
3. The adapter writes a completion or failure event.
4. The controller correlates the event by backend, session, and dispatch time.
5. It persists the completion marker before notifying and advancing the queue.
6. After a restart, it compares in-flight state, saved events, current session status, and recent messages before waiting, recovering completion, or requeuing.

Tasks started directly on the computer produce notifications but advance a queue only when a stored item was explicitly dispatched.

## Trust boundaries

- Every Telegram update must match private-chat type, bound user ID, and bound chat ID.
- Agent endpoints are restricted to HTTP loopback hosts.
- The adapter and controller run as the interactive Windows user.
- Secrets are protected with Windows DPAPI and directory ACLs.
- Approval callbacks contain opaque local tokens; the controller rechecks identity before submitting a decision.
- No component exposes a network server or a general shell command through Telegram.
