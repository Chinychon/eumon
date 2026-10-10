import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAnswer } from "./ai-answers.js";

const base = { sources: [], brandNames: ["Bright Smile"], site: "brightsmile.example", competitors: ["rival-dental.example", "other.example"] };

describe("readAnswer", () => {
  it("finds the brand by name, by domain, and by the domain's label", () => {
    assert.equal(readAnswer({ ...base, text: "Try Bright Smile in KL." }).mentioned, true);
    assert.equal(readAnswer({ ...base, text: "See brightsmile.example for prices." }).mentioned, true);
    assert.equal(readAnswer({ ...base, text: "BrightSmile has good reviews." }).mentioned, true, "the domain label, case-insensitive");
    assert.equal(readAnswer({ ...base, text: "Nobody here." }).mentioned, false);
  });

  it("whole words only", () => {
    assert.equal(readAnswer({ ...base, brandNames: ["Smile"], text: "Smiles everywhere" }).mentioned, false);
    assert.equal(readAnswer({ ...base, brandNames: ["Smile"], text: "Ask Smile, they know." }).mentioned, true);
  });

  it("short names need exact case", () => {
    assert.equal(readAnswer({ ...base, brandNames: ["SMC"], site: "zz.example", text: "the smc protocol" }).mentioned, false);
    assert.equal(readAnswer({ ...base, brandNames: ["SMC"], site: "zz.example", text: "SMC is a clinic" }).mentioned, true);
  });

  it("subdomains cite, look-alikes don't, and the rank counts distinct source domains", () => {
    const sources = [
      { domain: "wiki.example", url: "https://wiki.example/a" }, { domain: "wiki.example", url: "https://wiki.example/b" },
      { domain: "notbrightsmile.example", url: "https://notbrightsmile.example" }, { domain: "blog.brightsmile.example", url: "https://blog.brightsmile.example/x" },
    ];
    const read = readAnswer({ ...base, text: "…", sources });
    assert.equal(read.cited, true);
    assert.equal(read.citedRank, 3);
    assert.equal(readAnswer({ ...base, text: "…", sources: sources.slice(0, 3) }).cited, false);
  });

  it("names the competitors mentioned or cited, and only those", () => {
    const read = readAnswer({ ...base, text: "Rival Dental is popular.", sources: [{ domain: "other.example", url: "https://other.example/p" }] });
    assert.deepEqual(read.rivals, [{ domain: "rival-dental.example", mentioned: true, cited: false }, { domain: "other.example", mentioned: false, cited: true }]);
  });

  it("the excerpt centres on the first mention, else the answer's start, and stays within 600 characters", () => {
    const text = `${"a ".repeat(400)}Bright Smile ${"b ".repeat(400)}`;
    const read = readAnswer({ ...base, text });
    assert.ok(read.excerpt.includes("Bright Smile"));
    assert.ok(read.excerpt.length <= 600);
    assert.equal(readAnswer({ ...base, text: "x".repeat(900) }).excerpt, "x".repeat(600));
  });
});
