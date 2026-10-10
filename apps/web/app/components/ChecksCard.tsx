/*
 * The audit on the dashboard: the two health scores on the Overview, and per
 * pillar every check the latest analysis ran (failed, passed, or not run and
 * why) on the Technical and AI visibility tabs.
 */
import type { ResultsView } from "@organic-growth/core";
import { auditCounts, checksFor, type Report } from "./report-model";
import { Badge, Card, Kpi } from "./ui";

const CLASS_LABEL = { error: "Errors", warning: "Warnings", notice: "Notices" } as const;
const STATUS = { failed: { label: "Failed", tone: "red" }, passed: { label: "Passed", tone: "green" }, skipped: { label: "Not run", tone: "gray" } } as const;

/** Every check of one pillar from the latest analysis. */
export function ChecksCard({ report, pillar }: { report: Report | null; pillar: "seo" | "ai" }) {
  const counts = auditCounts(report);
  if (!report?.audit || !counts) {
    return <Card title="Checks"><p className="empty-state">{report ? "The last analysis ran before the checks were listed. Run it again to see every check." : "Run an analysis to see every check."}</p></Card>;
  }
  const groups = checksFor(report, pillar);
  const all = [...groups.error, ...groups.warning, ...groups.notice];
  const failed = all.filter((entry) => entry.row.status === "failed").length;
  return (
    <Card title="Checks" subtitle={pillar === "seo" ? "Every search check in the latest analysis: what failed, what passed, and what could not run. Errors on a page count against the SEO health score." : "Every AI visibility check in the latest analysis. Errors on a page count against the AI visibility health score."}
      actions={<span className="count-pill">{failed} of {all.length} failed</span>}>
      {(["error", "warning", "notice"] as const).filter((key) => groups[key].length).map((key) => {
        const rows = groups[key];
        const failing = rows.filter((entry) => entry.row.status === "failed").length;
        return (
          <details key={key} className="why-row table-toggle" open={key === "error" && failing > 0}>
            <summary><span className="why-title">{CLASS_LABEL[key]} · {failing ? `${failing} failed` : "none failed"} of {rows.length}</span><span className="why-open" aria-hidden="true" /></summary>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Check</th><th>Result</th><th className="num">Pages</th></tr></thead>
                <tbody>{rows.map(({ check, row, finding }) => (
                  <tr key={check.id}>
                    <td title={check.docs.what}>{check.name}{check.docs.unscored && <span className="small muted"> · never scored</span>}</td>
                    {/* A never-scored check (llms.txt) that fires is reported, not failed. */}
                    <td>{check.docs.unscored && row.status === "failed" ? <Badge tone="gray">Reported</Badge> : <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>}{row.status === "skipped" && row.reason && <span className="small muted"> needs {row.reason}</span>}</td>
                    <td className="num">{row.status === "failed" ? (finding ? <a href={`#finding-${finding.id}`}>{row.pages ?? "—"}</a> : row.pages ?? "—") : "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        );
      })}
    </Card>
  );
}

const change = (value: number | null, before: number | null) => (value === null || before === null ? null : Math.round((value - before) * 10) / 10);

/** SEO and AI visibility health on the Overview: the latest analysis's scores, their 28-day change, and the check counts. */
export function HealthTiles({ report, scores, onOpen }: { report: Report | null; scores?: ResultsView["scores"]; onOpen: (tab: "technical" | "ai") => void }) {
  const counts = auditCounts(report);
  const audit = report?.audit;
  const probe = report?.aiReadiness?.probe?.filter((agent) => agent.search && agent.allowedByRobots && agent.fetched > 0);
  const caption = (pillar: "seo" | "ai") => {
    const score = audit?.[pillar];
    if (!score) return report ? "The last analysis ran before scoring; run it again" : "Run an analysis to score the site";
    if (score.reason) return score.reason;
    if (pillar === "ai" && probe?.length) return `${probe.filter((agent) => agent.refused < agent.fetched).length} of ${probe.length} AI search crawlers can read the site`;
    const delta = change(scores?.[pillar].value ?? null, scores?.[pillar].before ?? null);
    return delta === null ? `${score.indexable.toLocaleString("en")} indexable pages; no earlier score to compare` : `${delta > 0 ? "+" : ""}${delta} since 28 days ago`;
  };
  const value = (pillar: "seo" | "ai") => (audit?.[pillar].value == null ? "—" : audit[pillar].value.toFixed(0));
  return (
    <div className="metrics-grid">
      <Kpi label="SEO health" value={value("seo")} caption={<>{caption("seo")} · <button className="inline-action" onClick={() => onOpen("technical")}>Checks</button></>} />
      <Kpi label="AI visibility health" value={value("ai")} caption={<>{caption("ai")} · <button className="inline-action" onClick={() => onOpen("ai")}>Checks</button></>} />
      <Kpi label="Checks" value={counts ? counts.checks : "—"} caption={counts ? `${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} not run` : "Every check the analysis runs"} />
    </div>
  );
}
