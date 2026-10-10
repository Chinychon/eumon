import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aiAnswerPoints, aiAnswersView, readAnswer, type AiAnswerCheck } from "./ai-answers.js";

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

describe("aiAnswerPoints", () => {
  const check = (prompt: string, engine: AiAnswerCheck["engine"], day: string, mentioned: boolean, cited: boolean, rivals: AiAnswerCheck["rivals"] = []): AiAnswerCheck =>
    ({ prompt, market: "mys", engine, day, mentioned, cited, citedRank: cited ? 1 : null, sources: [], rivals, excerpt: "" });
  it("counts the latest answer of each cell from the last 7 days, for current prompts only", () => {
    const checks = [
      check("a", "chatgpt", "2026-10-09", true, true, [{ domain: "r.example", mentioned: true, cited: false }]),
      check("a", "chatgpt", "2026-10-05", false, false),
      check("a", "gemini", "2026-10-08", true, false),
      check("b", "chatgpt", "2026-10-09", false, true),
      check("b", "gemini", "2026-09-30", true, true),
      check("gone", "chatgpt", "2026-10-09", true, true),
    ];
    const points = Object.fromEntries(aiAnswerPoints(checks, ["a", "b"], ["mys"], ["r.example"], "2026-10-10").map((point) => [point.metric, point.value]));
    assert.equal(points.ai_answers_checked, 3);
    assert.equal(points.ai_answers_mentioned, 2);
    assert.equal(points.ai_answers_cited, 2);
    assert.equal(points["ai_answers_checked.chatgpt"], 2);
    assert.equal(points["ai_answers_mentioned.gemini"], 1);
    assert.equal(points["ai_answers_mentioned:r.example"], 1);
    assert.equal(points["ai_answers_cited:r.example"], 0);
  });
});

describe("aiAnswersView", () => {
  const src = (...domains: string[]) => domains.map((domain) => ({ domain, url: `https://${domain}/` }));
  const check = (prompt: string, engine: AiAnswerCheck["engine"], day: string, mentioned: boolean, cited: boolean, sources: AiAnswerCheck["sources"] = [], rivals: AiAnswerCheck["rivals"] = []): AiAnswerCheck =>
    ({ prompt, market: "mys", engine, day, mentioned, cited, citedRank: cited ? 1 : null, sources, rivals, excerpt: `${prompt} ${engine} ${day}` });
  const checks = [
    check("a", "chatgpt", "2026-10-01", false, false, src("wiki.example")),
    check("a", "chatgpt", "2026-10-06", true, false, src("wiki.example")),
    check("a", "chatgpt", "2026-10-08", true, true, src("blog.brightsmile.example", "wiki.example", "wiki.example")),
    check("a", "perplexity", "2026-10-09", true, false, src("wiki.example", "rival.example"), [{ domain: "rival.example", mentioned: false, cited: true }]),
    check("b", "chatgpt", "2026-10-09", false, false, src("wiki.example")),
    check("gone", "chatgpt", "2026-10-09", true, true, src("gone.example"), [{ domain: "rival.example", mentioned: true, cited: true }]),
  ];
  const view = aiAnswersView({
    prompts: ["a", "b"], markets: ["mys"], checks, site: "brightsmile.example", competitors: ["rival.example"],
    today: "2026-10-10", overview: { searches: 4, citesYou: 1 },
  });

  it("rows hold the latest check of each cell, prompts in list order", () => {
    assert.deepEqual(view.rows.map((row) => [row.prompt, row.market, Object.keys(row.cells).sort()]), [["a", "mys", ["chatgpt", "perplexity"]], ["b", "mys", ["chatgpt"]]]);
    assert.equal(view.rows[0]!.cells.chatgpt!.day, "2026-10-08");
    assert.equal(view.checked, 3);
    assert.equal(view.asOf, "2026-10-09");
    assert.equal(view.prompts, 2);
    assert.deepEqual(view.totals, { mentioned: 2, cited: 1 });
    assert.deepEqual(view.overview, { searches: 4, citesYou: 1 });
  });

  it("ignores removed questions", () => {
    assert.ok(!view.rows.some((row) => row.prompt === "gone"));
    assert.ok(!view.topDomains.some((row) => row.domain === "gone.example"));
  });

  it("counts each engine over the latest checks", () => {
    assert.deepEqual(view.engines.map(({ engine, checked, mentioned, cited }) => [engine, checked, mentioned, cited]),
      [["chatgpt", 2, 1, 1], ["gemini", 0, 0, 0], ["ai_mode", 0, 0, 0], ["perplexity", 1, 1, 0]]);
    assert.equal(view.engines[0]!.label, "ChatGPT");
  });

  it("share of voice: answers naming or citing each site, the site first", () => {
    assert.deepEqual(view.shareOfVoice, [
      { domain: "brightsmile.example", site: true, answers: 2, share: 2 / 3 },
      { domain: "rival.example", site: false, answers: 1, share: 1 / 3 },
    ]);
    const none = aiAnswersView({ prompts: [], markets: ["mys"], checks, site: "brightsmile.example", competitors: [], today: "2026-10-10", overview: { searches: 0, citesYou: 0 } });
    assert.equal(none.shareOfVoice[0]!.share, null);
    assert.equal(none.asOf, null);
  });

  it("top domains count distinct answers citing each, with their kind", () => {
    assert.deepEqual(view.topDomains, [
      { domain: "wiki.example", answers: 3, kind: "other" },
      { domain: "blog.brightsmile.example", answers: 1, kind: "site" },
      { domain: "rival.example", answers: 1, kind: "competitor" },
    ]);
  });

  it("weeks: 12 Monday weeks, oldest first, a cell checked twice in a week counted once", () => {
    assert.equal(view.weeks.length, 12);
    assert.equal(view.weeks[0]!.week, "2026-07-20");
    assert.deepEqual(view.weeks[10], { week: "2026-09-28", checked: 1, mentioned: 0, cited: 0 });
    assert.deepEqual(view.weeks[11], { week: "2026-10-05", checked: 3, mentioned: 2, cited: 1 });
    assert.deepEqual(view.weeks[9], { week: "2026-09-21", checked: 0, mentioned: 0, cited: 0 });
  });
});
