# Local Event Processing Platform Requirements

This document is the source of truth for generalizing the GitHub Change Notifier proof of concept. Items marked as proposals remain design choices until explicitly settled.

## Goal

Make it easy to build and operate local applications that react to events.

The platform continues to use the published `@jugyo/duex` package. It is an independent project and must not be copied into this repository. The event-hub package must not bundle the `@jugyo/duex` source or distribution files.

The shared platform owns event storage, delivery, scheduling, and retries so plugins can focus on collecting or processing data.

## Confirmed requirements

- Sources and consumers are plugins that can be added or removed as folders.
- Plugins are discovered on the next process start or command invocation. Hot reload is not required.
- An invalid plugin produces a plugin-scoped diagnostic and does not prevent valid plugins from running.
- Source and consumer implementations must not import or otherwise depend on each other.
- This dependency rule is architectural, not a sandbox for untrusted third-party code.
- Source and consumer execution order is not guaranteed.
- Users install the npm package and initialize any directory as a project.
- The service can run periodically as a macOS user LaunchAgent while the user is logged in.
- Polling is the primary collection mechanism. Webhooks and file watching are optional future work.
- After sleep or downtime, a source collects the available gap in one run rather than replaying missed polling ticks.
- Source backfill defaults to 24 hours and is configurable per source.
- The backfill limit does not restrict queries over already stored history.
- Stored events are retained indefinitely until a separate retention policy is introduced.
- Consumers can query historical events by time range and type for daily or weekly aggregation.
- Scheduled aggregation is the primary use case; direct CLI-triggered aggregation and historical event replay are out of scope.
- Credentials are passed through environment variables using an explicit host-reference-to-plugin mapping. Even same-name mappings must be declared.
- Secret values must never be persisted in configuration, journals, logs, plist files, or command-line arguments.
- Plugin implementations run in separate Node.js processes. Parent environment variables are not inherited wholesale.

## User experience

| Task        | Expected behavior                                                                    |
| ----------- | ------------------------------------------------------------------------------------ |
| Start       | Install with npm and initialize a directory to create configuration and templates.   |
| Add         | Place a source or consumer folder and discover it on the next run.                   |
| Remove      | Delete the folder to stop new work without deleting stored state.                    |
| Build       | Use the shared API without importing another plugin implementation.                  |
| Connect     | Subscribe consumers to event types through a shared event contract.                  |
| Review      | Query stored events by time range and type.                                          |
| Aggregate   | Run consumers on schedules such as every morning.                                    |
| Fail        | Record load, configuration, and execution failures per plugin while others continue. |
| Inspect     | Show load state, last run, pending work, and failure details through the CLI.        |
| Operate     | Run the same tick behavior manually or through launchd.                              |
| Recover     | Resume collection from the stored source position, subject to the backfill limit.    |
| Use secrets | Store only reference names in project configuration and resolve values at runtime.   |

## Historical queries and delivery

Processed events remain queryable. A history query does not redeliver events or modify consumer delivery state.

Event-driven consumers subscribe from the end of the event log at registration time. Existing events are not automatically delivered to newly added consumers.

Daily consumers receive a persisted scheduled slot and a half-open aggregation window `[from, to)`. They may issue additional history queries, such as a seven-day view. Missed daily schedules use a `latest` catch-up policy: after downtime, only the most recent missed slot runs.

Whether a source event was collected before a consumer runs is intentionally not an ordering guarantee. A consumer that needs overlap must query an appropriate historical window.

## Source collection

Each source has a persistent position, such as a cursor or timestamp. The platform persists the collection window `[from, to)` for a polling run and keeps that same window across pagination and retries.

Event storage and cursor advancement are atomic. The cursor must never advance before events are safely stored. Duplicate collection is made idempotent by `(sourceId, externalId)`.

If the previous completed position is older than the configured backfill limit, collection starts at the limit boundary and records a `SOURCE_BACKFILL_LIMITED` diagnostic for the omitted range. Previously stored older events are not deleted.

Sources that cannot provide history, have shorter upstream retention, or cannot complete because of rate limits must report a clear diagnostic. Continuation uses the persisted window and cursor.

## Plugin registration and updates

The platform scans plugin folders on each startup, validates their manifests, and synchronizes registration state.

A stable plugin ID owns source cursors, consumer delivery state, schedules, and invocation namespaces. Renaming a folder does not reset state; changing the ID creates a different plugin.

Deleting a plugin disables new schedules and deliveries but retains events, cursors, delivery records, and journals. In-flight work may finish or suspend; suspended work does not resume until a plugin with the same stable ID returns.

The platform does not snapshot plugin code, retain old code, automatically migrate plugin state, or guarantee compatibility between plugin versions. Retries and resumes use the currently installed implementation. Plugin authors own compatibility with existing journals, cursors, and event schemas.

## Configuration and credentials

A plugin consists of a manifest and an implementation. The manifest declares:

- stable ID;
- source or consumer kind;
- entry point;
- polling schedule, event subscription, or daily schedule;
- ordinary JSON configuration;
- explicit environment variable mappings.

Example:

```json
{
  "env": {
    "GITHUB_TOKEN": "WORK_GITHUB_TOKEN",
    "GEMINI_API_KEY": "GEMINI_API_KEY"
  }
}
```

Only mapped values are resolved and passed to the plugin process. The initial secret backend is macOS Keychain. Project configuration stores backend type and reference names only. Secret values are resolved again for each attempt so updates do not require plugin re-registration.

The initial implementation does not implicitly pass `PATH`, `HOME`, or other ordinary parent variables. Node.js and the worker entry point are launched by absolute path.

## Event contract

An event envelope contains `id`, `sourceId`, `type`, `externalId`, `schemaVersion`, `occurredAt`, `observedAt`, and JSON `payload`.

- `occurredAt` is the upstream event time and the default history-query axis.
- `observedAt` is when the source presented the event to event-hub and is used for backfill and operational diagnostics.
- Timestamps are UTC ISO 8601 strings.
- Query windows are half-open intervals `[from, to)`.

Late events remain associated with their original `occurredAt` window and are not automatically replayed to a completed aggregation.

## Execution and IPC

The host starts one Node.js child process per plugin execution. IPC uses finite JSON discriminated-union messages with correlation IDs.

The child requests durable steps by name and retry metadata. The host maps one request at a time to `ctx.run(name, operation)`. Completed journal results are returned without re-executing the operation. Nested or concurrent context calls are rejected.

Protocol violations, unknown or duplicate correlation IDs, incomplete steps at plugin completion, import failures, and execution failures are plugin-scoped errors. Process exit, disconnect, or the default 30-second timeout during a step is a retryable step failure subject to the `@jugyo/duex` retry policy.

Plugin exception messages, stacks, and arbitrary details are discarded at the IPC boundary because they may contain secrets. The host persists only enumerated public error codes and fixed messages.

External effects are at-least-once. A crash after an external effect but before journal completion may repeat the effect. Plugins should use an idempotency key derived from the invocation ID and step name where the external system supports one.

## Explicit non-goals

- Untrusted-code sandboxing.
- Plugin code snapshots or old-code restoration.
- Automatic compatibility guarantees or migrations between plugin versions.
- Historical event replay or redelivery.
- Source/consumer execution-order dependencies.
- Indefinite daemon processes for webhooks or file watching in the initial release.
