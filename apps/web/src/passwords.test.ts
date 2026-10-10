import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "./passwords.ts";

describe("passwords", () => {
  it("verifies the right password only, with a fresh salt each time", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.match(hash, /^pbkdf2-sha256\$100000\$/);
    assert.equal(await verifyPassword({ hash, password: "correct horse battery staple" }), true);
    assert.equal(await verifyPassword({ hash, password: "wrong" }), false);
    assert.notEqual(await hashPassword("same"), await hashPassword("same"));
    assert.equal(await verifyPassword({ hash: "garbage", password: "x" }), false);
  });
});
