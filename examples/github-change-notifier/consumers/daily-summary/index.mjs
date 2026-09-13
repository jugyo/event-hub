import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DAY = 24 * 60 * 60 * 1000;

function escapeAppleScript(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function allEvents(ctx, from, to) {
  const events = [];
  let after;
  do {
    const page = await ctx.queryHistory({ from, to, eventTypes: ["github.commit.created"], limit: 1000, ...(after ? { after } : {}) });
    events.push(...page.events);
    after = page.nextCursor ?? undefined;
  } while (after);
  return events;
}

async function summarize(config, prompt) {
  const base = (config.geminiBaseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/u, "");
  const model = config.geminiModel ?? "gemini-2.5-flash";
  const response = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY ?? "")}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!response.ok) throw new Error(`Gemini API returned ${response.status}`);
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!text) throw new TypeError("Gemini API response has no summary");
  return text;
}

export async function execute(ctx, input) {
  const to = new Date(input.scheduledAt);
  // Run plugin-context IPC calls sequentially and query each history window independently.
  const week = await allEvents(ctx, new Date(to.getTime() - 7 * DAY).toISOString(), to.toISOString());
  const day = await allEvents(ctx, new Date(to.getTime() - DAY).toISOString(), to.toISOString());
  const lines = week.map((event) => `${event.occurredAt} ${event.payload.repository} ${event.payload.message}`);
  const summary = await ctx.run("summarize-daily-history", () => summarize(input.config, [
    "Create a daily summary of GitHub commits in English.",
    `Past 24 hours: ${day.length}`, `Past week: ${week.length}`, ...lines,
  ].join("\n")));
  await ctx.run("notify-daily-summary", async () => {
    const command = input.config.notification?.command ?? "/usr/bin/osascript";
    const title = "GitHub daily summary";
    const configuredArgs = input.config.notification?.args;
    const args = Array.isArray(configuredArgs)
      ? configuredArgs.map((value) => String(value).replaceAll("{title}", title).replaceAll("{message}", summary))
      : ["-e", `display notification "${escapeAppleScript(summary)}" with title "${escapeAppleScript(title)}"`];
    await execFileAsync(command, args);
    return { notified: true };
  });
  return { summary, counts: { day: day.length, week: week.length } };
}
