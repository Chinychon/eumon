"use client";

import { useEffect, useMemo, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import type { LinkGraph } from "@organic-growth/db";
import { api, errorMessage, formatNumber } from "./api";
import { familyLabel } from "./report-model";
import { Card, Kpi } from "./ui";

type Placed = LinkGraph["nodes"][number] & SimulationNodeDatum & { size: number };

/** Node size from page count: square root, so a 900-page type doesn't swallow a 10-page one. */
const sizeOf = (pages: number) => 10 + Math.sqrt(pages) * 1.6;

/**
 * Positions page types once with a force layout (a few dozen nodes, so it
 * runs synchronously in a few milliseconds) and returns the fitted viewBox.
 */
function layout(graph: LinkGraph) {
  const nodes: Placed[] = graph.nodes.map((node) => ({ ...node, size: sizeOf(node.pages) }));
  const links = graph.edges.map((edge) => ({ ...edge }));
  forceSimulation(nodes)
    .force("link", forceLink<Placed, (typeof links)[number] & { source: string | Placed; target: string | Placed }>(links).id((node) => node.id).distance(110).strength(0.4))
    .force("charge", forceManyBody().strength(-320))
    .force("collide", forceCollide<Placed>((node) => node.size + 26))
    .force("center", forceCenter(0, 0))
    .stop()
    .tick(300);
  const xs = nodes.map((node) => node.x ?? 0);
  const ys = nodes.map((node) => node.y ?? 0);
  const pad = 70;
  const box = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  return { nodes: new Map(nodes.map((node) => [node.id, node])), box };
}

const nodeLabel = (node: LinkGraph["nodes"][number]) => (node.kind === "site" ? familyLabel(node.label) : node.label);

/**
 * How the site links together: pages nothing links to, whether the site
 * links to Eumon's pages, and a map of links between page types.
 */
export function SiteGraph({ siteId }: { siteId: string }) {
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    setGraph(null); setError("");
    api<LinkGraph>(`/api/sites/${siteId}/graph`).then(setGraph).catch((cause) => setError(errorMessage(cause)));
  }, [siteId]);

  const placed = useMemo(() => (graph?.nodes.length ? layout(graph) : null), [graph]);

  if (error) return <Card title="How pages link"><p className="empty-state">{error}</p></Card>;
  if (!graph) return <Card title="How pages link"><p className="empty-state">Loading…</p></Card>;
  const coverage = graph.linkCoverage;
  if (!coverage?.recorded) {
    return <Card title="How pages link" subtitle="Run an analysis to record which pages link to which. Earlier crawls didn't keep links."><p className="empty-state">No links recorded yet.</p></Card>;
  }

  const sitePages = graph.nodes.filter((node) => node.kind === "site").reduce((sum, node) => sum + node.pages, 0);
  const { published, linkedFromSite } = graph.landingPages;
  const touches = (edge: LinkGraph["edges"][number]) => !active || edge.source === active || edge.target === active;
  const neighbours = new Set(graph.edges.filter((edge) => active && touches(edge)).flatMap((edge) => [edge.source, edge.target]));
  const maxLinks = Math.max(1, ...graph.edges.map((edge) => edge.links));
  const summary = `${graph.nodes.length} page types and ${graph.edges.length} links between them.${graph.orphans ? ` ${graph.orphans.count} of ${sitePages} sitemap pages have no links from other pages.` : ""}`;

  return (
    <Card title="How pages link" subtitle="Google finds pages by following links. Pages nothing links to are found late, or not at all.">
      <div className="kpi-grid link-kpis">
        {graph.orphans
          ? <Kpi label="Pages nothing links to" value={formatNumber(graph.orphans.count)} caption={`of ${formatNumber(sitePages)} sitemap pages`} />
          : <Kpi label="Pages nothing links to" value="—" caption={`Links known for ${formatNumber(coverage.recorded)} of ${formatNumber(coverage.pages)} pages. Re-crawl every page to map them all.`} />}
        <Kpi label="Landing pages your site links to" value={published ? `${formatNumber(linkedFromSite)}/${formatNumber(published)}` : "—"} caption={!published ? "No landing pages published yet" : linkedFromSite < published ? "Link the rest from related pages" : "All linked from your pages"} />
      </div>
      {graph.orphans && graph.orphans.examples.length > 0 && (
        <p className="small muted link-examples">For example: {graph.orphans.examples.map((url) => new URL(url).pathname).join(", ")}</p>
      )}
      {placed && (
        <svg className="link-map" viewBox={`${placed.box.x} ${placed.box.y} ${placed.box.w} ${placed.box.h}`} role="img" aria-label={summary} onMouseLeave={() => setActive(null)}>
          {graph.edges.map((edge) => {
            const a = placed.nodes.get(edge.source);
            const b = placed.nodes.get(edge.target);
            if (!a || !b) return null;
            const eumon = a.kind === "eumon" || b.kind === "eumon";
            return (
              <line key={`${edge.source}>${edge.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={`link-edge${eumon ? " eumon" : ""}${touches(edge) ? "" : " dim"}`}
                strokeWidth={1 + (Math.log2(edge.links + 1) / Math.log2(maxLinks + 1)) * 4}>
                <title>{`${nodeLabel(a)} → ${nodeLabel(b)}: ${formatNumber(edge.links)} links`}</title>
              </line>
            );
          })}
          {[...placed.nodes.values()].map((node) => (
            <g key={node.id} className={`link-node ${node.kind}${active && node.id !== active && !neighbours.has(node.id) ? " dim" : ""}`}
              transform={`translate(${node.x ?? 0} ${node.y ?? 0})`} onMouseEnter={() => setActive(node.id)}
              tabIndex={0} onFocus={() => setActive(node.id)} onBlur={() => setActive(null)}>
              <rect x={-node.size / 2} y={-node.size / 2} width={node.size} height={node.size} />
              <text y={node.size / 2 + 14}>{nodeLabel(node)}</text>
              <title>{`${nodeLabel(node)}: ${formatNumber(node.pages)} pages`}</title>
            </g>
          ))}
        </svg>
      )}
      <div className="chart-legend link-legend"><span className="s0">Your pages</span><span className="eumon">Eumon's landing pages</span></div>
      {graph.edges.length > 0 && (
        <details className="why-row table-toggle">
          <summary><span className="why-title">Links between page types as a table</span><span className="why-open" aria-hidden="true">Show</span></summary>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>From</th><th>To</th><th className="num">Links</th></tr></thead>
              <tbody>{[...graph.edges].sort((a, b) => b.links - a.links).map((edge) => (
                <tr key={`${edge.source}>${edge.target}`}>
                  <td><code>{nodeLabel(placed?.nodes.get(edge.source) ?? graph.nodes.find((node) => node.id === edge.source)!)}</code></td>
                  <td><code>{nodeLabel(placed?.nodes.get(edge.target) ?? graph.nodes.find((node) => node.id === edge.target)!)}</code></td>
                  <td className="num">{formatNumber(edge.links)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      )}
    </Card>
  );
}
