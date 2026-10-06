import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromBase64Url, signToken, toBase64Url, verifyToken } from "./tokens.js";

const secret = "s".repeat(32);

describe("signed tokens", () => {
  it("round-trips data until it expires", async () => {
    assert.deepEqual((await verifyToken<{ id: string }>(await signToken({ id: "42" }, 60_000, secret), secret))?.id, "42");
    assert.equal(await verifyToken(await signToken({ id: "42" }, -1, secret), secret), null);
  });

  it("rejects tampering, other secrets, and short secrets", async () => {
    const token = await signToken({ id: "42" }, 60_000, secret);
    const [, signature] = token.split(".");
    assert.equal(await verifyToken(`${toBase64Url(JSON.stringify({ id: "43", exp: Date.now() + 60_000 }))}.${signature}`, secret), null);
    assert.equal(await verifyToken(token, "t".repeat(32)), null);
    assert.equal(await verifyToken(`${token}.x`, secret), null);
    assert.equal(await verifyToken("not a token", secret), null);
    await assert.rejects(signToken({}, 1000, "short"));
  });

  it("encodes base64url without padding", () => {
    const bytes = Uint8Array.of(251, 255, 191);
    assert.equal(toBase64Url(bytes), "-_-_");
    assert.deepEqual(fromBase64Url(toBase64Url(Uint8Array.of(1, 2))), Uint8Array.of(1, 2));
  });
});
