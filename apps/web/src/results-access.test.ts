import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signalKeys } from "./results-access.ts";

describe("signalKeys", () => {
  it("reads the keyed signals from the environment, treating blank secrets as absent", () => {
    assert.deepEqual(signalKeys({ GOOGLE_API_KEY: "g", OPEN_PAGERANK_KEY: "", DATAFORSEO_LOGIN: "me", DATAFORSEO_PASSWORD: "pw" }), { googleApiKey: "g", openPageRankKey: undefined, dataForSeo: { login: "me", password: "pw" } });
    assert.equal(signalKeys({ DATAFORSEO_LOGIN: "me" }).dataForSeo, undefined, "a login without a password is no credential");
  });
});
