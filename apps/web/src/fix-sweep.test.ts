import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFix, stageFix, updateFix, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import type { GitHubOps } from "./fix-github.ts";
import { sweepFixes } from "./fix-sweep.ts";

const AT = "2026-10-10T00:00:00.000Z";
async function setup(pr: Partial<Awaited<ReturnType<GitHubOps["getPullRequest"]>>>, days = 0) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  await stageFix(db, { id: "f1", siteId: "s", analysisId: "a", kind: "llms-txt", route: "public/llms.txt", filePath: "public/llms.txt", title: "T", reason: "R",
    files: {}, original: {}, urls: [], problems: [], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT });
  await updateFix(db, "f1", { status: "draft", prNumber: 7, headSha: "h1", prNodeId: "N1" });
  const closed: number[] = [];
  const ops: GitHubOps = {
    getPullRequest: async () => ({ state: "open", merged: false, draft: true, headSha: "h1", nodeId: "N1", createdAt: AT, ...pr }),
    checkState: async () => "pending", previewUrl: async () => null, markReady: async () => {}, comment: async () => {}, close: async (n) => { closed.push(n); },
  };
  return { db, ops, closed, deps: { db, opsFor: async () => ops, fetchHtml: async () => null, now: () => new Date(Date.now() + days * 86_400_000) } };
}

describe("sweepFixes", () => {
  it("catches up on merges and closes missed by the webhook", async () => {
    const merged = await setup({ state: "closed", merged: true });
    assert.equal(await sweepFixes(merged.deps), 1);
    assert.equal((await getFix(merged.db, "f1"))?.status, "merged");
    const closed = await setup({ state: "closed", merged: false });
    await sweepFixes(closed.deps);
    assert.equal((await getFix(closed.db, "f1"))?.status, "rejected");
  });

  it("closes drafts older than 7 days and leaves fresh pending ones alone", async () => {
    const old = await setup({}, 8);
    assert.equal(await sweepFixes(old.deps), 1);
    assert.deepEqual(old.closed, [7]);
    assert.equal((await getFix(old.db, "f1"))?.status, "closed");
    const fresh = await setup({});
    assert.equal(await sweepFixes(fresh.deps), 0);
    assert.equal((await getFix(fresh.db, "f1"))?.status, "draft");
  });

  it("records a failed GitHub close but keeps the fix closed", async () => {
    const old = await setup({}, 8);
    old.ops.close = async () => { throw new Error("404"); };
    assert.equal(await sweepFixes(old.deps), 1);
    const fix = await getFix(old.db, "f1");
    assert.equal(fix?.status, "closed");
    assert.match(fix?.result ?? "", /Close the PR by hand/);
  });

  it("skips a fix whose pull request lookup throws and still sweeps the next one", async () => {
    const t = await setup({ state: "closed", merged: true });
    await stageFix(t.db, { id: "f2", siteId: "s", analysisId: "a", kind: "llms-txt", route: "public/llms.txt", filePath: "public/llms.txt", title: "T", reason: "R",
      files: {}, original: {}, urls: [], problems: [], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT });
    await updateFix(t.db, "f2", { status: "draft", prNumber: 8, headSha: "h2", prNodeId: "N2" });
    await t.db.prepare("UPDATE changes SET updated_at = '2026-10-09T00:00:00.000Z' WHERE id = 'f1'").run(); // f1 is swept first
    const real = t.ops.getPullRequest;
    t.ops.getPullRequest = async (n) => { if (n === 7) throw new Error("boom"); return real(n); };
    assert.equal(await sweepFixes(t.deps), 1);
    assert.equal((await getFix(t.db, "f1"))?.status, "draft");
    assert.equal((await getFix(t.db, "f2"))?.status, "merged");
  });

  it("mints ops once per site across its fixes", async () => {
    const t = await setup({}, 0);
    for (const n of [2, 3]) {
      await stageFix(t.db, { id: `f${n}`, siteId: "s", analysisId: "a", kind: "llms-txt", route: "public/llms.txt", filePath: "public/llms.txt", title: "T", reason: "R",
        files: {}, original: {}, urls: [], problems: [], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT });
      await updateFix(t.db, `f${n}`, { status: "draft", prNumber: 7 + n, headSha: `h${n}`, prNodeId: `N${n}` });
    }
    let minted = 0;
    await sweepFixes({ ...t.deps, opsFor: async () => { minted++; return t.ops; } });
    assert.equal(minted, 1);
  });

  async function many(updated: string[]) {
    const t = await setup({ state: "closed", merged: true });
    for (const [i, at] of updated.entries()) {
      await stageFix(t.db, { id: `g${i}`, siteId: "s", analysisId: "a", kind: "llms-txt", route: "public/llms.txt", filePath: "public/llms.txt", title: "T", reason: "R",
        files: {}, original: {}, urls: [], problems: [], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT });
      await updateFix(t.db, `g${i}`, { status: "draft", prNumber: 20 + i, headSha: `x${i}`, prNodeId: `X${i}` });
      await t.db.prepare("UPDATE changes SET updated_at = ? WHERE id = ?").bind(at, `g${i}`).run();
    }
    await t.db.prepare("DELETE FROM changes WHERE id = 'f1'").run();
    return t;
  }
  const status = async (t: Awaited<ReturnType<typeof many>>, id: string) => (await getFix(t.db, id))?.status;

  it("always sweeps a stale draft first even when newer ones exceed the limit", async () => {
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const t = await many([fresh, fresh, fresh, fresh, fresh, new Date(now - 9 * 86_400_000).toISOString()]);
    await sweepFixes({ ...t.deps, now: () => new Date(now), random: () => 0 }, 2);
    assert.equal(await status(t, "g5"), "merged");
  });

  it("picks among fresh drafts with the injected random source", async () => {
    const now = Date.now();
    const fresh = new Date(now).toISOString();
    const t = await many([fresh, fresh, fresh]);
    await sweepFixes({ ...t.deps, now: () => new Date(now), random: () => 0 }, 1);
    // random() = 0 swaps each slot with index 0 going down, leaving the first draft last in line and g1 first.
    const merged = [];
    for (const id of ["g0", "g1", "g2"]) if ((await status(t, id)) === "merged") merged.push(id);
    assert.deepEqual(merged, ["g1"]);
  });
});
