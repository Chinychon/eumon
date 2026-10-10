import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkStateOf, getFileWithSha, latestPreviewUrl, markReadyForReview } from "./github-pr.js";

function fake(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    return key ? Response.json(routes[key]) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("github helpers", () => {
  it("reads a file with its blob SHA, decoding base64 as UTF-8", async () => {
    const content = Buffer.from("const a = \"é\";\n").toString("base64");
    const { fetchFn, calls } = fake({ "/contents/app/page.tsx?ref=main": { content, sha: "abc", encoding: "base64" } });
    assert.deepEqual(await getFileWithSha("t", "acme", "web", "app/page.tsx", "main", fetchFn), { content: "const a = \"é\";\n", sha: "abc" });
    assert.match(String((calls[0]!.init!.headers as Record<string, string>).Authorization), /Bearer t/);
    assert.equal(await getFileWithSha("t", "acme", "web", "missing.tsx", "main", fetchFn), null);
  });

  it("treats a repo with no checks as passing, and any failure as failing", () => {
    assert.equal(checkStateOf([], { state: "pending", total_count: 0 }), "success");
    assert.equal(checkStateOf([{ status: "completed", conclusion: "success" }], { state: "success", total_count: 1 }), "success");
    assert.equal(checkStateOf([{ status: "in_progress", conclusion: null }], { state: "pending", total_count: 0 }), "pending");
    assert.equal(checkStateOf([{ status: "completed", conclusion: "failure" }], { state: "success", total_count: 1 }), "failure");
    assert.equal(checkStateOf([], { state: "failure", total_count: 1 }), "failure");
  });

  it("finds the newest successful preview URL for a commit", async () => {
    const { fetchFn } = fake({ "/deployments?sha=s1": [{ id: 9 }], "/deployments/9/statuses": [{ state: "success", environment_url: "https://pr-7.vercel.app" }] });
    assert.equal(await latestPreviewUrl("t", "acme", "web", "s1", fetchFn), "https://pr-7.vercel.app");
  });

  it("marks a draft ready through GraphQL", async () => {
    const { fetchFn, calls } = fake({ "/graphql": { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } });
    await markReadyForReview("t", "PR_node", fetchFn);
    assert.match(String(calls[0]!.init!.body), /markPullRequestReadyForReview/);
    assert.match(String(calls[0]!.init!.body), /PR_node/);
  });
});
