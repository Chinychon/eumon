import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isRosterPath } from "./auth-paths.ts";

describe("isRosterPath", () => {
  it("matches the Better Auth endpoints that list people", () => {
    for (const p of ["/api/auth/organization/get-full-organization", "/api/auth/organization/list-members", "/api/auth/organization/list-invitations", "/api/auth/organization/list-members/"]) assert.equal(isRosterPath(p), true, p);
    for (const p of ["/api/auth/get-session", "/api/auth/organization/list-organizations", "/api/auth/organization/set-active", "/api/auth/organization/get-active-member-role"]) assert.equal(isRosterPath(p), false, p);
  });
});
