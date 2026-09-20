# Contributing

Contributions are welcome through focused issues and pull requests.

## Development setup

1. Use Windows 10 or Windows 11 with Node.js 20 or newer.
2. Fork and clone the repository.
3. Run `npm test` before changing code.
4. Keep the controller dependency-free unless a dependency clearly improves security or reliability.
5. Preserve both `zh-CN` and `en-US` catalog coverage for user-facing changes.

## Pull requests

- Describe the concrete user-visible behavior.
- Include tests for command parsing, security boundaries, queue transitions, or plugin events when applicable.
- Never include real tokens, Telegram IDs, private prompts, personal paths, runtime state, or logs.
- Preserve the loopback-only agent restriction and the three-part Telegram authorization check.
- Keep agent-specific behavior behind an adapter boundary; do not add Codex behavior to the OpenCode adapter.
- Keep PowerShell 5.1 compatibility for setup and management scripts.

## Commit style

Use short imperative commit messages, for example:

```text
Add session search pagination
Recover in-flight queues after restart
Reject non-loopback OpenCode endpoints
```
