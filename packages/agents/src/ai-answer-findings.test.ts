import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiAnswerCheck, Opportunity } from "@organic-growth/core";
import { setAiPrompts, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { aiAnswerOpportunities, findingsFromAiAnswers, loadAiAnswerSignals, type AiAnswerSignals } from "./ai-answer-findings.js";

const today = "2026-10-10";
const day = (back: number) => new Date(Date.UTC(2026, 9, 10 - back)).toISOString().slice(0, 10);
/** One answer, `back` days ago; each of `rivals` is named and cited with a page of its own, each of `namedOnly` only named. */
const check = (prompt: string, engine: AiAnswerCheck["engine"], back: number, options: { mentioned?: boolean; cited?: boolean; rivals?: string[]; namedOnly?: string[]; market?: string } = {}): AiAnswerCheck => ({
  prompt, market: options.market ?? "mys", engine, day: day(back), answered: true, mentioned: options.mentioned ?? false, cited: options.cited ?? false, citedRank: options.cited ? 1 : null,
  sources: [
    ...(options.cited ? [{ domain: "x.com", url: "https://x.com/p" }] : []),
    ...(options.rivals ?? []).map((domain) => ({ domain, url: `https://${domain}/${prompt.replace(/\W+/g, "-")}` })),
    { domain: "wiki.example", url: "https://wiki.example/a" },
  ],
  rivals: [...(options.rivals ?? []).map((domain) => ({ domain, mentioned: true, cited: true })), ...(options.namedOnly ?? []).map((domain) => ({ domain, mentioned: true, cited: false }))],
  excerpt: "…",
});
const signals = (checks: AiAnswerCheck[], prompts = [...new Set(checks.map((row) => row.prompt))]): AiAnswerSignals => ({ prompts, markets: ["mys"], competitors: ["rival.example", "www.other.example"], checks, today });
const findings = (checks: AiAnswerCheck[], prompts?: string[]) => findingsFromAiAnswers({ siteId: "s", analysisId: "a", signals: signals(checks, prompts) });
/** Rivals instead of the site in ChatGPT and Gemini. */
const instead = (prompt: string) => [check(prompt, "chatgpt", 0, { rivals: ["rival.example"] }), check(prompt, "gemini", 0, { rivals: ["other.example"] })];

describe("findingsFromAiAnswers: competitors instead of you", () => {
  it("fires at three questions where two engines name a competitor and not the site, and not at two", () => {
    const three = findings([...instead("q1"), ...instead("q2"), ...instead("q3"), check("q4", "chatgpt", 0, { cited: true })]);
    assert.equal(three.length, 1);
    assert.equal(three[0]!.title, "AI assistants name competitors but not you for 3 of 4 questions");
    assert.equal(three[0]!.category, "ai_visibility");
    assert.equal(three[0]!.organicImpactScore, 45);
    assert.match(three[0]!.summary, /“q1” in Malaysia/);
    assert.match(three[0]!.summary, /rival\.example/);
    assert.equal((three[0]!.evidence.questions as unknown[]).length, 3);
    assert.equal(three[0]!.evidence.total, 4);
    assert.equal(findings([...instead("q1"), ...instead("q2")]).length, 0);
  });

  it("an engine where the site is mentioned doesn't count", () => {
    const mixed = [check("q3", "chatgpt", 0, { rivals: ["rival.example"] }), check("q3", "gemini", 0, { mentioned: true, rivals: ["rival.example"] })];
    assert.equal(findings([...instead("q1"), ...instead("q2"), ...mixed]).length, 0);
  });

  it("a competitor only named counts; a domain no longer among the competitors doesn't", () => {
    const named = (prompt: string) => [check(prompt, "chatgpt", 0, { namedOnly: ["rival.example"] }), check(prompt, "gemini", 0, { namedOnly: ["other.example"] })];
    assert.equal(findings([...instead("q1"), ...instead("q2"), ...named("q3")]).length, 1);
    const dropped = [check("q3", "chatgpt", 0, { rivals: ["former.example"] }), check("q3", "gemini", 0, { rivals: ["former.example"] })];
    assert.equal(findings([...instead("q1"), ...instead("q2"), ...dropped]).length, 0);
  });

  it("no finding for a removed question or an untargeted market", () => {
    const checks = [...instead("q1"), ...instead("q2"), ...instead("q3")];
    assert.equal(findings(checks, ["q1", "q2"]).length, 0);
    assert.equal(findings([...instead("q1"), ...instead("q2"), ...instead("q3").map((row) => ({ ...row, market: "sgp" }))]).length, 0);
  });
});

describe("findingsFromAiAnswers: lost citations", () => {
  const lost = (prompt: string, engine: AiAnswerCheck["engine"] = "chatgpt") => [check(prompt, engine, 14, { cited: true }), check(prompt, engine, 7, { rivals: ["rival.example"] }), check(prompt, engine, 0, { rivals: ["rival.example"] })];
  const lostFindings = (checks: AiAnswerCheck[]) => findings(checks).filter((finding) => /stopped citing/.test(finding.title));

  it("cited 14 days ago and not since: lost since the first check after; two in ChatGPT give one ChatGPT finding, one in Gemini none", () => {
    const made = lostFindings([...lost("q1"), ...lost("q2"), ...lost("q3", "gemini")]);
    assert.equal(made.length, 1);
    assert.equal(made[0]!.title, `ChatGPT stopped citing you for 2 questions since ${day(7)}`);
    assert.equal(made[0]!.category, "ai_visibility");
    assert.equal(made[0]!.organicImpactScore, 50);
    assert.match(made[0]!.summary, /“q1”/);
    assert.match(made[0]!.summary, /rival\.example/, "who it cites now");
  });

  it("cited again today: not lost", () => {
    const back = [check("q2", "chatgpt", 14, { cited: true }), check("q2", "chatgpt", 7), check("q2", "chatgpt", 0, { cited: true })];
    assert.equal(lostFindings([...lost("q1"), ...back]).length, 0);
  });
});

describe("aiAnswerOpportunities", () => {
  const existing = (prompt: string): Opportunity => ({ id: "o", siteId: "s", analysisId: "a", title: `Answer “${prompt}”`, searchDemand: 1, intent: "x", competitorStrength: 0, estimatedDifficulty: 1, businessValue: 1, conversionPotential: 1, technicalEffort: 1, contentEffort: 1, priorityScore: 1, rationale: "" });
  const run = (checks: AiAnswerCheck[], prior: Opportunity[] = []) => aiAnswerOpportunities({ siteId: "s", analysisId: "a", signals: signals(checks), existing: prior });

  it("ranks by engines missing × 8, × 1.5 when competitors are cited in two engines or more; skips a question already named", () => {
    const checks = [
      ...instead("two"), // 2 missing, 2 rival engines: 24
      check("one", "chatgpt", 0, { rivals: ["rival.example"] }), // 1 missing, 1 rival engine: 8
      check("shared", "chatgpt", 0, { rivals: ["rival.example"] }), check("shared", "gemini", 0, { cited: true, rivals: ["rival.example"] }), // 1 missing, 2 rival engines: 12
      check("none", "chatgpt", 0, { cited: true, rivals: ["rival.example"] }),
    ];
    const made = run(checks);
    assert.deepEqual(made.map((row) => row.priorityScore), [24, 12, 8]);
    assert.equal(made[0]!.title, "Get cited for “two” in AI answers (Malaysia)");
    assert.equal(made[0]!.intent, "ai_answer");
    assert.equal(made[0]!.estimatedDifficulty, 40);
    assert.match(made[0]!.rationale, /https:\/\/rival\.example\/two/);
    assert.deepEqual(run(checks, [existing("two")]).map((row) => row.priorityScore), [12, 8]);
  });

  it("needs a cited competitor still on the list: none for one only named, none for a former competitor", () => {
    assert.deepEqual(run([check("named", "chatgpt", 0, { namedOnly: ["rival.example"] }), check("named", "gemini", 0, { namedOnly: ["rival.example"] })]), []);
    assert.deepEqual(run([check("former", "chatgpt", 0, { rivals: ["former.example"] })]), []);
  });

  it("names the pages cited by the engines that skip the site only", () => {
    const made = run([check("q", "chatgpt", 0, { rivals: ["rival.example"] }), check("q", "gemini", 0, { cited: true, rivals: ["other.example"] })]);
    assert.match(made[0]!.rationale, /https:\/\/rival\.example\/q/);
    assert.doesNotMatch(made[0]!.rationale, /other\.example/);
  });

  it("at most five", () => {
    assert.equal(run(Array.from({ length: 7 }, (_, index) => instead(`q${index}`)).flat()).length, 5);
  });
});

describe("loadAiAnswerSignals", () => {
  it("null with no questions; otherwise the questions, markets and checks", async () => {
    const db = openSqliteD1();
    const at = "2026-10-01T00:00:00.000Z";
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    assert.equal(await loadAiAnswerSignals(db, "s", today), null);
    await setAiPrompts(db, "s", ["q1"]);
    assert.deepEqual(await loadAiAnswerSignals(db, "s", today), { prompts: ["q1"], markets: [], competitors: [], checks: [], today });
  });
});
