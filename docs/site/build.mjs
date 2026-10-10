// Builds the developer docs into one page: node docs/site/build.mjs
// Inlines pages/*.html (in ORDER) and diagrams/*.svg into shell.html, wraps tables so they scroll,
// scopes section ids per page, and fails on a missing page or diagram or a link that points nowhere.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ORDER = [
  "overview", "getting-started",
  "architecture", "flow-analysis", "flow-sync", "flow-pages", "data-model",
  "packages", "codebase-map", "web-app", "findings", "checks", "glossary",
  "ops", "gotchas",
];

const problems = [];
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Codebase map: a file-level view of graphify's symbol graph. graphify-out/ is gitignored, so the
// reduced map is saved to codebase-map.json and the docs still build without a graph.
const graphFile = join(here, "../../graphify-out/graph.json");
const mapFile = join(here, "codebase-map.json");
if (existsSync(graphFile)) writeFileSync(mapFile, JSON.stringify(codebaseMap(JSON.parse(readFileSync(graphFile, "utf8")))) + "\n");
const map = existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : null;
if (!map) problems.push("missing codebase-map.json: run /graphify . at the repo root, then build again");

function codebaseMap(g) {
  // Source files only: no tests, no build output, no client-specific evals.
  const keep = (f) => /^(apps|packages|scripts)\/.*\.(ts|tsx|mjs|js)$/.test(f ?? "") && !/\.test\.|\/dist\/|edea|medbay/i.test(f);
  const fileOf = new Map(), votes = new Map(), bySymbol = new Map();
  for (const n of g.nodes) {
    if (!keep(n.source_file)) continue;
    fileOf.set(n.id, n.source_file);
    const v = votes.get(n.source_file) ?? new Map();
    v.set(n.community_name, (v.get(n.community_name) ?? 0) + 1);
    votes.set(n.source_file, v);
    const pkg = n.source_file.match(/^packages\/([^/]+)\/src\//)?.[1];
    if (pkg) bySymbol.set(`${pkg.replace("-", "_")}:${n.label.replace(/\(\)$/, "").toLowerCase()}`, n.source_file);
  }
  // Imports of another workspace point at its built dist/index; send them back to the source file that defines the symbol.
  const resolve = (id) => {
    if (fileOf.has(id)) return fileOf.get(id);
    const m = id.match(/^packages_(.+?)_dist_index(?:_(.+))?$/);
    if (!m) return undefined;
    const index = `packages/${m[1].replace("_", "-")}/src/index.ts`;
    return bySymbol.get(`${m[1]}:${m[2]}`) ?? (votes.has(index) ? index : undefined);
  };
  const files = [...votes.keys()].sort();
  const at = new Map(files.map((f, i) => [f, i]));
  const edges = new Map();
  for (const e of g.links) {
    const a = at.get(resolve(e.source)), b = at.get(resolve(e.target));
    if (a !== undefined && b !== undefined && a !== b) edges.set(`${a}>${b}`, [a, b]);
  }
  const area = (f) => [...votes.get(f)].sort((x, y) => y[1] - x[1])[0][0];
  const areas = [...new Set(files.map(area))].sort();
  const degree = files.map(() => 0);
  for (const [a, b] of edges.values()) { degree[a]++; degree[b]++; }
  return {
    commit: (g.built_at_commit ?? "").slice(0, 7),
    areas,
    files: files.map((f, i) => [f, areas.indexOf(area(f)), degree[i]]),
    edges: [...edges.values()],
  };
}

function areasTable({ areas, files }) {
  const rows = areas.map((name, i) => ({ name, files: files.filter((f) => f[1] === i).map((f) => f[0]) }))
    .sort((a, b) => b.files.length - a.files.length || a.name.localeCompare(b.name));
  return `<table><thead><tr><th>Area</th><th>Files</th></tr></thead><tbody>${rows.map((a) =>
    `<tr><td>${esc(a.name)}</td><td>${a.files.map((f) => `<code class="path">${esc(f)}</code>`).join(" ")}</td></tr>`).join("")}</tbody></table>`;
}

// The Checks page is generated from the check registry, so the docs cannot drift from the code.
const checksDist = join(here, "../../packages/core/dist/checks/index.js");
const checks = existsSync(checksDist) ? await import(pathToFileURL(checksDist).href) : null;
if (!checks) problems.push("missing packages/core/dist: run `npm run build -w @organic-growth/core`, then build again");

function checksPage(head) {
  if (!checks) return head.replace("<!--CHECKS-->", "");
  const list = checks.checkList();
  for (const check of list) {
    for (const field of ["what", "why", "how", "severity"]) if (!check.docs[field] || check.docs[field].trim().length < 20) problems.push(`check ${check.id} has no docs.${field}`);
  }
  const anchor = (id) => `check-${id.replaceAll(".", "-").replaceAll("_", "-")}`;
  const section = (id, title, items) => {
    const categories = [...new Set(items.map((check) => check.category))];
    return `<h2 id="${id}">${esc(title)} (${items.length})</h2>` + categories.map((category) => {
      const rows = items.filter((check) => check.category === category);
      return `<h3>${esc(category.replaceAll("_", " "))}</h3>`
        + `<table><thead><tr><th>Check</th><th>Class</th><th>Scope</th><th>Source</th><th>Fix</th><th>Needs</th></tr></thead><tbody>${rows.map((check) =>
          `<tr><td><a href="#${anchor(check.id)}">${esc(check.name)}</a><br><code>${esc(check.id)}</code></td><td>${esc(check.class)}${check.docs.unscored ? ", never scored" : ""}</td><td>${esc(check.scope)}</td><td>${esc(check.sources.join(", "))}</td><td>${esc(check.fix)}</td><td>${esc(check.requires ?? "")}</td></tr>`).join("")}</tbody></table>`
        + `<dl>${rows.map((check) => `<dt id="${anchor(check.id)}">${esc(check.name)} <code>${esc(check.id)}</code></dt><dd><p><strong>What.</strong> ${esc(check.docs.what)}</p><p><strong>Why.</strong> ${esc(check.docs.why)}</p><p><strong>Fix.</strong> ${esc(check.docs.how)}</p><p><strong>Severity.</strong> ${esc(check.docs.severity)}</p></dd>`).join("")}</dl>`;
    }).join("");
  };
  const seo = list.filter((check) => check.pillars.includes("seo"));
  const ai = list.filter((check) => check.pillars.includes("ai") && !check.pillars.includes("seo"));
  const none = list.filter((check) => !check.pillars.length);
  const notRun = `<h2 id="not-run">Checks Eumon does not run</h2><dl>${checks.NOT_RUN.map((entry) => `<dt>${esc(entry.name)}</dt><dd><p>${esc(entry.why)}</p></dd>`).join("")}</dl>`;
  return head.replace("<!--CHECKS-->",
    `<p>${list.length} checks: ${seo.length} SEO (some also count for AI visibility), ${ai.length} AI visibility only, ${none.length} shown but never scored.</p>`
    + section("seo-checks", "SEO", seo) + section("ai-checks", "AI visibility", ai) + section("unscored-checks", "Conversion and data: shown, never scored", none) + notRun);
}

const pages = ORDER.map((slug) => {
  const file = join(here, "pages", slug === "checks" ? "checks.head.html" : `${slug}.html`);
  if (!existsSync(file)) { problems.push(`missing page: pages/${slug}.html`); return ""; }
  let html = readFileSync(file, "utf8");
  if (slug === "checks") html = checksPage(html);
  if (!html.includes(`<article id="${slug}"`)) problems.push(`pages/${slug}.html: <article> must have id="${slug}"`);
  if (map) html = html
    .replace("<!--MAP-DATA-->", `<script type="application/json" id="map-data">${JSON.stringify(map).replace(/</g, "\\u003c")}</script>`)
    .replace("<!--MAP-AREAS-->", areasTable(map))
    .replaceAll("<!--MAP-STATS-->", `${map.files.length} source files and ${map.edges.length} dependencies, from a graph built at <code>${map.commit}</code>`);
  // Section ids are page-scoped in the built page: <h2 id="x"> becomes "slug--x", so #slug--x deep-links work.
  html = html.replace(/<h2 id="([^"]+)"/g, (_, id) => `<h2 id="${slug}--${id}"`);
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, "</table></div>");
  html = html.replace(/<figure data-diagram="([^"]+)">([\s\S]*?)<\/figure>/g, (_, name, rest) => {
    const svgFile = join(here, "diagrams", `${name}.svg`);
    if (!existsSync(svgFile)) { problems.push(`pages/${slug}.html: missing diagram diagrams/${name}.svg`); return `<figure class="diagram missing"><div class="diagram-scroll">Diagram “${name}” not drawn yet.</div>${rest}</figure>`; }
    // A diagram can appear on several pages; page-scoped ids keep markers and labels pointing at their own copy.
    const svg = readFileSync(svgFile, "utf8").replace(/<\?xml[^>]*>\s*/, "").trim().replaceAll(`dg-${name}-`, `dg-${name}-${slug}-`);
    return `<figure class="diagram" data-diagram="${name}"><div class="diagram-scroll">${svg}</div>${rest}</figure>`;
  });
  return html;
}).join("\n");

// Every #link must land on a page or a section that exists.
const allIds = [...pages.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const ids = new Set(allIds);
for (const id of new Set(allIds.filter((id, i) => allIds.indexOf(id) !== i))) problems.push(`duplicate id: ${id}`);
for (const [, target] of pages.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.has(target)) problems.push(`broken link: #${target}`);
}

let commit = "";
try { commit = execSync("git rev-parse --short HEAD", { cwd: here }).toString().trim(); } catch {}
const meta = JSON.stringify({ commit, built: new Date().toISOString().slice(0, 10) });
const out = readFileSync(join(here, "shell.html"), "utf8").replace("<!--PAGES-->", pages).replace("<!--META-->", meta);

mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "eumon-docs.html"), out);
console.log(`built docs/site/dist/eumon-docs.html (${(out.length / 1024).toFixed(0)} KB, ${ORDER.length} pages)`);
if (problems.length) {
  console.error(problems.map((p) => `  - ${p}`).join("\n"));
  process.exitCode = 1;
}
