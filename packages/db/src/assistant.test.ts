import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendAssistantMessage, conversionCounts, createAssistantThread, deleteAssistantThread, deleteSite,
  getAssistantThread, insertConversionEvent, listAssistantMessages, listAssistantThreads, upsertSite,
} from "./index.js";
import { openSqliteD1 } from "./sqlite.js";

describe("assistant threads", async () => {
  const db = openSqliteD1();
  const now = new Date().toISOString();
  for (const id of ["a", "b"]) await upsertSite(db, { id, name: `${id}.com`, baseUrl: `https://${id}.com`, createdAt: now, updatedAt: now });

  it("keeps a conversation per site, in order, and never hands one site another's thread", async () => {
    await createAssistantThread(db, { id: "t1", siteId: "a", title: "Which page types have empty pages?" });
    await appendAssistantMessage(db, { id: "m1", threadId: "t1", role: "user", content: { text: "Which page types have empty pages?" } });
    await appendAssistantMessage(db, { id: "m2", threadId: "t1", role: "assistant", content: { text: "Procedures.", blocks: [] } });
    assert.deepEqual((await listAssistantMessages(db, "t1")).map((message) => [message.role, message.content]), [
      ["user", { text: "Which page types have empty pages?" }],
      ["assistant", { text: "Procedures.", blocks: [] }],
    ]);
    assert.equal((await listAssistantThreads(db, "a"))[0]?.id, "t1");
    assert.deepEqual(await listAssistantThreads(db, "b"), []);
    assert.equal(await getAssistantThread(db, "b", "t1"), null);
    await deleteAssistantThread(db, "b", "t1");
    assert.equal((await listAssistantMessages(db, "t1")).length, 2, "another site cannot delete it");
    await deleteAssistantThread(db, "a", "t1");
    assert.deepEqual(await listAssistantMessages(db, "t1"), []);
  });

  it("goes with its site", async () => {
    await createAssistantThread(db, { id: "t2", siteId: "b", title: "Leads" });
    await appendAssistantMessage(db, { id: "m3", threadId: "t2", role: "user", content: { text: "Leads?" } });
    await deleteSite(db, "b");
    assert.deepEqual(await listAssistantMessages(db, "t2"), []);
    assert.deepEqual(await listAssistantThreads(db, "b"), []);
  });

  it("counts conversions per day and event", async () => {
    for (const [event, at] of [["whatsapp_click", "2026-10-01T03:00:00Z"], ["whatsapp_click", "2026-10-01T09:00:00Z"], ["form_submit", "2026-10-02T01:00:00Z"], ["form_submit", "2026-09-01T01:00:00Z"]]) {
      await insertConversionEvent(db, { id: `e_${at}`, siteId: "a", event: event!, occurredAt: at! });
    }
    assert.deepEqual(await conversionCounts(db, "a", "2026-09-30T00:00:00Z"), [
      { day: "2026-10-01", event: "whatsapp_click", count: 2 },
      { day: "2026-10-02", event: "form_submit", count: 1 },
    ]);
  });
});
