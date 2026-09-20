# Agent Task Hub

[![CI](https://github.com/smallSheep123/agent-task-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/smallSheep123/agent-task-hub/actions/workflows/ci.yml)

**English** · [简体中文](docs/README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Codex commands](docs/CODEX_COMMANDS.md) · [Roadmap](docs/ROADMAP.md) · [Security](SECURITY.md)

Agent Task Hub is a Windows-first, multilingual Telegram control center for local coding agents. The current release supports OpenCode Desktop and Codex through one bot, with isolated sessions, queues, events, and approvals.

> Status: OpenCode and Codex adapters are implemented. Codex uses the official local `app-server` over `stdio`; no network listener is opened.

## What it does

- Sends a Telegram message when connected OpenCode sessions or monitored Codex turns complete, fail, or are interrupted.
- Provides one aggregated home with separate OpenCode and Codex entrances; selecting a session switches into that agent's mode.
- Browses and searches sessions with project paths and pagination.
- Sends prompts immediately or runs per-session sequential queues with `/add` and `/batch`.
- Recovers queues after restarts and suppresses duplicate events and notifications.
- Presents OpenCode approvals and approvals/questions from Codex turns started through the Hub, using only decisions supported by the underlying agent.
- Shows session progress, recent replies, file-change summaries, queue state, and service health.
- Keeps OpenCode access on loopback and opens no inbound network port.
- Supports Simplified Chinese and English in setup, management, Telegram commands, buttons, and notifications.

## Quick start

Requirements: Windows 10/11, Node.js 20+, a Telegram bot from [@BotFather](https://t.me/BotFather), and at least one supported local agent: OpenCode Desktop or Codex Desktop/CLI.

1. Download or clone this repository.
2. Double-click `Bridge-Manager.cmd`.
3. Choose **简体中文** or **English**. The choice is remembered and can be changed later with `L`.
4. Choose first-time setup, paste the BotFather token, send `/start` to the bot, and confirm your Telegram account.
5. Restart OpenCode Desktop once, then send `/home` to the bot and enter **OpenCode**.

Setup installs the adapter as `%USERPROFILE%\.config\opencode\plugins\agent-task-hub.js`, stores runtime data in `%USERPROFILE%\.config\agent-task-hub`, and creates an `Agent Task Hub` scheduled task. These names are intentionally separate from the earlier OpenCode Telegram Bridge project, so both codebases do not share state or startup entries.

## Telegram commands

| Command | Purpose |
|---|---|
| `/home` | Open the aggregated agent home |
| `/opencode`, `/codex` | Enter an agent-specific session list |
| `/sessions` or `/sessions 2` | Browse sessions from all connected agents |
| `/find keyword` | Search session titles and project paths |
| `/use 1` | Select a session from the current page |
| `/current`, `/show` | Show the current mode, selected session, status, changes, todos, and latest reply |
| `/send prompt` | Send one prompt immediately in the selected agent session |
| `/add prompt` | Append one prompt to the selected agent session queue |
| `/batch` | Queue prompts separated by a line containing `---` |
| `/queue`, `/remove 2` | Inspect or edit waiting queue items |
| `/pause`, `/resume`, `/clearqueue` | Control automatic queue progress |
| `/stop` | Stop the current task after confirmation |
| `/approvals` | Show pending OpenCode and Codex approvals |
| `/questions`, `/answer text` | Show or answer pending Codex questions |
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

Codex turns started through the Hub keep their live app-server connection, so approvals and questions can be answered from Telegram. For a turn started in another Codex client, the Hub detects and aggregates its terminal completion; any live approval remains in the client that started that turn.

The main command menu stays small. Advanced queue, approval, and diagnostic commands remain accepted. Buttons carry the action, backend, and session identity, so changing modes does not require repeatedly typing identifiers.

## Management

Use `Bridge-Manager.cmd`, or run the commands below in PowerShell:

```powershell
.\bridge.ps1 -Action status -Language en-US
.\bridge.ps1 -Action doctor -Language en-US
.\bridge.ps1 -Action restart -Language en-US
.\bridge.ps1 -Action install-plugin -Language en-US
```

Use `zh-CN`, `en-US`, or `auto`. The interactive manager stores the preference at `%USERPROFILE%\.config\agent-task-hub\ui.json`.

## Development

The runtime has no npm dependencies.

```powershell
npm test
npm run check
npm run stress
npm run stress:codex
npm run smoke:codex
```

See [Architecture](docs/ARCHITECTURE.md) for adapter boundaries, [Codex commands](docs/CODEX_COMMANDS.md) for the implemented Telegram interface, and [Roadmap](docs/ROADMAP.md) for later features.

## License

[MIT](LICENSE)
