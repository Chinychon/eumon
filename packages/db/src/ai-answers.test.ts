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
