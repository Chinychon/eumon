import { schema, type JsonLlm } from "@organic-growth/ai";
import { createId, type CompetitorProfile, type Opportunity } from "@organic-growth/core";
import { isContentFamily, type PageInspection, type SiteResearch } from "@organic-growth/crawler";

/** The connected site's side of the comparison. */
export type OwnContent = {
  domain: string;
  /** Sitemap URLs per route family. */
  families: Record<string, number>;
  /** Distinct pages per family (translations count once), when the sitemap audit measured them. */
  sections?: Record<string, { pages: number; languages: number }>;
  /** Inspected pages (homepage and one per template). */
  pages?: PageInspection[];
  /** Collected datasets: data the site already has, published or not. */
  datasets?: Array<{ name: string; entityType: string; records: number; livePages: number }>;
};

export type ContentTypeRow = {
  key: string;
  label: string;
  /** `pages` counts distinct content (translations once); `urls` counts every sitemap URL. */
  you: { pages: number; urls: number; languages: number; families: string[] };
  /** A dataset holding this kind of entity, when the site has one. */
  data?: { dataset: string; records: number; livePages: number };
  competitors: Array<{ domain: string; pages: number; urls: number; languages: number; families: string[]; examples: string[] }>;
  /**
   * `gap`: competitors publish far more of this content; `advantage`: you
   * publish far more; `shared`: comparable; `yours_only`: no competitor has it.
   */
  status: "gap" | "advantage" | "shared" | "yours_only";
};

type Signals = { sampled: number; emptyShells: number; schemaTypes: string[]; faq: number; whatsapp: number; phone: number; form: number; booking: number; prices: number };

export type CompetitorSummary = {
  domain: string;
  analyzed: boolean;
  error?: string;
  estimatedUrls: number;
  partial: boolean;
  /** Share of content-type mix the competitor has in common with you (0–1). */
  overlap: number;
  largest: Array<{ label: string; pages: number }>;
  signals: Signals;
  notes: string[];
};

export type CompetitionReport = {
  rows: ContentTypeRow[];
  competitors: CompetitorSummary[];
  you: Signals;
  /** Content types were matched across sites (and languages) by a language model. */
  aiLabels: boolean;
  insights: string[];
};

const MIN_GAP_PAGES = 20;

/** "doctors" → "doctor", "find-a-doctor" → "find-a-doctor": a deterministic key for matching families across sites. */
export function contentKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-")
    .map((word) => (word.length > 3 && word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word))
    .join("-");
}

const humanize = (family: string) => `/${family}/ pages`;
const count = (value: number) => value.toLocaleString("en");

/** "~19 blog articles in 3 languages (57 URLs)" for a translated section, "~19 blog articles" otherwise. */
export const counted = (cell: { pages: number; urls?: number; languages?: number }, label = "") =>
  `~${count(cell.pages)}${label ? ` ${label}` : ""}${(cell.languages ?? 1) > 1 ? ` in ${cell.languages} languages (${count(cell.urls ?? cell.pages)} URLs)` : ""}`;

function signalsOf(pages: PageInspection[]): Signals {
  const served = pages.filter((page) => page.status < 400);
  return {
    sampled: served.length,
    emptyShells: served.filter((page) => page.emptyShell).length,
    schemaTypes: [...new Set(served.flatMap((page) => page.schemaTypes))].slice(0, 20),
    faq: served.filter((page) => page.faq).length,
    whatsapp: served.filter((page) => page.conversion.whatsapp).length,
    phone: served.filter((page) => page.conversion.phone).length,
    form: served.filter((page) => page.conversion.form).length,
    booking: served.filter((page) => page.conversion.booking).length,
    prices: served.filter((page) => page.conversion.prices).length,
  };
}

const labelSchema = schema.object({
  items: schema.array(schema.object({ id: schema.string(), label: schema.string() })),
});

/**
 * Asks a model to name each page family (and dataset) by the content type it
 * represents, so equivalent sections match across sites and languages
 * (`/dokter/` and `/doctors/` → "doctor profiles"). Unknown ids and odd
 * labels are discarded; unlabelled entries fall back to `contentKey`.
 */
export async function labelContentTypes(
  llm: JsonLlm,
  entries: Array<{ id: string; site: string; name: string; pages: number; examples: string[] }>,
): Promise<Map<string, string>> {
  const result = await llm.json<{ items?: Array<{ id?: unknown; label?: unknown }> }>({
    system: `You compare the content architecture of websites in the same market. Each entry is a section of a site (a URL path family with example URLs) or a dataset the business owns.
Give every entry a short English content-type label: a plural noun phrase for the kind of page or entity, e.g. "doctor profiles", "treatment pages", "hospital pages", "city guides", "cost guides", "blog articles", "product pages", "location pages".
Entries that hold the same kind of content must get exactly the same label, even across sites, naming styles, and languages (e.g. /dokter/, /doctors/, and a "Doctors" dataset are all "doctor profiles"). Use different labels for different kinds of content. Return every id exactly once.`,
    user: JSON.stringify({ entries }),
    schema: labelSchema,
    maxTokens: 4000,
    effort: "low",
  });
  const ids = new Set(entries.map((entry) => entry.id));
  const labels = new Map<string, string>();
  for (const item of result.items ?? []) {
    if (typeof item.id !== "string" || typeof item.label !== "string" || !ids.has(item.id)) continue;
    const label = item.label.trim().toLowerCase();
    if (label.length >= 3 && label.length <= 40) labels.set(item.id, label);
  }
  return labels;
}

/** Builds the label-matching input for `labelContentTypes`. */
export function contentTypeEntries(own: OwnContent, research: SiteResearch[]) {
  return [
    ...Object.entries(own.families).filter(([family]) => isContentFamily(family)).slice(0, 25)
      .map(([family, urls]) => ({ id: `you|${family}`, site: own.domain, name: `/${family}/`, pages: own.sections?.[family]?.pages ?? urls, examples: [] as string[] })),
    ...(own.datasets ?? []).map((dataset) => ({ id: `data|${dataset.name}`, site: `${own.domain} (dataset)`, name: `${dataset.name} (${dataset.entityType})`, pages: dataset.records, examples: [] as string[] })),
    ...research.flatMap((site) => site.sitemap.families.filter((family) => isContentFamily(family.family)).slice(0, 25)
      .map((family) => ({ id: `${site.domain}|${family.family}`, site: site.domain, name: `/${family.family}/`, pages: family.pages ?? Math.max(family.estimated, family.urls), examples: family.examples.slice(0, 2) }))),
  ];
}

/**
 * Compares content architecture: which kinds of pages competitors publish
 * that this site doesn't (and vice versa), which of those the site already
 * has data for, and how pages differ in structured data and conversion paths.
 */
export function compareCompetition(own: OwnContent, research: SiteResearch[], labels: Map<string, string> = new Map()): CompetitionReport {
  const keyFor = (id: string, fallback: string) => {
    const label = labels.get(id);
    return label ? { key: contentKey(label), label } : { key: contentKey(fallback), label: humanize(fallback) };
  };
  const rows = new Map<string, ContentTypeRow>();
  const rowFor = (key: string, label: string) => {
    const row = rows.get(key) ?? { key, label, you: { pages: 0, urls: 0, languages: 1, families: [] }, competitors: [], status: "shared" as const };
    rows.set(key, row);
    return row;
  };

  for (const [family, urls] of Object.entries(own.families)) {
    if (!isContentFamily(family)) continue;
    const { key, label } = keyFor(`you|${family}`, family);
    const row = rowFor(key, label);
    const section = own.sections?.[family];
    row.you.pages += section?.pages ?? urls;
    row.you.urls += urls;
    row.you.languages = Math.max(row.you.languages, section?.languages ?? 1);
    row.you.families.push(family);
  }
  for (const site of research) {
    for (const family of site.sitemap.families) {
      if (!isContentFamily(family.family)) continue;
      const { key, label } = keyFor(`${site.domain}|${family.family}`, family.family);
      const row = rowFor(key, label);
      const urls = Math.max(family.estimated, family.urls);
      const pages = family.pages ?? urls;
      const languages = family.languages ?? 1;
      const entry = row.competitors.find((competitor) => competitor.domain === site.domain);
      if (entry) {
        entry.pages += pages;
        entry.urls += urls;
        entry.languages = Math.max(entry.languages, languages);
        entry.families.push(family.family);
        entry.examples.push(...family.examples.slice(0, 2));
      } else {
        row.competitors.push({ domain: site.domain, pages, urls, languages, families: [family.family], examples: family.examples.slice(0, 3) });
      }
    }
  }
  for (const dataset of own.datasets ?? []) {
    const labelled = labels.get(`data|${dataset.name}`);
    const candidates = labelled ? [contentKey(labelled)] : [contentKey(dataset.name), contentKey(dataset.entityType)];
    const row = candidates.map((key) => rows.get(key)).find(Boolean);
    if (row) row.data = { dataset: dataset.name, records: dataset.records, livePages: dataset.livePages };
  }

  for (const row of rows.values()) {
    const most = Math.max(0, ...row.competitors.map((competitor) => competitor.pages));
    row.status = most >= MIN_GAP_PAGES && row.you.pages < most * 0.25 ? "gap"
      : row.you.pages >= MIN_GAP_PAGES && most === 0 ? "yours_only"
        : row.you.pages >= MIN_GAP_PAGES && row.you.pages >= most * 2 ? "advantage"
          : "shared";
    row.competitors.sort((a, b) => b.pages - a.pages);
  }
  const order = { gap: 0, advantage: 1, yours_only: 2, shared: 3 };
  const sorted = [...rows.values()]
    .filter((row) => row.you.pages + row.competitors.reduce((sum, competitor) => sum + competitor.pages, 0) >= 5)
    .sort((a, b) => order[a.status] - order[b.status]
      || Math.max(0, ...b.competitors.map((c) => c.pages), b.you.pages) - Math.max(0, ...a.competitors.map((c) => c.pages), a.you.pages));

  const ownTotal = sorted.reduce((sum, row) => sum + row.you.pages, 0);
  const competitors = research.map((site): CompetitorSummary => {
    const theirRows = sorted.map((row) => ({ row, pages: row.competitors.find((competitor) => competitor.domain === site.domain)?.pages ?? 0 }));
    const theirTotal = theirRows.reduce((sum, entry) => sum + entry.pages, 0);
    const overlap = ownTotal && theirTotal
      ? theirRows.reduce((sum, entry) => sum + Math.min(entry.row.you.pages / ownTotal, entry.pages / theirTotal), 0)
      : 0;
    return {
      domain: site.domain,
      analyzed: site.allowed,
      error: site.error,
      estimatedUrls: Math.max(site.sitemap.estimatedUrls, site.sitemap.urlsSeen),
      partial: site.sitemap.partial,
      overlap: Number(overlap.toFixed(2)),
      largest: theirRows.filter((entry) => entry.pages > 0).sort((a, b) => b.pages - a.pages).slice(0, 4).map((entry) => ({ label: entry.row.label, pages: entry.pages })),
      signals: signalsOf(site.pages),
      notes: site.sitemap.notes.slice(0, 3),
    };
  });

  const report: CompetitionReport = { rows: sorted.slice(0, 30), competitors, you: signalsOf(own.pages ?? []), aiLabels: labels.size > 0, insights: [] };
  report.insights = competitionInsights(report);
  return report;
}

/** Plain-language conclusions an analyst would draw from the comparison. */
export function competitionInsights(report: CompetitionReport): string[] {
  const insights: string[] = [];
  const analyzed = report.competitors.filter((competitor) => competitor.analyzed && competitor.signals.sampled > 0);
  for (const row of report.rows.filter((entry) => entry.status === "gap").slice(0, 3)) {
    const leader = row.competitors[0]!;
    const dataNote = row.data
      ? ` You already hold ${count(row.data.records)} records in “${row.data.dataset}”${row.data.livePages ? ` (${count(row.data.livePages)} published)` : " but publish none of them"}.`
      : "";
    insights.push(`${leader.domain} publishes ${counted(leader, row.label)}; you have ${row.you.pages ? counted(row.you) : "none"}.${dataNote}`);
  }
  for (const row of report.rows.filter((entry) => entry.status === "advantage" || entry.status === "yours_only").slice(0, 2)) {
    const most = row.competitors[0];
    insights.push(`You publish ${counted(row.you, row.label)}${most ? `, more than any competitor (largest: ${most.domain} with ${counted(most)})` : "; no competitor analyzed has this content"}.`);
  }
  if (analyzed.length) {
    const share = (pick: (signals: Signals) => number) => analyzed.filter((competitor) => pick(competitor.signals) > 0).length;
    const you = report.you;
    const compare = (name: string, pick: (signals: Signals) => number, advice: string) => {
      const theirs = share(pick);
      if (theirs * 2 > analyzed.length && you.sampled > 0 && pick(you) === 0) insights.push(`${theirs} of ${analyzed.length} competitors ${name} on the pages sampled; yours don't. ${advice}`);
    };
    compare("show prices", (signals) => signals.prices, "Price information is a strong reason to click and convert for commercial searches.");
    compare("offer a WhatsApp contact", (signals) => signals.whatsapp, "A one-tap WhatsApp CTA is the expected contact route in many markets.");
    compare("include an FAQ section", (signals) => signals.faq, "FAQs answer the long-tail questions searchers ask and can earn FAQ rich results.");
    compare("ask for a booking or quote", (signals) => signals.booking, "A specific next step converts better than a generic contact link.");
    const theirSchema = new Set(analyzed.flatMap((competitor) => competitor.signals.schemaTypes));
    const missing = [...theirSchema].filter((type) => !report.you.schemaTypes.includes(type) && !["WebSite", "WebPage", "Organization", "BreadcrumbList", "SiteNavigationElement", "ImageObject"].includes(type));
    if (missing.length && report.you.sampled > 0) insights.push(`Competitors mark up their pages as ${missing.slice(0, 5).join(", ")}; your sampled pages don't use these types.`);
    const shells = analyzed.filter((competitor) => competitor.signals.emptyShells > 0);
    if (shells.length && report.you.emptyShells === 0) insights.push(`${shells.map((competitor) => competitor.domain).join(", ")} returned little or no text in the HTML of ${shells.length === 1 ? "a sampled page" : "sampled pages"}, while your sampled pages render their content on the server.`);
  }
  for (const competitor of report.competitors.filter((entry) => !entry.analyzed)) {
    insights.push(`${competitor.domain} was not analyzed: ${competitor.error ?? "no data"}`);
  }
  return insights;
}

/** Content gaps as prioritized opportunities; gaps the site already has data for rank higher (cheaper to close). */
export function competitionOpportunities(report: CompetitionReport, siteId: string, analysisId: string): Opportunity[] {
  return report.rows.filter((row) => row.status === "gap").slice(0, 6).map((row) => {
    const leader = row.competitors[0]!;
    const hasData = Boolean(row.data && row.data.records > row.data.livePages);
    const contentEffort = hasData ? 2 : 4;
    const priorityScore = (12 * Math.log10(leader.pages + 1) * (hasData ? 1.5 : 1)) / contentEffort * 2;
    return {
      id: createId("opp"),
      siteId,
      analysisId,
      title: hasData
        ? `Publish your ${row.data!.dataset} data as ${row.label}`
        : `Build ${row.label}: competitors have ~${count(leader.pages)}, you have ${row.you.pages ? `~${count(row.you.pages)}` : "none"}`,
      searchDemand: 0,
      intent: "content_gap",
      competitorStrength: leader.pages,
      estimatedDifficulty: Math.min(100, Math.round(Math.log10(leader.pages + 1) * 25)),
      businessValue: hasData ? 1.5 : 1,
      conversionPotential: 1,
      technicalEffort: 1,
      contentEffort,
      priorityScore: Number(priorityScore.toFixed(2)),
      rationale: `${row.competitors.slice(0, 3).map((competitor) => `${competitor.domain}: ${counted(competitor)}`).join(", ")}; you: ${row.you.pages ? counted(row.you) : "none"}.${hasData ? ` Your “${row.data!.dataset}” dataset has ${count(row.data!.records)} records, ${count(row.data!.livePages)} published.` : ""} Page counts come from sitemaps and show where competitors invest, not search demand; check that these searches matter to your market before building pages.`,
      potentialPage: leader.examples[0],
    };
  });
}

/** Competitor profiles for the report, now grounded in each competitor's sitemap and sampled pages. */
export function competitorProfiles(report: CompetitionReport, siteId: string): CompetitorProfile[] {
  return report.competitors.map((competitor) => {
    const signals = competitor.signals;
    const conversion = [signals.whatsapp && "WhatsApp", signals.phone && "phone", signals.form && "forms", signals.booking && "booking/quote CTAs", signals.prices && "visible prices"].filter(Boolean);
    return {
      id: createId("competitor"),
      siteId,
      domain: competitor.domain,
      category: "business",
      relevanceScore: competitor.overlap,
      summary: competitor.analyzed
        ? `~${count(competitor.estimatedUrls)} URLs in its sitemaps${competitor.partial ? " (extrapolated)" : ""}; content mix overlaps ${Math.round(competitor.overlap * 100)}% with yours.`
        : competitor.error ?? "Not analyzed.",
      architectureNotes: competitor.largest.length ? `Largest sections: ${competitor.largest.map((entry) => `${entry.label} (~${count(entry.pages)})`).join(", ")}.` : undefined,
      contentNotes: signals.sampled ? `${signals.faq} of ${signals.sampled} sampled pages have an FAQ; structured data: ${signals.schemaTypes.slice(0, 6).join(", ") || "none"}.` : undefined,
      conversionNotes: signals.sampled ? (conversion.length ? `Sampled pages use ${conversion.join(", ")}.` : "No WhatsApp, phone, form, booking, or price signals on sampled pages.") : undefined,
      technicalNotes: signals.sampled ? `${signals.emptyShells} of ${signals.sampled} sampled pages returned empty HTML.` : undefined,
      evidence: { source: "owner_selected", overlap: competitor.overlap, estimatedUrls: competitor.estimatedUrls, partial: competitor.partial, notes: competitor.notes },
    };
  });
}
