"use client";

import { formatDay } from "../../components/api";
import { BacklinksCard, BingCard, SearchResultsCard } from "../../components/results/ConnectorCards";
import { KeywordsCard } from "../../components/results/KeywordsCard";
import { AiReadersCard, AiReferralsCard, AUTHORITY_NOTE, AuthoritySection, EnquiriesCard, GoogleSearchCard, KeyNumbers, ProofHeadline, QuestionSearchesCard, SpeedSection } from "../../components/results/sections";
import { useResults } from "../../components/site-data";
import { Card, ViewHeader } from "../../components/ui";

/**
 * A client's view of their results, without the console around it: every
 * section in one long report, read-only, with no site health, AI readiness
 * checks, or controls.
 */
export function ClientReport({ token }: { token: string }) {
  const { data, error } = useResults(`/api/r/${token}`);
  return (
    <main className="client-report">
      {error ? <div className="callout error" role="alert">{error}</div> : !data ? <div className="empty">Loading…</div> : (
        <div>
          <ViewHeader
            title={data.site.name}
            description={<>Google search, enquiries, speed, and authority for {new URL(data.site.baseUrl).hostname}. {data.results.searchThrough ? `Google data through ${formatDay(data.results.searchThrough)}.` : "Google data appears after the first sync."}</>}
          />
          <div className="results">
            <ProofHeadline data={data} operator={false} />
            <KeyNumbers data={data} operator={false} />
            <GoogleSearchCard data={data} operator={false} />
            {data.results.bing && <BingCard data={data} operator={false} />}
            <KeywordsCard keywords={data.results.keywords} host={new URL(data.site.baseUrl).hostname} operator={false} hasCredentials={data.site.signals.keywords} hasMarkets={data.results.markets.length > 0}
              searchTop10={data.results.search?.buckets.find((bucket) => bucket.top === 10)?.queries ?? null} />
            {data.results.serp.checked > 0 && <SearchResultsCard data={data} operator={false} />}
            {data.results.links.domains.some((entry) => entry.summary) && <BacklinksCard data={data} operator={false} />}
            <EnquiriesCard data={data} operator={false} />
            <AiReadersCard data={data} operator={false} />
            <AiReferralsCard data={data} operator={false} />
            <QuestionSearchesCard data={data} operator={false} />
            <Card title="Speed and authority" subtitle="Speed for real Chrome visitors over 28 days (Google's 75th percentile), Lighthouse lab scores, and an authority estimate.">
              <SpeedSection data={data} operator={false} />
              <div className="section-title">Authority</div>
              <AuthoritySection data={data} operator={false} />
              <p className="small muted">{AUTHORITY_NOTE}</p>
            </Card>
          </div>
        </div>
      )}
      <footer className="client-report-credit">Report by Eumon</footer>
    </main>
  );
}
