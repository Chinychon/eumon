"use client";

import type { SiteRecord } from "@organic-growth/core";
import { CompetitorsSection } from "./ReportTabs";
import type { Navigate } from "./report-model";
import { KeywordsCard } from "./results/KeywordsCard";
import { AUTHORITY_NOTE, AuthoritySection } from "./results/sections";
import { useLatestReport, useResults } from "./site-data";
import { Card, ViewHeader } from "./ui";

/** What the site's searches are worth, which searches competitors win, and each domain's share of visibility. */
export function KeywordsView({ site }: { site: SiteRecord }) {
  const { data, error } = useResults(`/api/sites/${site.id}/results`);
  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const { results } = data;
  const host = new URL(site.baseUrl).hostname;
  return (
    <div>
      <ViewHeader
        title="Keywords"
        description={<>What {host}'s searches are worth, which searches competitors win, and each domain's share of visibility. {results.keywords.asOf ? "Refreshed monthly by Sync now on Performance." : "Filled by Sync now on Performance."}</>}
      />
      <div className="results">
        <KeywordsCard keywords={results.keywords} host={host} operator hasCredentials={data.site.signals.keywords} hasMarkets={results.markets.length > 0}
          searchTop10={results.search?.buckets.find((bucket) => bucket.top === 10)?.queries ?? null} />
      </div>
    </div>
  );
}

/** How the site compares: the kinds of pages competitors publish, your advantage, what stands out, and authority beside theirs. */
export function CompetitorsView({ site, onNavigate }: { site: SiteRecord; onNavigate: Navigate }) {
  const { data, error } = useResults(`/api/sites/${site.id}/results`);
  const { report, error: reportError } = useLatestReport(site.id);
  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data || report === undefined) return <div className="empty">Loading…</div>;
  return (
    <div>
      <ViewHeader
        title="Competitors"
        description={<>The kinds of pages your competitors publish that {new URL(site.baseUrl).hostname} doesn't, where you lead, and authority beside theirs. Compared by each analysis; add competitors in Setup.</>}
      />
      <div className="results">
        {reportError
          ? <div className="callout error" role="alert">The competitor comparison couldn't be loaded: {reportError}</div>
          : <CompetitorsSection report={report} site={site} competitors={data.results.authority.competitors.length} onNavigate={onNavigate} />}
        <Card title="Authority" subtitle="An authority estimate for you and each competitor.">
          <AuthoritySection data={data} operator />
          <p className="small muted">{AUTHORITY_NOTE}</p>
        </Card>
      </div>
    </div>
  );
}
