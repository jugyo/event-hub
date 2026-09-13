# GitHub Change Notifier Example

This example contains three independent plugins that collect GitHub commits, send a notification for each change, and produce a daily summary. Sources and consumers communicate only through the shared `github.commit.created` event and never import each other.

## Setup

Copy this directory into an event-hub project. Update the repository in `sources/github/plugin.json` and the time zone and schedule in each consumer manifest. Do not put secret values in configuration.

```console
event-hub secret add WORK_GITHUB_TOKEN
event-hub secret add GEMINI_API_KEY
event-hub tick
event-hub status --json
```

Each manifest explicitly maps child-process environment variables to Keychain reference names. Give the GitHub token only the permissions required to read the target repository. The consumers use Gemini for summaries and `/usr/bin/osascript` for macOS notifications by default.

Plugin folders are discovered on the next run. Removing a folder disables new work but retains stored events and execution state.

## Collection and delivery limits

The source pages through GitHub's commits API with `since` and `until`. It stores the repository, SHA, message, author, URL, occurrence time, and observation time needed for historical queries. `occurredAt` uses the committer date so API windows and daily aggregation align; the author date is stored as `payload.authoredAt`.

Backfill defaults to 24 hours and can be changed with `trigger.backfillMs`. This limits new upstream collection only. Stored history is retained indefinitely, and the daily consumer queries both the past 24 hours and the past week.

This is not a complete record of every GitHub push. History may be incomplete because of force pushes, deleted branches, API retention or visibility, rate limits, or downtime longer than the configured backfill period. Events collected after a daily window has completed are not automatically added to the old summary.

External effects use at-least-once delivery. A crash before completion is recorded can duplicate a notification or summary. Use the commit SHA or scheduled time as an idempotency key when the destination supports one. Source events themselves are deduplicated by `(sourceId, externalId)`.
