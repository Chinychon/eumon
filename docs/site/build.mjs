// Builds the developer docs into one page: node docs/site/build.mjs
// Inlines pages/*.html (in ORDER) and diagrams/*.svg into shell.html, wraps tables so they scroll,
// scopes section ids per page, and fails on a missing page or diagram or a link that points nowhere.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ORDER = [
  "overview", "getting-started",
  "architecture", "flow-analysis", "flow-sync", "flow-pages", "data-model",
  "packages", "web-app", "findings", "glossary",
  "ops", "gotchas",
];

const problems = [];
const pages = ORDER.map((slug) => {
  const file = join(here, "pages", `${slug}.html`);
  if (!existsSync(file)) { problems.push(`missing page: pages/${slug}.html`); return ""; }
  let html = readFileSync(file, "utf8");
  if (!html.includes(`<article id="${slug}"`)) problems.push(`pages/${slug}.html: <article> must have id="${slug}"`);
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
