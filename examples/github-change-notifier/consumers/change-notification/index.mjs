import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScript(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function summarize(config, prompt) {
  const base = (config.geminiBaseUrl ?? "https://generativelanguage.googleapis.com").replace(/\/$/u, "");
  const model = config.geminiModel ?? "gemini-2.5-flash";
  const response = await fetch(
    `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY ?? "")}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  if (!response.ok) throw new Error(`Gemini API returned ${response.status}`);
  const body = await response.json();
  const text = body.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new TypeError("Gemini API response has no summary");
  return text;
}

async function notify(config, title, message) {
  const command = config.notification?.command ?? "/usr/bin/osascript";
  const configuredArgs = config.notification?.args;
  const args = Array.isArray(configuredArgs)
    ? configuredArgs.map((value) => String(value).replaceAll("{title}", title).replaceAll("{message}", message))
    : ["-e", `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`];
  await execFileAsync(command, args);
}

export async function execute(ctx, input) {
  const payload = input.event.payload;
  const summary = await ctx.run("summarize-change", () =>
    summarize(
      input.config,
      [
        "Summarize the following GitHub commit concisely in English.",
        `repository: ${payload.repository}`,
        `author: ${payload.author ?? "unknown"}`,
        `message: ${payload.message}`,
      ].join("\n"),
    ),
  );
  await ctx.run("notify-change", async () => {
    await notify(input.config, `Changes in ${payload.repository}`, summary);
    return { notified: true };
  });
  return { summary };
}
