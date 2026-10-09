"use client";

import type { SiteRecord } from "@organic-growth/core";
import { AiReadinessCard, CompetitorsSection, ConversionSections, IndexCoverageCard, SearchAnalysis } from "./ReportTabs";
import type { Navigate, Report } from "./report-model";
import { BacklinksCard, BingCard, CompetitorSuggestionsCard, SearchResultsCard } from "./results/ConnectorCards";
import { KeywordsCard } from "./results/KeywordsCard";
import { SearchConsoleCard } from "./results/SearchConsoleCard";
import { LeadsDesk, OutcomesCard } from "./results/LeadsCards";
import { AiReadersCard, AiReferralsCard, AUTHORITY_NOTE, AuthoritySection, ConnectPrompt, EnquiriesCard, GoogleSearchCard, OrganicSessions, QuestionSearchesCard } from "./results/sections";
import { ExportMenu } from "./export/ExportMenu";
import { competitorSheets, pick } from "./export/report-sheets";
import type { Leads, Payload } from "./site-data";
import { Card } from "./ui";

/*
 * The Overview's Search, Enquiries, Keywords and Competitors tabs: the daily
 * sync's numbers first, then what the latest analysis found. Each panel
 * returns the tab's ruled column; the Overview loads the data once.
 */

/** Clicks, impressions, positions and top queries from the sync, then the analysis's queries near page one and pages to fix, then Google crawl coverage. */
export function SearchPanel({ site, data, report, onNavigate }: { site: SiteRecord; data: Payload; report: Report | null; onNavigate: Navigate }) {
  if (!data.site.searchConnected) {
    return (
      <div className="results">
        {/* One prompt, not a page of empty cards. */}
        <Card title="Google search" subtitle="Clicks, impressions, positions, top queries, the queries closest to page one, and which sitemap URLs Google has indexed.">
          <ConnectPrompt operator what="Search Console" onNavigate={onNavigate} />
        </Card>
        {data.results.organic && <Card title="Organic sessions"><OrganicSessions data={data} operator /></Card>}
        <BingCard data={data} operator />
      </div>
    );
  }
  return (
    <div className="results">
      <GoogleSearchCard data={data} operator onNavigate={onNavigate} />
      {report?.search ? <SearchAnalysis report={report} /> : (
        <Card title="Queries near page one">
          <p className="empty-state">Run an analysis to see the queries closest to page one, where searchers are, and the pages searchers skip.</p>
        </Card>
      )}
      <IndexCoverageCard siteId={site.id} onNavigate={onNavigate} />
      <SearchConsoleCard siteId={site.id} onNavigate={onNavigate} />
      <BingCard data={data} operator />
    </div>
  );
}

/** Eumon's pages from a search to an enquiry, enquiries per week, and how each template asks. */
export function EnquiriesPanel({ site, data, report, leads, onNavigate, onLeadsChanged }: { site: SiteRecord; data: Payload; report: Report | null; leads: Leads; onNavigate: Navigate; onLeadsChanged?: () => void }) {
  return (
    <div className="results">
      <EnquiriesCard data={data} operator />
      <OutcomesCard data={data} operator />
      <LeadsDesk siteId={site.id} onChanged={onLeadsChanged} />
      <ConversionSections report={report} leads={leads} onNavigate={onNavigate} />
    </div>
  );
}

/** What the site's searches are worth, which searches competitors win, each domain's share of visibility, and what the results pages hold. */
export function KeywordsPanel({ site, data }: { site: SiteRecord; data: Payload }) {
  const { results } = data;
  return (
    <div className="results">
      <KeywordsCard keywords={results.keywords} host={new URL(site.baseUrl).hostname} operator hasCredentials={data.site.signals.keywords} hasMarkets={results.markets.length > 0}
        searchTop10={results.search?.buckets.find((bucket) => bucket.top === 10)?.queries ?? null} />
      <SearchResultsCard data={data} operator />
    </div>
  );
}

/** Who wins the site's searches, the kinds of pages competitors publish that the site doesn't, and links and authority beside theirs. */
export function CompetitorsPanel({ site, data, report, onNavigate, onCompetitorsChanged }: { site: SiteRecord; data: Payload; report: Report | null; onNavigate: Navigate; onCompetitorsChanged?: () => void }) {
  return (
    <div className="results">
      <CompetitorSuggestionsCard siteId={site.id} data={data} onAdded={onCompetitorsChanged} />
      <CompetitorsSection report={report} site={site} competitors={data.results.authority.competitors.length} onNavigate={onNavigate} />
      <BacklinksCard data={data} operator />
      <Card title="Authority" subtitle="An authority estimate for you and each competitor." actions={<ExportMenu title="Authority" sheets={() => pick(competitorSheets(report, data.results, new URL(site.baseUrl).hostname), "Authority")} />}>
        <AuthoritySection data={data} operator />
        <p className="small muted">{AUTHORITY_NOTE}</p>
      </Card>
    </div>
  );
}

/** Which AI assistants read the site's pages, the visits they send, question searches, and whether the site lets them in. */
export function AiPanel({ data, report, onNavigate }: { data: Payload; report: Report | null; onNavigate: Navigate }) {
  return (
    <div className="results">
      <AiReadersCard data={data} operator onNavigate={onNavigate} />
      <AiReferralsCard data={data} operator onNavigate={onNavigate} />
      <QuestionSearchesCard data={data} operator onNavigate={onNavigate} />
      <AiReadinessCard report={report} />
    </div>
  );
}
