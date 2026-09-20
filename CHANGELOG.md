# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Documented the bilingual Codex Telegram command contract, API mapping, completion semantics, queue behavior, approvals, and phased delivery plan.
- Added an aggregated `/home`, dedicated `/opencode` and `/codex` entrances, and automatic agent-mode switching after session selection.
- Added backend labels to session lists and completion notifications while keeping one Telegram bot and one notification stream.
- Added backend-aware queue, in-flight, recovery, deduplication, and callback identities with migration for existing OpenCode state.
- Added reusable agent-context and callback contract tests.
- Added a real Codex app-server adapter using local JSONL stdio with Windows Desktop/CLI executable discovery.
- Added Codex task discovery, inspection, prompt dispatch, interruption, completion/failure/interruption events, queues, and restart recovery.
- Added Codex command, file-change, and permission approvals plus option and free-text user-input replies.
- Added polling for terminal turns written by another local Codex client, with a startup baseline that suppresses historical notifications.
- Added unit tests and a read-only `npm run smoke:codex` integration check.
- Added OpenCode question discovery and Telegram replies for single-choice, multi-choice, free-text, and rejected questions, independent of the selected agent mode.
- Unified `/questions` and `/answer` across OpenCode and Codex, with newest-presented routing when both agents are waiting.

### Changed

- Reduced the visible Telegram command menu to the common daily operations; advanced commands remain available by direct input.
- Activated the Codex entry when app-server is available and retained a clear connection error when it is not.
- Updated the package version to 0.2.5.
- Made OpenCode instance refresh tolerant of concurrent Windows file replacement and normalized both idle event forms so terminal notifications are still delivered.
- Added controller-side OpenCode terminal polling as a fallback for API-started sessions that do not reach the plugin event hook.
- Grouped OpenCode discovery by local server: ports run in parallel while directories on one server stay sequential, avoiding stale-port delays and local API overload.
- Fixed terminal-event identity mapping to prefer `sessionId` over the event ID, restoring queue correlation and per-session deduplication.
- Fixed completion-button callbacks to target `sessionId` instead of the longer event ID, preventing Codex notifications from exceeding Telegram's 64-byte callback limit.
- Suppressed transient externally-polled Codex `interrupted` states without `completedAt` and only report the latest turn, so a new question cannot turn an in-progress Desktop reply into a false interruption notification.
- Added repeatable local and live read-only stress suites covering 100,000 callback operations, 100,000 Codex terminal decisions, 20,000 state migrations, 500 concurrent OpenCode events, and concurrent Codex app-server reads.
- Clear stale Telegram polling/startup errors after a successful connection, so `/health` reports the current state instead of a recovered historical failure.
- Isolated OpenCode approval, OpenCode question, and Codex request polling failures so one unavailable interface cannot suppress the others.
- Increased the Windows DPAPI helper startup allowance for cold CI hosts and heavily loaded desktops.

## 0.1.0 - 2026-09-20

### Added

- Created Agent Task Hub as an independent repository and local folder.
- Added Simplified Chinese and English setup, management, Telegram commands, buttons, and notifications.
- Added first-run language selection, saved preference, and in-manager language switching.
- Isolated the scheduled task, runtime directory, environment variables, and installed OpenCode adapter name from the earlier bridge project.
- Preserved the proven OpenCode notifications, session browsing, queues, recovery, deduplication, health checks, and permission approvals.
- Established backend metadata, an adapter source directory, and a published Codex integration roadmap.
- Added locale, PowerShell catalog, adapter-security, and syntax tests.
