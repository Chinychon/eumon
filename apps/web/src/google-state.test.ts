import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googleStateProblem } from "./google-state.ts";

describe("googleStateProblem", () => {
  const state = { siteId: "s", nonce: "n1", userId: "u" };
  it("accepts the browser and user that started the connection", () => assert.equal(googleStateProblem(state, "n1", "u"), null));
  it("refuses a link opened in another browser", () => assert.ok(googleStateProblem(state, null, "u")));
  it("refuses a mismatched nonce", () => assert.ok(googleStateProblem(state, "n2", "u")));
  it("refuses another signed-in user", () => assert.ok(googleStateProblem(state, "n1", "someone-else")));
  it("refuses a missing or unsigned state", () => {
    assert.ok(googleStateProblem(null, "n1", "u"));
    assert.ok(googleStateProblem({ siteId: "s" }, "n1", "u"));
  });
});
