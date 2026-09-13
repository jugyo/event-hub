// During migration, `file:../mini-restate` (package name `@jugyo/duex`) resolves as a symlink.
// Rebuild the linked checkout before tests so stale distribution files cannot mask changes.
// Once the dependency uses a registry version, it is no longer a symlink and this script does nothing.
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dependency = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@jugyo", "duex");

let linked;
try {
  linked = lstatSync(dependency).isSymbolicLink();
} catch {
  console.error("@jugyo/duex is not installed. Run npm install first.");
  process.exit(1);
}

if (linked) {
  const build = spawnSync("npm", ["--prefix", dependency, "run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("Failed to build the adjacent @jugyo/duex checkout. Run npm --prefix ../mini-restate install first.");
    process.exit(build.status ?? 1);
  }
}
