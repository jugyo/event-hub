/**
 * The CLI help text. It is the only documentation a reader of the command output is guaranteed to have, so it
 * carries the options, the output fields, examples, and how the read commands build on each other.
 */

export const GENERAL_HELP = `Usage: event-hub <command> [options]

Commands:
  init [directory]                  Initialize a project directory
  tick                              Run one scheduling tick
  status                            Show plugin load state, last run, and pending work
  plugins [<id>]                    List plugins, or show one plugin with its manifest
  types                             Summarize stored events by (sourceId, type, schemaVersion)
  events                            List stored events, newest first
  web                               Serve the local Web UI
  invocation retry|cancel <id>      Retry or cancel one invocation
  launch-agent register|unregister  Install or remove the macOS LaunchAgent
  secret add|update|list|delete     Manage secret references

Common options:
  --root <directory>  Project root. Defaults to the current directory
  --json              Print machine-readable JSON
  --help, -h          Show help for the command

Reading what is registered and what is stored:
  1. event-hub plugins --json
     Every plugin with its kind, state, trigger, directory, and entry file.
  2. event-hub plugins <id> --json
     The same, plus the manifest configuration and the environment variable reference names.
  3. event-hub types --json
     Which (sourceId, type, schemaVersion) combinations exist, how many events each has,
     their occurredAt range, and the newest payload of each as a sample.
  4. event-hub events --source <id> --type <t> --json | jq
     The events themselves, one JSON object per line.
  5. Read the plugin code at the directory and entry file from step 1.
     No payload schema is declared anywhere. The plugin code is the source of truth for what a
     payload means, and types only reports what is actually stored.

Run \`event-hub <command> --help\` for the options, output fields, and examples of one command.
`;

const PLUGINS_HELP = `Usage: event-hub plugins [<id>] [--root <directory>] [--json]

Lists the registered plugins, or shows one plugin when <id> is given. An unknown <id> is an error.

Options:
  <id>                Plugin ID as printed by \`event-hub plugins\`
  --root <directory>  Project root. Defaults to the current directory
  --json              Print JSON: { "plugins": [...] }, or { "plugin": {...} } with an <id>

Output fields:
  id, kind (source | consumer | invalid), state (ready | failed | invalid), trigger, lastRunAt,
  failure, directory, entrypoint. The directory and entry file are absolute paths.
  With an <id>, also config (the manifest configuration) and env (environment variable reference
  names only; a secret value is never read or printed).

Examples:
  event-hub plugins
  event-hub plugins --json | jq -r '.plugins[] | "\\(.id)\\t\\(.entrypoint)"'
  event-hub plugins github-source --json

Next: \`event-hub types --source <id>\` for the event types a source has stored.
`;

const TYPES_HELP = `Usage: event-hub types [--root <directory>] [--source <id>] [--json]

Groups stored events by (sourceId, type, schemaVersion) so the payload shapes a source produces are
visible without a declared schema. A payload change shows up as a new schemaVersion row.

Options:
  --source <id>       Only this source ID (exact match)
  --root <directory>  Project root. Defaults to the current directory
  --json              Print JSON: { "types": [...] }

Output fields:
  sourceId, type, schemaVersion, count, firstOccurredAt, lastOccurredAt,
  samplePayload (the newest stored payload of the group)

Examples:
  event-hub types
  event-hub types --source github-source --json | jq '.types[] | {type, count, samplePayload}'

Next: \`event-hub events --type <t>\` for the events behind a row, or the plugin code from
\`event-hub plugins <id>\` for what a payload field means.
`;

const EVENTS_HELP = `Usage: event-hub events [--root <directory>] [--source <id>] [--type <t>]...
                        [--from <iso>] [--to <iso>] [--limit <n>] [--json]

Lists stored events in descending occurredAt order, and descending id for equal timestamps. Every
filter is optional and omitting one widens the result. Stored history is unlimited, so the 24-hour
source backfill default does not apply to this query.

Options:
  --source <id>       Only this source ID (exact match)
  --type <t>          Only this event type (exact match). Repeat to accept several types
  --from <iso>        occurredAt >= from. UTC ISO 8601, such as 2026-10-01T00:00:00Z
  --to <iso>          occurredAt < to. UTC ISO 8601. The window is the half-open interval [from, to)
  --limit <n>         Maximum number of events. Defaults to 20
  --root <directory>  Project root. Defaults to the current directory
  --json              Print JSON Lines: one event object per line

Output fields, one event per line:
  id, sourceId, type, externalId, schemaVersion, occurredAt, observedAt, payload

Examples:
  event-hub events --limit 5
  event-hub events --source github-source --type github.change --json | jq -r .occurredAt
  event-hub events --from 2026-10-01T00:00:00Z --to 2026-10-08T00:00:00Z --json | jq .payload
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `Usage: event-hub init [directory]

Creates event-hub.json, sources/, consumers/, and .event-hub/ in the directory, or in the current
directory when none is given. An existing file is never overwritten.
`,
  tick: `Usage: event-hub tick [--root <directory>] [--max-runs <n>] [--debug] [--json]

Runs one scheduling tick: polls due sources, enqueues consumer deliveries, and executes pending work.

Options:
  --max-runs <n>      Stop after n workflow runs
  --debug             Include debug-level diagnostics
  --json              Print the tick result as JSON on stdout and diagnostics as JSON Lines on stderr
  --root <directory>  Project root. Defaults to the current directory
`,
  status: `Usage: event-hub status [--root <directory>] [--json]

Prints one line per plugin with its ID, kind, state, last run time, last invocation ID, pending work,
and failure. Use \`event-hub plugins\` instead for the trigger and the code location.

Options:
  --json              Print JSON: { "plugins": [...] }
  --root <directory>  Project root. Defaults to the current directory
`,
  plugins: PLUGINS_HELP,
  types: TYPES_HELP,
  events: EVENTS_HELP,
  web: `Usage: event-hub web [--root <directory>] [--port <number>]

Serves the read-only Web UI on 127.0.0.1. Defaults to port 3000. Stops on SIGINT or SIGTERM.
`,
  invocation: `Usage: event-hub invocation retry|cancel <id> [--root <directory>] [--json]

Schedules a failed invocation for another attempt, or cancels a pending one.

Options:
  --json              Print the updated invocation as JSON
  --root <directory>  Project root. Defaults to the current directory
`,
  "launch-agent": `Usage: event-hub launch-agent register|unregister [--root <directory>] [--debug]

Installs or removes the macOS user LaunchAgent that runs \`event-hub tick\` periodically. Logs are
written to .event-hub/launch-agent.log and .event-hub/launch-agent.error.log.
`,
  secret: `Usage: event-hub secret add|update <reference>
          event-hub secret list
          event-hub secret delete <reference>

Manages secret values in the macOS Keychain by reference name. A value is read from the terminal or
stdin and is never passed as a command-line argument. \`list\` prints the reference names and whether
each one resolves.
`,
};
