import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

/** Routes the gate leaves public; each authenticates its own way (a token, a signed link, OAuth state). */
const PUBLIC = new Set(["sites/[siteId]/events/route.ts", "r/[token]/route.ts", "logs/[siteId]/route.ts"]);
const GUARD = /\brequire(Site|Owned|Workspace|Viewer|PlatformAdmin)\(/;
const root = new URL("../app/api/", import.meta.url).pathname;

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === "route.ts" ? [path] : [];
  });
}

describe("every API handler checks who is asking", () => {
  for (const file of routes(root)) {
    const name = relative(root, file);
    if (PUBLIC.has(name)) continue;
    it(name, () => {
      const handlers = readFileSync(file, "utf8").split(/(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
      assert.ok(handlers.length, "exports a handler");
      for (const handler of handlers) assert.match(handler, GUARD, handler.slice(0, 60));
    });
  }
});
