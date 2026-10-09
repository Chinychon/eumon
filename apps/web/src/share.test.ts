import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signToken } from "@organic-growth/core";
import { bumpReportShareVersion, getSite, upsertSite } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { shareToken, siteForShareToken } from "./share.ts";

const secret = "s".repeat(40);

describe("client link", () => {
  it("opens the site until revoked, and never another site", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    const token = await shareToken((await getSite(db, "s"))!, secret);
    assert.equal((await siteForShareToken(db, token, secret))?.id, "s");
    assert.equal(await siteForShareToken(db, `${token}x`, secret), null, "a tampered token");
    await bumpReportShareVersion(db, "s");
    assert.equal(await siteForShareToken(db, token, secret), null, "revoked");
  });

  it("only accepts tokens made as client links", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    const other = await signToken({ siteId: "s", v: 1 }, 60_000, secret);
    assert.equal(await siteForShareToken(db, other, secret), null, "a token signed for something else");
  });
});
