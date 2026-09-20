# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Documented the bilingual Codex Telegram command contract, API mapping, completion semantics, queue behavior, approvals, and phased delivery plan.
- Added an aggregated `/home`, dedicated `/opencode` and `/codex` entrances, and automatic agent-mode switching after session selection.
- Added backend labels to session lists and completion notifications while keeping one Telegram bot and one notification stream.
- Added backend-aware queue, in-flight, recovery, deduplication, and callback identities with migration for existing OpenCode state.
- Added reusable agent-context and callback contract tests.

### Changed

- Reduced the visible Telegram command menu to the common daily operations; advanced commands remain available by direct input.
- Made the unavailable Codex entry explicit until its adapter is implemented.

## 0.1.0 - 2026-09-20

### Added

- Created Agent Task Hub as an independent repository and local folder.
- Added Simplified Chinese and English setup, management, Telegram commands, buttons, and notifications.
- Added first-run language selection, saved preference, and in-manager language switching.
- Isolated the scheduled task, runtime directory, environment variables, and installed OpenCode adapter name from the earlier bridge project.
- Preserved the proven OpenCode notifications, session browsing, queues, recovery, deduplication, health checks, and permission approvals.
- Established backend metadata, an adapter source directory, and a published Codex integration roadmap.
- Added locale, PowerShell catalog, adapter-security, and syntax tests.
