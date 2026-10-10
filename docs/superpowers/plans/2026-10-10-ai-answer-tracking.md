# AI Answer Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users name up to 25 questions; Eumon asks ChatGPT, Gemini, Google AI Mode and Perplexity each week in every target market, records whether the brand is mentioned and the site cited (and which competitors are), shows it on the AI visibility tab and the client link, and turns gaps into findings and opportunities.

**Architecture:** Three tables (`ai_prompts`, `ai_brand_names`, `ai_answer_checks`). One DataForSEO client function per engine shape (`fetchAiAnswer`). Pure reading and view math in `packages/core/src/ai-answers.ts`. Workflow steps in `apps/web/src/ai-answers.ts` mirroring `rank-tracking.ts` (queue → slices of 20, one market each, fetched ten at a time → counts), run after rank tracking under one shared `dataforseo-limits` gate step. Findings and opportunities in `packages/agents/src/ai-answer-findings.ts` through `ConnectorSignals.aiAnswers`. An `AiAnswersCard` at the top of the AI visibility tab.

**Tech Stack:** TypeScript, Cloudflare Workers + Workflows + D1 (SQLite in tests via `openSqliteD1`), node:test, React, DataForSEO AI Optimization + SERP APIs.

**Spec:** `docs/superpowers/specs/2026-10-10-ai-answer-tracking-design.md`

## Global Constraints

- Branch `claude/ai-answers` is stacked on `claude/rank-tracking` (PR #27); reuse its patterns (`rank-tracking.ts`, `sync-steps.ts` gate step, `core/ranks.ts`).
- Migration number **0026** (`0026_ai_answers.sql`); every new table `REFERENCES sites(id) ON DELETE CASCADE`.
- Engines, in this order: `chatgpt` ("ChatGPT"), `gemini` ("Gemini"), `ai_mode` ("Google AI Mode"), `perplexity` ("Perplexity").
- Limits: at most **25** prompts (5–200 characters after trimming and collapsing whitespace, case kept, de-duplicated case-insensitively) and **5** brand names (2–60 characters) per site.
- A (prompt, market, engine) is due when its last check is **7** or more days old (or it has none); at most **40** checks a site a day, oldest first; a Workflow step checks at most **20**, all one market, fetched **10** at a time; step timeout 10 minutes; ≤ 50 subrequests a step.
- Answers aren't stored: `sources` up to 20, `excerpt` up to 600 characters.
- DataForSEO only where the workspace's `dataForSeo` limit allows (a site without a workspace follows `FREE_LIMITS`, which refuses); the demo site never calls DataForSEO.
- Copy: "users", never "operator"; never name client businesses; hard-cornered UI.
- Commit trailer: `Co-Authored-By: Claude <your model name> <noreply@anthropic.com>`.
- Tests: `npm test -w @organic-growth/<core|db|agents>`; `node --test apps/web/src/<file>.test.ts`; run `npm run build:packages` before web tests after changing a package; `npm run typecheck -w @organic-growth/web`.

## Review Focus

1. An engine DataForSEO doesn't serve in a market (e.g. the ChatGPT scraper refusing a location): that one check is a note, the other engines and markets still run (Task 3 test "a refused engine is a note").
2. An answer that names the brand inside another word ("medbaycareer" for "medbaycare") or a three-letter brand ("SMC") in lower case in unrelated text: not a mention (Task 2 tests "whole words only", "short names need exact case").
3. A source on a subdomain (`blog.example.com`) counts as citing `example.com`; a look-alike domain (`notexample.com`) doesn't (Task 2 test "subdomains cite, look-alikes don't").
4. A manual "Sync now" the same day as the daily run: nothing is fetched again (due only after 7 days) (Task 3 test "checks done this week aren't asked again").
5. A question removed from the list: its old checks are ignored by the card, the counts and the findings (Task 4 test "ignores removed questions"; Task 6 test "no finding for a removed question").

---

### Task 1: Store and helpers

**Files:**
- Create: `packages/db/migrations/0026_ai_answers.sql`, `packages/db/src/ai-answers.ts`, `packages/db/src/ai-answers.test.ts`
- Create: `packages/core/src/ai-answers.ts` (types and constants only in this task; Task 2 adds functions), and export it from `packages/core/src/index.ts` the way `ranks.js` is exported
- Modify: `packages/db/src/index.ts` (`export * from "./ai-answers.js";`)
- Modify: `packages/core/src/countries.ts` (add `countryAlpha2`)

**Interfaces:**
- Produces (core): `AI_ANSWER_ENGINES`, `type AiAnswerEngine`, `AI_PROMPTS_MAX = 25`, `AI_BRAND_NAMES_MAX = 5`, `AI_CHECK_FRESH_DAYS = 7`, `normalizePrompt(text)`, `type AiSource = { domain: string; url: string }`, `type AiRival = { domain: string; mentioned: boolean; cited: boolean }`, `type AiAnswerCheck = { prompt: string; market: string; engine: AiAnswerEngine; day: string; mentioned: boolean; cited: boolean; citedRank: number | null; sources: AiSource[]; rivals: AiRival[]; excerpt: string }`, `countryAlpha2(code): string | null`.
- Produces (db): `setAiPrompts(db, siteId, prompts)`, `listAiPrompts(db, siteId): Promise<string[]>` (creation order), `setAiBrandNames(db, siteId, names)`, `listAiBrandNames(db, siteId): Promise<string[]>`, `saveAiAnswerChecks(db, siteId, rows: AiAnswerCheck[])`, `listAiAnswerChecks(db, siteId, fromDay): Promise<AiAnswerCheck[]>` (oldest first), `aiLastChecked(db, siteId): Promise<Map<string, string>>` (key `prompt|market|engine` → latest day), `pruneAiAnswerChecks(db, siteId, beforeDay)`.

- [ ] **Step 1: Migration** `packages/db/migrations/0026_ai_answers.sql`

```sql
-- AI answer tracking: the questions users ask AI assistants about their market, the names the brand goes by, and
-- one row per question, market, engine and day: whether the answer mentioned the brand and cited the site, the
-- sources it cited (up to 20), the competitors it named, and an excerpt. Rows older than 400 days are pruned.
CREATE TABLE ai_prompts (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (site_id, prompt)
);

CREATE TABLE ai_brand_names (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  PRIMARY KEY (site_id, name)
);

CREATE TABLE ai_answer_checks (
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  market TEXT NOT NULL,
  engine TEXT NOT NULL,
  day TEXT NOT NULL,
  mentioned INTEGER NOT NULL,
  cited INTEGER NOT NULL,
  cited_rank INTEGER,
  sources_json TEXT NOT NULL DEFAULT '[]',
  rivals_json TEXT NOT NULL DEFAULT '[]',
  excerpt TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (site_id, prompt, market, engine, day)
);
CREATE INDEX ai_answer_checks_site_day ON ai_answer_checks (site_id, day);
```

- [ ] **Step 2: Core types** `packages/core/src/ai-answers.ts`

```ts
/*
 * AI answer tracking, pure: the questions users ask AI assistants, and what an
 * assistant's answer says about the site — whether it names the brand
 * ("mentioned"), links the site among its sources ("cited"), and which
 * competitors it names or cites instead.
 */

export const AI_ANSWER_ENGINES = [
  { engine: "chatgpt", label: "ChatGPT" },
  { engine: "gemini", label: "Gemini" },
  { engine: "ai_mode", label: "Google AI Mode" },
  { engine: "perplexity", label: "Perplexity" },
] as const;
export type AiAnswerEngine = (typeof AI_ANSWER_ENGINES)[number]["engine"];

export const AI_PROMPTS_MAX = 25;
export const AI_BRAND_NAMES_MAX = 5;
/** A question is asked again in a market and engine once its last answer is this many days old. */
export const AI_CHECK_FRESH_DAYS = 7;

export const normalizePrompt = (text: string) => text.trim().replace(/\s+/g, " ");

export type AiSource = { domain: string; url: string };
export type AiRival = { domain: string; mentioned: boolean; cited: boolean };
export type AiAnswerCheck = {
  prompt: string; market: string; engine: AiAnswerEngine; day: string;
  mentioned: boolean; cited: boolean;
  /** The site's place among the answer's distinct source domains (1 = first), or null when not cited. */
  citedRank: number | null;
  sources: AiSource[]; rivals: AiRival[]; excerpt: string;
};
```

In `packages/core/src/countries.ts` add:

```ts
/** ISO 3166-1 alpha-2 for a market (alpha-3), for APIs that take two letters (Perplexity's web search country). */
const ALPHA2: Record<string, string> = {
  idn: "ID", mys: "MY", sgp: "SG", tha: "TH", vnm: "VN", phl: "PH", brn: "BN", khm: "KH", mmr: "MM", lao: "LA", chn: "CN", hkg: "HK", twn: "TW", jpn: "JP", kor: "KR",
  ind: "IN", pak: "PK", bgd: "BD", lka: "LK", npl: "NP", aus: "AU", nzl: "NZ", usa: "US", can: "CA", mex: "MX", bra: "BR", arg: "AR", col: "CO", chl: "CL", gbr: "GB",
  irl: "IE", deu: "DE", fra: "FR", esp: "ES", ita: "IT", nld: "NL", bel: "BE", che: "CH", aut: "AT", swe: "SE", nor: "NO", dnk: "DK", fin: "FI", pol: "PL", prt: "PT",
  tur: "TR", rus: "RU", ukr: "UA", are: "AE", sau: "SA", qat: "QA", kwt: "KW", omn: "OM", egy: "EG", nga: "NG", ken: "KE", zaf: "ZA", isr: "IL",
};
export const countryAlpha2 = (code: string): string | null => ALPHA2[code.toLowerCase()] ?? null;
```

- [ ] **Step 3: Failing db test** `packages/db/src/ai-answers.test.ts`

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AiAnswerCheck } from "@organic-growth/core";
import { openSqliteD1 } from "./sqlite.js";
import { upsertSite } from "./index.js";
import { aiLastChecked, listAiAnswerChecks, listAiBrandNames, listAiPrompts, pruneAiAnswerChecks, saveAiAnswerChecks, setAiBrandNames, setAiPrompts } from "./ai-answers.js";

const at = "2026-10-07T04:15:00.000Z";
async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
  return db;
}
const check = (prompt: string, day: string, engine: AiAnswerCheck["engine"] = "chatgpt", cited = false): AiAnswerCheck => ({
  prompt, market: "mys", engine, day, mentioned: cited, cited, citedRank: cited ? 2 : null,
  sources: cited ? [{ domain: "other.example", url: "https://other.example/a" }, { domain: "x.com", url: "https://x.com/p" }] : [],
  rivals: [{ domain: "rival.example", mentioned: true, cited: false }], excerpt: "…",
});

describe("AI answer store", () => {
  it("replaces prompts and brand names, keeping the order prompts were given", async () => {
    const db = await site();
    await setAiPrompts(db, "s", ["Which clinic is best?", "How much are braces?"]);
    await setAiPrompts(db, "s", ["How much are braces?", "Who does implants?"]);
    assert.deepEqual(await listAiPrompts(db, "s"), ["How much are braces?", "Who does implants?"]);
    await setAiBrandNames(db, "s", ["X Clinic", "XC"]);
    assert.deepEqual(await listAiBrandNames(db, "s"), ["X Clinic", "XC"]);
  });

  it("upserts checks, lists them with every field, and knows each cell's latest day", async () => {
    const db = await site();
    await saveAiAnswerChecks(db, "s", [check("q", "2026-09-30"), check("q", "2026-10-07", "chatgpt", true), check("q", "2026-10-07", "gemini")]);
    await saveAiAnswerChecks(db, "s", [check("q", "2026-10-07", "chatgpt", true)]);
    const rows = await listAiAnswerChecks(db, "s", "2026-10-01");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((row) => row.engine === "chatgpt"), check("q", "2026-10-07", "chatgpt", true));
    assert.deepEqual(await aiLastChecked(db, "s"), new Map([["q|mys|chatgpt", "2026-10-07"], ["q|mys|gemini", "2026-10-07"]]));
  });

  it("prunes before a day, and deleting the site removes everything", async () => {
    const db = await site();
    await setAiPrompts(db, "s", ["q"]);
    await setAiBrandNames(db, "s", ["X"]);
    await saveAiAnswerChecks(db, "s", [check("q", "2025-01-01"), check("q", "2026-10-07")]);
    await pruneAiAnswerChecks(db, "s", "2026-01-01");
    assert.equal((await listAiAnswerChecks(db, "s", "2000-01-01")).length, 1);
    await db.prepare("DELETE FROM sites WHERE id = ?").bind("s").run();
    for (const table of ["ai_prompts", "ai_brand_names", "ai_answer_checks"]) {
      assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n, 0, table);
    }
  });
});
```

Run: `npm run build -w @organic-growth/core && npm test -w @organic-growth/db` — expected: compile error, `./ai-answers.js` not found.

- [ ] **Step 4: `packages/db/src/ai-answers.ts`**

```ts
import type { AiAnswerCheck, AiAnswerEngine } from "@organic-growth/core";
import { chunks, nowIso, runStatements, type D1Like } from "./d1.js";

/*
 * AI answer tracking: the questions (`ai_prompts`), the names the brand goes
 * by (`ai_brand_names`), and one row per question, market, engine and day
 * (`ai_answer_checks`). Answers aren't kept, only what was read from them.
 */

/** Replaces the list; `created_at` is spaced a millisecond apart so the given order is the listed order. */
export async function setAiPrompts(db: D1Like, siteId: string, prompts: string[]): Promise<void> {
  const base = Date.now();
  await runStatements(db, [
    db.prepare("DELETE FROM ai_prompts WHERE site_id = ?").bind(siteId),
    ...prompts.map((prompt, index) => db.prepare("INSERT INTO ai_prompts (site_id, prompt, created_at) VALUES (?, ?, ?)").bind(siteId, prompt, new Date(base + index).toISOString())),
  ]);
}

export async function listAiPrompts(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT prompt FROM ai_prompts WHERE site_id = ? ORDER BY created_at, prompt").bind(siteId).all<{ prompt: string }>();
  return results.map((row) => row.prompt);
}

export async function setAiBrandNames(db: D1Like, siteId: string, names: string[]): Promise<void> {
  await runStatements(db, [
    db.prepare("DELETE FROM ai_brand_names WHERE site_id = ?").bind(siteId),
    ...names.map((name) => db.prepare("INSERT INTO ai_brand_names (site_id, name) VALUES (?, ?)").bind(siteId, name)),
  ]);
}

export async function listAiBrandNames(db: D1Like, siteId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT name FROM ai_brand_names WHERE site_id = ? ORDER BY rowid").bind(siteId).all<{ name: string }>();
  return results.map((row) => row.name);
}

export async function saveAiAnswerChecks(db: D1Like, siteId: string, rows: AiAnswerCheck[]): Promise<void> {
  const statements = rows.map((row) => db.prepare(
    `INSERT INTO ai_answer_checks (site_id, prompt, market, engine, day, mentioned, cited, cited_rank, sources_json, rivals_json, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, prompt, market, engine, day) DO UPDATE SET mentioned = excluded.mentioned, cited = excluded.cited, cited_rank = excluded.cited_rank,
       sources_json = excluded.sources_json, rivals_json = excluded.rivals_json, excerpt = excluded.excerpt`,
  ).bind(siteId, row.prompt, row.market, row.engine, row.day, row.mentioned ? 1 : 0, row.cited ? 1 : 0, row.citedRank, JSON.stringify(row.sources), JSON.stringify(row.rivals), row.excerpt));
  for (const group of chunks(statements, 100)) await runStatements(db, group);
}

type CheckRow = { prompt: string; market: string; engine: string; day: string; mentioned: number; cited: number; cited_rank: number | null; sources_json: string; rivals_json: string; excerpt: string };

export async function listAiAnswerChecks(db: D1Like, siteId: string, fromDay: string): Promise<AiAnswerCheck[]> {
  const { results } = await db.prepare(
    "SELECT prompt, market, engine, day, mentioned, cited, cited_rank, sources_json, rivals_json, excerpt FROM ai_answer_checks WHERE site_id = ? AND day >= ? ORDER BY day, prompt, market, engine",
  ).bind(siteId, fromDay).all<CheckRow>();
  return results.map((row) => ({
    prompt: row.prompt, market: row.market, engine: row.engine as AiAnswerEngine, day: row.day,
    mentioned: Boolean(row.mentioned), cited: Boolean(row.cited), citedRank: row.cited_rank === null ? null : Number(row.cited_rank),
    sources: JSON.parse(row.sources_json), rivals: JSON.parse(row.rivals_json), excerpt: row.excerpt,
  }));
}

/** Each (prompt, market, engine)'s latest checked day, in one query, for deciding what is due. */
export async function aiLastChecked(db: D1Like, siteId: string): Promise<Map<string, string>> {
  const { results } = await db.prepare("SELECT prompt, market, engine, MAX(day) AS day FROM ai_answer_checks WHERE site_id = ? GROUP BY prompt, market, engine")
    .bind(siteId).all<{ prompt: string; market: string; engine: string; day: string }>();
  return new Map(results.map((row) => [`${row.prompt}|${row.market}|${row.engine}`, row.day]));
}

export async function pruneAiAnswerChecks(db: D1Like, siteId: string, beforeDay: string): Promise<void> {
  await db.prepare("DELETE FROM ai_answer_checks WHERE site_id = ? AND day < ?").bind(siteId, beforeDay).run();
}
```

(`nowIso` is unused — drop it from the import if the linter complains.)

- [ ] **Step 5: Run** `npm run build -w @organic-growth/core && npm test -w @organic-growth/core && npm test -w @organic-growth/db` — PASS.

- [ ] **Step 6: Commit** `git add packages/db packages/core && git commit -m "AI answers: prompts, brand names and answer checks tables with their helpers"` (with the trailer).

---

### Task 2: Reading an answer, and the engine clients

**Files:**
- Modify: `packages/core/src/ai-answers.ts` (add `readAnswer`), create `packages/core/src/ai-answers.test.ts`
- Modify: `packages/agents/src/dataforseo.ts` (add `fetchAiAnswer` and three result readers), `packages/agents/src/dataforseo.test.ts`

**Interfaces:**
- Consumes: `bareDomain` (`./serp.js` in core).
- Produces: `readAnswer(input: { text: string; sources: AiSource[]; brandNames: string[]; site: string; competitors: string[] }): { mentioned: boolean; cited: boolean; citedRank: number | null; rivals: AiRival[]; excerpt: string }`; `fetchAiAnswer(auth, input: { engine: AiAnswerEngine; prompt: string; location: number; language: string; countryIso2: string | null }, fetchFn?): Promise<{ text: string; sources: AiSource[]; cost: number }>`.

- [ ] **Step 1: Failing core tests** `packages/core/src/ai-answers.test.ts`

```ts
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
```

Run `npm test -w @organic-growth/core` — FAIL (no `readAnswer`).

- [ ] **Step 2: `readAnswer`** (append to `packages/core/src/ai-answers.ts`; add `import { bareDomain } from "./serp.js";` at the top)

```ts
const isOrUnder = (domain: string, root: string) => domain === root || domain.endsWith(`.${root}`);
/** "brightsmile.example" → "brightsmile"; "rival-dental.example" → "rival-dental". */
const domainLabel = (domain: string) => bareDomain(domain).split(".")[0] ?? domain;
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A whole-word pattern for a name; a hyphen or space in it matches either, or nothing; names of three characters or fewer match only in their exact case. */
function namePattern(name: string): RegExp {
  const body = escapeRegExp(name.trim()).replace(/(\\-|\s)+/g, "[\\s-]?");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}($|[^\\p{L}\\p{N}])`, name.trim().length <= 3 ? "u" : "iu");
}

function firstMention(text: string, names: string[]): number {
  let first = -1;
  for (const name of names) {
    const match = namePattern(name).exec(text);
    if (match) {
      const at = match.index + match[1]!.length;
      if (first < 0 || at < first) first = at;
    }
  }
  return first;
}

const EXCERPT = 600;

/** What one answer says about the site: mentioned (a brand name, the domain or its label in the text), cited (a source on the site's domain), and which competitors it names or cites. */
export function readAnswer(input: { text: string; sources: AiSource[]; brandNames: string[]; site: string; competitors: string[] }) {
  const site = bareDomain(input.site);
  const names = [...new Set([...input.brandNames, site, domainLabel(site)])].filter((name) => name.trim().length >= 2);
  const at = firstMention(input.text, names);
  const domains = [...new Set(input.sources.map((source) => bareDomain(source.domain)))];
  const rank = domains.findIndex((domain) => isOrUnder(domain, site));
  const rivals: AiRival[] = input.competitors.map((competitor) => {
    const domain = bareDomain(competitor);
    return { domain, mentioned: firstMention(input.text, [domain, domainLabel(domain)]) >= 0, cited: domains.some((source) => isOrUnder(source, domain)) };
  }).filter((rival) => rival.mentioned || rival.cited);
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - EXCERPT / 2, input.text.length - EXCERPT));
  return { mentioned: at >= 0, cited: rank >= 0, citedRank: rank >= 0 ? rank + 1 : null, rivals, excerpt: input.text.slice(start, start + EXCERPT) };
}
```

Run `npm test -w @organic-growth/core` — PASS. If "BrightSmile" fails against label "brightsmile", that is the expected case-insensitive label match; check the regex flags.

- [ ] **Step 3: Failing client tests** (append inside `describe("DataForSEO client", …)` in `packages/agents/src/dataforseo.test.ts`; import `fetchAiAnswer`)

```ts
  it("asks each AI engine at its endpoint and reads the answer and its sources", async () => {
    const asked: Array<{ url: string; task: Record<string, unknown> }> = [];
    const results: Record<string, object> = {
      "chat_gpt/llm_scraper": { markdown: "Bright Smile is a good choice.", sources: [{ domain: "www.brightsmile.example", url: "https://www.brightsmile.example/p", title: "t" }, { domain: null, url: "https://wiki.example/a" }] },
      "gemini/llm_scraper": { markdown: null, items: [{ type: "gemini_text", text: "Try Rival." }], sources: [] },
      "google/ai_mode": { items: [{ type: "ai_overview", items: [{ type: "ai_overview_element", markdown: "Clinics: Rival Dental.", references: [{ type: "ai_overview_reference", domain: "rival-dental.example", url: "https://rival-dental.example/x" }] }] }] },
      "perplexity/llm_responses": { items: [{ type: "message", sections: [{ type: "text", text: "Bright Smile [1]", annotations: [{ title: "brightsmile.example", url: "https://brightsmile.example/a" }] }] }] },
    };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      asked.push({ url, task: JSON.parse(String(init?.body))[0] });
      const key = Object.keys(results).find((part) => url.includes(part))!;
      return new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.004, result: [results[key]] }));
    }) as typeof fetch;
    const input = { prompt: "best dentist kl", location: 2458, language: "en", countryIso2: "MY" };
    const chatgpt = await fetchAiAnswer(auth, { ...input, engine: "chatgpt" }, fetchFn);
    assert.deepEqual(chatgpt, { text: "Bright Smile is a good choice.", sources: [{ domain: "brightsmile.example", url: "https://www.brightsmile.example/p" }, { domain: "wiki.example", url: "https://wiki.example/a" }], cost: 0.004 });
    assert.equal((await fetchAiAnswer(auth, { ...input, engine: "gemini" }, fetchFn)).text, "Try Rival.");
    assert.deepEqual((await fetchAiAnswer(auth, { ...input, engine: "ai_mode" }, fetchFn)).sources, [{ domain: "rival-dental.example", url: "https://rival-dental.example/x" }]);
    const perplexity = await fetchAiAnswer(auth, { ...input, engine: "perplexity" }, fetchFn);
    assert.deepEqual(perplexity.sources, [{ domain: "brightsmile.example", url: "https://brightsmile.example/a" }]);
    assert.deepEqual(asked.map((call) => call.url), [
      "https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced",
      "https://api.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/live/advanced",
      "https://api.dataforseo.com/v3/serp/google/ai_mode/live/advanced",
      "https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live",
    ]);
    assert.deepEqual(asked[0]!.task, { keyword: "best dentist kl", location_code: 2458, language_code: "en", force_web_search: true });
    assert.deepEqual(asked[3]!.task, { user_prompt: "best dentist kl", model_name: "sonar", max_output_tokens: 1024, web_search_country_iso_code: "MY" });
  });

  it("an answer with nothing in it is an empty answer, not an error; a refused task throws", async () => {
    const empty = (async () => new Response(envelope({ status_code: 20000, status_message: "Ok.", cost: 0.004, result: null }))) as unknown as typeof fetch;
    assert.deepEqual(await fetchAiAnswer(auth, { engine: "chatgpt", prompt: "q", location: 2458, language: "en", countryIso2: null }, empty), { text: "", sources: [], cost: 0.004 });
    const refused = (async () => new Response(envelope({ status_code: 40501, status_message: "Invalid Field: 'location_code'.", cost: 0, result: null }))) as unknown as typeof fetch;
    await assert.rejects(fetchAiAnswer(auth, { engine: "gemini", prompt: "q", location: 2458, language: "en", countryIso2: null }, refused), /location_code/);
  });
```

Run `npm test -w @organic-growth/agents` — FAIL.

- [ ] **Step 4: `fetchAiAnswer`** (append to `packages/agents/src/dataforseo.ts`; import `type AiAnswerEngine, type AiSource` from core)

```ts
type ScraperResult = { markdown?: string | null; items?: Array<{ text?: string | null; markdown?: string | null }> | null; sources?: Array<{ domain?: string | null; url?: string | null }> | null };
type AiNode = { text?: string | null; markdown?: string | null; references?: Array<{ domain?: string | null; url?: string | null }> | null; items?: AiNode[] | null };
type ResponsesResult = { items?: Array<{ sections?: Array<{ text?: string | null; annotations?: Array<{ url?: string | null }> | null }> | null }> | null };

/** A source as Eumon keeps it: its bare domain (from the URL when DataForSEO gives none) and URL; sources with neither are dropped. */
function source(entry: { domain?: string | null; url?: string | null }): AiSource[] {
  const url = entry.url ?? "";
  let domain = entry.domain ?? "";
  if (!domain && url) { try { domain = new URL(url).hostname; } catch { return []; } }
  return domain ? [{ domain: bareDomain(domain), url }] : [];
}

/** ChatGPT and Gemini as people see them (DataForSEO's LLM Scraper). */
function scraperAnswer(result: ScraperResult | undefined) {
  const text = result?.markdown ?? (result?.items ?? []).map((item) => item.markdown ?? item.text ?? "").filter(Boolean).join("\n");
  return { text, sources: (result?.sources ?? []).flatMap(source) };
}

/** Google's AI Mode: every AI Overview element's text and references, however deeply nested. */
function aiModeAnswer(result: { items?: AiNode[] | null } | undefined) {
  const texts: string[] = [];
  const sources: AiSource[] = [];
  const walk = (node: AiNode) => {
    const text = node.markdown ?? node.text;
    if (text) texts.push(text);
    for (const reference of node.references ?? []) sources.push(...source(reference));
    for (const child of node.items ?? []) walk(child);
  };
  for (const item of result?.items ?? []) walk(item);
  return { text: texts.join("\n"), sources };
}

/** Perplexity's answer through its API (Sonar searches the web), with the URLs it annotates. */
function responsesAnswer(result: ResponsesResult | undefined) {
  const sections = (result?.items ?? []).flatMap((item) => item.sections ?? []);
  return { text: sections.map((section) => section.text ?? "").filter(Boolean).join("\n"), sources: sections.flatMap((section) => section.annotations ?? []).flatMap(source) };
}

/** One question asked of one AI engine in a market: the answer's text and the sources it cites, and what the ask cost. */
export async function fetchAiAnswer(auth: DataForSeoAuth, input: { engine: AiAnswerEngine; prompt: string; location: number; language: string; countryIso2: string | null }, fetchFn: typeof fetch = fetch): Promise<{ text: string; sources: AiSource[]; cost: number }> {
  switch (input.engine) {
    case "chatgpt": {
      const { result, cost } = await post<ScraperResult>(auth, "ai_optimization/chat_gpt/llm_scraper/live/advanced", { keyword: input.prompt, location_code: input.location, language_code: input.language, force_web_search: true }, fetchFn);
      return { ...scraperAnswer(result), cost };
    }
    case "gemini": {
      const { result, cost } = await post<ScraperResult>(auth, "ai_optimization/gemini/llm_scraper/live/advanced", { keyword: input.prompt, location_code: input.location, language_code: input.language }, fetchFn);
      return { ...scraperAnswer(result), cost };
    }
    case "ai_mode": {
      const { result, cost } = await post<{ items?: AiNode[] | null }>(auth, "serp/google/ai_mode/live/advanced", { keyword: input.prompt, location_code: input.location, language_code: input.language }, fetchFn);
      return { ...aiModeAnswer(result), cost };
    }
    case "perplexity": {
      const { result, cost } = await post<ResponsesResult>(auth, "ai_optimization/perplexity/llm_responses", {
        user_prompt: input.prompt, model_name: "sonar", max_output_tokens: 1024, ...(input.countryIso2 ? { web_search_country_iso_code: input.countryIso2 } : {}),
      }, fetchFn);
      return { ...responsesAnswer(result), cost };
    }
  }
}
```

`post` already turns a non-20000 task into a thrown `DataForSeoError` and appends `/live` only when the path lacks it.

- [ ] **Step 5: Run** `npm run build -w @organic-growth/core && npm test -w @organic-growth/core && npm test -w @organic-growth/agents` — PASS.
- [ ] **Step 6: Commit** `"AI answers: read what an answer says about the site; ask ChatGPT, Gemini, AI Mode and Perplexity through DataForSEO"`.

---

### Task 3: The weekly steps

**Files:**
- Create: `apps/web/src/ai-answers.ts`, `apps/web/src/ai-answers.test.ts`
- Modify: `apps/web/src/source-helpers.ts` (add `sliceByMarket`), `apps/web/src/rank-tracking.ts` (`slices` uses it), `apps/web/src/sync-steps.ts` (gate step rename, call `trackAiAnswers`), `apps/web/src/sync-steps.test.ts`

**Interfaces:**
- Consumes: Task 1 db + core, Task 2 `fetchAiAnswer`, `readAnswer`; `marketLocation`, `dollars`, `said`; `countryAlpha2`; `listSiteCompetitorDomains`; `authorityDomain`; `DEMO_SITE_ID`.
- Produces: `sliceByMarket<T extends { market: string }>(targets: T[], size: number): T[][]`; `AI_STEP = 20`, `AI_CHECKS_PER_DAY = 40`; `type AiTarget = { prompt: string; market: string; engine: AiAnswerEngine }`; `aiQueue(db, site, today)`, `checkAiAnswers(db, site, auth, today, targets, fetchFn?)`, `writeAiCounts(db, site, today)`, `trackAiAnswers(db, safe, site, auth, today, fetchFn?)`; core `aiAnswerPoints(checks, prompts, markets, competitors, day)`.

- [ ] **Step 1: `sliceByMarket`** in `source-helpers.ts`, and `rank-tracking.ts`'s `slices` becomes `export const slices = (targets: RankTarget[]) => sliceByMarket(targets, RANK_STEP);`:

```ts
/** Slices of at most `size`, never mixing markets, so a step's subrequests stay fixed whatever the market count. */
export function sliceByMarket<T extends { market: string }>(targets: T[], size: number): T[][] {
  const out: T[][] = [];
  for (const target of targets) {
    const last = out[out.length - 1];
    if (last && last.length < size && last[0]!.market === target.market) last.push(target);
    else out.push([target]);
  }
  return out;
}
```

Run `node --test apps/web/src/rank-tracking.test.ts` — still PASS.

- [ ] **Step 2: Ledger points (core)** — append to `packages/core/src/ai-answers.ts`, with a test in `ai-answers.test.ts`:

```ts
/** The latest check of each (prompt, market, engine) among current prompts and markets. */
export function latestChecks(checks: AiAnswerCheck[], prompts: string[], markets: string[]): AiAnswerCheck[] {
  const wanted = new Set(prompts);
  const latest = new Map<string, AiAnswerCheck>();
  for (const check of checks) {
    if (!wanted.has(check.prompt) || !markets.includes(check.market)) continue;
    const key = `${check.prompt}|${check.market}|${check.engine}`;
    const seen = latest.get(key);
    if (!seen || check.day > seen.day) latest.set(key, check);
  }
  return [...latest.values()];
}

/** The day's ledger points over the latest answers of the last 7 days: answers checked, mentioning, citing — overall, per engine, and per competitor. */
export function aiAnswerPoints(checks: AiAnswerCheck[], prompts: string[], markets: string[], competitors: string[], day: string) {
  const recent = latestChecks(checks.filter((check) => check.day > addDays(day, -AI_CHECK_FRESH_DAYS)), prompts, markets);
  const count = (rows: AiAnswerCheck[], pick: (row: AiAnswerCheck) => boolean) => rows.filter(pick).length;
  const points = [
    { metric: "ai_answers_checked", day, value: recent.length },
    { metric: "ai_answers_mentioned", day, value: count(recent, (row) => row.mentioned) },
    { metric: "ai_answers_cited", day, value: count(recent, (row) => row.cited) },
  ];
  for (const { engine } of AI_ANSWER_ENGINES) {
    const rows = recent.filter((row) => row.engine === engine);
    points.push({ metric: `ai_answers_checked.${engine}`, day, value: rows.length }, { metric: `ai_answers_mentioned.${engine}`, day, value: count(rows, (row) => row.mentioned) }, { metric: `ai_answers_cited.${engine}`, day, value: count(rows, (row) => row.cited) });
  }
  for (const domain of competitors) {
    points.push({ metric: `ai_answers_mentioned:${domain}`, day, value: count(recent, (row) => row.rivals.some((rival) => rival.domain === domain && rival.mentioned)) },
      { metric: `ai_answers_cited:${domain}`, day, value: count(recent, (row) => row.rivals.some((rival) => rival.domain === domain && rival.cited)) });
  }
  return points;
}
```

(import `addDays` from `./dates.js`.) Test: two prompts × one market × two engines with one 10-day-old check ignored; the counts and one competitor's points as expected; a check for a removed prompt ignored. Add to `METRICS` in `packages/core/src/results.ts`: `aiAnswers: ["sync.ai_answers", "ai_answers_checked", "ai_answers_mentioned", "ai_answers_cited", ...AI_ANSWER_ENGINES.flatMap(({ engine }) => [`ai_answers_checked.${engine}`, `ai_answers_mentioned.${engine}`, `ai_answers_cited.${engine}`])]`, with the comment `/** AI answer tracking: answers checked, mentioning the brand, citing the site — overall and per engine. Plus `ai_answers_mentioned:<domain>` and `ai_answers_cited:<domain>` for each current competitor. */`

- [ ] **Step 3: Failing web tests** `apps/web/src/ai-answers.test.ts` — use real SQLite and a fake fetch that answers by URL (`chat_gpt`, `gemini`, `ai_mode`, `perplexity`), following `rank-tracking.test.ts`'s setup (`upsertSite`, `setSiteMarkets`, `setAiPrompts`, `setAiBrandNames`, `setSiteCompetitorDomains`). Tests:
  1. "queues every prompt × covered market × engine, oldest first, at most 40 a day, and skips an uncovered market with a note": 12 prompts × `["mys", "mmr"]` → 40 targets, all `mys` (Myanmar uncovered: note mentions `mmr`), never-checked first; after seeding a 3-day-old check for one cell that cell is not due; a 7-day-old one is.
  2. "checks done this week aren't asked again": run `checkAiAnswers` for a slice, then `aiQueue` the same day doesn't include those cells.
  3. "checks a slice ten at a time, reads each answer, saves the rows": 20 targets, the fake fetch records max in-flight ≤ 10; rows saved with `mentioned`/`cited`/`rivals` per the stubbed answers; the notes are empty.
  4. "a refused engine is a note, the rest are saved": the stub answers `gemini` with status 40501; one note `ai answers skipped “…” on Gemini in mys: …`; the other engines' rows saved.
  5. "writes the counts and the marker, and prunes": after a slice, `writeAiCounts` writes `ai_answers_checked` etc. and `sync.ai_answers`.

Run `node --test apps/web/src/ai-answers.test.ts` — FAIL (module missing).

- [ ] **Step 4: `apps/web/src/ai-answers.ts`**

```ts
import { authorityDomain, DEMO_SITE_ID, fetchAiAnswer } from "@organic-growth/agents";
import { addDays, aiAnswerPoints, AI_ANSWER_ENGINES, AI_CHECK_FRESH_DAYS, countryAlpha2, readAnswer, type AiAnswerCheck, type AiAnswerEngine, type SiteRecord } from "@organic-growth/core";
import {
  aiLastChecked, defaultPageSettings, getPageSettings, listAiAnswerChecks, listAiBrandNames, listAiPrompts, listSiteCompetitorDomains, listSiteMarkets,
  pruneAiAnswerChecks, saveAiAnswerChecks, upsertMetricPoints, type D1Like,
} from "@organic-growth/db";
import { dollars, marketLocation, said, sliceByMarket } from "./source-helpers.ts";
import type { StepOptions } from "./sync-steps.ts";

/*
 * AI answer tracking's steps: each question is asked of each engine in each
 * target market once a week. Due checks are spread over the week (at most
 * AI_CHECKS_PER_DAY a site a day, oldest first), asked 20 a step in one
 * market, ten at a time: a live scraper answer can take 90 seconds.
 */

export const AI_STEP = 20;
export const AI_CHECKS_PER_DAY = 40;
const KEEP_DAYS = 400;
const AI: StepOptions = { retries: { limit: 1, delay: 30_000 }, timeout: 10 * 60_000 };
const ENGINE_LABEL = Object.fromEntries(AI_ANSWER_ENGINES.map(({ engine, label }) => [engine, label])) as Record<AiAnswerEngine, string>;

export type AiTarget = { prompt: string; market: string; engine: AiAnswerEngine };
type Auth = { login: string; password: string };

/** The day's due checks: every prompt × covered market × engine whose last answer is a week old or missing, oldest first, capped, market-major for slicing. */
export async function aiQueue(db: D1Like, site: SiteRecord, today: string): Promise<{ targets: AiTarget[]; notes: string[] }> {
  const [prompts, markets, last] = await Promise.all([listAiPrompts(db, site.id), listSiteMarkets(db, site.id), aiLastChecked(db, site.id)]);
  const notes: string[] = [];
  const covered = markets.filter((market) => {
    if (marketLocation(market) !== null) return true;
    notes.push(`ai answers skipped ${market}: DataForSEO doesn't cover it`);
    return false;
  });
  const staleBefore = addDays(today, -AI_CHECK_FRESH_DAYS + 1);
  const due = covered.flatMap((market) => prompts.flatMap((prompt) => AI_ANSWER_ENGINES.map(({ engine }) => ({ prompt, market, engine, last: last.get(`${prompt}|${market}|${engine}`) ?? "" }))))
    .filter((target) => target.last < staleBefore)
    .sort((a, b) => a.last.localeCompare(b.last))
    .slice(0, AI_CHECKS_PER_DAY);
  const order = new Map(covered.map((market, index) => [market, index]));
  const targets = due.sort((a, b) => order.get(a.market)! - order.get(b.market)!).map(({ prompt, market, engine }) => ({ prompt, market, engine }));
  return { targets, notes };
}

/** One slice: ask each engine, ten at a time; read each answer; save the rows in one batch. */
export async function checkAiAnswers(db: D1Like, site: SiteRecord, auth: Auth, today: string, targets: AiTarget[], fetchFn: typeof fetch = fetch): Promise<{ checked: number; cost: number; notes: string[] }> {
  const [settings, brandNames, competitors] = await Promise.all([getPageSettings(db, site.id), listAiBrandNames(db, site.id), listSiteCompetitorDomains(db, site.id)]);
  const language = (settings ?? defaultPageSettings(site.id, site.name, site.baseUrl)).language;
  const own = authorityDomain(site.baseUrl);
  const rows: AiAnswerCheck[] = [];
  const notes: string[] = [];
  let cost = 0;
  for (let start = 0; start < targets.length; start += 10) {
    const group = targets.slice(start, start + 10);
    const answers = await Promise.allSettled(group.map((target) => fetchAiAnswer(auth, { engine: target.engine, prompt: target.prompt, location: marketLocation(target.market)!, language, countryIso2: countryAlpha2(target.market) }, fetchFn)));
    answers.forEach((answer, index) => {
      const target = group[index]!;
      if (answer.status === "rejected") {
        notes.push(`ai answers skipped “${target.prompt}” on ${ENGINE_LABEL[target.engine]} in ${target.market}: ${said(answer.reason)}`);
        return;
      }
      cost += answer.value.cost;
      const read = readAnswer({ text: answer.value.text, sources: answer.value.sources, brandNames: [site.name, ...brandNames], site: own, competitors });
      rows.push({ ...target, day: today, ...read, sources: answer.value.sources.slice(0, 20) });
    });
  }
  await saveAiAnswerChecks(db, site.id, rows);
  return { checked: rows.length, cost, notes };
}

/** The day's ledger points and marker, then the prune. */
export async function writeAiCounts(db: D1Like, site: SiteRecord, today: string): Promise<void> {
  const [checks, prompts, markets, competitors] = await Promise.all([
    listAiAnswerChecks(db, site.id, addDays(today, -AI_CHECK_FRESH_DAYS)), listAiPrompts(db, site.id), listSiteMarkets(db, site.id), listSiteCompetitorDomains(db, site.id),
  ]);
  const points = aiAnswerPoints(checks, prompts, markets, competitors, today);
  await upsertMetricPoints(db, site.id, [...points, { metric: "sync.ai_answers", day: today, value: points.length }]);
  await pruneAiAnswerChecks(db, site.id, addDays(today, -KEEP_DAYS));
}

type Safe = <T>(name: string, fn: () => Promise<T>, options?: StepOptions) => Promise<{ ok: T } | { error: string }>;

/** The step group for one site: queue, 20 a step in one market, counts. Returns the run's notes. */
export async function trackAiAnswers(db: D1Like, safe: Safe, site: SiteRecord, auth: Auth, today: string, fetchFn?: typeof fetch): Promise<string[]> {
  if (site.id === DEMO_SITE_ID) return [];
  const queue = await safe("ai-queue", () => aiQueue(db, site, today));
  if ("error" in queue) return [`ai answers failed: ${queue.error}`];
  const notes = [...queue.ok.notes];
  if (!queue.ok.targets.length) return notes;
  let checked = 0;
  let cost = 0;
  let steps = 0;
  let round = 0;
  for (const slice of sliceByMarket(queue.ok.targets, AI_STEP)) {
    round++;
    const result = await safe(`ai-${round}`, () => checkAiAnswers(db, site, auth, today, slice, fetchFn), AI);
    if ("error" in result) { notes.push(`ai answers failed: ${result.error}`); continue; }
    steps++;
    checked += result.ok.checked;
    cost += result.ok.cost;
    notes.push(...result.ok.notes);
  }
  if (checked) {
    notes.unshift(`ai answers: ${checked} checked in ${steps} step${steps === 1 ? "" : "s"}, ${dollars(cost)}`);
    const counts = await safe("ai-counts", () => writeAiCounts(db, site, today));
    if ("error" in counts) notes.push(`ai answers counts failed: ${counts.error}`);
  }
  return notes;
}
```

Due rule check: `staleBefore = today − 6`; a cell last checked 7 days ago (`today − 7`) is `< today − 6` → due; 3 days ago → not due; never checked (`""`) → due and sorts first.

- [ ] **Step 5: Wire `syncSite`.** In `sync-steps.ts` rename the step `"ranks-limits"` to `"dataforseo-limits"` (and its failure note to `dataforseo limits failed: …`), and after `trackRanks(...)` add `notes.push(...await trackAiAnswers(deps.db, safe, site, dataForSeo, startedAt.slice(0, 10), deps.google(siteId).fetchFn));` inside the same `mayRank.ok` branch. Update `sync-steps.test.ts` references to `s/ranks-limits` → `s/dataforseo-limits`. Add a test: a site with the workspace feature, two prompts and one market runs `ai-queue`, one `ai-1` step and `ai-counts`, and the second run the same day fetches nothing from `ai_optimization`/`ai_mode`.

- [ ] **Step 6: Run** `npm run build:packages && node --test apps/web/src/ai-answers.test.ts apps/web/src/rank-tracking.test.ts apps/web/src/sync-steps.test.ts && npm test -w @organic-growth/core && npm run typecheck -w @organic-growth/web` — PASS.
- [ ] **Step 7: Commit** `"AI answers: weekly checks per question, market and engine, spread over the week, 20 a step"`.

---

### Task 4: The prompts route

**Files:**
- Create: `apps/web/src/ai-prompts.ts`, `apps/web/src/ai-prompts.test.ts`, `apps/web/app/api/sites/[siteId]/ai-prompts/route.ts`

**Interfaces:**
- Produces: `parseAiPrompts(body: unknown): { prompts: string[]; brandNames: string[] } | { error: string }`; `promptSuggestions(queries: Array<{ query: string; impressions: number }>, current: string[]): string[]` (question queries only via `isQuestionQuery` from `@organic-growth/agents`, most impressions first, not already listed case-insensitively, at most 10); `GET` → `{ prompts, brandNames, suggestions }`; `PUT { prompts, brandNames }` → same shape or `{ error }` (400), gate 403.

- [ ] **Step 1: Failing test** `apps/web/src/ai-prompts.test.ts`

```ts
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
```

(If `berapa` isn't matched by `QUESTION_QUERY_PATTERN`, read `packages/agents/src/search.ts:16` and use a Malay/Indonesian question word it does match; the test asserts the pattern's behaviour, not a new one.)

- [ ] **Step 2: `apps/web/src/ai-prompts.ts`**

```ts
import { isQuestionQuery } from "@organic-growth/agents";
import { AI_BRAND_NAMES_MAX, AI_PROMPTS_MAX, normalizePrompt } from "@organic-growth/core";

/** PUT /api/sites/:id/ai-prompts: up to 25 questions (5–200 characters) and 5 brand names (2–60), trimmed, de-duplicated case-insensitively. */
export function parseAiPrompts(body: unknown): { prompts: string[]; brandNames: string[] } | { error: string } {
  const input = body as { prompts?: unknown; brandNames?: unknown } | null;
  if (!Array.isArray(input?.prompts) || !Array.isArray(input?.brandNames)) return { error: "Send a list of questions and a list of brand names." };
  if (input.prompts.length > AI_PROMPTS_MAX) return { error: `Track up to ${AI_PROMPTS_MAX} questions.` };
  if (input.brandNames.length > AI_BRAND_NAMES_MAX) return { error: `Give up to ${AI_BRAND_NAMES_MAX} brand names.` };
  const unique = (list: unknown[], min: number, max: number, what: string): string[] | { error: string } => {
    const out: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") return { error: `Each ${what} must be text.` };
      const value = normalizePrompt(entry);
      if (value.length < min || value.length > max) return { error: `Each ${what} must be ${min} to ${max} characters.` };
      if (!out.some((seen) => seen.toLowerCase() === value.toLowerCase())) out.push(value);
    }
    return out;
  };
  const prompts = unique(input.prompts, 5, 200, "question");
  if ("error" in prompts) return prompts;
  const brandNames = unique(input.brandNames, 2, 60, "brand name");
  if ("error" in brandNames) return brandNames;
  return { prompts, brandNames };
}

/** The site's own question searches (Search Console), most impressions first, that aren't tracked yet: at most 10, never invented. */
export function promptSuggestions(queries: Array<{ query: string; impressions: number }>, current: string[]): string[] {
  const listed = new Set(current.map((prompt) => prompt.toLowerCase()));
  return queries.filter((row) => isQuestionQuery(row.query) && !listed.has(row.query.toLowerCase()))
    .sort((a, b) => b.impressions - a.impressions).slice(0, 10).map((row) => row.query);
}
```

- [ ] **Step 3: Route** `apps/web/app/api/sites/[siteId]/ai-prompts/route.ts` — same shape as `apps/web/app/api/sites/[siteId]/keywords/route.ts` (read it first; reuse `access.site` for the workspace and its exact gate expression). `GET`: `listAiPrompts`, `listAiBrandNames`, and suggestions from `getTopQueriesSnapshot(env.DB, siteId, { property: site.gscProperty, markets: await listSiteMarkets(env.DB, siteId) })` when the site has a Search Console property (rows `{ query, impressions }`), else `[]`; `Cache-Control: no-store`. `PUT`: write access → gate (403) → JSON (400) → `parseAiPrompts` (400) → `setAiPrompts` + `setAiBrandNames` → respond `{ prompts, brandNames, suggestions: [] }`.

- [ ] **Step 4: Run** `node --test apps/web/src/ai-prompts.test.ts apps/web/src/routes-guarded.test.ts && npm run typecheck -w @organic-growth/web` — PASS.
- [ ] **Step 5: Commit** `"AI answers: questions and brand names route, with suggestions from the site's own question searches"`.

---

### Task 5: View model, results loading and the card

**Files:**
- Modify: `packages/core/src/ai-answers.ts` (`aiAnswersView`), `packages/core/src/ai-answers.test.ts`, `packages/core/src/results.ts` (`ResultsInput.aiAnswers`, `ResultsView.aiAnswers`)
- Modify: `apps/web/src/results-data.ts`, `apps/web/src/results-data.test.ts`
- Create: `apps/web/app/components/results/AiAnswersCard.tsx`
- Modify: `apps/web/app/components/SitePanels.tsx` (`AiPanel`, first card; thread `onSaved` like `KeywordsPanel`'s, from `OverviewView.tsx`), `apps/web/app/r/[token]/ClientReport.tsx`

**Interfaces:**
- Produces: `type AiAnswersView = { prompts: number; markets: string[]; checked: number; asOf: string | null; totals: { mentioned: number; cited: number }; engines: Array<{ engine: AiAnswerEngine; label: string; checked: number; mentioned: number; cited: number }>; rows: Array<{ prompt: string; market: string; cells: Partial<Record<AiAnswerEngine, AiAnswerCheck>> }>; shareOfVoice: Array<{ domain: string; site: boolean; answers: number; share: number | null }>; topDomains: Array<{ domain: string; answers: number; kind: "site" | "competitor" | "other" }>; weeks: Array<{ week: string; checked: number; mentioned: number; cited: number }>; overview: { searches: number; citesYou: number } }`; `aiAnswersView(input: { prompts: string[]; markets: string[]; checks: AiAnswerCheck[]; site: string; competitors: string[]; today: string; overview: { searches: number; citesYou: number } }): AiAnswersView`.

- [ ] **Step 1: Failing core test** for `aiAnswersView` in `ai-answers.test.ts`: two prompts, one market, checks for `chatgpt` on two days (latest wins in `rows`), `perplexity` once; a removed prompt's checks ignored ("ignores removed questions"); `engines` counts per engine over the latest checks; `shareOfVoice` with the site and one competitor where the site appears in 2 answers and the competitor in 1 → shares 2/3 and 1/3, site first; `topDomains` counts distinct answers citing each domain, kinds set; `weeks` buckets checks by ISO week start (Monday) over the last 12 weeks, oldest first; `asOf` = the latest day; `checked` = number of latest cells.

- [ ] **Step 2: `aiAnswersView`** — implement exactly to the interface above:
  - `latest = latestChecks(checks, prompts, markets)`; `rows` = for each prompt (list order) × market: cells from `latest`.
  - `engines` = `AI_ANSWER_ENGINES` with counts over `latest`.
  - `shareOfVoice`: site answers = latest with `mentioned || cited`; each competitor's = latest with a rival `{ domain }` mentioned or cited; `share` = answers ÷ the sum (null when the sum is 0); site first, then competitors by answers desc.
  - `topDomains`: for each latest check, its distinct source domains; count answers per domain; kind `site` (is or under the site), `competitor` (is or under one), else `other`; top 10 by answers then domain.
  - `weeks`: week start = the Monday on or before the day (`addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7))`); for each of the 12 weeks ending this week, over `checks` filtered to current prompts and markets in that week: checked, mentioned, cited (a cell checked twice in a week counts once, its later check).
  - `overview` passed through.

- [ ] **Step 3: Wire results.** `ResultsInput.aiAnswers?: { prompts: string[]; checks: AiAnswerCheck[]; site: string }`; `ResultsView.aiAnswers: AiAnswersView`; in `resultsView`: `aiAnswersView({ prompts: input.aiAnswers?.prompts ?? [], markets: input.markets, checks: input.aiAnswers?.checks ?? [], site: input.aiAnswers?.site ?? "", competitors: input.competitors ?? [], today: input.today, overview: { searches: serp.aiOverview.searches, citesYou: serp.aiOverview.citesYou } })`. In `loadResults` (`apps/web/src/results-data.ts`) load `listAiPrompts(db, site.id)` and `listAiAnswerChecks(db, site.id, addDays(today, -90))` in the second `Promise.all` and pass `aiAnswers: { prompts, checks, site: authorityDomain(site.baseUrl) }` (`authorityDomain` from `@organic-growth/agents`, as `connectors-data.ts` imports it). Results-data test: a prompt with one check appears in `view.aiAnswers.rows`. Also add `ai_answers_mentioned:<domain>`/`ai_answers_cited:<domain>` to `perCompetitor` in `loadResults` (beside `authority:<domain>`).

- [ ] **Step 4: The card** `apps/web/app/components/results/AiAnswersCard.tsx` — props `{ view: AiAnswersView; siteId: string; operator: boolean; hasCredentials: boolean; hasMarkets: boolean; onSaved?: () => void }`. Follow `RankTrackingCard.tsx` for structure, state handling (saved lists in state, set from the PUT response; draft derived from them; "Saved"; error line), `aria-label`s and the empty states:
  - Empty states (in order): no credentials ("Add DataForSEO credentials (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD) to ask AI assistants about your market." / client "Not measured yet."); no markets ("Set target markets in Setup: answers are checked per country."); no prompts (users: "Add the questions people ask AI assistants about your services."; client: "No questions are tracked yet."); prompts but `checked === 0` ("First answers at the next sync.").
  - Subtitle: `Answers from ChatGPT, Gemini, Google AI Mode and Perplexity to the questions you track, asked weekly in your target markets through DataForSEO${asOf ? ` (last on ${formatDay(asOf)})` : ""}.`
  - KPIs (`Kpi`): "Questions tracked" (`prompts`), "Answers that mention you" (`${mentioned} of ${checked}`), "Answers that cite you" (`${cited} of ${checked}`), "Google AI Overviews citing you" (`${overview.citesYou} of ${overview.searches}`, caption "from the search results checked").
  - `Radar` (`axes` = engine labels; series: you and up to 3 competitors from `shareOfVoice`; values = mention-or-citation rate per engine: for the site `(mentioned or cited) / checked` per engine — compute in the card from `rows`), caption "Share of answers naming or citing each site, by engine".
  - "Share of voice" `BarList` from `shareOfVoice` (`label: domain · NN%`).
  - Question grid: a table, rows = `rows` (prompt + market via `countryName`), columns = engines; a cell shows `●` cited (title "Cites you"), `◐` mentioned (title "Mentions you"), `○` neither (title naming rivals cited, if any), `—` not checked yet. Clicking a cell toggles a detail row under it with the excerpt, the rivals, and up to 5 source links. On the client link, rows whose cells are all unchecked are hidden.
  - "Sites AI cites for these questions" — `topDomains` as a list with the kind as a `Badge` ("you", "competitor").
  - "Weekly" `LineChart` of mention and citation rates (`mentioned/checked`, `cited/checked` as percentages) when `weeks` has ≥ 2 weeks with checks.
  - Editor (users with credentials and markets): fetch `GET /api/sites/${siteId}/ai-prompts` on mount for `brandNames` and `suggestions`; textarea (one question a line, `aria-label="Questions to track, one per line"`), a brand-names input (comma-separated, `aria-label="Names your brand goes by"`), suggestion chips as `Button small variant="ghost"` that append the suggestion to the draft, Save, the cost line `${n} question(s) × ${m} market(s) × 4 engines ≈ $${(n * m * 4 * 0.0048 * 4.3).toFixed(2)} a month at DataForSEO.` and "Answers are checked weekly; the first ones arrive at the next sync."
  - Place it first in `AiPanel` and in `ClientReport.tsx` before the AI cards, only when `view.checked > 0`, with `operator={false}`.

- [ ] **Step 5: Run** `npm run build:packages && npm test -w @organic-growth/core && node --test apps/web/src/results-data.test.ts && npm run typecheck -w @organic-growth/web && npm run build -w @organic-growth/web` — PASS.
- [ ] **Step 6: Commit** `"AI answers card on the AI visibility tab and the client link"`.

---

### Task 6: Findings and opportunities

**Files:**
- Create: `packages/agents/src/ai-answer-findings.ts`, `packages/agents/src/ai-answer-findings.test.ts`
- Modify: `packages/agents/src/demand.ts` (kind `ai_answer`), `packages/agents/src/connector-findings.ts` (`ConnectorSignals.aiAnswers`), `packages/agents/src/pipeline.ts` (push findings beside `findingsFromRanks`), `packages/agents/src/index.ts` (opportunities in `buildOpportunities` beside `rankOpportunities`; export), `apps/web/src/connectors-data.ts` (`connectorSignals` 7th arg `aiAnswers`), `apps/web/src/analysis-workflow.ts` (load with `.catch(() => null)`)

**Interfaces:**
- Produces: `type AiAnswerSignals = { prompts: string[]; markets: string[]; checks: AiAnswerCheck[]; today: string }`; `AI_FINDINGS` thresholds; `findingsFromAiAnswers({ siteId, analysisId, signals }): Finding[]`; `aiAnswerOpportunities({ siteId, analysisId, signals, existing }): Opportunity[]`; `loadAiAnswerSignals(db, siteId, today): Promise<AiAnswerSignals | null>` (null when no prompts; 90 days of checks; markets from `listSiteMarkets`).

Rules (constants in `AI_FINDINGS` with their reasons):
- **Competitors instead of you** — over `latestChecks`: a (prompt, market) *qualifies* when in at least `ENGINES_AT_LEAST = 2` engines the latest answer has a rival mentioned or cited and the site neither mentioned nor cited. Fires when qualifying questions ≥ `QUESTIONS_AT_LEAST = 3`. Title `AI assistants name competitors but not you for ${n} of ${m} questions`. Category `ai_visibility`. Impact `min(70, 30 + 5 × n)`. Summary lists up to 5 questions (“…” in Market) and the competitors named; evidence `{ questions: [{ prompt, market, engines, rivals }], total: m }`. Recommendation: "Answer each question directly in the first lines of a page, with figures and sources; add a question-and-answer section; keep the page's date current; and get listed on the sites AI cites for these questions (the AI answers card shows them)."
- **Lost citations, per engine** — for each (prompt, market, engine) with checks sorted by day: it is *lost* when the latest check is not cited and an earlier check was, and every check after the last cited one is not cited; `since` = the day of the first check after the last cited one. Per engine, fires when lost ≥ `LOST_AT_LEAST = 2`: title `${Engine} stopped citing you for ${n} questions since ${earliest since}`, impact `min(75, 40 + 5 × n)`, summary names the questions and who it cites now (the latest check's top 3 source domains). Stays while lost (90-day window). At most one finding per engine.
- **Opportunities** — per (prompt, market) where at least one engine's latest answer cites a rival and the site isn't cited in that engine: `missing` = such engines; skip when an existing opportunity names the prompt in “quotes”; top `OPPORTUNITIES_MAX = 5` by `priorityScore = missing × 8 × (engines citing a rival ≥ 2 ? 1.5 : 1)`. Title `Get cited for “${prompt}” in AI answers (${countryName(market)})`; intent `ai_answer`; `estimateDemand({ kind: "ai_answer", engines: missing })` → add to `DemandInput`: `/** An AI answer that cites competitors: no search volume exists for it; harder the more engines skip the site. */ | { kind: "ai_answer"; engines: number }` returning `{ searchDemand: 0, estimatedDifficulty: cap(input.engines * 20), priced: null }`; rationale names up to 3 rival pages cited (URLs from the latest checks' sources whose domain is a rival) and the levers sentence.

- [ ] **Step 1: Failing tests** `ai-answer-findings.test.ts` (build checks with a small helper `check(prompt, engine, day, { mentioned?, cited?, rivals? })`): the competitors-instead finding fires at 3 qualifying questions and not at 2; an engine where only the site is mentioned doesn't count; "no finding for a removed question"; lost citations: cited on day −14, not on −7 and 0 → lost since −7; cited again at 0 → not lost; two lost in ChatGPT → one ChatGPT finding, one lost in Gemini → none; opportunities ranked by the formula, deduped against an existing “prompt” title, at most 5; `loadAiAnswerSignals` null with no prompts (SQLite).
- [ ] **Step 2: Implement** `ai-answer-findings.ts` (mirror `rank-findings.ts`'s structure: header comment, `AI_FINDINGS`, drafts → `Finding` mapping with `createId("finding")`, `severityFromImpact`, `createdAt`), the `demand.ts` kind, and the wiring (signals type on `ConnectorSignals`, `pipeline.ts`, `buildOpportunities` with `existing` = the list built so far, `connectorSignals` 7th argument, `analysis-workflow.ts` load with `.catch(() => null)` run alongside `loadRankSignals` in a `Promise.all`).
- [ ] **Step 3: Run** `npm run build:packages && npm test -w @organic-growth/agents && npm run typecheck -w @organic-growth/web` — PASS.
- [ ] **Step 4: Commit** `"AI answers: findings when AI names competitors instead of you or stops citing you, and per-question opportunities"`.

---

### Task 7: Demo

**Files:** Modify `packages/agents/src/demo.ts` (a `seedDemoAiAnswers(db, now)` called after `seedDemoRanks`; `connectors.aiAnswers` from `loadAiAnswerSignals`), `packages/agents/src/demo.test.ts`.

- [ ] **Step 1: Failing assertions** in `demo.test.ts` beside the rank ones: a finding titled `AI assistants name competitors but not you for …` and one ending with a `stopped citing you for` title, and an opportunity titled `Get cited for “…” in AI answers (Malaysia)`.
- [ ] **Step 2: Seed** six questions phrased from the demo's own treatments and city (e.g. `` `How much does ${words} cost in Kuala Lumpur?` `` for the first four `TREATMENTS`, plus "Which dental clinic in Kuala Lumpur is best for families?" and "Where can I get emergency dental care in Kuala Lumpur?"), brand name "Demo Dental Clinic", market `mys`, eight weekly checks for each of the four engines (days `today − 7k`, k = 0…7). Shape, deterministic by question index `q` and engine:
  - `perplexity` and `ai_mode`: cited (`citedRank` 2, sources include `${ORIGIN}/…` on the demo domain) for q = 0, 1; otherwise a rival cited.
  - `chatgpt`: mentioned (not cited) for q = 0, 1, 2; q = 3 was cited until two weeks ago (k ≥ 2 cited) and not since; otherwise a rival mentioned.
  - `gemini`: never mentions or cites the site; a rival cited for q = 2…5.
  - Rivals are the demo's competitor domains (`COMPETITORS`); excerpts are short sentences built from the question.
  - The lost-citation finding needs ≥ 2 lost in one engine: make q = 4 in `chatgpt` also cited for k ≥ 2.
  Save with `setAiPrompts`, `setAiBrandNames`, one `saveAiAnswerChecks`; write the day's points via `aiAnswerPoints` + `upsertMetricPoints` so the card's KPIs and ledger agree.
- [ ] **Step 3: Run** `npm run build:packages && npm test -w @organic-growth/agents` — PASS (ownership test included).
- [ ] **Step 4: Commit** `"Demo site tracks six AI questions across four engines"`.

---

### Task 8: Words, docs, full check

**Files:** `CONTEXT.md` (§ AI visibility: **AI answer**, **Mentioned / cited**, **Share of voice**; § Growth plan: the two findings and the opportunity), `apps/web/app/components/ConnectorSetup.tsx` (DataForSEO paragraph: add the sentence "Weekly answers from ChatGPT, Gemini, Google AI Mode and Perplexity to the questions you track on the AI visibility tab."), `docs/site/pages/web-app.html` (one sentence where Task 8 of rank tracking added the Rank tracking sentence).

- [ ] **Step 1:** Write the three edits (copy rules: "users", no client names).
- [ ] **Step 2:** `npm run build:packages && npm run typecheck && npm test` — all pass.
- [ ] **Step 3:** Commit `"AI answers: context terms, setup copy and docs"`. Do not push or open a PR (the controller does, after the whole-branch review).
