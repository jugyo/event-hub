# event-hub

`event-hub` is a local event collection and processing service built on `@jugyo/duex`. It discovers source and consumer plugins, stores events in SQLite, runs durable workflows, and can operate as a macOS LaunchAgent.

## Requirements

- Node.js 24 or later
- macOS for Keychain and LaunchAgent support
- A sibling `../mini-restate` checkout while `@jugyo/duex` is referenced through `file:../mini-restate`

## Development setup

```console
npm --prefix ../mini-restate install
npm --prefix ../mini-restate run build
npm install
npm test
```

## Quick start

Install the package, then initialize a project directory:

```console
event-hub init
event-hub init "/path/to/project"
```

Initialization creates `event-hub.json`, `sources/`, `consumers/`, and `.event-hub/`. It never overwrites an existing target.

Run due work and inspect plugin state:

```console
event-hub tick
event-hub status
event-hub status --json
```

Retry or cancel an invocation with:

```console
event-hub invocation retry <invocation-id>
event-hub invocation cancel <invocation-id>
```

## Plugins

Place each source under `sources/<name>/` and each consumer under `consumers/<name>/`. Every plugin needs a `plugin.json` manifest and a JavaScript entry point.

Example polling source manifest:

```json
{
  "id": "example-source",
  "kind": "source",
  "entry": "index.mjs",
  "config": { "repository": "owner/name" },
  "env": { "API_TOKEN": "WORK_API_TOKEN" },
  "trigger": { "type": "poll", "everyMs": 60000, "backfillMs": 86400000 }
}
```

Example source implementation:

```js
export async function execute(ctx, input) {
  return ctx.run("fetch", async () => ({
    events: [],
    nextCursor: input.cursor,
    hasMore: false,
  }));
}
```

Consumers can subscribe to events or run daily:

```json
{ "type": "events", "eventTypes": ["example.changed"] }
```

```json
{ "type": "daily", "at": "09:00", "timezone": "Asia/Tokyo" }
```

Plugins run in separate Node.js processes. They may only receive environment variables explicitly mapped in their manifests. Source and consumer implementations must not import one another.

See the [GitHub change notifier example](examples/github-change-notifier/README.md) and [architecture](docs/architecture.md) for the full contracts.

## Secrets

Secret values are stored in macOS Keychain. Project configuration stores reference names only.

```console
event-hub secret add WORK_GITHUB_TOKEN
event-hub secret update WORK_GITHUB_TOKEN
event-hub secret list
event-hub secret delete WORK_GITHUB_TOKEN
```

Values are read from a hidden terminal prompt or standard input, never from command-line arguments. See [ADR 0002](docs/adr-0002-secret-backend.md) for the security model.

## LaunchAgent

Register or remove the current project for periodic execution:

```console
event-hub launch-agent register
event-hub launch-agent unregister
```

Logs are written to `.event-hub/launch-agent.log` and `.event-hub/launch-agent.error.log`.

## Development

```console
npm run typecheck
npm test
npm run test:pack
npm run build
```

The real Keychain integration test is opt-in:

```console
npm run test:keychain
```

## Current limits

- Plugins are trusted code; there is no sandbox for untrusted third-party code.
- Plugin code snapshots, automatic update compatibility, and historical event replay are not supported.
- Source and consumer execution order is not guaranteed.
- Stored events are retained indefinitely. The default 24-hour source backfill limit only controls collection from external systems.
- The initial release supports polling sources and daily consumers, not webhooks or file watching.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the source-of-truth requirements.
