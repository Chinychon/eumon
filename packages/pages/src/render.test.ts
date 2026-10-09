import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trackingScript } from "./render.js";

describe("tracking script", () => {
  it("caps utm_source before sending it, so a long tracking value can't push the view beacon over the server's body limit", () => {
    const script = trackingScript("/eumon/beacon", "page_1", undefined, undefined);
    assert.match(script, /utm_source"\)\|\|""\)\.slice\(0,80\)/, "the server reads at most 2 KB and keeps 80 characters of utm_source");
  });
});
