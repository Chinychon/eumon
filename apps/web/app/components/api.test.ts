import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { api } from "./api.ts";

/** Answers every fetch with `status` and `{ error }`, and records where the page was sent. */
function stub(status: number, error: string) {
  const sent: string[] = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({ error }), { status })) as typeof fetch;
  (globalThis as { window?: unknown }).window = { location: { pathname: "/", search: "?view=setup", assign: (to: string) => sent.push(to) } };
  return sent;
}

describe("api 401 handling", () => {
  it("sends the browser to sign-in when the session is gone", async () => {
    const sent = stub(401, "Sign in to continue.");
    await assert.rejects(api("/api/sites"));
    assert.deepEqual(sent, ["/sign-in?next=%2F%3Fview%3Dsetup"]);
  });

  it("stays put on any other refusal, so a missing integration never looks like a sign-out", async () => {
    const sent = stub(401, "Install the GitHub App for this workspace first.");
    await assert.rejects(api("/api/github/repositories"), /Install the GitHub App/);
    assert.deepEqual(sent, []);
  });
});
