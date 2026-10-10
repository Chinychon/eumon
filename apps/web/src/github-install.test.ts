import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { checkInstallation } from "./github-install.ts";

type Inst = { id: number; account: { login: string; type: string } };
function github(installations: Inst[], opts: { user?: string; membership?: { status: number; body?: unknown } } = {}) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "user-token" });
    if (u === "https://api.github.com/user/installations?per_page=100") return Response.json({ installations });
    if (u === "https://api.github.com/user") return Response.json({ login: opts.user ?? "Me" });
    if (u.startsWith("https://api.github.com/user/memberships/orgs/")) return Response.json(opts.membership?.body ?? {}, { status: opts.membership?.status ?? 404 });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const input = { clientId: "c", clientSecret: "s", code: "code", installationId: "7" };
const personal = (login: string): Inst => ({ id: 7, account: { login, type: "User" } });
const org: Inst = { id: 7, account: { login: "acme", type: "Organization" } };

describe("checkInstallation", () => {
  it("accepts a personal installation of the user themselves", async () => {
    const g = github([personal("me")], { user: "Me" });
    assert.equal(await checkInstallation(g.fetchFn, input), "ok");
    assert.equal(g.calls[0], "https://github.com/login/oauth/access_token");
  });
  it("refuses another login's personal installation, and ids the user can't reach", async () => {
    assert.equal(await checkInstallation(github([personal("someone")]).fetchFn, input), "not_yours");
    assert.equal(await checkInstallation(github([{ ...personal("me"), id: 5 }]).fetchFn, input), "not_yours");
  });
  it("accepts an org installation only for an active admin", async () => {
    assert.equal(await checkInstallation(github([org], { membership: { status: 200, body: { state: "active", role: "admin" } } }).fetchFn, input), "ok");
    assert.equal(await checkInstallation(github([org], { membership: { status: 200, body: { state: "active", role: "member" } } }).fetchFn, input), "not_yours");
    assert.equal(await checkInstallation(github([org], { membership: { status: 200, body: { state: "pending", role: "admin" } } }).fetchFn, input), "not_yours");
  });
  it("reports when the org check is unavailable", async () => {
    assert.equal(await checkInstallation(github([org], { membership: { status: 403 } }).fetchFn, input), "org_check_unavailable");
  });
  it("refuses when GitHub gives no user token (user authorization is off)", async () => {
    const fetchFn = (async () => Response.json({ error: "bad_verification_code" })) as unknown as typeof fetch;
    assert.equal(await checkInstallation(fetchFn, input), "not_yours");
  });
});

it("no route reads the old og_installation cookie", () => {
  for (const file of ["../app/api/github/repositories/route.ts", "../app/api/sites/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /og_installation=/, file);
  }
});
