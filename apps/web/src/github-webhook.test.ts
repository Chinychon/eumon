import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { getFix, stageFix, updateFix, upsertSite, type FixRecord } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { advanceFix, handleGitHubEvent, verifySignature, type WebhookDeps } from "./github-webhook.ts";
import type { GitHubOps } from "./fix-github.ts";

const AT = "2026-10-10T00:00:00.000Z";
const repository = { name: "web", owner: { login: "acme" } };

async function setup(over: Partial<GitHubOps> = {}, pages: Record<string, { status: number; body: string }> = {}, minutes = 0) {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  const fix: FixRecord = { id: "f1", siteId: "s", analysisId: "a", kind: "head", route: "/p/:slug", filePath: "app/p/[slug]/page.tsx", title: "T", reason: "R",
    files: {}, original: {}, urls: ["https://x.com/p/a"], problems: ["canonical-missing"], warnings: [], score: 1, status: "staged", createdAt: AT, updatedAt: AT };
  await stageFix(db, fix);
  await updateFix(db, "f1", { status: "draft", prNumber: 7, headSha: "h1", prNodeId: "N1" });
  const calls: string[] = [];
  const ops: GitHubOps = {
    getPullRequest: async () => ({ state: "open", merged: false, draft: true, headSha: "h1", nodeId: "N1", createdAt: AT }),
    checkState: async () => "success", previewUrl: async () => "https://pr-7.vercel.app",
    markReady: async (id) => { calls.push(`ready:${id}`); }, comment: async (_n, body) => { calls.push(`comment:${body.slice(0, 20)}`); }, close: async () => { calls.push("close"); },
    ...over,
  };
  const deps: WebhookDeps = { db, opsFor: async () => ops, fetchHtml: async (url) => pages[url] ?? null, now: () => new Date(Date.now() + minutes * 60_000) };
  return { db, deps, calls };
}

describe("webhook signature", () => {
  it("accepts GitHub's sha256 HMAC and rejects anything else", async () => {
    const body = '{"a":1}';
    const header = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    assert.equal(await verifySignature("s3cret", body, header), true);
    assert.equal(await verifySignature("s3cret", body + " ", header), false);
    assert.equal(await verifySignature("s3cret", body, null), false);
    assert.equal(await verifySignature("", body, header), false);
  });
});

describe("webhook events", () => {
  it("records merges and rejections", async () => {
    const { db, deps } = await setup();
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: true } }), "merged");
    assert.equal((await getFix(db, "f1"))?.status, "merged");
    const second = await setup();
    assert.equal(await handleGitHubEvent(second.deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: false } }), "rejected");
  });

  it("ignores repos and PRs Eumon doesn't know (Review Focus 3)", async () => {
    const { db, deps } = await setup();
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository: { name: "other", owner: { login: "acme" } }, pull_request: { number: 7, merged: true } }), "ignored");
    assert.equal(await handleGitHubEvent(deps, "check_suite", { action: "completed", repository, check_suite: { head_sha: "zzz" } }), "ignored");
    assert.equal((await getFix(db, "f1"))?.status, "draft");
  });

  it("marks ready when checks pass and the preview shows the change", async () => {
    const html = `<html><head><link rel="canonical" href="https://x.com/p/a"></head><body></body></html>`;
    const { db, deps, calls } = await setup({}, { "https://pr-7.vercel.app/p/a": { status: 200, body: html } });
    assert.equal(await handleGitHubEvent(deps, "check_suite", { action: "completed", repository, check_suite: { head_sha: "h1" } }), "ready");
    assert.equal((await getFix(db, "f1"))?.status, "ready");
    assert.ok(calls.includes("ready:N1"));
  });

  it("fails when the preview lacks the change, and when checks fail", async () => {
    const { db, deps } = await setup({}, { "https://pr-7.vercel.app/p/a": { status: 200, body: "<html><head></head></html>" } });
    assert.equal(await handleGitHubEvent(deps, "status", { repository, state: "success", sha: "h1" }), "failed");
    assert.equal((await getFix(db, "f1"))?.status, "failed");
    const red = await setup({ checkState: async () => "failure" });
    assert.equal(await handleGitHubEvent(red.deps, "check_run", { action: "completed", repository, check_run: { head_sha: "h1" } }), "failed");
  });

  it("treats a password-protected preview as no preview, then readies on build after 30 minutes (Review Focus 2)", async () => {
    const locked = { "https://pr-7.vercel.app/p/a": { status: 401, body: "" } };
    const early = await setup({}, locked, 5);
    assert.equal(await handleGitHubEvent(early.deps, "deployment_status", { repository, deployment_status: { state: "success", deployment: { sha: "h1" } } }), "waiting");
    const late = await setup({}, locked, 31);
    assert.equal(await handleGitHubEvent(late.deps, "deployment_status", { repository, deployment_status: { state: "success", deployment: { sha: "h1" } } }), "ready");
    assert.deepEqual((await getFix(late.db, "f1"))?.verification, { buildOnly: true });
  });
});

describe("two sites on one repo", () => {
  it("routes events to the site that owns the fix", async () => {
    const { db, deps } = await setup();
    await upsertSite(db, { id: "s0", name: "y.com", baseUrl: "https://y.com", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: AT, githubOwner: "acme", githubRepo: "web" });
    // s0 is older, so it is tried first, but owns no fix.
    assert.equal(await handleGitHubEvent(deps, "check_suite", { action: "completed", repository, check_suite: { head_sha: "zzz" } }), "ignored");
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: true } }), "merged");
    assert.equal((await getFix(db, "f1"))?.status, "merged");
  });
});

describe("webhook races and failures", () => {
  it("comments and marks ready once for concurrent advances", async () => {
    const html = `<html><head><link rel="canonical" href="https://x.com/p/a"></head></html>`;
    const { db, deps, calls } = await setup({}, { "https://pr-7.vercel.app/p/a": { status: 200, body: html } });
    const fix = (await getFix(db, "f1"))!;
    const ops = await deps.opsFor({} as never);
    await Promise.all([advanceFix(deps, ops, fix), advanceFix(deps, ops, fix)]);
    assert.equal(calls.filter((c) => c.startsWith("ready:")).length, 1);
    assert.equal(calls.filter((c) => c.startsWith("comment:")).length, 1);
  });

  it("leaves a fix that merged mid-advance merged", async () => {
    const ctx = await setup({ checkState: async () => { await updateFix(ctx.db, "f1", { status: "merged" }); return "failure"; } });
    await advanceFix(ctx.deps, await ctx.deps.opsFor({} as never), (await getFix(ctx.db, "f1"))!);
    assert.equal((await getFix(ctx.db, "f1"))?.status, "merged");
    assert.deepEqual(ctx.calls, []);
  });

  it("ignores a replayed merge on a reverted fix", async () => {
    const { db, deps } = await setup();
    await updateFix(db, "f1", { status: "reverted" });
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: true } }), "ignored");
    assert.equal((await getFix(db, "f1"))?.status, "reverted");
  });

  it("waits when the preview is unreachable or erroring", async () => {
    const { deps } = await setup();
    assert.equal(await handleGitHubEvent(deps, "check_suite", { action: "completed", repository, check_suite: { head_sha: "h1" } }), "waiting");
    const err = await setup({}, { "https://pr-7.vercel.app/p/a": { status: 502, body: "" } });
    assert.equal(await handleGitHubEvent(err.deps, "check_suite", { action: "completed", repository, check_suite: { head_sha: "h1" } }), "waiting");
  });

  it("rejects a failed fix whose PR is closed, and records a later merge of a rejected one (I3)", async () => {
    const { db, deps } = await setup();
    await updateFix(db, "f1", { status: "failed" });
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: false } }), "rejected");
    assert.equal((await getFix(db, "f1"))?.status, "rejected");
    assert.equal(await handleGitHubEvent(deps, "pull_request", { action: "closed", repository, pull_request: { number: 7, merged: true } }), "merged");
    assert.equal((await getFix(db, "f1"))?.status, "merged");
  });

  it("ignores unfinished check events", async () => {
    const { deps } = await setup();
    assert.equal(await handleGitHubEvent(deps, "check_suite", { action: "requested", repository, check_suite: { head_sha: "h1" } }), "ignored");
    assert.equal(await handleGitHubEvent(deps, "status", { repository, state: "pending", sha: "h1" }), "ignored");
  });
});
