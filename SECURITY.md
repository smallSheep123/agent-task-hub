# Security policy

## Supported version

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature for this repository. Do not open a public issue containing a Telegram token, chat ID, OpenCode credential, local path, private prompt, or proof-of-concept that exposes another user's data.

Include the affected commit, Windows version, agent version, reproduction steps, and the security impact. Remove all real credentials from logs and screenshots.

## Security boundaries

- Agent Task Hub is intended for one Windows user and one bound Telegram private chat.
- It does not provide multi-user authorization or role-based access control.
- It accepts OpenCode endpoints only on HTTP loopback addresses.
- It starts Codex app-server as a local child process and communicates through stdin/stdout; WebSocket transport is not enabled.
- It does not listen for inbound network traffic.
- Telegram Bot tokens and OpenCode Desktop temporary credentials are protected with Windows DPAPI for the current user.
- Runtime files are restricted to the current user, SYSTEM, and local administrators during setup.
- Permission callback data contains only a short local mapping token and the selected reply; the controller rechecks the bound Telegram identity before calling OpenCode or Codex.
- Codex decisions are limited to the options supplied by app-server. The Hub does not add a permanent allow-all choice.
- Anyone who can act as the configured Windows user or local administrator is inside the local trust boundary.

## Operational guidance

- Use a dedicated Telegram bot for Agent Task Hub.
- Revoke and replace the BotFather token if it is ever pasted into an issue, terminal recording, public log, or repository.
- Do not commit `%USERPROFILE%\.config\agent-task-hub`.
- Run `bridge.ps1 -Action doctor` after updating OpenCode Desktop, Codex, or Node.js.
