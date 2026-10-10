import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeNext } from "./next-path.ts";

describe("safeNext", () => {
  it("keeps same-site paths and sends everything else home", () => {
    assert.equal(safeNext("/?view=setup"), "/?view=setup");
    assert.equal(safeNext("/invite/inv_1"), "/invite/inv_1");
    for (const bad of [null, "", "//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "evil"]) assert.equal(safeNext(bad), "/", String(bad));
  });
});
