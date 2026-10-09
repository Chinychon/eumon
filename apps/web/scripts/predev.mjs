// Runs before `npm run dev`, however it is started: the web app reads the
// shared packages' built copies, so a stale build shows old features and old
// demo data, and a missing migration breaks the pages that need it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (args, cwd, stdin = "inherit") => {
  const result = spawnSync(npm, args, { cwd: fileURLToPath(new URL(cwd, import.meta.url)), stdio: [stdin, "inherit", "inherit"], shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

console.log("Building the shared packages…");
run(["run", "build:packages", "--silent"], "../../../");
console.log("Applying local database migrations…");
// Without a terminal on stdin the migration doesn't stop to ask for confirmation.
run(["run", "db:migrate:local", "--silent"], "../", "ignore");
