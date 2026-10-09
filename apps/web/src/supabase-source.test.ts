import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDataset, getSource, listAllRecords, listSources, upsertDataset, upsertSite, upsertSource } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { pullSupabaseSource, saveSupabaseKey, supabaseKey, supabaseSourceView } from "./supabase-source.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 32 zero bytes, base64url
const AT = "2026-10-01T00:00:00.000Z";

async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await upsertDataset(db, { id: "d", siteId: "s", name: "Doctors", entityType: "doctor", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT,
    fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "bio_en", label: "Bio (EN)", type: "text" }, { key: "hospital", label: "Hospital", type: "text" }] });
  await upsertSource(db, { id: "src", siteId: "s", datasetId: "d", url: "https://abc.supabase.co", kind: "supabase", urlPattern: "doctors", maxPages: 40, origin: "user", status: "approved", recordCount: 0, createdAt: AT });
  return db;
}

describe("Supabase table source", () => {
  it("keeps the key sealed, reads the table in pages, maps columns to fields and upserts the records", async () => {
    const db = await site();
    await saveSupabaseKey(db, "s", "src", "service-key-never-shown", KEY);
    assert.equal(await supabaseKey(db, "s", "src", KEY), "service-key-never-shown");
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchFn = (async (input: string, init?: RequestInit) => {
      calls.push({ url: input, headers: Object.fromEntries(Object.entries(init?.headers ?? {})) });
      const offset = Number(new URL(input).searchParams.get("offset"));
      const rows = offset === 0
        ? Array.from({ length: 1000 }, (_, i) => ({ id: i, Name: `Dr ${i}`, "Bio (EN)": i % 2 ? "A bio." : null, hospital: "Pantai" }))
        : [{ id: 1000, Name: "Dr Last", "Bio (EN)": "Done.", hospital: "Gleneagles" }];
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await pullSupabaseSource(db, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, KEY, fetchFn);
    assert.deepEqual(result, { rows: 1001, records: 1001, pages: 2 });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /^https:\/\/abc\.supabase\.co\/rest\/v1\/doctors\?select=\*&offset=0&limit=1000$/);
    assert.equal(calls[0]!.headers.apikey, "service-key-never-shown");
    assert.equal(calls[0]!.headers.Authorization, "Bearer service-key-never-shown");
    const records = await listAllRecords(db, "d");
    assert.equal(records.length, 1001);
    assert.equal(records.find((record) => record.key === "dr-last")?.data.hospital, "Gleneagles");
    assert.equal(records.filter((record) => record.data.bio_en).length, 501, "null columns stay empty");
    assert.equal((await getSource(db, "src"))!.recordCount, 1001);
  });

  it("stops on an error and says what the table answered, without echoing the key", async () => {
    const db = await site();
    await saveSupabaseKey(db, "s", "src", "secret", KEY);
    const fetchFn = (async () => new Response(JSON.stringify({ message: "JWT expired" }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(async () => pullSupabaseSource(db, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, KEY, fetchFn), (error: Error) => /401/.test(error.message) && /JWT expired/.test(error.message) && !/secret/.test(error.message));
    const view = supabaseSourceView((await listSources(db, "d"))[0]!);
    assert.equal(JSON.stringify(view).includes("secret"), false);
  });
});
