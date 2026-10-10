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

const HANDLER_START = /^export\s+(?:async\s+)?(?:function|const|let)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/;
const HANDLER = /(?=export\s+(?:async\s+)?(?:function|const|let)\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b)/;

/** Throws unless the source exports a handler, every handler calls a guard, and nothing is re-exported. */
function checkSource(source: string): void {
  assert.doesNotMatch(source, /export\s*(\{|\*)/, "re-exports could smuggle an unguarded handler");
  const handlers = source.split(HANDLER).filter((chunk) => HANDLER_START.test(chunk)); // the first chunk may be the preamble or a handler
  assert.ok(handlers.length, "exports a handler");
  for (const handler of handlers) assert.match(handler, GUARD, handler.slice(0, 60));
}

describe("the checker itself", () => {
  it("rejects an unguarded arrow handler", () => {
    assert.throws(() => checkSource("export const GET = async () => json(x);"));
  });
  it("rejects an unguarded non-async handler", () => {
    assert.throws(() => checkSource("export function POST() {}"));
  });
  it("rejects an unguarded handler after a guarded one", () => {
    assert.throws(() => checkSource("export async function GET(r) { await requireSite(r, 'a', 'read'); }\nexport const DELETE = async () => ok();"));
  });
  it("rejects re-exports", () => {
    assert.throws(() => checkSource("export async function GET(r) { await requireSite(r); }\nexport { POST } from './x';"));
  });
  it("accepts a guarded handler", () => {
    checkSource("export async function GET(r) { await requireSite(r, 'a', 'read'); }");
  });
});

describe("every API handler checks who is asking", () => {
  for (const file of routes(root)) {
    const name = relative(root, file);
    if (PUBLIC.has(name)) continue;
    it(name, () => checkSource(readFileSync(file, "utf8")));
  }
});
