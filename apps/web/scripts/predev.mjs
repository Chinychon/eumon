// Runs before `npm run dev`, however it is started: the web app reads the
// shared packages' built copies, so a stale build shows old features and old
// demo data, and a missing migration breaks the pages that need it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const MIGRATIONS = path("../../../packages/db/migrations/");
const LOCAL_D1 = path("../.cloudflare/state/v3/d1/miniflare-D1DatabaseObject/");

console.log("Building the shared packages…");
const build = spawnSync(npm, ["run", "build:packages", "--silent"], { cwd: path("../../../"), stdio: "inherit", shell: windows });
if (build.status !== 0) process.exit(build.status ?? 1);

/** Migration files the local database hasn't applied, or null when that can't be read here (then `cf` decides). */
async function pendingMigrations() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
  if (!existsSync(LOCAL_D1)) return files;
  const databases = readdirSync(LOCAL_D1).filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
  if (databases.length !== 1) return null;
  try {
    process.removeAllListeners("warning"); // node:sqlite is "experimental" on Node 22
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(LOCAL_D1 + databases[0], { readOnly: true });
    const applied = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((row) => row.name));
    db.close();
    return files.filter((name) => !applied.has(name));
  } catch {
    return null; // Node 20 has no node:sqlite, or the table doesn't exist yet
  }
}

/**
 * `npm run db:migrate:local`, stopped after two minutes: the `cf` CLI (beta)
 * sometimes prints its result and never exits. Without a terminal on stdin it
 * doesn't stop to ask for confirmation.
 */
function migrate() {
  return new Promise((resolve) => {
    const child = spawn(npm, ["run", "db:migrate:local", "--silent"], { cwd: path("../"), stdio: ["ignore", "inherit", "inherit"], shell: windows, detached: !windows });
    const timer = setTimeout(() => {
      try { windows ? child.kill() : process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, 120_000);
    child.on("exit", () => { clearTimeout(timer); resolve(); });
  });
}

const pending = await pendingMigrations();
if (pending?.length === 0) {
  console.log("Local database is up to date.");
} else {
  console.log(pending ? `Applying ${pending.length} local database migration${pending.length === 1 ? "" : "s"}…` : "Applying local database migrations…");
  await migrate();
  const left = await pendingMigrations();
  if (left?.length) console.warn(`Still not applied: ${left.join(", ")}. Run \`npm run db:migrate:local -w @organic-growth/web\`, then restart.`);
}
process.exit(0);
