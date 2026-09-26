# Agent Task Hub

[![CI](https://github.com/smallSheep123/agent-task-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/smallSheep123/agent-task-hub/actions/workflows/ci.yml)

**English** · [简体中文](docs/README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Codex commands](docs/CODEX_COMMANDS.md) · [Roadmap](docs/ROADMAP.md) · [Security](SECURITY.md)

Agent Task Hub is a Windows-first, multilingual Telegram control center for local coding agents. The current release supports OpenCode Desktop, Codex, ZCode, and Pi through one bot, with isolated sessions, queues, events, and approvals.

> Status: OpenCode, Codex, and ZCode adapters are implemented. Codex supports private `stdio` and an optional shared official App Server bound only to `127.0.0.1`; ZCode uses its bundled local App Server over private `stdio`.

Pi uses an extension inside each Pi terminal. Each terminal process is a separate Hub instance, even when two terminals open the same session file.

## What it does

- Sends a Telegram message when connected OpenCode, Codex, or ZCode work completes, fails, or is interrupted.
- Provides one aggregated home with separate OpenCode, Codex, and ZCode entrances; selecting a session switches into that agent's mode.
- Turns the aggregated home into a live dashboard with each agent's running conversations, elapsed time, project path, queued work, and approval/question blockers.
- Browses and searches sessions with project paths and pagination.
- Sends prompts immediately or runs per-session sequential queues with `/add` and `/batch`.
- Recovers queues after restarts and suppresses duplicate events and notifications.
- Presents OpenCode approvals and questions from every registered local OpenCode server, plus live approvals/questions from Codex and ZCode work started through the Hub, using only decisions supported by the underlying agent.
- Shows session progress, recent replies, file-change summaries, queue state, and service health.
- Keeps OpenCode access on loopback and opens no inbound network port.
- Supports Simplified Chinese and English in setup, management, Telegram commands, buttons, and notifications.

## Quick start

Requirements: Windows 10/11, Node.js 22+, a Telegram bot from [@BotFather](https://t.me/BotFather), and at least one supported local agent: OpenCode Desktop, Codex Desktop/CLI, or ZCode Desktop.

1. Download or clone this repository.
2. Double-click `Bridge-Manager.cmd`.
3. Choose **简体中文** or **English**. The choice is remembered and can be changed later with `L`.
4. Choose first-time setup, paste the BotFather token, send `/start` to the bot, and confirm your Telegram account.
5. Restart OpenCode Desktop once, then send `/home` to the bot and enter **OpenCode**.

Setup installs the adapter as `%USERPROFILE%\.config\opencode\plugins\agent-task-hub.js`, stores runtime data in `%USERPROFILE%\.config\agent-task-hub`, and creates an `Agent Task Hub` scheduled task. These names are intentionally separate from the earlier OpenCode Telegram Bridge project, so both codebases do not share state or startup entries.

### Pi terminal integration

Install the optional Pi extension with `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-pi-extension.ps1`. It copies one file to `%USERPROFILE%\.pi\agent\extensions\agent-task-hub.js`. New Pi terminals load it automatically; enter `/reload` once in each terminal that was already open. Then use `/pi` in Telegram to select a live terminal session. `/send`, `/add`, `/batch`, `/queue`, and `/stop` work in the selected terminal. Manually started Pi tasks also send completion notifications. The extension communicates through local files under `%USERPROFILE%\.config\agent-task-hub\pi`; it opens no network listener and does not copy Pi credentials. Pi approval prompts remain in the terminal. A Pi queue whose completion cannot be proved after a gateway restart is paused for review instead of replayed.

Pi stores sessions by working directory, so `pi --continue` selects the latest session for the current directory. The extension records each persistent session's original directory and exact session file. `/show` displays a PowerShell resume command for the selected Pi session, including after that terminal closes. The command uses `pi --session <absolute-session-file>` and must be run on the computer. Telegram only controls terminals that are already running; it does not launch or resume Pi processes remotely.

## Telegram commands

| Command | Purpose |
|---|---|
| `/home` | Open the aggregated agent home |
| `/opencode`, `/codex`, `/zcode`, `/pi` | Enter an agent-specific session list |
| `/new project_alias \| prompt` | Create a session in the active Codex or ZCode mode |
| `/sessions` or `/sessions 2` | Browse sessions from all connected agents |
| `/find keyword` | Search session titles and project paths |
| `/use 1` | Select a session from the current page |
| `/current`, `/show` | Show the current mode, selected session, status, changes, todos, and latest reply |
| `/send prompt` | Send a separate visible turn; wait automatically while Codex is busy |
| `/steer prompt` | Update the active Codex turn immediately without creating a separate user bubble |
| `/add prompt` | Append one prompt to the selected agent session queue |
| `/batch` | Queue prompts separated by a line containing `---` |
| `/queue`, `/remove 2` | Inspect or edit waiting queue items |
| `/pause`, `/resume`, `/clearqueue` | Control automatic queue progress |
| `/stop` | Stop the current task after confirmation |
| `/approvals` | Show pending OpenCode, Codex, and ZCode approvals |
| `/questions`, `/answer text` | Show or answer pending OpenCode, Codex, and ZCode questions |
| `/health`, `/status` | Show detailed or compact health information |

Example:

```text
/batch
Inspect the failing tests
---
Fix the root cause and rerun the tests
---
Write a short maintenance note
```

Each item starts after the preceding completion event. The bot reports every completion before dispatching the next item, then sends a final message when the queue is empty. Tasks started manually on the computer are reported without accidentally advancing an unrelated queue.

`/new` accepts only aliases registered in `%USERPROFILE%\.config\agent-task-hub\config.json`. Use `codexProjects` for Codex and `zcodeProjects` for ZCode. Example: `"zcodeProjects": { "hub": "D:\\AIGC\\agent-task-hub" }`.

OpenCode questions are discovered independently of the selected Telegram mode. Single-choice options continue immediately, multi-choice questions have an explicit submit button, and free-text choices use `/answer text`.

Codex turns started through the Hub keep their live app-server connection, so approvals and questions can be answered from Telegram. For a turn started in another Codex client, the Hub detects and aggregates its terminal completion; live approvals and questions remain in the client that owns that app-server connection.

ZCode uses the App Server bundled with the installed desktop application. The adapter reads the existing ZCode account configuration at runtime, decrypts it only in memory using ZCode's own local format, and never copies provider credentials into Hub configuration, state, logs, or the repository. Sessions started or resumed through Telegram are synchronized into ZCode Desktop's local task index, while interactive and fork sessions are both shown by the Hub. Sessions started through Telegram keep a live subscription for completion, approval, and question handling. For sessions run directly in ZCode Desktop, the Hub also watches the local task index read-only for completion because a separate App Server cannot read events from a non-active desktop session. These index-based notifications contain task status and title but may not contain the latest reply text.

Session discovery is parallel, prewarmed at gateway startup, and cached briefly. A cold request waits at most 1.2 seconds for each agent before rendering available results, while later refreshes continue in the background. Telegram interactions temporarily yield background recovery scans, ZCode polls only active or changed sessions between periodic recovery checks, and unavailable OpenCode loopback endpoints use bounded exponential backoff. These scheduling rules keep interactive requests responsive without weakening completion recovery.

### Shared Codex backend

Version 0.3 adds an optional shared Codex backend. It runs the official Codex App Server on `ws://127.0.0.1:9234`; Agent Task Hub and compatible Codex clients can then use the same server process and the same thread writer. The listener is loopback-only and is never exposed to the LAN or Internet.

Run the compatibility probe before enabling it:

```powershell
.\bridge.ps1 -Action codex-probe -Language en-US
.\bridge.ps1 -Action codex-shared -Language en-US
.\bridge.ps1 -Action restart -Language en-US
```

Fully restart Codex Desktop after enabling shared mode. To return to the stable 0.2 behavior:

```powershell
.\bridge.ps1 -Action codex-private -Language en-US
.\bridge.ps1 -Action restart -Language en-US
```

The transport setting is stored as `codexTransport` and `codexWsUrl` in the existing protected configuration directory. The shared host discovers and uses the newest Codex Desktop runtime at every start so its protocol matches the UI; the official standalone package is only a fallback.

The main command menu stays small. Advanced queue, approval, and diagnostic commands remain accepted. Buttons carry the action, backend, and session identity, so changing modes does not require repeatedly typing identifiers.

The home dashboard lists up to three running conversations per agent and adds direct session buttons for the busiest items. Use **Refresh** to recalculate elapsed time and current blockers; use **All sessions** for history and idle conversations.

## Management

Use `Bridge-Manager.cmd`, or run the commands below in PowerShell:

```powershell
.\bridge.ps1 -Action status -Language en-US
.\bridge.ps1 -Action doctor -Language en-US
.\bridge.ps1 -Action restart -Language en-US
.\bridge.ps1 -Action install-plugin -Language en-US
.\bridge.ps1 -Action codex-probe -Language en-US
.\bridge.ps1 -Action codex-shared -Language en-US
.\bridge.ps1 -Action codex-private -Language en-US
```

Use `zh-CN`, `en-US`, or `auto`. The interactive manager stores the preference at `%USERPROFILE%\.config\agent-task-hub\ui.json`.

If Telegram is unreliable on the direct route, set `outboundProxy` in `config.json` to a local HTTP proxy such as `http://127.0.0.1:7897`, then restart the service. The launcher passes it to Node while keeping `127.0.0.1`, `localhost`, and `::1` in `NO_PROXY`, so local agent traffic stays local. An existing `HTTPS_PROXY` environment variable takes precedence; otherwise the enabled Windows system proxy remains the fallback.

## Development

The runtime has no npm dependencies.

```powershell
npm test
npm run check
npm run stress
npm run stress:codex
npm run smoke:codex
npm run smoke:zcode
```

`npm run smoke:zcode` is read-only by default. Add `-- --send` to create a temporary real ZCode task, wait for its response, and verify the full dispatch path.

Model-backed live suites are opt-in because they create real Codex turns. Both archive their temporary threads:

```powershell
$env:AGENT_TASK_HUB_LIVE_E2E = '1'
npm run e2e:codex
npm run e2e:hub
```

See [Architecture](docs/ARCHITECTURE.md) for adapter boundaries, [Codex commands](docs/CODEX_COMMANDS.md) for the implemented Telegram interface, and [Roadmap](docs/ROADMAP.md) for later features.

## License

[MIT](LICENSE)
