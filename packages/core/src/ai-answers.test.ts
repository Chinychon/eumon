import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readAnswer } from "./ai-answers.js";

const base = { prompt: "best dentist kl", sources: [], brandNames: ["Bright Smile"], site: "brightsmile.example", competitors: ["rival-dental.example", "othersmile.example"] };

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
    const read = readAnswer({ ...base, text: "rival-dental is popular.", sources: [{ domain: "othersmile.example", url: "https://othersmile.example/p" }] });
    assert.deepEqual(read.rivals, [{ domain: "rival-dental.example", mentioned: true, cited: false }, { domain: "othersmile.example", mentioned: false, cited: true }]);
  });

  it("the excerpt centres on the first mention, else the answer's start, and stays within 600 characters", () => {
    const text = `${"a ".repeat(400)}Bright Smile ${"b ".repeat(400)}`;
    const read = readAnswer({ ...base, text });
    assert.ok(read.excerpt.includes("Bright Smile"));
    assert.ok(read.excerpt.length <= 600);
    assert.equal(readAnswer({ ...base, text: "x".repeat(900) }).excerpt, "x".repeat(600));
  });

  it("a rival's label written with a space doesn't count", () => {
    assert.deepEqual(readAnswer({ ...base, text: "Rival Dental is popular." }).rivals, []);
    assert.equal(readAnswer({ ...base, text: "rivaldental is popular." }).rivals.length, 1);
  });

  it("a label made of the question's own words doesn't count", () => {
    assert.equal(readAnswer({ ...base, site: "dentist-kl.example", brandNames: [], text: "Try a dentist-kl near you" }).mentioned, false);
  });

  it("a generic label written with a space doesn't count", () => {
    assert.equal(readAnswer({ ...base, site: "best-clinic.example", brandNames: [], text: "the best clinic in town" }).mentioned, false);
    assert.equal(readAnswer({ ...base, site: "best-clinic.example", brandNames: [], prompt: "dentist", text: "try best-clinic today" }).mentioned, true);
  });

  it("names in scripts without spaces match inside a sentence", () => {
    assert.equal(readAnswer({ ...base, brandNames: ["光明牙科"], text: "推荐在光明牙科看牙。" }).mentioned, true);
    assert.equal(readAnswer({ ...base, brandNames: ["ยิ้มสวย"], text: "แนะนำคลินิกยิ้มสวยครับ" }).mentioned, true);
  });

  it("link targets are not mentions", () => {
    const url = "https://www.brightsmile.example/p?utm_source=chatgpt.com";
    const read = readAnswer({ ...base, text: `Clinics ([source](${url}))`, sources: [{ domain: "brightsmile.example", url }] });
    assert.equal(read.cited, true);
    assert.equal(read.mentioned, false);
    assert.equal(readAnswer({ ...base, text: `see ${url} now` }).mentioned, false);
  });

  it("curly apostrophes match straight ones", () => {
    assert.equal(readAnswer({ ...base, brandNames: ["Joe's Dental"], text: "Try Joe\u2019s Dental." }).mentioned, true);
  });
});
