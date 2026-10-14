# event-hub

`event-hub` is a local event collection and processing service built on `@jugyo/duex`. It discovers source and consumer plugins, stores events in SQLite, runs durable workflows, and can operate as a macOS LaunchAgent.

## Requirements

- Node.js 24 or later
- macOS for Keychain and LaunchAgent support

## Development setup

```console
npm ci
npm run ci
```

## Quick start

Install the package, then initialize a project directory:

```console
npm install --global @jugyo/event-hub
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

Read the registered plugins and the stored events from the command line, without starting the server:

```console
event-hub plugins
event-hub plugins <plugin-id> --json
event-hub types --source <source-id> --json
event-hub events --source <source-id> --type <event-type> --json | jq
```

`plugins` prints each plugin with its kind, state, trigger, and the absolute path of its directory
and entry file; adding a plugin ID also prints the manifest configuration and the environment
variable reference names. `types` groups stored events by `(sourceId, type, schemaVersion)` with a
count, the `occurredAt` range, and the newest payload as a sample. `events` lists the events
themselves, newest first, filtered by `--source`, a repeatable `--type`, the half-open
`--from`/`--to` window, and `--limit`; with `--json` it prints one event per line.

No payload schema is declared in a manifest. The plugin code is the source of truth for what a
payload means, and `types` reports only what is actually stored. Run `event-hub --help` to see how
these commands build on each other, and `event-hub <command> --help` for one command's options and
output fields.

Start the read-only Web UI for the current project at `http://127.0.0.1:3000`:

```console
event-hub web
event-hub web --root "/path/to/project" --port 3001
```

The server runs in the foreground, listens only on IPv4 loopback, and serves the UI and `/api/v1`
from the same origin. Press `Ctrl-C` to stop it. The production command serves packaged static files;
it does not start the Vite development server.

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
  "trigger": { "type": "poll", "every": "1m", "backfill": "1d" }
}
```

Polling durations accept a positive number followed by `ms`, `s`, `m`, `h`, `d`, or `w` and must
resolve to at least one whole millisecond. The numeric `everyMs` and `backfillMs` fields remain
supported for compatibility. Do not specify `every` together with `everyMs`, or `backfill` together
with `backfillMs`.

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

イベント Consumer は `ctx.emit` で 1 件以上の派生イベントを発行できます。ホストは Consumer の
stable ID を `sourceId` として設定し、プラグインはそれ以外のイベントフィールドを指定します。
派生イベントは入力 delivery の完了とアトミックに保存され、Source イベントと同じ履歴照会、
重複排除、後続 Consumer への配信の対象になります。

```js
export async function execute(ctx, input) {
  await ctx.emit({
    id: `article:${input.event.id}`,
    externalId: input.event.externalId,
    type: "article.extracted",
    schemaVersion: 1,
    occurredAt: input.event.occurredAt,
    observedAt: new Date().toISOString(),
    payload: { markdown: "# Article" },
  });
}
```

`ctx.emit` は 1 件のイベント、または空でない配列を受け取ります。各イベントには、空でない `id`、
`externalId`、`type`、正の整数である `schemaVersion`、UTC ISO 8601 形式の `occurredAt` と
`observedAt`、有限 JSON 値である `payload` が必要です。同じ delivery の再試行が冪等になるよう、
入力イベントから安定した `externalId` を導出してください。

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

Run the same checks as GitHub Actions with:

```console
npm ci
npm run ci
```

The combined check runs formatting, linting, type checking, tests, package validation, and the build. To fix formatting locally, run `npm run format`.

Individual checks are also available:

```console
npm run format:check
npm run lint
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
- Polling sources, event consumers, and daily consumers are supported; webhooks and file watching are not.

## License

[MIT](LICENSE)

See [REQUIREMENTS.md](REQUIREMENTS.md) for the source-of-truth requirements.
