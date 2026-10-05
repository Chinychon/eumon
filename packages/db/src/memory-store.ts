/**
 * In-memory store for local/demo mode when D1 is unavailable.
 */
import type {
  CompetitorProfile,
  Finding,
  GrowthPlan,
  Opportunity,
  ProposedChange,
  SearchMetricRow,
  SiteRecord,
} from "@organic-growth/core";

export class MemoryStore {
  sites = new Map<string, SiteRecord>();
  findings = new Map<string, Finding[]>();
  plans = new Map<string, GrowthPlan>();
  opportunities = new Map<string, Opportunity[]>();
  competitors = new Map<string, CompetitorProfile[]>();
  changes = new Map<string, ProposedChange[]>();
  searchMetrics = new Map<string, SearchMetricRow[]>();
  conversionCounts = new Map<string, Record<string, number>>();
  analyses = new Map<
    string,
    { id: string; siteId: string; status: string; summary?: string }
  >();

  upsertSite(site: SiteRecord): void {
    this.sites.set(site.id, site);
  }

  getSite(id: string): SiteRecord | undefined {
    return this.sites.get(id);
  }

  listSites(): SiteRecord[] {
    return [...this.sites.values()].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  setFindings(siteId: string, findings: Finding[]): void {
    this.findings.set(siteId, findings);
  }

  getFindings(siteId: string): Finding[] {
    return this.findings.get(siteId) ?? [];
  }

  setPlan(plan: GrowthPlan): void {
    this.plans.set(plan.siteId, plan);
  }

  getPlan(siteId: string): GrowthPlan | undefined {
    return this.plans.get(siteId);
  }

  setOpportunities(siteId: string, items: Opportunity[]): void {
    this.opportunities.set(siteId, items);
  }

  getOpportunities(siteId: string): Opportunity[] {
    return this.opportunities.get(siteId) ?? [];
  }

  setCompetitors(siteId: string, items: CompetitorProfile[]): void {
    this.competitors.set(siteId, items);
  }

  getCompetitors(siteId: string): CompetitorProfile[] {
    return this.competitors.get(siteId) ?? [];
  }

  addChange(change: ProposedChange): void {
    const list = this.changes.get(change.siteId) ?? [];
    list.unshift(change);
    this.changes.set(change.siteId, list);
  }

  updateChange(
    siteId: string,
    changeId: string,
    patch: Partial<ProposedChange>,
  ): ProposedChange | undefined {
    const list = this.changes.get(siteId) ?? [];
    const idx = list.findIndex((c) => c.id === changeId);
    if (idx < 0) return undefined;
    list[idx] = { ...list[idx], ...patch };
    this.changes.set(siteId, list);
    return list[idx];
  }

  getChanges(siteId: string): ProposedChange[] {
    return this.changes.get(siteId) ?? [];
  }

  setSearchMetrics(siteId: string, rows: SearchMetricRow[]): void {
    this.searchMetrics.set(siteId, rows);
  }

  getSearchMetrics(siteId: string): SearchMetricRow[] {
    return this.searchMetrics.get(siteId) ?? [];
  }

  trackConversion(siteId: string, event: string): void {
    const counts = this.conversionCounts.get(siteId) ?? {};
    counts[event] = (counts[event] ?? 0) + 1;
    this.conversionCounts.set(siteId, counts);
  }

  getConversionCounts(siteId: string): Record<string, number> {
    return this.conversionCounts.get(siteId) ?? {};
  }
}

export const globalMemoryStore = new MemoryStore();
