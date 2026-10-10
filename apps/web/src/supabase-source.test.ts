import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getDataset, getSource, listAllRecords, upsertDataset, upsertRecords, upsertSite, upsertSource } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { isSupabaseProjectUrl, MAX_PULL_BYTES, runSupabasePull, saveSupabaseKey, supabaseKey, validateSupabaseKey, type PullStep } from "./supabase-source.ts";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 32 zero bytes, base64url
const AT = "2026-10-01T00:00:00.000Z";
const SECRET = "sb_publishable_abcdefghijklmnopqrstuvwxyz";

async function site() {
  const db = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await upsertDataset(db, { id: "d", siteId: "s", name: "Doctors", entityType: "doctor", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT,
    fields: [{ key: "name", label: "Name", type: "text", required: true }, { key: "bio_en", label: "Bio (EN)", type: "text" }, { key: "hospital", label: "Hospital", type: "text" }] });
  await upsertSource(db, { id: "src", siteId: "s", datasetId: "d", url: "https://abc.supabase.co", kind: "supabase", urlPattern: "doctors", maxPages: 40, origin: "user", status: "approved", recordCount: 0, createdAt: AT });
  await saveSupabaseKey(db, "s", "src", SECRET, KEY);
  return db;
}

/** A PostgREST stand-in: `total` rows named Dr 0…, answering at most `cap` rows a request whatever the limit asks. */
function table(total: number, cap = 1000) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const params = new URL(url).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Math.min(Number(params.get("limit")), cap);
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({ id: offset + i, Name: `Dr ${offset + i}`, "Bio (EN)": (offset + i) % 2 ? "A bio." : null, hospital: "Pantai" }));
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json", "content-range": `${offset}-${offset + rows.length - 1}/${total}` } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

/** Runs each step at once and remembers its name. */
function steps() {
  const names: string[] = [];
  const step: PullStep = { do: async (name, fn) => { names.push(name); return fn(); } };
  return { step, names };
}

describe("Supabase table source", () => {
  it("keeps the key sealed and refuses keys that are not keys", async () => {
    const db = await site();
    assert.equal(await supabaseKey(db, "s", "src", KEY), SECRET);
    assert.equal(validateSupabaseKey(SECRET), null);
    assert.equal(validateSupabaseKey("eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ role: "anon", iss: "supabase" })).toString("base64url") + ".sig"), null, "an anon JWT");
    assert.match(validateSupabaseKey("eyJhbGciOiJIUzI1NiJ9." + Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url") + ".sig") ?? "", /service/i, "the service-role JWT is never the right key");
    assert.match(validateSupabaseKey("sb_secret_abcdefghijklmnopqrstuvwxyz") ?? "", /service|secret/i);
    assert.match(validateSupabaseKey("short") ?? "", /key/i);
    assert.match(validateSupabaseKey("has a space in it and is long enough to pass") ?? "", /key/i, "only key characters");
  });

  it("reads the table a page a step, replaces the source's records, drops the ones no longer there, and counts them", async () => {
    const db = await site();
    await upsertRecords(db, [{ siteId: "s", datasetId: "d", key: "dr-gone", data: { name: "Dr Gone" }, sourceId: "src", sourceUrl: "https://abc.supabase.co" }], (await getDataset(db, "d"))!.fields);
    await db.prepare("UPDATE data_records SET updated_at = '2026-09-01T00:00:00.000Z' WHERE record_key = 'dr-gone'").run();
    const { fetchFn, calls } = table(2500);
    const { step, names } = steps();
    const result = await runSupabasePull({ db, encryptionKey: KEY, fetchFn }, step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job1");
    assert.deepEqual(result, { rows: 2500, records: 2500, pages: 3, total: 2500, truncated: false, removed: 1 });
    assert.deepEqual(names, ["pull-src-1", "pull-src-2", "pull-src-3", "pull-src-finish"]);
    assert.equal(calls.length, 3);
    assert.match(calls[0]!.url, /^https:\/\/abc\.supabase\.co\/rest\/v1\/doctors\?select=\*&offset=0&limit=1000$/);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.apikey, SECRET);
    assert.equal(headers.Authorization, `Bearer ${SECRET}`);
    assert.equal(headers.Prefer, "count=exact");
    assert.equal(calls[0]!.init.redirect, "error", "a redirect would carry the key to another host");
    const records = await listAllRecords(db, "d");
    assert.equal(records.length, 2500, "dr-gone was removed");
    assert.equal(records.find((record) => record.key === "dr-2499")?.data.hospital, "Pantai");
    assert.equal(records.filter((record) => record.data.bio_en).length, 1250, "null columns stay empty");
    const source = (await getSource(db, "src"))!;
    assert.equal(source.recordCount, 2500);
    assert.ok(source.lastRunAt);
    assert.equal(source.error, undefined);
  });

  it("finishes a table whose project caps rows per request below the page size, using the total it reports", async () => {
    const db = await site();
    const { fetchFn, calls } = table(1200, 500);
    const result = await runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job1");
    assert.deepEqual([result.rows, result.pages, result.total], [1200, 3, 1200]);
    assert.deepEqual(calls.map((call) => new URL(call.url).searchParams.get("offset")), ["0", "500", "1000"]);
  });

  it("keeps the same name twice apart when the rows have ids, so the inventory can see the duplicate", async () => {
    const db = await site();
    const fetchFn = (async () => new Response(JSON.stringify([{ id: 1, Name: "Dr Tan Mei", hospital: "A" }, { id: 2, Name: "Dr. Tan Mei", hospital: "B" }, { id: 3, Name: "Dr Lim", hospital: "C" }]), { status: 200, headers: { "content-range": "0-2/3" } })) as unknown as typeof fetch;
    const result = await runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job1");
    assert.equal(result.records, 3);
    assert.deepEqual((await listAllRecords(db, "d")).map((record) => record.key).sort(), ["dr-lim", "dr-tan-mei", "dr-tan-mei-2"]);
  });

  it("stops after the page cap and says the table is larger", async () => {
    const db = await site();
    const { fetchFn } = table(5000);
    const result = await runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job1", { maxPages: 2 });
    assert.deepEqual([result.rows, result.pages, result.truncated, result.removed], [2000, 2, true, 0], "nothing is removed after a partial pull");
    assert.match((await getSource(db, "src"))!.error ?? "", /first 2,000 rows.*5,000/);
  });

  it("fails a pull whose columns match no field, naming the columns it saw, and never echoes the key", async () => {
    const db = await site();
    const fetchFn = (async () => new Response(JSON.stringify([{ id: 1, full_name: "Dr X", clinic: "Y" }]), { status: 200, headers: { "content-range": "0-0/1" } })) as unknown as typeof fetch;
    await assert.rejects(async () => runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job1"), (error: Error) => /Name/.test(error.message) && /full_name, clinic/.test(error.message) && !error.message.includes(SECRET));
    const refused = (async () => new Response(JSON.stringify({ message: `JWT expired ${SECRET}` }), { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(async () => runSupabasePull({ db, encryptionKey: KEY, fetchFn: refused }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job1"), (error: Error) => /401/.test(error.message) && /JWT expired/.test(error.message) && !error.message.includes(SECRET));
    assert.ok(!(await getSource(db, "src"))!.error?.includes(SECRET), "the stored error never carries the key");
  });
  it("only pulls from a Supabase project address", async () => {
    assert.equal(isSupabaseProjectUrl("https://abc.supabase.co"), true);
    for (const url of ["http://abc.supabase.co", "https://attacker.tld", "https://abc.supabase.co.evil.tld", "https://abc.supabase.co:8443"]) assert.equal(isSupabaseProjectUrl(url), false, url);
    const db = await site();
    const source = (await getSource(db, "src"))!;
    const { fetchFn, calls } = table(3);
    await assert.rejects(
      runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, { ...source, url: "https://attacker.tld" }, (await getDataset(db, "d"))!, "job"),
      /supabase\.co/,
    );
    assert.equal(calls.length, 0, "nothing was fetched");
  });

  it("gives up on a page larger than the cap, and asks with a timeout", async () => {
    const db = await site();
    let signal: AbortSignal | undefined;
    const huge = "[" + `{"Name":"${"x".repeat(1000)}"},`.repeat(Math.ceil(MAX_PULL_BYTES / 1000)) + `{"Name":"y"}]`;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(huge, { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job"),
      /more than 5 MB/,
    );
    assert.ok(signal, "the request carried an abort signal");
  });
});
