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
  ├─ Codex app-server  ← implemented
  └─ future adapters
```

The controller routes OpenCode through loopback HTTP and Codex through a persistent local JSONL `stdio` process. Telegram interaction and persistent identities are backend-aware, so both adapters share commands and queue semantics without sharing state.

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

`/sessions` is the aggregated browser. `/opencode` and `/codex` are direct entrances. Selecting an item enters its backend mode. Common commands such as `/show`, `/send`, `/add`, `/batch`, `/queue`, and `/stop` operate only on the selected session in the active mode. Notifications from every adapter remain aggregated and always show their backend.

## Codex flow

```text
Controller
  └─ local Codex app-server process (stdio JSONL)
       ├─ thread/list + thread/read for discovery and inspection
       ├─ thread/resume + turn/start for prompts and queues
       ├─ turn/interrupt for stop
       ├─ turn/completed for terminal notifications
       └─ server requests for approvals and user input
```

The adapter prefers the Codex Desktop bundled executable on Windows and falls back to a CLI installation. It never starts a WebSocket listener. A five-second metadata poll detects terminal turns written by another local Codex client; the live event stream handles turns started through the Hub. The first poll establishes a baseline, so historical turns are not reported as new completions. Approval and user-input requests are connection-scoped: the Hub can answer them for turns it starts, while a turn started in another Codex client keeps its live requests in that originating client.

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

The OpenCode adapter never reads the Telegram token. The controller never listens on a TCP port. OpenCode registrations use an ACL-restricted local directory, while Codex communication stays inside the controller's child-process pipes.

OpenCode terminal events normally arrive through the plugin. The controller also polls session metadata and status every five seconds, establishing a startup baseline before emitting anything. This catches short API-started tasks and Desktop versions that omit the plugin terminal callback; the shared event fingerprinting prevents duplicate Telegram notifications.

OpenCode approvals and questions are polled directly from each registered loopback server, independently of the selected Telegram agent mode. Question state stores only opaque callback tokens, selected labels, and delivery metadata. Replies are posted back to the same loopback server and directory scope. Codex approvals and questions are bidirectional server requests on the app-server transport, so only turns owned by the Hub's app-server connection can be answered from Telegram.

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

`config.json` stores the selected locale, Telegram identity binding, and a DPAPI-protected token. Instance records contain loopback connection metadata and a DPAPI-protected temporary OpenCode credential. `state.json` stores Telegram offsets, selected sessions, queues, recovery metadata, processed-event fingerprints, and short approval/question callback mappings.

## Queue lifecycle

1. `/add` or `/batch` appends work to the selected session queue.
2. When the session is idle, the controller marks one item as dispatching and sends it asynchronously.
3. The adapter writes a completion or failure event.
4. The controller correlates the event by backend, session, and dispatch time.
5. It persists the completion marker before notifying and advancing the queue.
6. After a restart, it compares in-flight state, saved events, current session status, and recent messages before waiting, recovering completion, or requeuing.

Tasks started directly on the computer produce notifications but advance a queue only when a stored item was explicitly dispatched.

## Home dashboard

The aggregated home derives active work from each adapter's live session status. For OpenCode, elapsed time starts at the first user message after the latest completed assistant message; queued work uses its persisted dispatch time. For Codex, elapsed time uses the active turn's `startedAt`, including the temporary no-`completedAt` state written by another Desktop client. The dashboard limits detail reads to three active sessions per backend and performs them concurrently.

Pending approval and question records are correlated by backend and session ID. They annotate the matching running conversation without changing the active Telegram agent mode. Idle and historical conversations remain in the paginated session browser.

## Trust boundaries

- Every Telegram update must match private-chat type, bound user ID, and bound chat ID.
- Agent endpoints are restricted to HTTP loopback hosts.
- The adapter and controller run as the interactive Windows user.
- Secrets are protected with Windows DPAPI and directory ACLs.
- Approval callbacks contain opaque local tokens; the controller rechecks identity before submitting a decision.
- No component exposes a network server or a general shell command through Telegram.
