// End-to-end evaluation of the collection pipeline on a real website.
//
// Runs the same steps the scrape Workflow runs — list discovery (with
// pagination), extraction with the configured model, merging repeated
// mentions, and duplicate resolution — against edeadesign.com.my, then grades
// the result against an answer key parsed deterministically (no AI) from the
// same pages. Use it before and after changing prompts or merge logic.
//
//   npm run eval            (needs DEEPSEEK_API_KEY or ANTHROPIC_API_KEY;
//                            read from the environment or apps/web/.dev.vars)
//
// A run makes ~30 model calls (a few US cents) and fetches ~30 public pages.

import { existsSync, readFileSync } from "node:fs";
import { createLlm } from "@organic-growth/ai";
import { mergeRecordData } from "@organic-growth/core";
import { expandSource, extractRecordsFromHtml, findDuplicateRecords, htmlToText, PoliteFetcher } from "@organic-growth/scraper";

const SITE = "https://edeadesign.com.my";
// Loose enough for run-to-run model variance, tight enough to catch regressions
// such as list facts being overwritten instead of accumulated (recall fell to 22%).
const THRESHOLDS = { venuePrecision: 0.95, claimPrecision: 0.98, claimRecall: 0.9 };

// The dataset as the scoping step proposes it for this site.
const dataset = {
  name: "Shopping Malls",
  entityType: "shopping mall",
  description: "Malaysian shopping malls where the business is a panel hoarding contractor or has completed hoarding projects.",
  keyField: "name",
  fields: [
    { key: "name", label: "Mall name", type: "text", required: true },
    { key: "mall_group", label: "Mall owner / management group", type: "text" },
    { key: "city", label: "City / area", type: "text" },
    { key: "state", label: "State", type: "text" },
    { key: "panel_contractor", label: "Panel contractor status", type: "boolean" },
    { key: "recent_clients", label: "Retail brands hoarded here", type: "list" },
  ],
};

function loadEnv() {
  const env = { ...process.env };
  const devVars = new URL("../apps/web/.dev.vars", import.meta.url);
  if (existsSync(devVars)) {
    for (const line of readFileSync(devVars, "utf8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].replace(/^"|"$/g, "");
    }
  }
  return env;
}

// ---- Answer key: parsed from the pages' own markup, no model involved ------

// The site appends locations inconsistently ("Sunway Pier, Port Klang", "Queensbay Mall (Penang)").
const venueName = (name) => name.replace(/\s*\([^)]*\)\s*$/, "").replace(/,\s*[^,]+$/, "").trim();
// A few portfolio headings are project titles rather than brands.
const isProjectTitle = (heading) => /\bproject\b|merry christmas/i.test(heading);

async function answerKey(fetcher, portfolioPages) {
  const venues = new Set();
  const panel = htmlToText((await fetcher.fetch(`${SITE}/our-services/shopping-mall-panel-contractor`)).body);
  let inClients = false;
  for (const line of panel.split("\n")) {
    if (/^## /.test(line)) inClients = /clients we currently work with/i.test(line);
    else if (/^#### /.test(line)) inClients = inClients && !/brand clients/i.test(line);
    else if (inClients && line.startsWith("- ")) venues.add(venueName(line.slice(2)));
  }
  const pairs = [];
  for (const url of portfolioPages) {
    const lines = htmlToText((await fetcher.fetch(url)).body).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const heading = lines[i].match(/^#{6} (.+)$/)?.[1];
      if (!heading) continue;
      const next = lines[i + 1] ?? "";
      if (/^\d+ photos?$/.test(next)) venues.add(venueName(heading));
      else {
        venues.add(venueName(next));
        if (!isProjectTitle(heading)) pairs.push({ brand: heading, venue: venueName(next) });
      }
    }
  }
  return { venues: [...venues], pairs };
}

// Venue names are written inconsistently on the site ("My Town" / "MyTown Shopping Mall").
const STOP = new Set(["mall", "shopping", "centre", "center", "the", "penang", "johor", "jb"]);
const ALIAS = { "1mk": "1 mont kiara", "my town": "mytown", "one utama": "1 utama" };
const words = (name) => {
  let value = name.toLowerCase().trim();
  value = ALIAS[value] ?? value;
  value = value.replace("1st", "first").replace("my town", "mytown");
  return new Set(value.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word && !STOP.has(word)));
};
// Same venue only when the distinctive words match exactly: "Gurney Plaza" and
// "Gurney Paragon Mall" share a word but are different malls.
const sameVenue = (a, b) => {
  const left = words(a);
  const right = words(b);
  return left.size > 0 && left.size === right.size && [...left].every((word) => right.has(word));
};
const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

// ---- The pipeline under test ----------------------------------------------

async function runPipeline(llm, fetcher, urls) {
  const records = new Map();
  for (const url of urls) {
    const response = await fetcher.fetch(url);
    const { records: extracted } = await extractRecordsFromHtml({ llm, dataset, url: response.finalUrl, html: response.body });
    for (const record of extracted) {
      const prior = records.get(record.key);
      // Same merge rule as storage: new single values win, lists accumulate.
      records.set(record.key, prior ? mergeRecordData(dataset.fields, record.data, [prior]) : record.data);
    }
    process.stdout.write(".");
  }
  const list = [...records].map(([key, data], index) => ({ id: `r${index}`, key, data }));
  const clusters = await findDuplicateRecords({ llm, dataset, records: list });
  const byId = new Map(list.map((record) => [record.id, record]));
  for (const cluster of clusters) {
    const canonical = byId.get(cluster.canonicalId);
    const duplicates = cluster.duplicateIds.map((id) => byId.get(id));
    canonical.data = mergeRecordData(dataset.fields, canonical.data, duplicates.map((record) => record.data));
    for (const duplicate of duplicates) byId.delete(duplicate.id);
  }
  process.stdout.write("\n");
  return { records: [...byId.values()], merged: clusters.reduce((sum, cluster) => sum + cluster.duplicateIds.length, 0) };
}

// ---- Run and grade ---------------------------------------------------------

const env = loadEnv();
const llm = createLlm({ DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, LLM_MODEL: env.LLM_MODEL });
const fetcher = new PoliteFetcher();
const portfolio = await expandSource({ url: `${SITE}/project-highlights`, kind: "page", maxPages: 50 }, fetcher);
const sources = [`${SITE}/our-services/shopping-mall-panel-contractor`, ...portfolio.urls];
console.log(`Model: ${llm.model} · ${sources.length} pages (${portfolio.urls.length} portfolio pages found by pagination)`);

const key = await answerKey(fetcher, portfolio.urls);
const { records, merged } = await runPipeline(llm, fetcher, sources);

const notVenues = records.filter((record) => !key.venues.some((venue) => sameVenue(String(record.data.name), venue)));
const duplicatesLeft = records.flatMap((record, index) =>
  records.slice(index + 1).filter((other) => sameVenue(String(record.data.name), String(other.data.name))).map((other) => `${record.data.name} ≈ ${other.data.name}`));
const claims = records.flatMap((record) => (record.data.recent_clients ?? []).map((brand) => ({ brand, venue: String(record.data.name) })));
const wrongClaims = claims.filter((claim) => !key.pairs.some((pair) => norm(pair.brand) === norm(claim.brand) && sameVenue(pair.venue, claim.venue)));
const realPairs = key.pairs.filter((pair) => !sameVenue(pair.brand, pair.venue));
const missed = realPairs.filter((pair) => !records.some((record) =>
  sameVenue(pair.venue, String(record.data.name)) && (record.data.recent_clients ?? []).some((brand) => norm(brand) === norm(pair.brand))));

const venuePrecision = records.length ? (records.length - notVenues.length) / records.length : 0;
const claimPrecision = claims.length ? (claims.length - wrongClaims.length) / claims.length : 0;
const claimRecall = realPairs.length ? (realPairs.length - missed.length) / realPairs.length : 0;
const pct = (value) => `${(value * 100).toFixed(1)}%`;

console.log(`
Records:          ${records.length} venues (${merged} duplicate names merged; ${duplicatesLeft.length} likely duplicates left)
Venue precision:  ${pct(venuePrecision)}  — records that are real venues on the site
Claim precision:  ${pct(claimPrecision)}  — brand–venue facts on pages that the site states (${claims.length - wrongClaims.length}/${claims.length})
Claim recall:     ${pct(claimRecall)}  — site's brand–venue facts that were captured (${realPairs.length - missed.length}/${realPairs.length})`);
for (const record of notVenues) console.log(`  ✗ not a venue: ${record.data.name}`);
for (const claim of wrongClaims) console.log(`  ✗ unsupported claim: ${claim.brand} @ ${claim.venue}`);
for (const pair of duplicatesLeft) console.log(`  ≈ duplicate left: ${pair}`);
for (const pair of missed.slice(0, 15)) console.log(`  · missed: ${pair.brand} @ ${pair.venue}`);

const failed = Object.entries(THRESHOLDS).filter(([name, minimum]) => ({ venuePrecision, claimPrecision, claimRecall })[name] < minimum);
if (failed.length) {
  console.log(`\nFAIL: below threshold — ${failed.map(([name, minimum]) => `${name} < ${pct(minimum)}`).join(", ")}`);
  process.exit(1);
}
console.log("\nPASS");
