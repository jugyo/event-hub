# Initial Architecture

This document defines the boundaries shared by the initial implementation. Confirmed items in `REQUIREMENTS.md` are requirements; decisions that resolve previously open details are initial policies.

## Responsibility boundaries

The host owns plugin discovery and validation, process startup, ordinary configuration and secret-reference resolution, event history, source positions, consumer delivery state, schedules, and the `@jugyo/duex` invocations and journal. Plugins own only source- or destination-specific behavior.

Each plugin execution loads its implementation in a separate Node.js child process. This isolates failures by plugin but is not a sandbox for untrusted code. Sources and consumers communicate only through the shared API and event envelope. Their execution order is not part of the contract.

Functions such as `WorkflowContext` and `ctx.run` cannot cross JSON IPC. The child requests a step by name and retry metadata. The host serially maps that request to `ctx.run(name, operation)`. The operation and its inputs remain in the child closure. The host sends `step.execute` when no result exists or returns a completed journal result through `step.result`. Only one context request may be active at a time, matching the `@jugyo/duex` restriction against nested or concurrent context calls.

This boundary is implemented under `src/plugins/process/`. Plugin closures exist only in child processes. Code is not snapshotted. A resume loads the currently installed entry point, so plugin authors must preserve compatibility in step order, names, and JSON results.

### Cross-plugin dependency detection

Discovery parses `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`, and `.cts` files with the TypeScript parser. Registration is rejected when a literal relative or absolute `import`, dynamic `import()`, `export ... from`, or `require()` points into another plugin directory. Comments, ordinary strings, and regular-expression literals are ignored. `node_modules` and dot directories are not scanned.

This is an early architectural check, not a sandbox. It does not detect computed dynamic imports, custom loaders, package or symlink indirection, or runtime filesystem access. Entry-point loading remains the child-process runner's responsibility.

## Manifests and stable IDs

The manifest types in `src/plugins/manifest.ts` and IPC types in `src/plugins/process/contract.ts` are authoritative.

A manifest declares:

- `id`: a stable, unique ID independent of its directory or display name;
- `kind`: `source` or `consumer`;
- `entry`: a relative path that stays within the plugin directory;
- `config`: ordinary JSON configuration without secret values;
- `env`: explicit mappings from child variable names to host-managed secret references;
- `trigger`: polling for sources, or an event subscription or daily schedule for consumers.

Stable IDs namespace source positions, consumer delivery state, schedules, and invocations. Renaming a folder does not reset state. Changing an ID creates a different plugin.

A child never inherits the complete parent environment. Its environment contains only required runtime values and mappings explicitly resolved for that execution. Secret values are never persisted in manifests, configuration, events, journals, plist files, or diagnostic logs. Values are resolved again on every retry.

The initial implementation passes no implicit ordinary environment variables. Node.js and the worker are invoked by absolute path, so even `PATH` and `HOME` are not inherited.

## Source and consumer APIs

A source poll receives `{ cursor, from, to, config }` and returns events, an opaque next cursor, and pagination state. The host stores events and advances the cursor atomically. Duplicate upstream results are deduplicated by `(sourceId, externalId)`.

A polling run persists its half-open window `[from, to)` before collection and uses it for every page and retry. A retry resumes from the stored cursor and the same window. The final page completes the window in the same transaction that stores its events and cursor.

When the previous completed position predates the backfill limit, `from` advances to the limit boundary while the original start is retained. This allows retries to keep reporting the omitted interval through `SOURCE_BACKFILL_LIMITED`.

An event consumer receives an event envelope and ordinary configuration. A daily consumer receives a scheduled window and can query history through `ctx.queryHistory`. History queries are read-only and never redeliver events or move delivery cursors.

Delivery state is independent for each `(consumerId, eventId)`:

- `pending`: runnable;
- `retry_wait`: temporarily failed with a next-attempt time;
- `completed`: successfully processed;
- `failed`: terminally failed or retry limit reached.

Attempts and fixed error codes are persisted. Work in `retry_wait` before its deadline and work in `completed` or `failed` are excluded from normal ticks. One failure must not block another consumer or a later event. External effects are at-least-once, not exactly-once.

## Event envelope and time

An event contains `id`, `sourceId`, `type`, `externalId`, `schemaVersion`, `occurredAt`, `observedAt`, and JSON `payload`.

- `occurredAt`: when the event occurred upstream; the default history-query axis.
- `observedAt`: when the source presented it to event-hub; used for delay and backfill diagnostics.

Timestamps are stored as UTC ISO 8601 strings. Query windows are always half-open intervals `[from, to)`.

Late events remain in their original occurrence window and are not automatically redelivered to a completed daily aggregation. Consumers that need overlap must query it explicitly.

Events are retained indefinitely. Source backfill defaults to 24 hours and is configurable per source. The limit controls new upstream collection only, never stored-history queries.

## Plugin removal and updates

Removing a plugin stops new schedules and deliveries but retains events, cursors, delivery records, and journals. A running child may finish or suspend. Suspended work remains pending until a plugin with the same stable ID returns.

Retries and resumes use the currently installed implementation. Plugin authors own compatibility with existing steps, journal results, cursors, and event schemas. The platform does not store old code, snapshot implementations, restore earlier versions, or provide automatic migrations.

`@jugyo/duex` records the workflow version at invocation creation and rejects mismatches with the registered version. Application workflow versions represent IPC contract generations, not individual plugin releases. Only an incompatible IPC contract change increments the version.

## Daily schedules

A daily schedule uses local `HH:mm` and an IANA time zone such as `Asia/Tokyo`. The application computes the next UTC instant, including daylight-saving transitions, and submits one invocation to `@jugyo/duex`. `everyMs` remains reserved for elapsed-time intervals such as polling.

After sleep or downtime, the `latest` catch-up policy runs only the newest missed daily slot. The invocation persists `scheduledAt` and receives the window from the previous scheduled slot to the current one. It does not wait for source backfill.

## IPC protocol

IPC uses finite JSON discriminated-union messages and one child process per execution. The host sends `start`. The child sends `step.request`, and the host replies with `step.execute` or a journal-backed `step.result`. The child then sends `step.executed`. History uses `history.request` and `history.result`. Execution ends with `plugin.completed` or `plugin.failed`. Every request has a correlation ID.

Inputs, outputs, step results, and retry metadata must be finite JSON values. Schema violations, unknown or duplicate correlation IDs, and concurrent step requests are terminal protocol violations. Both host and child verify that no step is unfinished when the plugin returns.

A process exit, IPC disconnect, or the default 30-second timeout during a step becomes a retryable `ctx.run` failure. `@jugyo/duex` persists `retry_wait`; the next tick starts a new child. Completed journal steps return their stored result without another `step.execute`.

An exit outside a step, import failure, execution failure, or protocol violation fails only that invocation and must not retain the runner lease.

Plugin exception messages, stacks, and details may contain secrets, so the IPC boundary discards them and returns only enumerated public error codes. Plugins must also avoid returning secrets through step results or ordinary output.

If a process stops after an external effect but before `step.executed` or journal completion, the operation may run again. Plugins should use destination-side idempotency keys derived from the invocation ID and step name.
