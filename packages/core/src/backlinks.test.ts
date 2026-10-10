import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backlinksView, classifyReferringDomains, spamNetworks, type ReferringDomain } from "./backlinks.js";

const SITE = "x.com";
const row = (i: number, over: Partial<ReferringDomain> = {}) => ({
  domain: `site${i}.com`, urlFrom: `https://site${i}.com/page-${i}`, urlTo: "https://x.com/", anchor: `topic ${i}`,
  dofollow: true, firstSeen: "2026-09-01", lastSeen: "2026-10-01", lost: false, broken: false, rank: 10, spamScore: null, ...over,
});
const many = (n: number, over: (i: number) => Partial<ReferringDomain>) => Array.from({ length: n }, (_, i) => row(i, over(i)));
const verdicts = (rows: ReturnType<typeof row>[]) => classifyReferringDomains(rows, SITE).map((r) => r.spamReason);

describe("classifyReferringDomains", () => {
  it("a link-selling anchor is spam", () => {
    const [r] = classifyReferringDomains([row(1, { anchor: "High Quality Dofollow Backlinks DA 50 PA 40 Premium PBN Network Service x.com Rank First Page Google" })], SITE);
    assert.equal(r.spam, true);
    assert.equal(r.spamReason, "Link-selling anchor");
  });

  it("the same anchor on ten sites is a network, and the site's domain inside it doesn't stop that", () => {
    const anchor = "Premium SEO Authority Backlinks to Help x.com Websites Rank Higher";
    const out = classifyReferringDomains(many(10, () => ({ anchor })), SITE);
    assert.ok(out.every((r) => r.spam && r.spamReason === "Same anchor on 10 sites"));
    // nine on a neutral anchor: not a network
    assert.ok(verdicts(many(9, () => ({ anchor: "great local clinic x.com review" }))).every((v) => v === null));
    // nine on a sales anchor: caught by the sales rule instead
    assert.ok(verdicts(many(9, () => ({ anchor }))).every((v) => v === "Link-selling anchor"));
  });

  it("the same page path on ten sites is a network", () => {
    const out = classifyReferringDomains(many(10, (i) => ({ urlFrom: `https://site${i}.com/dir/seo-growth-backlinks-133226` })), SITE);
    assert.ok(out.every((r) => r.spam && r.spamReason === "Same page path on 10 sites"));
  });

  it("brand anchors are never a network by anchor alone", () => {
    const out = classifyReferringDomains(many(12, (i) => ({ anchor: i % 2 ? "x.com" : "X" })), SITE);
    assert.ok(out.every((r) => !r.spam));
    const empty = classifyReferringDomains(many(12, () => ({ anchor: "" })), SITE);
    assert.ok(empty.every((r) => !r.spam));
  });

  it("shared generic paths are not a network", () => {
    for (const path of ["/", "/partners", "/about", "/members/directory"]) {
      assert.ok(verdicts(many(10, (i) => ({ urlFrom: `https://site${i}.com${path}` }))).every((v) => v === null), path);
    }
  });

  it("brand and generic anchors are not a network", () => {
    const med = (anchor: string) => classifyReferringDomains(many(10, () => ({ anchor })), "medbaycare.com").map((r) => r.spamReason);
    for (const a of ["MedBay Care Clinic", "https://medbaycare.com/", "www.medbaycare.com", "Website", "click here"]) {
      assert.ok(med(a).every((v) => v === null), a);
    }
  });

  it("sales metrics are case-sensitive and short", () => {
    for (const a of ["Dr 5 Tan", "Prezzi da 30 euro", "45 Harbor Dr 200", "DA 2026 conference", "first page of results"]) {
      assert.equal(verdicts([row(1, { anchor: a })])[0], null, a);
    }
    for (const a of ["🚀DA50🚀", "High Quality Dofollow Backlinks DA 50 PA 40"]) {
      assert.equal(verdicts([row(1, { anchor: a })])[0], "Link-selling anchor", a);
    }
  });

  it("calibration networks stay spam", () => {
    const anchor = "Premium SEO Authority Backlinks to Help medbaycare.com Websites Rank Higher";
    const out = classifyReferringDomains(many(687, () => ({ anchor })), "medbaycare.com");
    assert.ok(out.every((r) => r.spamReason === "Same anchor on 687 sites"));
    for (const path of ["/dir/seo-growth-backlinks-133226", "/share/134128", "/all/1873/27.html", "/site/medbaycare.com"]) {
      const o = classifyReferringDomains(many(10, (i) => ({ urlFrom: `https://s${i}.com${path}` })), "medbaycare.com");
      assert.ok(o.every((r) => r.spamReason === "Same page path on 10 sites"), path);
    }
    const q = classifyReferringDomains(many(10, (i) => ({ urlFrom: `https://s${i}.com/list.php?part=${i}` })), "medbaycare.com");
    assert.ok(q.every((r) => r.spam));
  });

  it("a trailing slash doesn't split a path", () => {
    const rows = many(10, (i) => ({ urlFrom: `https://s${i}.com/share/1${i % 2 ? "/" : ""}` }));
    assert.ok(verdicts(rows).every((v) => v === "Same page path on 10 sites"));
  });

  it("a spam score of 70 or more is spam; 69 isn't", () => {
    const [a, b] = classifyReferringDomains([row(1, { spamScore: 70 }), row(2, { spamScore: 69 })], SITE);
    assert.equal(a.spam, true);
    assert.equal(a.spamReason, "Spam score 70");
    assert.equal(b.spam, false);
    assert.equal(b.spamReason, null);
  });

  it("a clean profile", () => {
    const out = classifyReferringDomains(many(5, () => ({})), SITE);
    assert.ok(out.every((r) => !r.spam));
    assert.deepEqual(spamNetworks(out), []);
  });
});

describe("spamNetworks", () => {
  it("groups by the shared anchor or path, with the earliest first seen and an example", () => {
    const anchor = "Premium SEO Authority Backlinks to Help x.com Websites Rank Higher";
    const rows = classifyReferringDomains([
      ...many(12, (i) => ({ anchor, firstSeen: `2026-09-${String(20 - i).padStart(2, "0")}` })),
      ...many(10, (i) => ({ domain: `p${i}.com`, anchor: `n${i}`, urlFrom: `https://p${i}.com/share/134128` })),
    ], SITE);
    const nets = spamNetworks(rows);
    assert.equal(nets.length, 2);
    assert.deepEqual([nets[0].kind, nets[0].domains, nets[0].since, nets[0].example], ["anchor", 12, "2026-09-09", "https://site11.com/page-11"]);
    assert.equal(nets[0].label.toLowerCase(), anchor.toLowerCase());
    assert.deepEqual([nets[1].kind, nets[1].domains, nets[1].label], ["path", 10, "/share/134128"]);
  });
});

describe("backlinksView", () => {
  it("the lists and anchor mix, capped", () => {
    const top = classifyReferringDomains(many(30, (i) => ({ anchor: i < 5 ? "" : i < 12 ? "clinic" : `a${i}` })), SITE);
    const counts = { real: 30, spam: 0, newReal: 0, lostReal: 0, brokenReal: 0, dofollowReal: 30, newSpam: 0 };
    const view = backlinksView({ asOf: "2026-10-10", counts, top, newReal: top.slice(0, 2), lostReal: [], brokenReal: [], networks: [] });
    const net = (i: number) => ({ key: `anchor:${i}`, kind: "anchor" as const, label: `a${i}`, domains: 20 - i, since: "2026-09-01", example: "https://n.example/" });
    assert.equal(view.top.length, 25);
    assert.deepEqual(view.anchors.slice(0, 2), [{ anchor: "clinic", domains: 7 }, { anchor: "(no text)", domains: 5 }]);
    assert.equal(view.newReal.length, 2);
    assert.deepEqual(view.networks, []);
    assert.equal(backlinksView({ asOf: null, counts, top: [], newReal: [], lostReal: [], brokenReal: [], networks: Array.from({ length: 7 }, (_, i) => net(i)) }).networks.length, 5);
  });
});
