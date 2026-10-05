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

export interface FrameworkFingerprint {
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
  details: Record<string, unknown>;
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
  evidence: Record<string, unknown>;
  organicImpactScore: number;
  recommendation?: string;
  pagesAffected?: string[];
  createdAt: string;
}

export interface CrawlPageResult {
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
}

export interface SitemapAudit {
  totalUrls: number;
  sampledUrls: number;
  indexFiles: string[];
  urlTypes: Record<string, number>;
  languages: Record<string, number>;
  errors: string[];
  freshness?: string;
}

export interface SearchMetricRow {
  query: string;
  page: string;
  country: string;
  device: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
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
  evidence: Record<string, unknown>;
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
  evidence: Record<string, unknown>;
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
  properties?: Record<string, unknown>;
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
