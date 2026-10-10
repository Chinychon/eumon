import type { EditResult } from "../types.js";

/** AI *search* crawlers only. Training crawlers (GPTBot, Google-Extended…) are never touched. */
export const AI_SEARCH_AGENTS = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"];

type Group = { agents: string[]; rules: Array<{ index: number; field: string; value: string }> };

function groups(lines: string[]): Group[] {
  const out: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) return;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; out.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      current?.rules.push({ index, field, value });
      lastWasAgent = false;
    }
  });
  return out;
}

export function blockedAiSearchAgents(robots: string): string[] {
  const all = groups(robots.split("\n"));
  return AI_SEARCH_AGENTS.filter((agent) => all.some((g) => g.agents.includes(agent.toLowerCase())
    && g.rules.some((r) => r.field === "disallow" && r.value === "/")
    && !g.rules.some((r) => r.field === "allow" && r.value === "/")));
}

export function editAiRobots(robots: string, requested: string[]): EditResult {
  const allowed = AI_SEARCH_AGENTS.map((a) => a.toLowerCase());
  const agents = requested.filter((a) => allowed.includes(a.toLowerCase()));
  if (!agents.length) return { ok: false, reason: "only AI search crawlers can be changed", snippet: "" };
  const lines = robots.split("\n");
  const all = groups(lines);
  const change = new Set<number>();
  for (const agent of agents) {
    const group = all.find((g) => g.agents.includes(agent.toLowerCase()));
    if (!group) continue;
    if (group.agents.length > 1) return { ok: false, reason: `${agent} shares a robots.txt group with other crawlers`, snippet: `User-agent: ${agent}\nAllow: /` };
    for (const rule of group.rules) if (rule.field === "disallow" && rule.value === "/") change.add(rule.index);
  }
  if (!change.size) return { ok: false, reason: "nothing in robots.txt blocks AI search", snippet: "" };
  const next = lines.map((line, i) => (change.has(i) ? line.replace(/disallow\s*:\s*\//i, "Allow: /") : line)).join("\n");
  return { ok: true, edits: [], allowedRanges: [], roots: [], files: { "public/robots.txt": next }, summary: `Lets ${agents.join(", ")} read the site, so AI search can cite it.` };
}
