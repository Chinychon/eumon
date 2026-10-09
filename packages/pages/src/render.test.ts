import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackingScript } from "./render.js";

describe("tracking script", () => {
  it("caps utm_source before sending it, so a long tracking value can't push the view beacon over the server's body limit", () => {
    const script = trackingScript("/eumon/beacon", "page_1", undefined, undefined);
    assert.match(script, /utm_source"\)\|\|""\)\.slice\(0,80\)/, "the server reads at most 2 KB and keeps 80 characters of utm_source");
  });
});

/** Runs the tracking script against a stand-in browser and clicks a CTA link. */
function clickCta(href: string, hello: string) {
  const script = trackingScript("/guides/__eumon/e", "page_1", undefined, undefined, hello).replace(/^<script>|<\/script>$/g, "");
  const sent: Array<Record<string, unknown>> = [];
  let onClick: ((event: unknown) => void) | undefined;
  const link = { href, getAttribute: () => "hero" };
  const browser = {
    document: { cookie: "", referrer: "", addEventListener: (_: string, listener: (event: unknown) => void) => { onClick = listener; } },
    location: { host: "x.com", search: "" },
    navigator: { sendBeacon: (_: string, blob: { parts: string[] }) => { sent.push(JSON.parse(blob.parts[0]!)); return true; } },
    Blob: class { parts: string[]; constructor(parts: string[]) { this.parts = parts; } },
    crypto: globalThis.crypto, URL, URLSearchParams, JSON, Math, String, Uint8Array,
  };
  const run = new Function(...Object.keys(browser), "window", script);
  run(...Object.values(browser), browser);
  onClick!({ target: { closest: () => link } });
  return { link, cta: sent.find((body) => body.t === "cta")! };
}

describe("WhatsApp reference codes", () => {
  it("adds a fresh code to a WhatsApp CTA's message when it is clicked, and sends the code with the click", () => {
    const { link, cta } = clickCta("https://wa.me/60123456789", "Hi, I would like to ask about Braces");
    const text = new URL(link.href).searchParams.get("text")!;
    assert.match(text, /^Hi, I would like to ask about Braces \(ref [A-HJ-NP-Z2-9]{5}\)$/);
    assert.equal(cta.w, text.slice(-6, -1));
    // A link with its own message keeps it; a second click replaces the code rather than adding one.
    const own = clickCta("https://wa.me/60123456789?text=Quote%20please%20(ref%20AAAAA)", "Hi");
    assert.match(new URL(own.link.href).searchParams.get("text")!, /^Quote please \(ref [A-HJ-NP-Z2-9]{5}\)$/);
  });

  it("leaves other links alone and sends no code", () => {
    const { link, cta } = clickCta("tel:+60123456789", "Hi");
    assert.equal(link.href, "tel:+60123456789");
    assert.equal(cta.w, null);
    assert.equal(clickCta("https://chat.whatsapp.com/invite123", "Hi").cta.w, null, "a group invite can't carry a message");
  });
});
