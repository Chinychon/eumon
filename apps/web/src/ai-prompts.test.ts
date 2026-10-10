import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAiPrompts, promptSuggestions } from "./ai-prompts.ts";

describe("parseAiPrompts", () => {
  it("trims, collapses whitespace, keeps case, de-duplicates case-insensitively", () => {
    assert.deepEqual(parseAiPrompts({ prompts: ["  Which clinic   is best? ", "which clinic is best?", "How much are braces in KL?"], brandNames: [" Bright Smile ", "BS"] }),
      { prompts: ["Which clinic is best?", "How much are braces in KL?"], brandNames: ["Bright Smile", "BS"] });
  });
  it("refuses bad shapes, too many, and bad lengths", () => {
    assert.ok("error" in parseAiPrompts({}));
    assert.ok("error" in parseAiPrompts({ prompts: [], brandNames: "x" }));
    assert.ok("error" in parseAiPrompts({ prompts: Array.from({ length: 26 }, (_, index) => `question number ${index}`), brandNames: [] }));
    assert.ok("error" in parseAiPrompts({ prompts: ["four"], brandNames: [] }));
    assert.ok("error" in parseAiPrompts({ prompts: ["x".repeat(201)], brandNames: [] }));
    assert.ok("error" in parseAiPrompts({ prompts: [], brandNames: ["a", "b", "c", "d", "e", "f"] }));
    assert.ok("error" in parseAiPrompts({ prompts: [], brandNames: ["x"] }));
    assert.ok("error" in parseAiPrompts({ prompts: [7], brandNames: [] }));
  });
  it("empty lists clear tracking", () => {
    assert.deepEqual(parseAiPrompts({ prompts: [], brandNames: [] }), { prompts: [], brandNames: [] });
  });
});

describe("promptSuggestions", () => {
  it("offers the site's own question searches, most impressions first, not already listed", () => {
    const queries = [{ query: "braces price", impressions: 900 }, { query: "how much are braces", impressions: 500 }, { query: "berapa harga braces", impressions: 700 }, { query: "what is a root canal", impressions: 100 }];
    assert.deepEqual(promptSuggestions(queries, ["How much are braces"]), ["berapa harga braces", "what is a root canal"]);
  });
});
