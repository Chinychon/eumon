import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockedAiSearchAgents, editAiRobots } from "./ai-robots.js";
import { buildLlmsTxt, editLlmsTxt, LLMS_MARKER } from "./llms-txt.js";

describe("llms.txt", () => {
  const content = buildLlmsTxt({ siteName: "MedBay", summary: "Medical travel to Malaysia.", pages: [
    { url: "https://x.com/procedures/a", title: "A", description: "About A", section: "Procedures" },
    { url: "https://x.com/doctors/b", title: "Dr B", section: "Doctors" },
  ] });

  it("writes the site, a summary, the marker, and pages grouped by section", () => {
    assert.match(content, /^# MedBay\n\n> Medical travel to Malaysia\.\n\n<!-- maintained by Eumon -->\n/);
    assert.match(content, /## Procedures\n- \[A\]\(https:\/\/x\.com\/procedures\/a\): About A/);
    assert.match(content, /## Doctors\n- \[Dr B\]\(https:\/\/x\.com\/doctors\/b\)\n/);
  });

  it("creates or refreshes its own file, never a hand-written one", () => {
    assert.equal(editLlmsTxt(null, content).ok, true);
    assert.equal(editLlmsTxt(`# Old\n${LLMS_MARKER}\n`, content).ok, true);
    assert.equal(editLlmsTxt(content, content).ok, false, "already up to date");
    assert.equal(editLlmsTxt("# Written by hand\n", content).ok, false);
  });
});

describe("AI search robots rules", () => {
  const robots = "User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n";

  it("finds blocked AI search agents, ignoring training bots", () => {
    assert.deepEqual(blockedAiSearchAgents(robots), ["OAI-SearchBot"]);
  });

  it("turns only that group's Disallow: / into Allow: /", () => {
    const result = editAiRobots(robots, ["OAI-SearchBot"]);
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.files["public/robots.txt"], "User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n");
  });

  it("skips a group shared with other agents", () => {
    assert.equal(editAiRobots("User-agent: OAI-SearchBot\nUser-agent: GPTBot\nDisallow: /\n", ["OAI-SearchBot"]).ok, false);
  });
});
