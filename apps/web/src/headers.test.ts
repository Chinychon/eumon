import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_HEADERS, PAGE_HEADERS, withHeaders } from "./headers.ts";

describe("security headers", () => {
  it("adds headers to an immutable response without losing its body or status", async () => {
    const original = Response.redirect("https://x.com/", 302);
    const response = withHeaders(original, APP_HEADERS);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://x.com/");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  });

  it("lets landing pages be framed but keeps nosniff and base-uri", () => {
    assert.equal(PAGE_HEADERS["X-Frame-Options"], undefined);
    assert.equal(PAGE_HEADERS["X-Content-Type-Options"], "nosniff");
    assert.match(PAGE_HEADERS["Content-Security-Policy"]!, /base-uri 'none'/);
  });
});
