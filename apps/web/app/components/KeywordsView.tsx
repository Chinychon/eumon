"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "./api";
import type { Payload } from "./ResultsView";
import { KeywordsCard } from "./results/KeywordsCard";
import { ViewHeader } from "./ui";

/**
 * What the site's searches are worth and which ones competitors win: the
 * Keywords card on its own page, for the operator and technical clients.
 */
export function KeywordsView({ endpoint }: { endpoint: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setData(null);
    setError("");
    api<Payload>(endpoint).then(setData).catch((cause) => setError(errorMessage(cause)));
  }, [endpoint]);

  if (error) return <div className="callout error" role="alert">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const { site, results } = data;
  const host = new URL(site.baseUrl).hostname;
  return (
    <div>
      <ViewHeader
        title="Keywords"
        description={<>What {host}'s searches are worth, which searches competitors win, and each domain's share of visibility. {results.keywords.asOf ? "Refreshed monthly by Sync now on Performance." : "Filled by Sync now on Performance."}</>}
      />
      <div className="results">
        <KeywordsCard keywords={results.keywords} host={host} operator hasCredentials={site.signals.keywords} hasMarkets={results.markets.length > 0}
          searchTop10={results.search?.buckets.find((bucket) => bucket.top === 10)?.queries ?? null} />
      </div>
    </div>
  );
}
