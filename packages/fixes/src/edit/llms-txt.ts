import type { EditResult } from "../types.js";

export const LLMS_MARKER = "<!-- maintained by Eumon -->";
const PER_SECTION = 50;
const TOTAL = 200;

export function buildLlmsTxt(input: { siteName: string; summary: string; pages: Array<{ url: string; title?: string; description?: string; section: string }> }): string {
  const sections = new Map<string, string[]>();
  let total = 0;
  for (const page of input.pages) {
    const list = sections.get(page.section) ?? [];
    if (list.length >= PER_SECTION || total >= TOTAL) continue;
    list.push(`- [${(page.title ?? page.url).replace(/[[\]]/g, "")}](${page.url})${page.description ? `: ${page.description}` : ""}`);
    sections.set(page.section, list);
    total++;
  }
  const body = [...sections].map(([title, links]) => `## ${title}\n${links.join("\n")}\n`).join("\n");
  return `# ${input.siteName}\n\n> ${input.summary}\n\n${LLMS_MARKER}\n\n${body}`;
}

export function editLlmsTxt(existing: string | null, content: string): EditResult {
  if (existing !== null && !existing.includes(LLMS_MARKER)) return { ok: false, reason: "the site has a hand-written llms.txt, which Eumon leaves alone", snippet: content };
  if (existing === content) return { ok: false, reason: "llms.txt is already up to date", snippet: content };
  return { ok: true, edits: [], allowedRanges: [], roots: [], files: { "public/llms.txt": content }, summary: existing ? "Refreshes llms.txt from the latest crawl." : "Adds llms.txt so AI assistants can find the site's key pages." };
}
