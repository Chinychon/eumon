import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRosterPath, requestedWorkspaces } from "./auth-paths.ts";

describe("isRosterPath", () => {
  it("matches the Better Auth endpoints that list people", () => {
    for (const p of ["/api/auth/organization/get-full-organization", "/api/auth/organization/list-members", "/api/auth/organization/list-invitations", "/api/auth/organization/list-members/"]) assert.equal(isRosterPath(p), true, p);
    for (const p of ["/api/auth/get-session", "/api/auth/organization/list-organizations", "/api/auth/organization/set-active", "/api/auth/organization/get-active-member-role"]) assert.equal(isRosterPath(p), false, p);
  });
});

describe("requestedWorkspaces", () => {
  const ask = (query: string, active: string | null) => requestedWorkspaces(new URLSearchParams(query), active);

  it("names every workspace Better Auth could answer for, so a Client in any of them is refused", () => {
    assert.deepEqual(ask("organizationId=w2", "w1"), { ids: ["w2", "w1"], slug: null });
    assert.deepEqual(ask("", "w1"), { ids: ["w1"], slug: null });
    assert.deepEqual(ask("organizationSlug=acme&organizationId=w2", "w1"), { ids: ["w2", "w1"], slug: "acme" });
  });

  it("treats an empty organizationId as absent (Better Auth falls back to the active workspace)", () => {
    assert.deepEqual(ask("organizationId=", "w1"), { ids: ["w1"], slug: null });
    assert.deepEqual(ask("organizationSlug=", null), { ids: [], slug: null });
  });
});
