import { schema, type JsonLlm } from "@organic-growth/ai";
import { isSafePublicUrl } from "@organic-growth/crawler";
import type { DataSourceKind, DatasetField, DatasetFieldType, PageIdea } from "@organic-growth/core";
import { slugify } from "./extract.js";

export type SiteEvidence = {
  name: string;
  baseUrl: string;
  goal?: string;
  pages: Array<{ url: string; title?: string; description?: string; headings: string[]; text: string }>;
  routeGroups: Array<{ pattern: string; count: number; examples: string[] }>;
  topQueries: Array<{ query: string; impressions: number; position: number }>;
  framework?: string;
};

export type ProposedSource = {
  url: string;
  kind: DataSourceKind;
  urlPattern?: string;
  rationale: string;
};

export type ProposedDataset = {
  name: string;
  entityType: string;
  description: string;
  fields: DatasetField[];
  keyField: string;
  pageIdeas: PageIdea[];
  sources: ProposedSource[];
};

export type ScopeProposal = {
  /** The brand name the business uses for itself (e.g. "Edea Design"). */
  businessName: string;
  businessSummary: string;
  conversionGoal: string;
  datasets: ProposedDataset[];
};

const SCOPE_SYSTEM = `You are the scoping analyst for a programmatic SEO engine.

The engine turns a business's general offering into many specific landing pages. Each landing page describes one thing a searcher is looking for and drives them to a conversion (enquiry, booking, WhatsApp, purchase).

Your job:
1. From the site evidence, state what the business sells and what a conversion is.
2. Break the general offering into its granular units — the specific things people search for by name. For a medical tourism site that means individual doctors, individual procedures/treatments, individual hospitals; for a SaaS it might be integrations, use cases, or templates; for a marketplace it is listings, categories, and locations.
3. Each unit type becomes one dataset. Propose 2–4 datasets, highest commercial value first. Each record in a dataset will become its own landing page, so choose units with real, distinct search demand and enough facts to make each page genuinely useful. Do not propose units that would produce thin or near-identical pages.
4. For each dataset define the fields a strong landing page needs (facts that answer the searcher's questions and support the conversion: names, location, prices or price ranges, qualifications, features, availability, languages, ratings, etc.). Use snake_case keys. Field types: text, number, list, url, boolean. keyField must be the field that names one record (usually "name").
5. Page ideas: always include one entity page idea (groupBy: []) — one page per record. Optionally add a grouped page idea (groupBy: one or two fields, e.g. ["specialty", "city"]) when combinations have clear search demand.
6. Sources: where the records can be collected.
   - If the site's own route groups already contain these entities, propose kind "own_site" with url = the site origin and urlPattern = the route glob (e.g. "/doctors/*"). This is the most reliable source; prefer it.
   - Otherwise propose public pages likely to list the entities: kind "listing" (a directory page whose links lead to detail pages; give a urlPattern glob for the detail links), "sitemap" (a sitemap.xml; give a urlPattern), or "page" (one page containing a table or list of many records).
   - Only propose URLs you are confident exist. Prefer official sources (the entity's own site, registries, associations) over aggregators. Never propose sources behind logins or paywalls.

Be concrete and specific to this business. Write rationales in one or two sentences.`;

const fieldTypes: DatasetFieldType[] = ["text", "number", "list", "url", "boolean"];
const sourceKinds: DataSourceKind[] = ["own_site", "listing", "sitemap", "page"];

const proposalSchema = schema.object({
  businessName: schema.string("the brand name the business uses on its own site"),
  businessSummary: schema.string(),
  conversionGoal: schema.string(),
  datasets: schema.array(schema.object({
    name: schema.string("plural, e.g. Doctors"),
    entityType: schema.string("singular, e.g. doctor"),
    description: schema.string(),
    keyField: schema.string(),
    fields: schema.array(schema.object({
      key: schema.string(),
      label: schema.string(),
      type: schema.enum(fieldTypes),
      description: schema.string(),
      required: schema.boolean(),
    })),
    pageIdeas: schema.array(schema.object({
      name: schema.string(),
      groupBy: schema.array(schema.string()),
      exampleTitle: schema.string(),
      exampleQueries: schema.array(schema.string()),
      intent: schema.string(),
      rationale: schema.string(),
    })),
    sources: schema.array(schema.object({
      url: schema.string(),
      kind: schema.enum(sourceKinds),
      urlPattern: schema.nullable(schema.string()),
      rationale: schema.string(),
    })),
  })),
});

export async function proposeScope(llm: JsonLlm, evidence: SiteEvidence): Promise<ScopeProposal> {
  const raw = await llm.json<Record<string, unknown>>({
    system: SCOPE_SYSTEM,
    user: JSON.stringify({
      site: { name: evidence.name, url: evidence.baseUrl, framework: evidence.framework },
      ownerGoal: evidence.goal || "Not stated.",
      pages: evidence.pages.map((page) => ({ ...page, text: page.text.slice(0, 2500) })),
      sitemapRouteGroups: evidence.routeGroups,
      searchConsoleTopQueries: evidence.topQueries.slice(0, 40),
    }),
    schema: proposalSchema,
    maxTokens: 16000,
    effort: "high",
  });
  return validateProposal(raw, evidence.baseUrl);
}

/** Enforces invariants the rest of the engine relies on, whatever the model returned. */
export function validateProposal(raw: Record<string, unknown>, baseUrl: string): ScopeProposal {
  const origin = new URL(baseUrl).origin;
  const datasets = (Array.isArray(raw.datasets) ? raw.datasets : []).slice(0, 4).flatMap((entry): ProposedDataset[] => {
    const value = entry as Record<string, unknown>;
    const seen = new Set<string>();
    const fields = (Array.isArray(value.fields) ? value.fields : []).flatMap((item): DatasetField[] => {
      const field = item as Record<string, unknown>;
      const key = slugify(String(field.key ?? "")).replace(/-/g, "_");
      if (!key || seen.has(key) || seen.size >= 25) return [];
      seen.add(key);
      return [{
        key,
        label: String(field.label || key).slice(0, 60),
        type: fieldTypes.includes(field.type as DatasetFieldType) ? field.type as DatasetFieldType : "text",
        description: typeof field.description === "string" ? field.description.slice(0, 200) : undefined,
        required: field.required === true,
      }];
    });
    let keyField = slugify(String(value.keyField ?? "")).replace(/-/g, "_");
    if (!seen.has(keyField)) keyField = seen.has("name") ? "name" : fields[0]?.key ?? "";
    if (!keyField || fields.length < 2) return [];
    // Only the key is required: records missing other details still become (thinner) pages.
    for (const field of fields) field.required = field.key === keyField;

    const pageIdeas = (Array.isArray(value.pageIdeas) ? value.pageIdeas : []).slice(0, 4).map((item): PageIdea => {
      const idea = item as Record<string, unknown>;
      return {
        name: String(idea.name ?? "Landing pages").slice(0, 80),
        groupBy: (Array.isArray(idea.groupBy) ? idea.groupBy : []).map(String).filter((key) => seen.has(key)).slice(0, 2),
        exampleTitle: String(idea.exampleTitle ?? "").slice(0, 120),
        exampleQueries: (Array.isArray(idea.exampleQueries) ? idea.exampleQueries : []).map(String).slice(0, 6),
        intent: String(idea.intent ?? "").slice(0, 80),
        rationale: String(idea.rationale ?? "").slice(0, 400),
      };
    });
    if (!pageIdeas.some((idea) => idea.groupBy.length === 0)) {
      pageIdeas.unshift({
        name: `One page per ${String(value.entityType || "record")}`,
        groupBy: [],
        exampleTitle: "",
        exampleQueries: [],
        intent: "commercial",
        rationale: "Each record becomes its own landing page.",
      });
    }

    const sources = (Array.isArray(value.sources) ? value.sources : []).slice(0, 6).flatMap((item): ProposedSource[] => {
      const source = item as Record<string, unknown>;
      const kind = sourceKinds.includes(source.kind as DataSourceKind) ? source.kind as DataSourceKind : "listing";
      const url = kind === "own_site" ? origin : normalizeUrl(source.url);
      if (!url) return [];
      const urlPattern = typeof source.urlPattern === "string" && source.urlPattern.startsWith("/") ? source.urlPattern.slice(0, 200) : undefined;
      if (kind === "own_site" && !urlPattern) return [];
      return [{ url, kind, urlPattern, rationale: String(source.rationale ?? "").slice(0, 400) }];
    });

    return [{
      name: String(value.name || "Records").slice(0, 60),
      entityType: String(value.entityType || "record").slice(0, 40),
      description: String(value.description ?? "").slice(0, 500),
      fields,
      keyField,
      pageIdeas,
      sources,
    }];
  });
  return {
    businessName: String(raw.businessName ?? "").trim().slice(0, 80),
    businessSummary: String(raw.businessSummary ?? "").slice(0, 800),
    conversionGoal: String(raw.conversionGoal ?? "").slice(0, 300),
    datasets,
  };
}

function normalizeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return isSafePublicUrl(url.toString()) ? url.toString() : null;
  } catch {
    return null;
  }
}
