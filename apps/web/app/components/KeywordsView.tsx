"use client";

import type { SiteRecord } from "@organic-growth/core";
import { CompetitorsSection } from "./ReportTabs";
import type { Navigate } from "./report-model";
import { KeywordsCard } from "./results/KeywordsCard";
import { AUTHORITY_NOTE, AuthoritySection } from "./results/sections";
import { useLatestReport, useResults } from "./site-data";
import { Card, ViewHeader } from "./ui";

/**
 * How the site compares: what its searches are worth and which ones
 * competitors win, the kinds of pages competitors publish, and authority
 * beside theirs. Keywords show even before competitors are added.
 */
export function KeywordsView({ site, onNavigate }: { site: SiteRecord; onNavigate: Navigate }) {
  const { data, error } = useResults(`/api/sites/${site.id}/results`);
  const { report, error: reportError } = useLatestReport(site.id);

  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data || report === undefined) return <div className="empty">Loading…</div>;
  const { results } = data;
  const host = new URL(site.baseUrl).hostname;
  return (
    <div>
      <ViewHeader
        title="Keywords & competitors"
        description={<>What {host}'s searches are worth, which searches competitors win, the pages they publish that you don't, and authority beside theirs. Keywords {results.keywords.asOf ? "refresh monthly with Sync now on Performance" : "fill in with Sync now on Performance"}; competitors are compared by each analysis.</>}
      />
      <div className="results">
        <KeywordsCard keywords={results.keywords} host={host} operator hasCredentials={data.site.signals.keywords} hasMarkets={results.markets.length > 0}
          searchTop10={results.search?.buckets.find((bucket) => bucket.top === 10)?.queries ?? null} />
        {reportError
          ? <div className="callout error" role="alert">The competitor comparison couldn't be loaded: {reportError}</div>
          : <CompetitorsSection report={report} site={site} competitors={results.authority.competitors.length} onNavigate={onNavigate} />}
        <Card title="Authority" subtitle="An authority estimate for you and each competitor.">
          <AuthoritySection data={data} operator />
          <p className="small muted">{AUTHORITY_NOTE}</p>
        </Card>
      </div>
    </div>
  );
}
