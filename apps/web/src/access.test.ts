import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { siteForUser, upsertDataset, upsertSite, upsertRecords, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { allows, resolveSiteId } from "./access.ts";

const AT = "2026-10-10T00:00:00.000Z";
const FIELDS = [{ key: "name", label: "Name", type: "text", required: true }] as const;

describe("allows", () => {
  it("lets owners do anything, members everything but admin, clients only read", () => {
    const table = { owner: [true, true, true], member: [true, true, false], client: [true, false, false] } as const;
    for (const [role, expected] of Object.entries(table)) {
      assert.deepEqual((["read", "write", "admin"] as const).map((need) => allows(role as "owner", need)), expected, role);
    }
  });
});

describe("resolveSiteId", () => {
  it("finds the owning site for each ID kind, and null for unknown ids", async () => {
    const db: D1Like = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
    await upsertDataset(db, { id: "d", siteId: "s", name: "Doctors", entityType: "doctor", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT, fields: [...FIELDS] });
    await upsertRecords(db, [{ siteId: "s", datasetId: "d", key: "a", data: { name: "A" } }], [...FIELDS]);
    const recordId = (await db.prepare("SELECT id FROM data_records LIMIT 1").first<{ id: string }>())!.id;
    assert.equal(await resolveSiteId(db, "dataset", "d"), "s");
    assert.equal(await resolveSiteId(db, "record", recordId), "s");
    assert.equal(await resolveSiteId(db, "analysis", "nope"), null);
  });

  it("a client's ID-keyed request resolves to a site the client can only read", async () => {
    const db: D1Like = openSqliteD1();
    await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(AT).run();
    await db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('c', 'c', 'c@x', 1, ?, ?)`).bind(AT, AT).run();
    await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', 'w', 'c', 'client', ?)`).bind(AT).run();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, workspaceId: "w" });
    await db.prepare("INSERT INTO site_access (user_id, site_id, created_at) VALUES ('c', 's', ?)").bind(AT).run();
    await upsertDataset(db, { id: "d", siteId: "s", name: "D", entityType: "x", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT, fields: [...FIELDS] });
    const found = await siteForUser(db, "c", (await resolveSiteId(db, "dataset", "d"))!);
    assert.equal(found?.role, "client");
    assert.equal(allows(found!.role, "write"), false, "a client can't delete a dataset by its id");
  });
});
