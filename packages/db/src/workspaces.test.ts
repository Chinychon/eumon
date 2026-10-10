import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSite, listSitesForUser, setSiteWorkspace, siteForUser, upsertSite } from "./index.js";
import { addSiteInvites, chargeUsage, grantInvitedSites, INITIAL_WORKSPACE_ID, memberRole, memberSlotsUsed, setUpNewUser, workspaceForNewSession } from "./workspaces.js";
import { openSqliteD1 } from "./sqlite.js";
import type { D1Like } from "./d1.js";

const AT = "2026-10-10T00:00:00.000Z";

async function user(db: D1Like, id: string, email: string) {
  await db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`).bind(id, id, email, AT, AT).run();
}
async function member(db: D1Like, workspaceId: string, userId: string, role: string) {
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`).bind(`m_${workspaceId}_${userId}`, workspaceId, userId, role, AT).run();
}
async function workspace(db: D1Like, id: string) {
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(id, id, id, AT).run();
}
async function site(db: D1Like, id: string, workspaceId: string) {
  await upsertSite(db, { id, name: `${id}.com`, baseUrl: `https://${id}.com`, createdAt: AT, updatedAt: AT, workspaceId });
}

describe("site roles", () => {
  it("gives owners and members every workspace site, clients only granted ones, and strangers nothing", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1"); await workspace(db, "w2");
    for (const [id, email] of [["o", "o@x"], ["m", "m@x"], ["c", "c@x"], ["s", "s@x"]] as const) await user(db, id, email);
    await member(db, "w1", "o", "owner"); await member(db, "w1", "m", "member"); await member(db, "w1", "c", "client"); await member(db, "w2", "s", "owner");
    await site(db, "a", "w1"); await site(db, "b", "w1");
    await db.prepare("INSERT INTO site_access (user_id, site_id, created_at) VALUES ('c', 'a', ?)").bind(AT).run();

    assert.equal((await siteForUser(db, "o", "a"))?.role, "owner");
    assert.equal((await siteForUser(db, "m", "b"))?.role, "member");
    assert.equal((await siteForUser(db, "c", "a"))?.role, "client");
    assert.equal(await siteForUser(db, "c", "b"), null, "client without a grant");
    assert.equal(await siteForUser(db, "s", "a"), null, "another workspace's owner");
    assert.equal(await siteForUser(db, "o", "missing"), null);
    assert.deepEqual((await listSitesForUser(db, "c", "w1")).map((s) => s.id), ["a"]);
    assert.deepEqual((await listSitesForUser(db, "m", "w1")).map((s) => s.id).sort(), ["a", "b"]);
  });

  it("keeps a site's workspace when the site is saved again", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1");
    await site(db, "a", "w1");
    await upsertSite(db, { id: "a", name: "renamed", baseUrl: "https://a.com", createdAt: AT, updatedAt: AT });
    assert.equal((await getSite(db, "a"))?.workspaceId, "w1");
    await workspace(db, "w2");
    await setSiteWorkspace(db, "a", "w2");
    assert.equal((await getSite(db, "a"))?.workspaceId, "w2");
  });
});

describe("new users", () => {
  it("gives a new user a workspace of their own, unless an invitation waits for them", async () => {
    const db = openSqliteD1();
    await user(db, "u", "u@x");
    await setUpNewUser(db, { id: "u", name: "Una", email: "u@x", emailVerified: true }, []);
    const workspaceId = await workspaceForNewSession(db, "u", []);
    assert.ok(workspaceId && workspaceId !== INITIAL_WORKSPACE_ID);
    assert.equal(await memberRole(db, workspaceId, "u"), "owner");

    await workspace(db, "w1"); await user(db, "inviter", "i@x");
    await db.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES ('inv', 'w1', 'V@x', 'client', 'pending', ?, ?, 'inviter')`).bind("2099-01-01T00:00:00.000Z", AT).run();
    await user(db, "v", "v@x");
    await setUpNewUser(db, { id: "v", name: "Vee", email: "v@x", emailVerified: true }, []);
    assert.equal(await workspaceForNewSession(db, "v", []), null, "no personal workspace while invited");
  });

  it("makes listed admins owners of the initial workspace, verified emails only", async () => {
    const db = openSqliteD1();
    await user(db, "a", "Boss@x");
    await setUpNewUser(db, { id: "a", name: "A", email: "Boss@x", emailVerified: true }, ["boss@x"]);
    assert.equal(await workspaceForNewSession(db, "a", ["boss@x"]), INITIAL_WORKSPACE_ID);
    assert.equal(await memberRole(db, INITIAL_WORKSPACE_ID, "a"), "owner");
    await user(db, "b", "boss2@x");
    await setUpNewUser(db, { id: "b", name: "B", email: "boss2@x", emailVerified: false }, ["boss2@x"]);
    assert.equal(await memberRole(db, INITIAL_WORKSPACE_ID, "b"), null);
  });

  it("copies an accepted client invitation's sites into the user's access", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1"); await user(db, "i", "i@x"); await user(db, "c", "c@x");
    await site(db, "a", "w1");
    await db.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES ('inv', 'w1', 'c@x', 'client', 'pending', ?, ?, 'i')`).bind("2099-01-01T00:00:00.000Z", AT).run();
    await addSiteInvites(db, "inv", ["a"]);
    await member(db, "w1", "c", "client");
    await grantInvitedSites(db, "inv", "c");
    assert.equal((await siteForUser(db, "c", "a"))?.role, "client");
    assert.equal(await memberSlotsUsed(db, "w1"), 2, "the client plus the still-pending invitation row");
  });
});

describe("usage", () => {
  it("charges up to the limit and refuses past it, per day", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1");
    const charge = (amount: number, day = "2026-10-10") => chargeUsage(db, { workspaceId: "w1", day, metric: "askPerDay", amount, limit: 3 });
    assert.equal(await charge(2), true);
    assert.equal(await charge(1), true);
    assert.equal(await charge(1), false);
    assert.equal(await charge(4, "2026-10-11"), false, "more than the limit at once");
    assert.equal(await charge(1, "2026-10-11"), true, "a new day");
    assert.equal(await chargeUsage(db, { workspaceId: "w1", day: "2026-10-10", metric: "askPerDay", amount: 50, limit: null }), true, "unlimited");
  });
});
