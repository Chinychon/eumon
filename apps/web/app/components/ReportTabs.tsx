"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CHECKS, COVERAGE_CLASSES, countryName, type CoverageClass, type SiteRecord } from "@organic-growth/core";
import { ChecksCard } from "./ChecksCard";
import type { IndexCoverage } from "@organic-growth/db";
import { api, formatDay, formatNumber } from "./api";
import { BarList, Funnel, Heatmap, PairedBars, Scatter } from "./charts";
import { CrawlGarden } from "./pixel";
import { CrawlLogCard } from "./results/ConnectorCards";
import { SPEED_SUBTITLE, SpeedSection } from "./results/sections";
import { SiteGraph } from "./SiteGraph";
import { familyLabel, findingArea, gapsFirst, HEALTH_COLUMNS, opportunityArea, pageTypeHealth, servedShare, urlPath, type Finding, type Navigate, type Report } from "./report-model";
import { ExportMenu } from "./export/ExportMenu";
import { aiReadinessSheets, competitorSheets, conversionSheets, coverageSheets, fixSheets, pageTypeSheets, pick, pushSheets, renderingSheets, routeSheets, searchAnalysisSheets, speedSheets } from "./export/report-sheets";
import type { Leads, Payload } from "./site-data";
import { Badge, Button, Card, Kpi } from "./ui";

/*
 * The analysis report by area, as sections the console's pages compose:
 * technical on the Overview, search and conversion on Performance,
 * competitors beside keywords. Each leads with a chart; every finding,
 * opportunity, and insight is one line, with the explanation behind "Why" so
 * the page reads at a glance. Sections return fragments, so they stack into
 * the page's ruled `.results` column.
 */

export type Change = { id: string; findingId?: string; title: string; reason: string; patch: string; prUrl?: string };

const SEVERITY_CLASS: Record<string, string> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", INFORMATIONAL: "info" };
const path = urlPath;
const share = (value: number) => `${Math.round(value * 100)}%`;

/** One line that opens in place to say why it matters and what to do. */
export function WhyRow({ lead, title, aside, children }: { lead?: ReactNode; title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <details className="why-row">
      <summary>
        {lead}
        <span className="why-title">{title}</span>
        {aside && <span className="why-aside">{aside}</span>}
        <span className="why-open" aria-hidden="true">Why</span>
      </summary>
      <div className="why-body">{children}</div>
    </details>
  );
}

/** A finding's title, led by its check's name, and the anchor the Checks card links to. */
const FindingTitle = ({ finding }: { finding: Finding }) => {
  const check = finding.checkId ? CHECKS[finding.checkId] : undefined;
  return <span id={`finding-${finding.id}`}>{check && <span className="small muted">{check.name} · </span>}{finding.title}</span>;
};

export const Severity = ({ value }: { value: string }) => <span className={`severity ${SEVERITY_CLASS[value] ?? "info"}`}>{value}</span>;

/** The site as Google receives it, where it breaks, how fast it is, and the fixes, most impact first. Speed comes from the sync, so it shows before any analysis. */
export function TechnicalTab({ siteId, report, results, running, changes, busy, hasRepo, onGenerateChange, onOpenPullRequest, onRecrawl, onSetup }: {
  siteId: string;
  report: Report | null;
  results: Payload | null;
  /** An analysis is under way, so the empty states wait for it rather than ask for one. */
  running: boolean;
  changes: Change[];
  busy: string;
  hasRepo: boolean;
  onGenerateChange: (findingId: string) => void;
  onOpenPullRequest: (change: Change) => void;
  onRecrawl: () => void;
  /** Opens Setup, where server logs are connected. */
  onSetup?: () => void;
}) {
  const speed = results && <Card title="Speed" subtitle={SPEED_SUBTITLE} actions={<ExportMenu title="Speed" sheets={() => speedSheets(results.results)} />}><SpeedSection data={results} operator /></Card>;
  const crawlLog = results && <CrawlLogCard data={results} onSetup={onSetup} />;
  if (!report) {
    return (
      <div className="results">
        <TechnicalNumbers report={null} results={results} running={running} />
        <Card title="Every sitemap URL"><p className="empty-state">{running ? "Fills in when the analysis finishes: every sitemap URL, fetched as Googlebot does, and where pages break." : "Run an analysis to fetch every sitemap URL as Googlebot does and see where pages break."}</p></Card>
        {crawlLog}
        {speed}
      </div>
    );
  }
  const families = report.coverage?.families ?? [];
  const findings = report.findings.filter((finding) => findingArea(finding.category) === "technical").sort((a, b) => b.organicImpactScore - a.organicImpactScore);
  const comparisons = report.rendering?.comparisons ?? [];
  const flaky = (report.rendering?.repeatability ?? []).filter((entry) => entry.failed);
  return (
    <div className="results">
      <TechnicalNumbers report={report} results={results} running={running} />
      <div className="ruled-grid c11">
        <Card title="Every sitemap URL" subtitle={`${formatNumber(report.coverage?.totalUrls ?? report.sitemap.totalUrls)} URLs, one square each, as Googlebot received them.`}
          actions={families.length > 0 && <ExportMenu title="Sitemap URLs by page type" sheets={() => pageTypeSheets(report)} />}>
          {families.length ? (
            <CrawlGarden
              fill
              label="Every sitemap URL by page type"
              families={families.map((family) => ({ family: family.family, total: family.urls, done: family.urls, blocked: Math.max(0, family.urls - family.crawled - family.errors), emptyShells: family.emptyShells, errors: family.errors }))}
            />
          ) : <p className="empty-state">Run a full analysis to see every URL.</p>}
        </Card>
        <Card title="Text Google gets, before and after JavaScript" subtitle="One page per template. A short first bar means Google sees little until scripts run."
          actions={comparisons.length > 0 && <ExportMenu title="Text before and after JavaScript" sheets={() => renderingSheets(report)} />}>
          {comparisons.length
            ? <PairedBars series={["In the HTML", "After JavaScript"]} groups={comparisons.map((entry) => ({ label: familyLabel(entry.family), values: [entry.rawTextLength, entry.renderedTextLength] }))} />
            : <p className="empty-state">No pages were rendered in a browser in this analysis.</p>}
          {flaky.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>Repeated fetches failed on {flaky.map((entry) => `${familyLabel(entry.family)} (${entry.failed} of ${entry.attempts})`).join(", ")}.</p>}
        </Card>
      </div>
      {families.length > 0 && (
        <Card title="Where pages break, by page type" subtitle="Darker means a larger share of that page type has the problem." actions={<ExportMenu title="Where pages break" sheets={() => pageTypeSheets(report)} />}>
          <Heatmap caption="Problems per page type" columns={HEALTH_COLUMNS.map((column) => column.label)} rows={pageTypeHealth(families).map((row) => ({ ...row, note: `${formatNumber(row.urls)} ${row.urls === 1 ? "URL" : "URLs"}` }))} />
        </Card>
      )}
      {crawlLog}
      {speed}
      <SiteGraph siteId={siteId} />
      <ChecksCard report={report} pillar="seo" />
      <Card title="Fixes" actions={<><span className="count-pill">{findings.length} findings</span>{findings.length > 0 && <ExportMenu title="Technical fixes" sheets={() => fixSheets(report, (category) => findingArea(category) === "technical")} />}</>}>
        {findings.length ? findings.map((finding) => (
          <FindingRow key={finding.id} finding={finding} change={changes.find((item) => item.findingId === finding.id)} busy={busy}
            fixable={hasRepo && ["sitemap", "indexing"].includes(finding.category)} onGenerateChange={onGenerateChange} onOpenPullRequest={onOpenPullRequest} />
        )) : <p className="empty-state">No technical issues surfaced in this analysis.</p>}
      </Card>
      {report.repo && <CodeIntelligence repo={report.repo} />}
      {report.crawlReuse && (
        <div className="callout run-reuse">
          <span>{formatNumber(report.crawlReuse.urls)} pages were reused from {report.crawlReuse.from ? `the analysis on ${new Date(report.crawlReuse.from).toLocaleDateString("en", { day: "numeric", month: "short" })}` : "the last analysis"}: unchanged since then, so they were not fetched again.</span>
          <Button small variant="ghost" disabled={busy === "analysis"} onClick={onRecrawl}>Re-crawl every page</Button>
        </div>
      )}
      {report.sitemap.errors.length > 0 && <div className="crawl-note"><strong>Sitemap note</strong><span>{report.sitemap.errors.join(" ")}</span></div>}
    </div>
  );
}

/** Sitemap size, how much of it reaches Google intact, site health, and the fixes found. */
function TechnicalNumbers({ report, results, running }: { report: Report | null; results: Payload | null; running: boolean }) {
  const coverage = report?.coverage;
  const served = servedShare(coverage);
  const health = results?.results.health;
  const fixes = report?.findings.filter((finding) => findingArea(finding.category) === "technical");
  const urgent = fixes?.filter((finding) => finding.severity === "CRITICAL" || finding.severity === "HIGH").length ?? 0;
  return (
    <div className="metrics-grid">
      <Kpi label="URLs in sitemap" value={report ? formatNumber(report.sitemap.totalUrls) : "—"} caption={!report ? (running ? "Fills in when the analysis finishes" : "Run an analysis to fill these in") : report.sitemap.errors[0] ? "See the sitemap note below" : "Declared to search engines"} />
      <Kpi label="Reach Google intact" value={served === null ? "—" : `${Math.round(served * 100)}%`} caption={coverage ? `${formatNumber(coverage.emptyShellUrls)} empty · ${formatNumber(coverage.httpErrorUrls)} errors` : "Every sitemap URL, fetched as Google"} />
      <Kpi label="Site health" value={health?.value == null ? "—" : `${health.value}%`} caption={health?.day ? `No error, empty HTML, or noindex · ${formatDay(health.day)}` : "Crawled pages with no error, empty HTML, or noindex"} />
      <Kpi label="Technical fixes" value={fixes ? formatNumber(fixes.length) : "—"} caption={fixes ? (urgent ? `${urgent} critical or high` : "None critical or high") : "Found by each analysis"} />
    </div>
  );
}

function FindingRow({ finding, change, busy, fixable, onGenerateChange, onOpenPullRequest }: {
  finding: Finding; change?: Change; busy: string; fixable: boolean;
  onGenerateChange: (findingId: string) => void; onOpenPullRequest: (change: Change) => void;
}) {
  return (
    <WhyRow lead={<Severity value={finding.severity} />} title={<FindingTitle finding={finding} />} aside={<span className="impact">{finding.organicImpactScore}<small>impact</small></span>}>
      <p>{finding.summary}</p>
      {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
      {fixable && !change && <button className="inline-action" disabled={Boolean(busy)} onClick={() => onGenerateChange(finding.id)}>{busy === finding.id ? "Preparing reviewable change…" : "Generate safe configuration fix"}</button>}
      {change && (
        <div className="change-card">
          <strong>{change.title}</strong>
          <p>{change.reason}</p>
          <pre>{change.patch}</pre>
          {change.prUrl ? <a href={change.prUrl} target="_blank" rel="noreferrer">Open draft pull request</a> : <button className="inline-action" disabled={Boolean(busy)} onClick={() => onOpenPullRequest(change)}>{busy === change.id ? "Opening draft PR…" : "Create draft GitHub PR"}</button>}
        </div>
      )}
    </WhyRow>
  );
}

/** Points for the position × impressions plot: queries near page one stand out from the rest. */
export function searchPoints(search: NonNullable<Report["search"]>) {
  return [
    ...search.strikingDistance.map((entry) => ({ label: entry.query, x: entry.position, y: entry.impressions, detail: path(entry.page), highlight: true })),
    ...search.lowCtrPages.map((entry) => ({ label: path(entry.page), x: entry.position, y: entry.impressions, detail: `CTR ${(entry.ctr * 100).toFixed(1)}%, typical ${(entry.expectedCtr * 100).toFixed(0)}%` })),
  ];
}

const COVERAGE_LABEL: Record<CoverageClass, string> = {
  indexed: "Indexed", crawled: "Crawled, not indexed", discovered: "Discovered, not crawled", unknown: "Unknown to Google", excluded: "Excluded",
};

/** A stacked bar of what Google did with checked URLs, in the class order. */
function CoverageBar({ byClass, checked }: { byClass: Record<CoverageClass, number>; checked: number }) {
  return (
    <span className="coverage-bar" role="img" aria-label={COVERAGE_CLASSES.map((name) => `${COVERAGE_LABEL[name]} ${byClass[name]}`).join(", ")}>
      {checked > 0 && COVERAGE_CLASSES.map((name) => byClass[name] > 0 && <i key={name} className={`cov-${name}`} style={{ width: `${(byClass[name] / checked) * 100}%` }} title={`${COVERAGE_LABEL[name]}: ${formatNumber(byClass[name])}`} />)}
    </span>
  );
}

/** How many sitemap URLs Google has crawled and indexed, from URL Inspection a few hundred a day. */
export function IndexCoverageCard({ siteId, onNavigate }: { siteId: string; onNavigate: Navigate }) {
  const [data, setData] = useState<{ coverage: IndexCoverage | null; connected: boolean } | null>(null);
  useEffect(() => { api<{ coverage: IndexCoverage | null; connected: boolean }>(`/api/sites/${siteId}/index-coverage`).then(setData).catch(() => setData(null)); }, [siteId]);
  if (!data) return null;
  const title = "Google crawl coverage";
  if (!data.connected) {
    return <Card title={title}><p className="empty-state">Connect Search Console to ask Google about each sitemap URL.</p><Button small variant="secondary" onClick={() => onNavigate("setup")}>Open Setup</Button></Card>;
  }
  const coverage = data.coverage;
  if (!coverage || coverage.checked === 0) {
    return <Card title={title} subtitle="Google is asked about a few hundred sitemap URLs a day."><p className="empty-state">No URLs checked yet. The first ones are checked on the next sync.</p></Card>;
  }
  const days = Math.ceil((coverage.total - coverage.checked) / 1800);
  const share = (n: number) => `${Math.round((n / coverage.checked) * 100)}%`;
  return (
    <Card title={title} actions={<ExportMenu title="Google crawl coverage" sheets={() => coverageSheets(coverage)} />} subtitle={`Checked ${formatNumber(coverage.checked)} of ${formatNumber(coverage.total)} sitemap URLs with Google.${days > 0 ? ` About ${days} more day${days === 1 ? "" : "s"} until every URL is checked once.` : " Every URL has been checked; each is checked again after 30 days."}`}>
      <CoverageBar byClass={coverage.byClass} checked={coverage.checked} />
      <div className="chart-legend coverage-legend">
        {COVERAGE_CLASSES.map((name) => <span key={name} className={`cov-${name}`}>{COVERAGE_LABEL[name]} {formatNumber(coverage.byClass[name])} · {share(coverage.byClass[name])}</span>)}
      </div>
      <p className="small muted">{formatNumber(coverage.recentlyCrawled)} of the checked URLs ({share(coverage.recentlyCrawled)}) were crawled by Google in the last 30 days. Shares are of checked URLs.</p>
      <div className="table-wrap">
        <table className="table coverage-table">
          <thead><tr><th>Page type</th><th className="num">Checked</th><th>What Google did</th></tr></thead>
          <tbody>{coverage.families.map((family) => (
            <tr key={family.family}>
              <td><code>{familyLabel(family.family)}</code></td>
              <td className="num">{formatNumber(family.checked)} of {formatNumber(family.total)}</td>
              <td><CoverageBar byClass={family.byClass} checked={family.checked} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  );
}

/** What the latest analysis found in Search Console: the search mix, queries near page one, where searchers are, and pages to fix. */
export function SearchAnalysis({ report }: { report: Report }) {
  const search = report.search;
  if (!search) return null;
  const entity = search.entityQueries?.byType[0];
  const opportunities = report.opportunities.filter((entry) => opportunityArea(entry, report.findings) === "search" && entry.intent !== "technical_enabler").sort((a, b) => b.priorityScore - a.priorityScore);
  // The page-level rows below say what the search findings say, page by page; the findings show only without them.
  const findings = search.lowCtrPages.length || search.cannibalized.length ? [] : report.findings.filter((finding) => finding.category === "search");
  return (
    <>
      <div className="metrics-grid">
        <Kpi label="Near page one" value={formatNumber(search.strikingDistance.length)} caption="queries at positions 4–15 in the latest analysis" />
        <Kpi label="From target markets" value={search.targetShare ? share(search.targetShare.impressions) : "—"} caption={search.targetShare ? search.targetMarkets.map(countryName).join(", ") : "Set markets in Setup"} />
        <Kpi label="Commercial searches" value={share(search.commercialShare)} caption="of clicks: cost, price, best, booking…" />
        <Kpi label={entity ? `Looking up a ${entity.entityType}` : "Branded searches"} value={share(entity ? search.entityQueries!.share : search.brandedShare)} caption={entity ? "of clicks name one record" : "of clicks include your brand"} />
      </div>
      <div className="ruled-grid c21">
        <Card title="Position vs impressions" subtitle="Green: queries at positions 4–15, the closest to page-one clicks. Grey: pages on page one that searchers skip."
          actions={<ExportMenu title="Position vs impressions" sheets={() => pick(searchAnalysisSheets(report), "Near page one", "Skipped on page one")} />}>
          <Scatter points={searchPoints(search)} band={[4, 15]} xLabel="Position" yLabel="impressions" />
        </Card>
        <Card title="Where searchers are" subtitle="Share of impressions by country." actions={<ExportMenu title="Where searchers are" sheets={() => pick(searchAnalysisSheets(report), "Where searchers are")} />}>
          <BarList rows={search.countries.slice(0, 6).map((country) => ({ label: country.name, value: Math.round(country.impressionShare * 100) }))} />
        </Card>
      </div>
      <Card title="Queries to push" actions={<><span className="count-pill">{opportunities.length}</span>{opportunities.length > 0 && <ExportMenu title="Queries to push" sheets={() => pushSheets(opportunities)} />}</>}>
        {opportunities.length ? opportunities.slice(0, 5).map((entry) => (
          <WhyRow key={entry.title} title={entry.title} aside={<span className="score">{Math.round(entry.priorityScore)}<small>priority</small></span>}>
            <p>{entry.rationale}</p>
            {entry.potentialPage && <p><code>{entry.potentialPage}</code></p>}
          </WhyRow>
        )) : <p className="empty-state">No queries are close enough to page one to push yet.</p>}
      </Card>
      <Card title="Pages to fix" actions={<ExportMenu title="Pages to fix" sheets={() => [...pick(searchAnalysisSheets(report), "Skipped on page one", "Competing pages"), ...fixSheets(report, (category) => category === "search")]} />}>
        {findings.map((finding) => (
          <WhyRow key={finding.id} lead={<Severity value={finding.severity} />} title={<FindingTitle finding={finding} />}>
            <p>{finding.summary}</p>
            {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
          </WhyRow>
        ))}
        {search.lowCtrPages.slice(0, 5).map((page) => (
          <WhyRow key={page.page} title={<>Skipped on page one: <a href={page.page} target="_blank" rel="noreferrer">{path(page.page)}</a></>} aside={<span className="bad-count">{(page.ctr * 100).toFixed(1)}% CTR</span>}>
            <p>Position {page.position.toFixed(1)} usually earns about {(page.expectedCtr * 100).toFixed(0)}% of clicks. Rewrite the title and description around: {page.queries.join(", ")}.</p>
          </WhyRow>
        ))}
        {search.cannibalized.slice(0, 5).map((entry) => (
          <WhyRow key={entry.query} title={<>Competing pages for “{entry.query}”</>} aside={<span className="small muted">{entry.pages.length} pages</span>}>
            <p>{formatNumber(entry.impressions)} impressions split between {entry.pages.map((page) => `${path(page.page)} (#${page.position.toFixed(0)})`).join(" and ")}. Pick one page to rank; merge or redirect the other, or link it to the main one.</p>
          </WhyRow>
        ))}
        {!findings.length && !search.lowCtrPages.length && !search.cannibalized.length && <p className="empty-state">No search problems found on existing pages.</p>}
      </Card>
    </>
  );
}

const GAP_STATUS: Record<string, { label: string; tone: string }> = {
  gap: { label: "Gap", tone: "red" },
  advantage: { label: "You lead", tone: "green" },
  yours_only: { label: "Only you", tone: "green" },
  shared: { label: "Comparable", tone: "gray" },
};

/** Pages per section against each competitor, your advantage, the competitors, and what stands out. */
export function CompetitorsSection({ report, site, competitors, onNavigate }: { report: Report | null; site: SiteRecord; competitors: number; onNavigate: Navigate }) {
  const competition = report?.competition;
  if (competitors > 0 && !competition?.rows.length) {
    return (
      <Card title="Competitors not compared yet" subtitle={`${competitors} ${competitors === 1 ? "competitor is" : "competitors are"} set up. ${report ? "The last analysis ran before they were added; update it" : "Run an analysis"} (top of this page) to compare the kinds of pages they publish with yours.`} />
    );
  }
  if (!report || !competition?.rows.length) {
    return (
      <Card title="No competitors compared yet" subtitle="Add competitor domains in Setup. The next analysis reads their sitemaps and a few pages per section to show which kinds of pages they publish that you don't.">
        <Button onClick={() => onNavigate("setup")}>Add competitors</Button>
      </Card>
    );
  }
  const domains = competition.competitors.filter((competitor) => competitor.analyzed).slice(0, 3);
  const you = new URL(site.baseUrl).hostname.replace(/^www\./, "");
  const rows = gapsFirst(competition);
  const pages = (entry?: { pages: number; urls?: number; languages?: number }) => (entry?.pages
    ? <>{`~${formatNumber(entry.pages)}`}{(entry.languages ?? 1) > 1 && <small className="cell-note">{entry.languages} languages · {formatNumber(entry.urls ?? entry.pages)} URLs</small>}</>
    : "—");
  return (
    <>
      <Card
        title="Pages per section: you vs each competitor"
        subtitle="Sections where a competitor is furthest ahead come first. Counts show where they invest, not search demand."
        actions={<>{competition.rows.some((row) => row.status === "gap") && <Button small variant="secondary" onClick={() => onNavigate("data")}>Close a gap in Data</Button>}<ExportMenu title="Pages per section" sheets={() => pick(competitorSheets(report, null, you), "Pages per section")} /></>}
      >
        <PairedBars series={[you, ...domains.map((competitor) => competitor.domain)]} groups={rows.slice(0, 10).map((row) => ({
          label: row.label,
          values: [row.you.pages, ...domains.map((competitor) => row.competitors.find((entry) => entry.domain === competitor.domain)?.pages ?? 0)],
        }))} />
      </Card>
      <div className="ruled-grid c11">
        <Card title="Your advantage"><p className="advantage-line">{report.plan.competitiveAdvantage}</p></Card>
        <Card title="Competitors" actions={<ExportMenu title="Competitors" sheets={() => pick(competitorSheets(report, null, you), "Competitors")} />}>
          {report.competitors.slice(0, 5).map((competitor) => (
            <WhyRow key={competitor.domain} lead={<span className="domain-icon">{competitor.domain[0]?.toUpperCase()}</span>} title={competitor.domain}
              aside={<span className="relevance">{competitor.relevanceScore !== undefined ? `${Math.round(competitor.relevanceScore * 100)}% overlap` : "Owner selected"}</span>}>
              <p>{competitor.summary}</p>
              {competitor.architectureNotes && <p>{competitor.architectureNotes}</p>}
              {competitor.conversionNotes && <p>{competitor.conversionNotes}</p>}
            </WhyRow>
          ))}
        </Card>
      </div>
      <Card title="What stands out" actions={<ExportMenu title="What stands out" sheets={() => pick(competitorSheets(report, null, you), "What stands out", "Pages per section")} />}>
        {competition.insights.slice(0, 6).map((insight) => <p key={insight} className="line-item">{insight}</p>)}
        <details className="why-row table-toggle" open>
          <summary><span className="why-title">Every section as a table</span><span className="why-open" aria-hidden="true" /></summary>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Content type</th><th className="num">You</th>{domains.map((competitor) => <th className="num" key={competitor.domain}>{competitor.domain}</th>)}<th>Status</th><th>Your data</th></tr></thead>
              <tbody>{rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td className="num">{pages(row.you)}</td>
                  {domains.map((competitor) => {
                    const entry = row.competitors.find((item) => item.domain === competitor.domain);
                    return <td className="num" key={competitor.domain}>{entry?.examples[0] ? <a href={entry.examples[0]} target="_blank" rel="noreferrer">{pages(entry)}</a> : pages(entry)}</td>;
                  })}
                  <td><Badge tone={GAP_STATUS[row.status]?.tone}>{GAP_STATUS[row.status]?.label ?? row.status}</Badge></td>
                  <td className="small">{row.data ? `${row.data.dataset}: ${formatNumber(row.data.records)} records, ${formatNumber(row.data.livePages)} live` : <span className="muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      </Card>
    </>
  );
}

const PATH_LABELS: Record<string, string> = { whatsapp: "WhatsApp", phone: "Phone", email: "Email", form: "Enquiry form", booking: "Booking / quote" };

/** Visit → CTA → lead from the landing pages. */
export function LeadFunnel({ leads, onNavigate }: { leads: Leads; onNavigate: Navigate }) {
  if (!leads) return <p className="empty-state">Loading…</p>;
  if (!leads.pages) {
    return (
      <>
        <p className="empty-state">{leads.events28 ? `${formatNumber(leads.events28)} conversion events in the last 28 days. Publish landing pages to see which ones bring them.` : "No conversions recorded yet. Install tracking to count WhatsApp taps, calls, and forms."}</p>
        {!leads.events28 && <Button small variant="secondary" onClick={() => onNavigate("setup")}>Install tracking</Button>}
      </>
    );
  }
  return <Funnel steps={[{ label: "Page views", value: leads.views }, { label: "CTA clicks", value: leads.ctaClicks }, { label: "Leads", value: leads.conversions }]} />;
}

/** Every conversion event tracked, how each template asks for the enquiry, and the conversion findings. */
export function ConversionSections({ report, leads, onNavigate }: { report: Report | null; leads: Leads; onNavigate: Navigate }) {
  const conversion = report?.conversion;
  return (
    <>
      <Card title="Conversion events" subtitle="Everything tracked on the site in the last 28 days." actions={<><Button small variant="secondary" onClick={() => onNavigate("setup")}>Tracking setup</Button><ExportMenu title="Conversion events" sheets={() => pick(conversionSheets(report, leads), "Conversion events")} /></>}>
        <div className="big-number">{leads ? formatNumber(leads.events28) : "—"}</div>
      </Card>
      {conversion && conversion.templates.length > 0 && (
        <Card title="How each template asks for the enquiry" actions={<ExportMenu title="How each template asks" sheets={() => pick(conversionSheets(report, leads), "How each template asks", "Events worth tracking")} />}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Template</th><th>Ways to convert</th><th>Prices shown</th><th>Tracking</th></tr></thead>
              <tbody>{conversion.templates.map((template) => (
                <tr key={template.url}>
                  <td><a href={template.url} target="_blank" rel="noreferrer"><code>{familyLabel(template.family)}</code></a></td>
                  <td>{template.paths.length ? template.paths.map((entry) => PATH_LABELS[entry] ?? entry).join(", ") : <span className="bad-count">None found</span>}</td>
                  <td>{template.prices ? "Yes" : <span className="muted">No</span>}</td>
                  <td className="small">{template.tracking.join(", ") || <span className="bad-count">None found</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <details className="why-row table-toggle" open>
            <summary><span className="why-title">Events worth tracking</span><span className="why-open" aria-hidden="true" /></summary>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Event</th><th>When it fires</th></tr></thead>
                <tbody>{conversion.suggestedEvents.map((entry) => <tr key={entry.event}><td><code>{entry.event}</code></td><td>{entry.trigger}</td></tr>)}</tbody>
              </table>
            </div>
          </details>
        </Card>
      )}
      {report?.findings.filter((finding) => finding.category === "conversion").map((finding) => (
        <Card key={finding.id}>
          <WhyRow lead={<Severity value={finding.severity} />} title={finding.title}>
            <p>{finding.summary}</p>
            {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
          </WhyRow>
        </Card>
      ))}
    </>
  );
}

const KIND_LABEL: Record<string, string> = { live: "Live answers", crawler: "Crawler", control: "Control token" };

/**
 * Whether AI assistants may read the site, from the latest analysis:
 * robots.txt per AI agent, llms.txt, and question-and-answer markup.
 * Blocking is a choice; this says what it costs, it never "fixes" it.
 */
export function AiReadinessCard({ report }: { report: Report | null }) {
  const readiness = report?.aiReadiness;
  if (!readiness) {
    return <Card title="Can AI assistants read the site?"><p className="empty-state">{report ? "The last analysis ran before AI readiness was checked. Run it again to see it." : "Run an analysis to check robots.txt for each AI crawler, llms.txt, and question markup."}</p></Card>;
  }
  const blocked = readiness.crawlers.filter((crawler) => !crawler.allowed);
  const findings = report!.findings.filter((finding) => finding.category === "ai_visibility");
  return (
    <Card title="Can AI assistants read the site?" actions={<ExportMenu title="AI agents in robots.txt" sheets={() => aiReadinessSheets(report)} />} subtitle="From the latest analysis: robots.txt as it applies to each AI agent, an llms.txt guide for AI tools, and FAQ markup on the sampled pages.">
      <div className="metrics-grid c3">
        <Kpi label="AI agents allowed" value={readiness.robots === "unreadable" ? "—" : `${readiness.crawlers.length - blocked.length} of ${readiness.crawlers.length}`}
          caption={readiness.robots === "missing" ? "No robots.txt: everything is allowed" : readiness.robots === "unreadable" ? "robots.txt couldn't be read" : blocked.length ? `${blocked.length} blocked in robots.txt` : "None blocked"} />
        <Kpi label="llms.txt" value={readiness.llmsTxt ? "Present" : "None"} caption={readiness.llmsTxt ? "A plain-text guide AI tools can read" : "Optional: a short guide to the site for AI tools"} />
        <Kpi label="Pages with Q&A markup" value={`${readiness.faqPages.pages} of ${readiness.faqPages.of}`} caption="FAQPage or QAPage data on sampled pages; no longer a Google rich result" />
      </div>
      {findings.map((finding) => (
        <WhyRow key={finding.id} lead={<Severity value={finding.severity} />} title={<FindingTitle finding={finding} />}>
          <p>{finding.summary}</p>
          {finding.recommendation && <p><strong>Next step.</strong> {finding.recommendation}</p>}
        </WhyRow>
      ))}
      <details className="why-row table-toggle" open={blocked.length > 0}>
        <summary><span className="why-title">Every AI agent and what robots.txt says</span><span className="why-open" aria-hidden="true" /></summary>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Agent</th><th>What it does</th><th>Kind</th><th>robots.txt</th></tr></thead>
            <tbody>{readiness.crawlers.map((crawler) => (
              <tr key={crawler.agent}>
                <td><code>{crawler.agent}</code></td>
                <td className="small">{crawler.purpose}</td>
                <td className="small">{KIND_LABEL[crawler.kind] ?? crawler.kind}</td>
                <td>{crawler.allowed ? <Badge tone="green">Allowed</Badge> : <Badge tone="red">Blocked</Badge>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

const RENDERING_LABEL: Record<string, { label: string; tone: string }> = {
  static: { label: "Static", tone: "green" },
  isr: { label: "Static + revalidate", tone: "green" },
  ssr: { label: "Server per request", tone: "gray" },
  on_demand: { label: "On demand", tone: "gray" },
  client: { label: "Browser", tone: "red" },
  unknown: { label: "Unknown", tone: "gray" },
};

/** The detected stack and what each route's code means for the HTML crawlers receive. */
function CodeIntelligence({ repo }: { repo: NonNullable<Report["repo"]> }) {
  const { fingerprint } = repo;
  const facts: Array<[string, string | undefined]> = [
    ["Framework", [fingerprint.framework, fingerprint.router].filter(Boolean).join(" · ")],
    ["Rendering", fingerprint.rendering],
    ["Language", `${fingerprint.language} · ${fingerprint.packageManager}`],
    ["Deployment", fingerprint.deployment],
    ["Content", fingerprint.contentSource ?? (fingerprint.cms !== "none" ? fingerprint.cms : undefined)],
    ["Database", fingerprint.database],
    ["Analytics", fingerprint.analytics.join(", ") || undefined],
    ["SEO tooling", fingerprint.seoTooling.join(", ") || undefined],
    ["Sitemap code", repo.sitemapCode ? `${repo.sitemapCode.source}${repo.sitemapCode.splitsSitemaps ? " (split)" : ""}` : undefined],
  ];
  const routes = [...(repo.routeInspections ?? [])].sort((a, b) => Number(b.dynamic) - Number(a.dynamic)).slice(0, 15);
  return (
    <Card title="Stack and routes, from the repository" actions={routes.length > 0 && <ExportMenu title="Routes" sheets={() => routeSheets(repo)} />}>
      <div className="fact-grid">{facts.filter(([, value]) => value).map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>
      {routes.length > 0 && (
        <details className="why-row table-toggle">
          <summary><span className="why-title">{routes.length} routes and how they render</span><span className="why-open" aria-hidden="true" /></summary>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Route</th><th>Renders</th><th>Content data</th><th>Title & meta</th><th>Notes</th></tr></thead>
              <tbody>{routes.map((route) => (
                <tr key={route.source + route.pathPattern}>
                  <td><code>{route.pathPattern}</code><div className="small muted">{route.source}</div></td>
                  <td><Badge tone={RENDERING_LABEL[route.rendering]?.tone}>{RENDERING_LABEL[route.rendering]?.label ?? route.rendering}</Badge></td>
                  <td className="small">{route.clientDataFetching ? <span className="bad-count">In the browser</span> : route.rendering === "client" ? <span className="muted">—</span> : "In the HTML"}</td>
                  <td className="small">{route.metadata === "server" ? "Per page" : route.metadata === "inherited" ? <span className="bad-count">Layout only</span> : route.metadata === "client" ? <span className="bad-count">Set by JavaScript</span> : <span className="bad-count">None</span>}</td>
                  <td className="small">{[
                    route.sequentialAwaits >= 3 && `${route.sequentialAwaits} sequential requests`,
                    route.unboundedQueries.length > 0 && `unpaginated: ${route.unboundedQueries.map((query) => query.split(":")[0]).join(", ")}`,
                  ].filter(Boolean).join(" · ") || <span className="muted">—</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}
