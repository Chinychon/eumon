/** Values that survive JSON and Workflow step serialization unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";

export type FindingCategory =
  | "rendering"
  | "sitemap"
  | "indexing"
  | "metadata"
  | "structured_data"
  | "internal_links"
  | "content"
  | "conversion"
  | "competitors"
  | "search"
  | "repository";

export type CompetitorCategory =
  | "business"
  | "search"
  | "serp"
  | "authority";

export type AnalysisStatus =
  | "queued"
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type ChangeStatus =
  | "proposed"
  | "approved"
  | "rejected"
  | "pr_opened"
  | "merged"
  | "failed";

export type ConversionEventName =
  | "page_view"
  | "cta_click"
  | "whatsapp_click"
  | "phone_click"
  | "email_click"
  | "form_start"
  | "form_submit"
  | "booking_start"
  | "booking_complete"
  | "lead_created"
  | "lead_qualified"
  | "customer_created";

export type FrameworkFingerprint = {
  framework: string;
  language: string;
  packageManager: string;
  router?: string;
  rendering?: string;
  deployment?: string;
  cms?: string;
  database?: string;
  analytics: string[];
  seoTooling: string[];
  contentSource?: string;
  hasSitemap: boolean;
  hasRobots: boolean;
  hasStructuredData: boolean;
  details: JsonObject;
}

export interface SiteRecord {
  id: string;
  name: string;
  baseUrl: string;
  githubOwner?: string;
  githubRepo?: string;
  githubInstallationId?: string;
  defaultBranch?: string;
  fingerprint?: FrameworkFingerprint;
  gscProperty?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Finding {
  id: string;
  siteId: string;
  analysisId: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  summary: string;
  evidence: JsonObject;
  organicImpactScore: number;
  recommendation?: string;
  pagesAffected?: string[];
  createdAt: string;
}

export type CrawlPageResult = {
  url: string;
  status: number;
  finalUrl?: string;
  title?: string;
  description?: string;
  canonical?: string;
  robots?: string;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLdCount: number;
  contentLength: number;
  isEmptyShell: boolean;
  headingOutline: string[];
  internalLinkCount: number;
  rawHtmlKey?: string;
  renderedHtmlKey?: string;
  rawTextLength: number;
  renderedTextLength: number;
  renderDelta: number;
  fetchMode: "raw" | "googlebot" | "browser";
  /** Number of `<h1>` elements in the crawler-visible HTML. */
  h1Count?: number;
  /** Excluded from Google's index by a robots meta tag or an `X-Robots-Tag` header. */
  noindex?: boolean;
  /** schema.org `@type` values found in JSON-LD, `@graph` flattened. */
  jsonLdTypes?: string[];
  /** JSON-LD blocks that failed to parse (search engines ignore them). */
  invalidJsonLd?: number;
  /** Route family (`/en/doctors/jane` → `doctors`), used to report problems per page template. */
  routeFamily?: string;
  /** The canonical tag names a different URL than the one fetched. */
  canonicalMismatch?: boolean;
  /**
   * Status a Googlebot-identified request got before the crawler retried as a
   * browser — typically a firewall rejecting unverified Googlebot traffic.
   */
  googlebotBlockedStatus?: number;
  /** The response was a bot-protection challenge page rather than the site's content. */
  botChallenge?: boolean;
  /** Target of a `<meta http-equiv="refresh">` redirect; such pages are redirects, not content. */
  metaRefresh?: string;
}

export type SitemapAudit = {
  totalUrls: number;
  sampledUrls: number;
  indexFiles: string[];
  urlTypes: Record<string, number>;
  languages: Record<string, number>;
  errors: string[];
  freshness?: string;
}

/** Problems counted across every crawled sitemap URL. */
export type CrawlIssue =
  | "robotsBlocked"
  | "noindex"
  | "canonicalMismatch"
  | "redirected"
  | "missingH1"
  | "multipleH1"
  | "missingDescription"
  | "missingStructuredData"
  | "invalidStructuredData"
  | "duplicateTitle"
  | "botFallback"
  | "botChallenge";

export type CrawlIssueExample = { url: string; detail?: string };

/** Crawl health of one route family (page template), e.g. every `/doctors/*` URL. */
export type CrawlFamilyStats = {
  family: string;
  urls: number;
  crawled: number;
  emptyShells: number;
  errors: number;
  noindex: number;
  missingStructuredData: number;
};

/** Aggregate coverage for a sitemap-driven crawl. Individual page records live in storage. */
export type CrawlCoverage = {
  totalUrls: number;
  completedUrls: number;
  failedUrls: number;
  pendingUrls: number;
  emptyShellUrls: number;
  httpErrorUrls: number;
  missingTitleUrls: number;
  /** URL counts per issue. Absent in reports created before these checks existed. */
  issues?: Partial<Record<CrawlIssue, number>>;
  issueExamples?: Partial<Record<CrawlIssue, CrawlIssueExample[]>>;
  duplicateTitleGroups?: Array<{ title: string; count: number; examples: string[] }>;
  families?: CrawlFamilyStats[];
}

export type SearchMetricRow = {
  query: string;
  page: string;
  country: string;
  device: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
  periodStart?: string;
  periodEnd?: string;
}

export interface CompetitorProfile {
  id: string;
  siteId: string;
  domain: string;
  category: CompetitorCategory;
  relevanceScore: number;
  summary: string;
  architectureNotes?: string;
  contentNotes?: string;
  conversionNotes?: string;
  technicalNotes?: string;
  evidence: JsonObject;
}

export interface Opportunity {
  id: string;
  siteId: string;
  analysisId: string;
  title: string;
  searchDemand: number;
  intent: string;
  currentRank?: number;
  competitorStrength: number;
  currentPage?: string;
  potentialPage?: string;
  estimatedDifficulty: number;
  businessValue: number;
  conversionPotential: number;
  technicalEffort: number;
  contentEffort: number;
  priorityScore: number;
  rationale: string;
}

export interface GrowthPlanSection {
  title: string;
  body: string;
  evidenceIds?: string[];
}

export interface GrowthPlanPriority {
  rank: number;
  title: string;
  expectedObjective: string;
  whyThisMatters: string;
  pagesAffected: string[];
  implementationRequired: string;
  contentRequired: string;
  dependencies: string[];
  risk: string;
  measurementMethod: string;
}

export interface GrowthPlan {
  id: string;
  siteId: string;
  analysisId: string;
  situation: string;
  constraints: string[];
  competitiveAdvantage: string;
  highestImpactOpportunity: string;
  priorities: GrowthPlanPriority[];
  sections: GrowthPlanSection[];
  markdown: string;
  createdAt: string;
}

export interface ProposedChange {
  id: string;
  siteId: string;
  analysisId: string;
  opportunityId?: string;
  findingId?: string;
  title: string;
  reason: string;
  evidence: JsonObject;
  filesChanged: string[];
  pagesAffected: string[];
  patch: string;
  status: ChangeStatus;
  prUrl?: string;
  prNumber?: number;
  author: string;
  aiModel?: string;
  createdAt: string;
  result?: string;
}

export interface ConversionEvent {
  id: string;
  siteId: string;
  event: ConversionEventName;
  destination?: string;
  pageUrl?: string;
  sessionId?: string;
  properties?: JsonObject;
  occurredAt: string;
}

/** Prioritization model — not a traffic prediction. */
export function computePriorityScore(input: {
  searchDemand: number;
  businessValue: number;
  conversionPotential: number;
  competitiveGap: number;
  implementationEffort: number;
}): number {
  const effort = Math.max(input.implementationEffort, 0.1);
  return (
    (input.searchDemand *
      input.businessValue *
      input.conversionPotential *
      input.competitiveGap) /
    effort
  );
}

export function rankSeverityByOrganicImpact(
  findings: Finding[],
): Finding[] {
  const order: Record<Severity, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    INFORMATIONAL: 4,
  };
  return [...findings].sort((a, b) => {
    if (a.organicImpactScore !== b.organicImpactScore) {
      return b.organicImpactScore - a.organicImpactScore;
    }
    return order[a.severity] - order[b.severity];
  });
}

// ---------------------------------------------------------------------------
// Programmatic page engine: scoped datasets → sources → records → pages.
// ---------------------------------------------------------------------------

export type DatasetFieldType = "text" | "number" | "list" | "url" | "boolean";

export type DatasetField = {
  key: string;
  label: string;
  type: DatasetFieldType;
  description?: string;
  required?: boolean;
};

/** A page family the scoping agent believes the dataset can support. */
export type PageIdea = {
  name: string;
  /** Dataset fields that define one page; empty means one page per record. */
  groupBy: string[];
  exampleTitle: string;
  exampleQueries: string[];
  intent: string;
  rationale: string;
};

export type DatasetStatus = "proposed" | "active" | "archived";

export type Dataset = {
  id: string;
  siteId: string;
  name: string;
  entityType: string;
  description: string;
  fields: DatasetField[];
  /** Field whose slug identifies a record and deduplicates scrapes. */
  keyField: string;
  pageIdeas: PageIdea[];
  status: DatasetStatus;
  createdAt: string;
  updatedAt: string;
};

export type DataSourceKind = "sitemap" | "listing" | "page" | "own_site";
export type DataSourceOrigin = "ai" | "user" | "own_site";
export type DataSourceStatus = "proposed" | "approved" | "rejected" | "blocked";

export type DataSource = {
  id: string;
  siteId: string;
  datasetId: string;
  url: string;
  kind: DataSourceKind;
  /** Path glob for detail pages, e.g. `/doctors/*`; `**` crosses segments. */
  urlPattern?: string;
  maxPages: number;
  origin: DataSourceOrigin;
  rationale?: string;
  status: DataSourceStatus;
  robotsAllowed?: boolean;
  recordCount: number;
  lastRunAt?: string;
  error?: string;
  createdAt: string;
};

export type DataRecord = {
  id: string;
  siteId: string;
  datasetId: string;
  key: string;
  data: JsonObject;
  sourceId?: string;
  sourceUrl?: string;
  createdAt: string;
  updatedAt: string;
};

export type FaqPattern = { question: string; answer: string };

export type TemplateStatus = "draft" | "active";

export type PageTemplate = {
  id: string;
  siteId: string;
  datasetId: string;
  name: string;
  /** Empty → one page per record. Otherwise one page per unique combination. */
  groupBy: string[];
  pathPattern: string;
  titlePattern: string;
  descriptionPattern: string;
  h1Pattern: string;
  introPattern: string;
  itemTitleField: string;
  itemFields: string[];
  sortBy?: string;
  sortDir: "asc" | "desc";
  minRecords: number;
  faq: FaqPattern[];
  status: TemplateStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * `unpublished`: taken offline by the owner. `retired`: its records no longer
 * exist. Both are served as 410 Gone; only unpublished pages can be republished.
 */
export type GeneratedPageStatus = "draft" | "published" | "thin" | "duplicate" | "unpublished" | "retired";

export type PageLink = { path: string; title: string };

/** A display-ready snapshot of one record on a page, so serving needs no joins. */
export type PageItem = {
  title: string;
  fields: Array<{ label: string; value: string; href?: string }>;
};

export type GeneratedPage = {
  id: string;
  siteId: string;
  templateId: string;
  path: string;
  groupKey: string;
  groupValues: Record<string, string>;
  title: string;
  description: string;
  h1: string;
  intro: string;
  faq: FaqPattern[];
  recordIds: string[];
  items: PageItem[];
  facts: JsonObject;
  related: PageLink[];
  /** Fields edited by the owner or applied from an optimization; regeneration keeps them. */
  overrides?: Partial<Record<"title" | "description" | "h1" | "intro", string>>;
  qualityScore: number;
  qualityIssues: string[];
  status: GeneratedPageStatus;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type PageSettings = {
  siteId: string;
  /**
   * Origin the pages are served from: the main site for a subdirectory proxy
   * (`https://example.com`) or a subdomain (`https://guides.example.com`).
   * Canonical URLs, sitemaps, and Search Console joins all use it.
   */
  publicOrigin: string;
  /** Path prefix the proxy forwards to Eumon, e.g. `/guides`; `` for a whole subdomain. */
  mountPath: string;
  /** Language the pages are written in (BCP 47, e.g. `en`, `id`, `ms`): page copy, interface labels, and `<html lang>`. */
  language: string;
  siteName: string;
  brandColor: string;
  ctaLabel: string;
  ctaUrl: string;
  ctaCopy: string;
  /** Set when the live check confirmed the proxy serves these pages on the public origin. */
  verifiedAt?: string;
  updatedAt: string;
};

export type CtaVariant = {
  id: string;
  siteId: string;
  label: string;
  copy: string;
  url: string;
  impressions: number;
  clicks: number;
  active: boolean;
  createdAt: string;
};

export type JobKind = "scrape";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export type Job = {
  id: string;
  siteId: string;
  kind: JobKind;
  status: JobStatus;
  subjectId: string;
  progress?: { message: string; done: number; total: number };
  error?: string;
  createdAt: string;
  completedAt?: string;
};
