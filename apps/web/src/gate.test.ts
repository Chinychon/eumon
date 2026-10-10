import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gate, isPublicPath } from "./gate.ts";

const req = (path: string, init: RequestInit = {}) => new Request(`https://app.eumon.test${path}`, init);

describe("gate", () => {
  it("lets public paths through without a session", () => {
    for (const path of ["/p/site_1/doctors/tan", "/api/sites/site_1/events", "/r/abc", "/api/r/abc", "/api/logs/site_1", "/api/auth/sign-in/social", "/sign-in", "/invite/inv_1", "/manifest.json", "/sw.js", "/assets/app.js", "/icon-192.png"]) {
      assert.equal(isPublicPath(path), true, path);
      assert.equal(gate(req(path, { method: path.startsWith("/api/") ? "POST" : "GET", headers: { origin: "https://elsewhere.test" } }), false), null, path);
    }
  });

  it("keeps everything else behind sign-in", async () => {
    for (const path of ["/", "/admin", "/api/sites", "/api/sites/site_1/events/recent", "/api/sites/site_1/events/summary", "/api/dev/demo-site"]) assert.equal(isPublicPath(path), false, path);
    const api = gate(req("/api/sites"), false)!;
    assert.equal(api.status, 401);
    assert.match((await api.json() as { error: string }).error, /Sign in/);
    const page = gate(req("/?view=setup"), false)!;
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "https://app.eumon.test/sign-in?next=%2F%3Fview%3Dsetup");
    assert.equal(gate(req("/api/sites"), true), null);
  });

  it("refuses cross-site writes from signed-in browsers", () => {
    assert.equal(gate(req("/api/sites", { method: "POST", headers: { origin: "https://evil.test" } }), true)?.status, 403);
    assert.equal(gate(req("/api/sites", { method: "POST" }), true)?.status, 403, "no Origin on a write");
    assert.equal(gate(req("/api/sites", { method: "POST", headers: { origin: "https://app.eumon.test" } }), true), null);
    assert.equal(gate(req("/api/sites", { method: "GET", headers: { origin: "https://evil.test" } }), true), null, "reads are not writes");
  });
});
