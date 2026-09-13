# Development guidance

- Read REQUIREMENTS.md and the current issue before implementation. REQUIREMENTS.md is the source of truth; proposed details remain design choices until settled.
- `@jugyo/duex` is a separate package resolved as `file:../mini-restate` during the migration period. Keep its runtime concerns out of this repository, and keep application-specific plugin and event store concerns out of `@jugyo/duex`. Change `@jugyo/duex` in its own repository, not here.
- Plugin implementations execute in separate Node.js processes. Explicitly map environment variables; never inherit all parent secrets. Do not persist secret values in configuration, journals, or logs.
- Do not add code snapshots, automatic compatibility guarantees, replay of historical events, untrusted-code sandboxing, or Source/Consumer execution-order dependencies. Plugin authors own update compatibility.
- Retain stored events indefinitely. Source backfill defaults to 24 hours and is configurable; this does not limit history queries.
- Follow the issue dependencies. Keep each change scoped to its acceptance criteria. Record design decisions and run relevant tests, including the `@jugyo/duex` package tests when its behavior changes.
- Intended implementation runtime/model: Codex / gpt-5.6-sol. Starting workflows is a separate operator action.
