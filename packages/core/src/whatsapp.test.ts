import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findRef, isRef, isWhatsAppChatUrl, REF_ALPHABET } from "./whatsapp.js";

describe("WhatsApp reference codes", () => {
  it("finds the code in a pasted message, or typed on its own", () => {
    assert.equal(findRef("Hi, I would like to ask about Braces (ref K7M2Q)"), "K7M2Q");
    assert.equal(findRef("halo ref: k7m2q terima kasih"), "K7M2Q");
    assert.equal(findRef("  k7m2q "), "K7M2Q");
    assert.equal(findRef("Hi, I would like to ask about braces"), null);
    assert.equal(findRef("(ref K0M2Q)"), null, "0 and O, 1 and I are never in a code");
  });

  it("knows which links can carry a message, and what a code looks like", () => {
    assert.ok(isWhatsAppChatUrl("https://wa.me/60123456789") && isWhatsAppChatUrl("https://api.whatsapp.com/send?phone=60123"));
    assert.equal(isWhatsAppChatUrl("https://chat.whatsapp.com/invite"), false);
    assert.ok(isRef("K7M2Q") && !isRef("k7m2q") && !isRef("K7M2QX"));
    assert.equal(new Set(REF_ALPHABET).size, 32, "a byte maps evenly onto 32 letters");
  });
});
