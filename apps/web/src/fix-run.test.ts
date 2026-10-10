import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonLlm } from "@organic-growth/ai";
import { getFix, listFixes, stageFix, updateFix, upsertSite, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { JSON_LD_COMPONENT, type FixCandidate } from "@organic-growth/fixes";
import { checkMergedFixes, openStagedFixes, stageCandidates, type FixDeps } from "./fix-run.ts";

const AT = "2026-10-10T00:00:00.000Z";
const pageFile = `export async function generateMetadata({ params }) {\n  const { slug } = await params;\n  const procedure = await get(slug);\n  return {\n    title: procedure.name,\n  };\n}\nexport default async function Page() { return <main><h1>x</h1></main>; }\n`;
const html = (name: string) => `<html><head><title>${name}</title></head><body><h1>${name}</h1><p>${name} in Malaysia from RM 900 with 120 specialists.</p></body></html>`;

async function setup() {
  const db: D1Like = openSqliteD1();
  await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
  await db.prepare("INSERT INTO analyses (id, site_id, status, created_at) VALUES ('a', 's', 'completed', ?)").bind(AT).run();
  const files: Record<string, { content: string; sha: string }> = { "app/procedures/[slug]/page.tsx": { content: pageFile, sha: "sha1" } };
  const deps: FixDeps = {
    db, now: () => new Date(AT), budget: { calls: 10 },
    repo: { owner: "acme", name: "web", branch: "main", treePaths: Object.keys(files), getFile: async (p) => files[p] ?? null },
    fetchPage: async (url) => ({ status: 200, body: html(url.endsWith("mri") ? "MRI Scan" : "ACL Reconstruction") }),
    llm: null,
  };
  return { db, deps, files };
}
const head: FixCandidate = {
  kind: "head", file: "app/procedures/[slug]/page.tsx",
  route: { pathPattern: "/procedures/:slug", source: "app/procedures/[slug]/page.tsx", dynamic: true, rendering: "ssr", metadata: "server" },
  problems: ["canonical-missing"], urls: ["https://x.com/procedures/acl"], pageCount: 2, score: 6,
};
const input = { siteId: "s", analysisId: "a", origin: "https://x.com", siteName: "MedBay", language: "en", queries: [], pages: [], sensitivePaths: [] };
const prs = () => {
  const opened: Array<{ branch: string; body: string; files: Record<string, string> }> = [];
  return { opened, ops: { createPr: async (pr: { branch: string; title: string; body: string; files: Record<string, string> }) => { opened.push(pr); return { number: opened.length, url: `https://github.com/acme/web/pull/${opened.length}`, nodeId: "N", headSha: `h${opened.length}` }; } } };
};

describe("fix run", () => {
  it("stages a validated canonical fix and opens it as a draft within budget", async () => {
    const { db, deps } = await setup();
    assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [head] }), { staged: 1, skipped: 0 });
    const [fix] = await listFixes(db, "s");
    assert.match(fix!.files["app/procedures/[slug]/page.tsx"]!, /canonical: `\/procedures\/\$\{slug\}`/);
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 1);
    assert.equal(opened[0]!.branch, `eumon/head-procedures-slug-${fix!.id.slice(-6)}`);
    assert.match(opened[0]!.branch, /^eumon\/head-procedures-slug-.{6}$/);
    assert.match(opened[0]!.body, /## After\n\n```\n[^`]*canonical: `\/procedures\/\$\{slug\}`[\s\S]*revert this PR's single commit[\s\S]*Opened by Eumon's fix engine\.$/);
    assert.equal((await getFix(db, fix!.id))?.status, "draft");
  });

  it("never re-stages a route and kind that's open or rejected", async () => {
    const { deps } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [head] }), { staged: 0, skipped: 0 });
  });

  it("closes a staged fix whose file changed before the PR (Review Focus 1)", async () => {
    const { db, deps, files } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    files["app/procedures/[slug]/page.tsx"] = { content: pageFile + "\n// edited", sha: "sha2" };
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 0);
    assert.equal(opened.length, 0);
    assert.equal((await listFixes(db, "s"))[0]?.status, "closed");
  });

  it("skips with a snippet when there's no AI for the words", async () => {
    const { db, deps } = await setup();
    await stageCandidates(deps, { ...input, candidates: [{ ...head, problems: ["title-missing"] }] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
  });

  it("opens a revert PR when the recrawl finds merged pages broken", async () => {
    const { db, deps, files } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    const [fix] = await listFixes(db, "s");
    await updateFix(db, fix!.id, { status: "merged" });
    files["app/procedures/[slug]/page.tsx"] = { content: fix!.files["app/procedures/[slug]/page.tsx"]!, sha: "merged" };
    const { opened, ops } = prs();
    const pages = [{ url: "https://x.com/procedures/acl", status: 500, hreflang: [], jsonLdTypes: [] }];
    assert.equal(await checkMergedFixes(deps, ops, { siteId: "s", pages }), 1);
    assert.equal(opened[0]!.files["app/procedures/[slug]/page.tsx"], pageFile);
    assert.equal((await getFix(db, fix!.id))?.status, "reverted");
    assert.match(opened[0]!.branch, new RegExp(`^eumon/revert-${fix!.id.slice(-6)}-`));
  });
});

const fakeLlm = (answers: unknown[]): JsonLlm => ({ model: "fake", async json<T>() { return answers.shift() as T; } });
const pageWithData = `export default async function Page({ params }) {\n  const { slug } = await params;\n  const procedure = await get(slug);\n  return (\n    <main>\n      <h1>{procedure.name}</h1>\n    </main>\n  );\n}\n`;
const urls = ["https://x.com/procedures/acl", "https://x.com/procedures/mri"];
const examples = [{ url: urls[0], values: [{ path: "procedure.name", value: "ACL Reconstruction" }] }, { url: urls[1], values: [{ path: "procedure.name", value: "MRI Scan" }] }];
const jsonld: FixCandidate = { ...head, kind: "jsonld", problems: [], urls, schemaType: "MedicalProcedure" };
const layout = `export const metadata = {\n  title: "X",\n};\nexport default function RootLayout({ children }) { return <html><body>{children}</body></html>; }\n`;

describe("fix run rulings", () => {
  it("writes title and description with the AI and checks them", async () => {
    const { db, deps } = await setup();
    deps.llm = fakeLlm([
      { skip: false, reason: "", facts: ["offered in Malaysia"], titleSubject: "procedure.name", titleQualifier: null, schema: [], examples,
        description: "{procedure.name} in Malaysia: compare costs and specialists, then send an enquiry for a written quote from the hospital team." },
      { supported: true, problems: [] },
    ]);
    await stageCandidates(deps, { ...input, candidates: [{ ...head, urls, problems: ["canonical-missing", "description-missing", "title-missing"] }] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "staged", fix?.result ?? "");
    const after = fix!.files["app/procedures/[slug]/page.tsx"]!;
    assert.match(after, /title: `\$\{procedure\.name\} \| MedBay`/);
    assert.match(after, /description: `\$\{procedure\.name\} in Malaysia/);
    assert.equal(fix!.promptSha, "fix-text-1");
  });

  it("stages structured data with Eumon's component file", async () => {
    const { db, deps, files } = await setup();
    files["app/procedures/[slug]/page.tsx"] = { content: pageWithData, sha: "sha1" };
    deps.repo.treePaths = [...Object.keys(files), "tsconfig.json"];
    deps.llm = fakeLlm([{ skip: false, reason: "", facts: [], titleSubject: null, titleQualifier: null, description: null, schema: [{ field: "name", path: "procedure.name" }], examples }]);
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "staged", fix?.result ?? "");
    assert.equal(fix!.files["components/eumon-json-ld.tsx"], JSON_LD_COMPONENT);
    assert.match(fix!.files["app/procedures/[slug]/page.tsx"]!, /<EumonJsonLd data=/);
  });

  it("skips structured data when the component file exists with other content", async () => {
    const { db, deps, files } = await setup();
    files["components/eumon-json-ld.tsx"] = { content: "export const x = 1;\n", sha: "c1" };
    deps.repo.treePaths = ["app/procedures/[slug]/page.tsx", "tsconfig.json"]; // a truncated tree that misses the component
    deps.llm = fakeLlm([]);
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
    assert.match(fix!.result!, /eumon-json-ld\.tsx/);
  });

  it("skips structured data on a site without TypeScript", async () => {
    const { db, deps } = await setup();
    deps.llm = fakeLlm([]);
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
    assert.match(fix!.result!, /doesn't use TypeScript/);
  });

  it("turns a throwing getFile into a skipped row", async () => {
    const { db, deps } = await setup();
    deps.repo.getFile = async () => { throw new Error("the file is over 1 MB"); };
    assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [head] }), { staged: 0, skipped: 1 });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
    assert.match(fix!.result!, /Eumon couldn't prepare this fix: the file is over 1 MB/);
  });

  it("opens at most `max` PRs per call, highest score first", async () => {
    const { db, deps, files } = await setup();
    files["app/layout.tsx"] = { content: layout, sha: "l1" };
    const base: FixCandidate = { kind: "metadata-base", file: "app/layout.tsx", problems: ["canonical-missing"], urls: [], pageCount: 4, score: 20 };
    assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [base, head] }), { staged: 2, skipped: 0 });
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3, max: 1 }), 1);
    assert.match(opened[0]!.files["app/layout.tsx"]!, /metadataBase: new URL\("https:\/\/x\.com"\)/);
    assert.equal((await listFixes(db, "s", ["staged"])).length, 1);
  });

  it("examines at most twice `max` staged fixes per call", async () => {
    const { db, deps, files } = await setup();
    await stageCandidates(deps, { ...input, candidates: [head] });
    const [fix] = await listFixes(db, "s");
    for (let i = 0; i < 9; i++) await stageFix(db, { ...fix!, id: `copy${i}`, route: `/copy${i}` });
    files["app/procedures/[slug]/page.tsx"] = { content: pageFile + "\n// edited", sha: "sha2" };
    let reads = 0;
    const counted: FixDeps = { ...deps, repo: { ...deps.repo, getFile: async (p) => { reads++; return deps.repo.getFile(p); } } };
    const { ops } = prs();
    assert.equal(await openStagedFixes(counted, ops, { siteId: "s", origin: "https://x.com", budget: 3, max: 3 }), 0);
    assert.ok(reads <= 6, `read ${reads} files`);
    assert.equal((await listFixes(db, "s", ["staged"])).length, 4);
  });

  it("closes a new llms.txt fix when the file appeared after the analysis", async () => {
    const { db, deps, files } = await setup();
    const pages = [{ url: "https://x.com/", status: 200, title: "Home", description: "Clinics in Malaysia.", hreflang: [], jsonLdTypes: [] }];
    const llms: FixCandidate = { kind: "llms-txt", file: "public/llms.txt", problems: [], urls: [], pageCount: 1, score: 50 };
    await stageCandidates(deps, { ...input, pages, candidates: [llms] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.fileSha, "new");
    assert.match(fix!.files["public/llms.txt"]!, /> Clinics in Malaysia\./);
    files["public/llms.txt"] = { content: "# mine\n", sha: "m1" };
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 0);
    assert.equal(opened.length, 0);
    assert.equal((await getFix(db, fix!.id))?.status, "closed");
  });
});

async function stageJsonLdFix() {
  const ctx = await setup();
  ctx.files["app/procedures/[slug]/page.tsx"] = { content: pageWithData, sha: "sha1" };
  ctx.deps.repo.treePaths = ["app/procedures/[slug]/page.tsx", "tsconfig.json"];
  ctx.deps.llm = fakeLlm([{ skip: false, reason: "", facts: [], titleSubject: null, titleQualifier: null, description: null, schema: [{ field: "name", path: "procedure.name" }], examples }]);
  return ctx;
}
const mergedHead = async () => {
  const ctx = await setup();
  await stageCandidates(ctx.deps, { ...input, candidates: [head] });
  const [fix] = await listFixes(ctx.db, "s");
  await updateFix(ctx.db, fix!.id, { status: "merged" });
  return { ...ctx, fix: fix! };
};

describe("fix run guards", () => {
  it("reuses Eumon's component when it's already there, even outside the listed tree", async () => {
    const { db, deps, files } = await stageJsonLdFix();
    files["components/eumon-json-ld.tsx"] = { content: JSON_LD_COMPONENT, sha: "c1" };
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "staged", fix?.result ?? "");
    assert.deepEqual(Object.keys(fix!.files), ["app/procedures/[slug]/page.tsx"]);
  });

  it("closes a fix when a file it adds appeared with other content before the PR", async () => {
    const { db, deps, files } = await stageJsonLdFix();
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    const [fix] = await listFixes(db, "s");
    assert.ok(fix!.files["components/eumon-json-ld.tsx"]);
    files["components/eumon-json-ld.tsx"] = { content: "export const mine = 1;\n", sha: "c2" };
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 0);
    assert.equal(opened.length, 0);
    assert.equal((await getFix(db, fix!.id))?.status, "closed");
  });

  it("stores a snippet when the AI can't write structured data", async () => {
    const { db, deps } = await stageJsonLdFix();
    deps.llm = fakeLlm([{ skip: true, reason: "The pages don't name the procedure." }]);
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
    assert.match(fix!.snippet ?? "", /application\/ld\+json/);
  });

  it("doesn't fetch samples when the AI budget is used up", async () => {
    const { db, deps } = await stageJsonLdFix();
    deps.budget.calls = 0;
    let fetched = 0;
    deps.fetchPage = async () => { fetched++; return null; };
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    assert.equal(fetched, 0);
    assert.equal((await listFixes(db, "s"))[0]?.status, "skipped");
  });

  it("drops a sample page whose fetch throws", async () => {
    const { db, deps } = await stageJsonLdFix();
    const fetchPage = deps.fetchPage;
    deps.fetchPage = async (url) => { if (url.endsWith("mri")) throw new Error("timeout"); return fetchPage(url); };
    deps.llm = fakeLlm([{ skip: false, reason: "", facts: [], titleSubject: null, titleQualifier: null, description: null, schema: [{ field: "name", path: "procedure.name" }], examples: [examples[0]] }]);
    await stageCandidates(deps, { ...input, candidates: [jsonld] });
    assert.equal((await listFixes(db, "s"))[0]?.status, "staged");
  });

  it("logs and skips a candidate whose row can't be saved", async () => {
    const { db, deps } = await setup();
    const prepare = db.prepare.bind(db);
    deps.db = { prepare: (sql: string) => { if (sql.startsWith("INSERT INTO changes")) throw new Error("D1 is down"); return prepare(sql); } } as unknown as D1Like;
    const errors = console.error;
    console.error = () => {};
    try { assert.deepEqual(await stageCandidates(deps, { ...input, candidates: [head] }), { staged: 0, skipped: 0 }); } finally { console.error = errors; }
  });

  it("keeps opening the next fix when reading the top one throws", async () => {
    const { db, deps, files } = await setup();
    files["app/layout.tsx"] = { content: layout, sha: "l1" };
    const base: FixCandidate = { kind: "metadata-base", file: "app/layout.tsx", problems: ["canonical-missing"], urls: [], pageCount: 4, score: 20 };
    await stageCandidates(deps, { ...input, candidates: [base, head] });
    const getFile = deps.repo.getFile;
    deps.repo.getFile = async (p) => { if (p === "app/layout.tsx") throw new Error("GitHub said 502"); return getFile(p); };
    const { opened, ops } = prs();
    assert.equal(await openStagedFixes(deps, ops, { siteId: "s", origin: "https://x.com", budget: 3 }), 1);
    assert.match(opened[0]!.branch, /^eumon\/head-/);
    const layoutFix = (await listFixes(db, "s")).find((f) => f.kind === "metadata-base");
    assert.equal(layoutFix?.status, "closed");
    assert.match(layoutFix?.result ?? "", /next run/);
  });

  it("waits for a recrawl that includes a head fix's pages, but verifies url-less fixes", async () => {
    const { db, deps, fix } = await mergedHead();
    const llms = { ...fix, id: "llms1", kind: "llms-txt", route: "public/llms.txt", filePath: "public/llms.txt", urls: [], problems: [] };
    await stageFix(db, { ...llms, status: "merged" });
    const { opened, ops } = prs();
    assert.equal(await checkMergedFixes(deps, ops, { siteId: "s", pages: [] }), 0);
    assert.equal(opened.length, 0);
    assert.equal((await getFix(db, fix.id))?.verification, undefined);
    assert.equal((await getFix(db, "llms1"))?.verification?.recrawl, "ok");
  });

  it("leaves the revert to the user when the file changed after the merge", async () => {
    const { db, deps, files, fix } = await mergedHead();
    files["app/procedures/[slug]/page.tsx"] = { content: fix.files["app/procedures/[slug]/page.tsx"] + "\n// later work", sha: "later" };
    const { opened, ops } = prs();
    const pages = [{ url: "https://x.com/procedures/acl", status: 500, hreflang: [], jsonLdTypes: [] }];
    assert.equal(await checkMergedFixes(deps, ops, { siteId: "s", pages }), 0);
    assert.equal(opened.length, 0);
    const after = await getFix(db, fix.id);
    assert.equal(after?.status, "merged");
    assert.deepEqual({ recrawl: after?.verification?.recrawl, revert: after?.verification?.revert }, { recrawl: "broken", revert: "manual" });
    assert.match(after?.result ?? "", /Revert button/);
  });

  it("keeps checking merged fixes when a revert PR fails", async () => {
    const { db, deps, files, fix } = await mergedHead();
    files["app/procedures/[slug]/page.tsx"] = { content: fix.files["app/procedures/[slug]/page.tsx"]!, sha: "merged" };
    await stageFix(db, { ...fix, id: "other", route: "/other", urls: ["https://x.com/other"], score: 1, status: "merged" });
    const pages = [{ url: "https://x.com/procedures/acl", status: 500, hreflang: [], jsonLdTypes: [] }, { url: "https://x.com/other", status: 200, title: "Other", hreflang: [], jsonLdTypes: [] }];
    const ops = { createPr: async () => { throw new Error("reference already exists"); } };
    assert.equal(await checkMergedFixes(deps, ops, { siteId: "s", pages }), 0);
    const failed = await getFix(db, fix.id);
    assert.deepEqual({ recrawl: failed?.verification?.recrawl, revert: failed?.verification?.revert }, { recrawl: "broken", revert: "failed" });
    assert.equal((await getFix(db, "other"))?.verification?.recrawl, "ok");
  });
});

import { parseFixSettings } from "./fix-run.ts";

describe("parseFixSettings", () => {
  it("accepts booleans and a budget from 1 to 5", () => {
    assert.deepEqual(parseFixSettings({ allowAiSearch: true, budget: 2, autopilot: false }), { allowAiSearch: true, budget: 2, autopilot: false });
  });
  it("explains what's wrong otherwise", () => {
    assert.equal(typeof parseFixSettings({ allowAiSearch: "yes", budget: 2, autopilot: true }), "string");
    assert.equal(typeof parseFixSettings({ allowAiSearch: true, budget: 9, autopilot: true }), "string");
    assert.equal(typeof parseFixSettings(null), "string");
  });
});

const aboutFile = `export const metadata = {\n  title: "About us",\n};\nexport default function Page() { return <main><h1>About</h1></main>; }\n`;
const about: FixCandidate = {
  kind: "head", file: "app/about/page.tsx",
  route: { pathPattern: "/about", source: "app/about/page.tsx", dynamic: false, rendering: "static", metadata: "server" },
  problems: ["hreflang-missing"], urls: ["https://x.com/about", "https://x.com/id/about"], pageCount: 2, score: 6, pathLocales: { "/about": ["default", "id"] },
};

describe("hreflang and alternates (I1)", () => {
  it("leaves hreflang to a snippet on a route under a [locale] segment", async () => {
    const { db, deps, files } = await setup();
    files["app/[locale]/about/page.tsx"] = { content: aboutFile, sha: "a1" };
    const route = { ...about.route!, pathPattern: "/:locale/about", source: "app/[locale]/about/page.tsx", dynamic: true };
    await stageCandidates(deps, { ...input, candidates: [{ ...about, file: route.source, route }] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
    assert.deepEqual(fix?.files, {});
    assert.match(fix?.snippet ?? "", /languages/);
  });

  it("builds languages only from the locales the path exists in", async () => {
    const { db, deps, files } = await setup();
    files["app/about/page.tsx"] = { content: aboutFile, sha: "a1" };
    await stageCandidates(deps, { ...input, candidates: [about] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "staged", fix?.result ?? "");
    assert.match(fix!.files["app/about/page.tsx"]!, /languages: \{ "x-default": "\/about", "en": "\/about", "id": "\/id\/about" \}/);
    assert.doesNotMatch(fix!.files["app/about/page.tsx"]!, /zh/);
  });

  it("skips a canonical-only alternates when the crawled pages already have hreflang", async () => {
    const { db, deps, files } = await setup();
    files["app/about/page.tsx"] = { content: aboutFile, sha: "a1" };
    const pages = [{ url: "https://x.com/about", status: 200, title: "About", hreflang: [{ lang: "id", href: "https://x.com/id/about" }], jsonLdTypes: [] }];
    await stageCandidates(deps, { ...input, pages, candidates: [{ ...about, problems: ["canonical-missing"], urls: ["https://x.com/about"], pathLocales: undefined }] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "skipped");
    assert.match(fix?.result ?? "", /replace/);
    assert.match(fix?.snippet ?? "", /canonical: "\/about"/);
  });
});

describe("title template (I2)", () => {
  it("writes only the subject and qualifier when the root layout has a title template", async () => {
    const { db, deps } = await setup();
    deps.llm = fakeLlm([
      { skip: false, reason: "", facts: [], titleSubject: "procedure.name", titleQualifier: null, description: null, schema: [], examples },
      { supported: true, problems: [] },
    ]);
    await stageCandidates(deps, { ...input, titleTemplate: "%s | MedBay", candidates: [{ ...head, urls, problems: ["title-missing"] }] });
    const [fix] = await listFixes(db, "s");
    assert.equal(fix?.status, "staged", fix?.result ?? "");
    assert.match(fix!.files["app/procedures/[slug]/page.tsx"]!, /title: `\$\{procedure\.name\}`,/);
  });
});
