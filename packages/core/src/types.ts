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
  | "repository"
  /** AI assistants' access to the site (robots.txt for AI crawlers): reported, never auto-fixed. */
  | "ai_visibility"
  /** HTTPS hygiene: mixed content, HTTP links, HSTS. */
  | "security";

export type CompetitorCategory =
  | "business"
  | "search"
  | "serp"
  | "authority";

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
  /** GA4 property (`properties/123456`) whose sessions feed Results. */
  ga4Property?: string;
  /** Bumped to revoke every client link to this site's Results. */
  reportShareVersion?: number;
  /** The workspace that owns the site; access is decided by membership in it. */
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Finding {
  id: string;
  siteId: string;
  analysisId: string;
  category: FindingCategory;
  /** The registry check that produced it (packages/core/src/checks); reports from before the registry have none. */
  checkId?: string;
  /** Distinguishes several findings from one check: the family, query or entity type. */
  scopeKey?: string;
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
  /** The URL's language prefix (`classifyLanguage`): `id`, `zh`, or `default`. */
  locale?: string;
  /** Simhash of the visible text (16 hex characters) when it has 200 characters or more; `nearDuplicate` compares two. */
  textHash?: string;
  /** Answered under 400 but says it is missing: Google's soft 404. */
  softNotFound?: boolean;
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
  /**
   * Same-site links on the page (path with no trailing slash, and its page
   * type), from full-crawl fetches only. Stored in `page_links`, not with the page.
   */
  internalLinks?: Array<{ path: string; family: string }>;
  /** Redirects followed before the final response; 2 or more is a chain. */
  redirectHops?: number;
  /** The response carried Strict-Transport-Security. */
  hsts?: boolean;
  /** The title's display width when it has CJK characters (each counts twice); absent means its length. */
  titleWidth?: number;
  /*
   * Content signals (packages/crawler/src/content-signals.ts). `viewport`,
   * `words`, `leadWords`, `images`, `landmarks`, `listsOrTables`,
   * `articleLike`, `author` and `entitySchema` are always written by crawls
   * that read them, so their absence means a result from before they existed.
   */
  lang?: string;
  viewport?: boolean;
  images?: number;
  imagesNoAlt?: number;
  mixedContent?: number;
  httpLinks?: number;
  externalLinks?: number;
  h1?: string;
  words?: number;
  questionHeadings?: number;
  listsOrTables?: boolean;
  leadWords?: number;
  statistics?: number;
  quotes?: number;
  /** Last-modified day (YYYY-MM-DD) from structured data, Open Graph or a <time> element. */
  modified?: string;
  articleLike?: boolean;
  author?: boolean;
  /** nosnippet or max-snippet:0: the page cannot appear in AI Overviews or AI Mode. */
  snippetBlocked?: boolean;
  landmarks?: number;
  headingSkips?: boolean;
  /** Organization, LocalBusiness or Person structured data with sameAs or url. */
  entitySchema?: boolean;
}

export type SitemapAudit = {
  totalUrls: number;
  sampledUrls: number;
  indexFiles: string[];
  urlTypes: Record<string, number>;
  /** Distinct pages per family: translations of one page count once (its largest language edition). */
  sections?: Record<string, { pages: number; languages: number }>;
  languages: Record<string, number>;
  errors: string[];
  freshness?: string;
}

/** Problems counted across every crawled sitemap URL. */
export type CrawlIssue =
  | "softNotFound"
  | "nearDuplicate"
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
  | "botChallenge"
  | "redirectChain"
  | "metaRefresh"
  | "mixedContent"
  | "httpLinks"
  | "titleLength"
  | "descriptionLength"
  | "duplicateDescription"
  | "h1EqualsTitle"
  | "headingSkips"
  | "langMissing"
  | "viewportMissing"
  | "imagesNoAlt"
  | "thinContent"
  | "yearInSlug"
  | "snippetBlocked"
  | "stale"
  | "noDate"
  | "noAnswerStructure"
  | "lowEvidence"
  | "noAuthor"
  | "noLandmarks";

/** Internal-link problems from `page_links` against one crawl; null parts when the crawl recorded no links. */
export type LinkGraphIssues = {
  orphans: { count: number; examples: string[] } | null;
  singleInbound: { count: number; examples: string[] } | null;
  brokenLinks: { links: number; sources: number; targets: Array<{ path: string; status: number; from: number }> } | null;
  depth: { deep: number; examples: string[]; skipped?: string } | null;
};

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

/** Crawl health of one language version (the URL's locale prefix; `default` for none). */
export type CrawlLocaleStats = {
  locale: string;
  urls: number;
  crawled: number;
  emptyShells: number;
  errors: number;
  noindex: number;
  redirected: number;
  missingDescription: number;
  missingStructuredData: number;
  softNotFound: number;
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
  /** Indexable pages, and those with an error-class issue per pillar (packages/core/src/checks/health.ts); `checked` is false when no row carries the content signals. */
  health?: { indexable: number; unhealthySeo: number; unhealthyAi: number; checked: boolean };
  duplicateDescriptionGroups?: Array<{ description: string; count: number; examples: string[] }>;
  linkGraph?: LinkGraphIssues;
  duplicateTitleGroups?: Array<{ title: string; count: number; examples: string[] }>;
  /** Indexable pages with the same title whose text hashes are within a few bits; `suffixed` when their URLs differ only by a trailing code. */
  nearDuplicateGroups?: Array<{ title: string; urls: string[]; suffixed: boolean }>;
  /** The near-duplicate count stopped at the query's cap, so it is a floor. */
  nearDuplicateTruncated?: boolean;
  /** Per language version, only when the crawl has more than one. */
  locales?: CrawlLocaleStats[];
  /** The title the site gave a URL that cannot exist, when it answered under 400; pages with that title count as soft 404s. */
  notFoundTitle?: string | null;
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

export type DataSourceKind = "sitemap" | "listing" | "page" | "own_site" | "supabase";
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
  /** ISO 4217 code lead values are entered in (e.g. `MYR`); unset until chosen. */
  currency?: string;
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
