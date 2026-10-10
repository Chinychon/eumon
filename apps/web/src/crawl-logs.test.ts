import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logToken, tokenMatches } from "./crawl-logs.ts";

const secret = "s".repeat(40);
const delivery = (token: string) => new Request("https://eumon.test/api/logs/site", { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("log token", () => {
  it("accepts the derived token until the site has its own, then only its own", async () => {
    const derived = await logToken(secret, "site");
    assert.equal(await tokenMatches(delivery(derived), secret, "site", null), true);
    assert.equal(await tokenMatches(delivery(derived), secret, "site", "f".repeat(64)), false, "rotated: the old token stops");
    assert.equal(await tokenMatches(delivery("f".repeat(64)), secret, "site", "f".repeat(64)), true);
    assert.equal(await tokenMatches(delivery("wrong"), secret, "site", null), false);
  });
});
