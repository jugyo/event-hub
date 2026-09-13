import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const CONFIG_FILENAME = "event-hub.json";

const directoryFiles = new Map([
  ["sources", "Place each source plugin in its own directory.\n"],
  ["consumers", "Place each consumer plugin in its own directory.\n"],
]);

export interface InitResult {
  projectRoot: string;
  created: string[];
}

export class InitConflictError extends Error {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(`Cannot initialize because these targets already exist: ${paths.join(", ")}`);
    this.name = "InitConflictError";
    this.paths = paths;
  }
}

function configText(): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    paths: {
      sources: "sources",
      consumers: "consumers",
      data: ".event-hub",
    },
    pluginManifest: "plugin.json",
    sourceDefaults: { backfill: "24h" },
    secrets: {},
  }, null, 2)}\n`;
}

async function existingTargets(projectRoot: string): Promise<string[]> {
  const targets = [CONFIG_FILENAME, ...directoryFiles.keys(), ".event-hub"];
  const existing = await Promise.all(targets.map(async (target) => {
    try {
      await stat(resolve(projectRoot, target));
      return target;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }));
  return existing.filter((target): target is string => target !== null);
}

export async function initProject(directory = "."): Promise<InitResult> {
  const projectRoot = resolve(directory);
  const conflicts = await existingTargets(projectRoot);
  if (conflicts.length > 0) throw new InitConflictError(conflicts);

  await mkdir(projectRoot, { recursive: true });
  await writeFile(resolve(projectRoot, CONFIG_FILENAME), configText(), { flag: "wx" });

  for (const [directoryName, readme] of directoryFiles) {
    const path = resolve(projectRoot, directoryName);
    await mkdir(path);
    await writeFile(resolve(path, "README.md"), readme, { flag: "wx" });
  }

  await mkdir(resolve(projectRoot, ".event-hub"));
  await writeFile(
    resolve(projectRoot, ".event-hub", "README.md"),
    "Event history and execution state are stored here.\n",
    { flag: "wx" },
  );

  return {
    projectRoot,
    created: [CONFIG_FILENAME, "sources", "consumers", ".event-hub"],
  };
}
