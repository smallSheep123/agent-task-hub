# Changelog

All notable changes to this project are documented here.

## 0.7.0 - 2026-09-26

### Added

- Listed running and saved Pi sessions with name-first titles, first-prompt excerpts, original folders, recent activity, and running/closed state.
- Added a closed-session detail view and explicit background resume action; an already-running canonical session file is reused rather than opened twice.
- Kept restored Pi processes alive independently of the Telegram gateway and added a real multi-process restore smoke test plus a mocked Telegram list/detail test.

## 0.6.1 - 2026-09-26

### Added

- Recorded each persistent Pi session's original directory and exact session file so `/show` can provide a PowerShell resume command after the selected terminal closes.
- Added a two-process live smoke test covering distinct working directories, isolated prompts and notifications, survival of one terminal after the other exits, and exact-file resume from another directory.

### Verified

- Both live Pi processes were aggregated without mixing their sessions or completion events. `--session <absolute file>` restored the original working directory when launched from a different directory.

## 0.6.0 - 2026-09-26

### Added

- Connected live Pi terminal sessions through a Pi extension, with a separate instance identity for every terminal process.
- Added `/pi` session selection, prompt delivery, sequential queues, stop requests, dashboard status, and completion notifications for both Telegram and terminal-started work.
- Added a Pi extension installer and isolated live smoke test.

### Verified

- Passed the existing Hub test suite and the Pi bridge lifecycle test.
- Passed a real Pi 0.87.1 session, prompt, model response, and completion-event test both with an explicit extension path and after auto-discovery from the installed extension directory. The live Telegram gateway processed completions for prompts sent through the bridge and for a Pi-side manual prompt.

## 0.5.5 - 2026-09-26

### Fixed

- Reduced Codex desktop completion polling from 60 to 15 seconds and capped a stalled monitor request at 30 seconds.
- Read ZCode Desktop's local task index for external task completions when its separate App Server cannot access the desktop's active session events.
- Ignored redundant OpenCode status-idle events and correlated terminal events with the current user turn, preventing an aborted task from reusing a previous answer or generating multiple success/failure notices.

### Verified

- Passed the full test suite, including a task-index transition test for ZCode and an aborted-turn regression test for OpenCode.

## 0.5.4 - 2026-09-23

### Changed

- Prewarm the aggregated session cache during gateway startup instead of making the first Telegram home request do all discovery work.
- Give Telegram commands and callbacks a foreground window that defers Codex and ZCode recovery polling for five seconds.
- Send idle-looking Codex prompts directly and rely on the App Server's active-writer response for safe queue fallback, removing a redundant `thread/read` from the common `/send` path.
- Resolve session buttons from the displayed page or current selection before falling back to agent discovery.
- Cache the OpenCode instance registry for two seconds to avoid repeated directory and JSON reads during one interaction.
- Establish one ZCode event baseline, then poll only running, changed, or subscribed sessions; retained a 30-second recovery poll and processed baseline reads in bounded batches.

### Verified

- Passed the full unit, localization, syntax, and stress suites.
- Passed a real ZCode desktop-index, prompt, response, and completion-event E2E after the polling reduction.

## 0.5.3 - 2026-09-23

### Fixed

- Registered Telegram-created and resumed ZCode tasks in the desktop task index, so they remain visible in ZCode Desktop as well as in the Hub.
- Included ZCode fork sessions in Telegram session discovery.
- Made home, agent, session-list, and callback navigation use parallel stale-while-revalidate discovery with a 1.2-second cold-start ceiling.
- Added exponential backoff and log throttling for stale OpenCode loopback endpoints instead of retrying every dead port every five seconds.
- Acknowledged session action buttons before slower reads and cached Codex dashboard probes, so Telegram stops showing a long-running button spinner.
- Avoided redundant ZCode session resumes after the adapter already owns the resident session.

### Verified

- Added deterministic discovery-cache and ZCode desktop-index tests.
- Passed the real ZCode create, desktop-index, prompt, completion-event, and reply E2E flow.

## 0.5.2 - 2026-09-22

### Fixed

- Made Codex `/send` create a distinct visible turn so its prompt appears as a separate user-message bubble in Codex Desktop.
- Queued `/send` automatically while a Codex turn is active; `/steer` remains the explicit immediate in-turn update command.
- Rejected accidental second `turn/start` calls for active Codex tasks to prevent prompts from being merged into the current turn.

## 0.5.1 - 2026-09-22

### Fixed

- Added adaptive backoff and diagnostic throttling to the Codex completion fallback monitor when the shared App Server is busy.
- Isolated individual `thread/read` failures so one slow conversation cannot abort the full completion scan or suppress later retries.
- Reduced the default shared-history scan from 100 conversations every 5 seconds to 30 conversations every 60 seconds; live App Server events remain immediate.
- Made the service start action idempotent so starting an already-running gateway does not leave a misleading Task Scheduler error result.

## 0.5.0 - 2026-09-22

### Fixed

- Fixed dashboard task timers treating an absent queue timestamp as `2000-01-01`, which produced multi-million-minute runtimes; running time now starts from the current prompt/turn and supports day, hour, minute, and second precision.
- Excluded Codex internal guardian and other sub-agent threads from session lists, dashboards, and completion notifications.
- Kept Telegram and Codex commands available while the initial Codex session-list baseline is still loading.
- Allowed up to 60 seconds for large Codex history lists without weakening the timeout for ordinary requests.

### Added

- Added first-class ZCode support through its desktop-bundled App Server, including session discovery, inspection, creation, prompts, sequential queues, interruption, live completion events, approvals, questions, and restart recovery.
- Reused the existing ZCode account and provider configuration in memory without copying credentials into Hub configuration, state, logs, or the repository.
- Added `/zcode`, a third dashboard section, ZCode-aware session buttons and callbacks, approved `zcodeProjects`, and read-only/full-path ZCode integration smoke tests.
- Added an explicit `outboundProxy` launcher setting for reliable Telegram access without routing loopback agent traffic through the proxy.

- Added `/new project_alias | prompt` for safe Codex task creation from administrator-registered local projects.
- Added `/steer prompt` for appending instructions to an active Codex turn.
- Added a gated, model-backed Codex live E2E suite covering create, first turn, follow-up context, steer, interrupt, read, list, and archive cleanup.
- Added an isolated full-Hub live E2E suite that feeds authorized Telegram updates through a loopback mock API and verifies `/new`, `/add`, `/batch`, `/queue`, `/current`, `/show`, `/sessions`, four sequential completions, queue cleanup, and thread archival against the real shared Codex server.
- Included `appServer` source threads in Codex discovery and completion monitoring.
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
- Added a live aggregated-home dashboard with per-agent running conversations, elapsed time, project paths, waiting queue counts, request blockers, refresh, and direct active-session buttons.
- Detect Codex Desktop-owned work whose separate app-server view reports `notLoaded` while the latest persisted turn has `startedAt` but no `completedAt`; probe only recent and preferred tasks to keep the dashboard responsive.
- Added safe Telegram MarkdownV2 rendering for dashboard, session, queue, approval, question, help, and completion messages, including bold headings, inline status/path values, quoted assistant replies, and automatic escaping of dynamic content.
- Redesigned session pages with clear number badges and separate metadata, title, and directory rows; restricted field styling to known labels so colons inside titles and Windows paths cannot cause accidental bold text.
- Render common Markdown inside quoted agent replies (bold, inline code, lists, headings, web links, and readable local-file references) and disable large Telegram link previews in task notifications.
- Launch the scheduled PowerShell host with a hidden window and stop an existing controller before replacing its scheduled task, preventing empty Windows Terminal tabs during login, service start, and restart.
- Render fenced agent code blocks with Telegram language metadata for syntax-aware Bash, PowerShell, Python, JavaScript, TypeScript, JSON, YAML, and other common code, while safely closing truncated or incomplete fences.
- Convert Markdown tables in agent replies into labeled mobile-friendly cards, preserving every column while leaving pipe characters inside fenced code blocks untouched.

### Changed

- Avoided a premature `thread/resume` after `thread/start`, retried immediate interrupts during the App Server activation window, and tolerated transient thread-store reads with live cached state.
- Assigned names to Hub-created Codex threads so completion and queue notifications retain their task title.
- Reduced the visible Telegram command menu to the common daily operations; advanced commands remain available by direct input.
- Activated the Codex entry when app-server is available and retained a clear connection error when it is not.
- Updated the package version to 0.2.12.
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
- Clear a recovered shared Codex connection error when the adapter first attaches or reconnects, so `/health` reflects the live connection.

## 0.1.0 - 2026-09-20

### Added

- Created Agent Task Hub as an independent repository and local folder.
- Added Simplified Chinese and English setup, management, Telegram commands, buttons, and notifications.
- Added first-run language selection, saved preference, and in-manager language switching.
- Isolated the scheduled task, runtime directory, environment variables, and installed OpenCode adapter name from the earlier bridge project.
- Preserved the proven OpenCode notifications, session browsing, queues, recovery, deduplication, health checks, and permission approvals.
- Established backend metadata, an adapter source directory, and a published Codex integration roadmap.
- Added locale, PowerShell catalog, adapter-security, and syntax tests.
