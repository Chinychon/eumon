"use client";

import { useEffect, useMemo, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from "d3-force";
import type { LinkFamily, LinkGraph } from "@organic-growth/db";
import { api, errorMessage, formatNumber } from "./api";
import { familyLabel } from "./report-model";
import { Card, Kpi } from "./ui";

type Node = LinkGraph["nodes"][number];
type Placed = Node & SimulationNodeDatum & { size: number };

/** Node size from page count: square root, capped, so a 14,000-page type doesn't swallow the map. */
const sizeOf = (pages: number) => Math.min(64, 10 + Math.sqrt(pages) * 1.6);

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
    .force("collide", forceCollide<Placed>((node) => node.size + 30))
    .force("center", forceCenter(0, 0))
    .stop()
    .tick(300);
  const xs = nodes.map((node) => node.x ?? 0);
  const ys = nodes.map((node) => node.y ?? 0);
  const pad = 74;
  const box = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  return { nodes: new Map(nodes.map((node) => [node.id, node])), box };
}

const nodeLabel = (node: Node) => (node.kind === "site" ? familyLabel(node.label) : node.label);
/** Line weight for a link count, on a log scale so one dominant pair doesn't flatten the rest. */
const weight = (links: number, max: number, top = 4) => 1 + (Math.log2(links + 1) / Math.log2(max + 1)) * top;
const pathOf = (url: string) => { try { return new URL(url).pathname; } catch { return url; } };

/** The opened page type lives in `?graph=`, so a reload keeps it. */
function rememberOpen(family: string | null) {
  const url = new URL(window.location.href);
  if (family) url.searchParams.set("graph", family); else url.searchParams.delete("graph");
  window.history.replaceState({}, "", `${url.pathname}${url.search}`);
}

/** Opens on click, Enter, or Space, like a button. */
const opener = (open: () => void) => ({
  role: "button" as const,
  onClick: open,
  onKeyDown: (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
  },
});

/** A square sized by its pages, filled from the bottom by the share nothing links to. */
function NodeSquare({ size, orphanShare }: { size: number; orphanShare: number }) {
  const level = size * Math.min(1, orphanShare);
  return (
    <>
      <rect className="link-square" x={-size / 2} y={-size / 2} width={size} height={size} />
      {level > 0.5 && <rect className="link-orphan" x={-size / 2} y={size / 2 - level} width={size} height={level} />}
    </>
  );
}

/**
 * How the site links together: pages nothing links to, whether the site
 * links to Eumon's pages, and a map of links between page types. Each page
 * type opens into who links to it, where it links, and its own pages.
 */
export function SiteGraph({ siteId }: { siteId: string }) {
  const [graph, setGraph] = useState<LinkGraph | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setGraph(null); setError(""); setActive(null);
    setOpen(new URL(window.location.href).searchParams.get("graph"));
    api<LinkGraph>(`/api/sites/${siteId}/graph`).then(setGraph).catch((cause) => setError(errorMessage(cause)));
  }, [siteId]);

  const placed = useMemo(() => (graph?.nodes.length ? layout(graph) : null), [graph]);
  const openFamily = (family: string | null) => { setOpen(family); setActive(null); rememberOpen(family); };

  if (error) return <Card title="How pages link"><p className="empty-state">{error}</p></Card>;
  if (!graph) return <Card title="How pages link"><p className="empty-state">Loading…</p></Card>;
  const coverage = graph.linkCoverage;
  if (!coverage?.recorded) {
    return <Card title="How pages link" subtitle="Run an analysis to record which pages link to which. Earlier crawls didn't keep links."><p className="empty-state">No links recorded yet.</p></Card>;
  }

  const families = new Set(graph.nodes.filter((node) => node.kind === "site").map((node) => node.label));
  // A page type that isn't in this crawl (another site's, or one that went away) closes the view.
  if (open !== null && families.has(open)) {
    return (
      <Card title="How pages link" subtitle="Google finds pages by following links. Pages nothing links to are found late, or not at all.">
        <FamilyView siteId={siteId} family={open} graph={graph} families={families} onOpen={openFamily} />
      </Card>
    );
  }

  const sitePages = graph.nodes.filter((node) => node.kind === "site").reduce((sum, node) => sum + node.pages, 0);
  const { published, linkedFromSite } = graph.landingPages;
  const touches = (edge: LinkGraph["edges"][number]) => !active || edge.source === active || edge.target === active;
  const neighbours = new Set(graph.edges.filter((edge) => active && touches(edge)).flatMap((edge) => [edge.source, edge.target]));
  const maxLinks = Math.max(1, ...graph.edges.map((edge) => edge.links));
  const orphanShare = (node: Node) => (node.kind === "site" && graph.orphans ? (graph.orphans.byFamily[node.label] ?? 0) / Math.max(1, node.pages) : 0);
  const summary = `${graph.nodes.length} page types and ${graph.edges.length} links between them.${graph.orphans ? ` ${graph.orphans.count} of ${sitePages} sitemap pages have no links from other pages.` : ""}`;

  return (
    <Card title="How pages link" subtitle="Google finds pages by following links. Pages nothing links to are found late, or not at all.">
      <div className="kpi-grid link-kpis">
        {graph.orphans
          ? <Kpi label="Pages nothing links to" value={formatNumber(graph.orphans.count)} caption={`of ${formatNumber(sitePages)} sitemap pages`} />
          : <Kpi label="Pages nothing links to" value="—" caption={`Links known for ${formatNumber(coverage.recorded)} of ${formatNumber(coverage.pages)} pages. Re-crawl every page to map them all.`} />}
        <Kpi label="Landing pages your site links to" value={published ? `${formatNumber(linkedFromSite)}/${formatNumber(published)}` : "—"} caption={!published ? "No landing pages published yet" : linkedFromSite < published ? "Link the rest from related pages" : "All linked from your pages"} />
      </div>
      {placed && (
        <svg className="link-map" viewBox={`${placed.box.x} ${placed.box.y} ${placed.box.w} ${placed.box.h}`} role="group" aria-label={summary} onMouseLeave={() => setActive(null)}>
          {graph.edges.map((edge) => {
            const a = placed.nodes.get(edge.source);
            const b = placed.nodes.get(edge.target);
            if (!a || !b) return null;
            const eumon = a.kind === "eumon" || b.kind === "eumon";
            return (
              <line key={`${edge.source}>${edge.target}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                className={`link-edge${eumon ? " eumon" : ""}${touches(edge) ? "" : " dim"}`} strokeWidth={weight(edge.links, maxLinks)}>
                <title>{`${nodeLabel(a)} → ${nodeLabel(b)}: ${formatNumber(edge.links)} links`}</title>
              </line>
            );
          })}
          {[...placed.nodes.values()].map((node) => {
            const share = orphanShare(node);
            const opens = node.kind === "site";
            const describe = `${nodeLabel(node)}: ${formatNumber(node.pages)} pages${graph.orphans && opens ? `, ${formatNumber(graph.orphans.byFamily[node.label] ?? 0)} nothing links to` : ""}`;
            return (
              <g key={node.id} className={`link-node ${node.kind}${opens ? " opens" : ""}${active && node.id !== active && !neighbours.has(node.id) ? " dim" : ""}`}
                transform={`translate(${node.x ?? 0} ${node.y ?? 0})`} tabIndex={0}
                aria-label={opens ? `Open ${describe}` : describe}
                onMouseEnter={() => setActive(node.id)} onFocus={() => setActive(node.id)} onBlur={() => setActive(null)}
                {...(opens ? opener(() => openFamily(node.label)) : {})}>
                <NodeSquare size={node.size} orphanShare={share} />
                <text className="link-name" y={node.size / 2 + 15}>{nodeLabel(node)}</text>
                <text className="link-count" y={node.size / 2 + 28}>{formatNumber(node.pages)}</text>
                <title>{describe}</title>
              </g>
            );
          })}
        </svg>
      )}
      <div className="link-foot">
        <div className="chart-legend link-legend">
          <span className="s0">Your pages</span>
          <span className="eumon">Eumon's landing pages</span>
          {graph.orphans && <span className="orphan">Share nothing links to</span>}
        </div>
        <span className="small muted">Open a page type to see what links to it, where it links, and its pages.</span>
      </div>
      {graph.edges.length > 0 && (
        <details className="why-row table-toggle">
          <summary><span className="why-title">Links between page types as a table</span><span className="why-open" aria-hidden="true" /></summary>
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

const ROWS = 8;
const ROW_H = 34;

/**
 * One page type opened: the types that link into it on the left, the types
 * it links to on the right, line weight by link count, then its own pages.
 */
function FamilyView({ siteId, family, graph, families, onOpen }: {
  siteId: string;
  family: string;
  graph: LinkGraph;
  families: Set<string>;
  onOpen: (family: string | null) => void;
}) {
  const [detail, setDetail] = useState<LinkFamily | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setDetail(null); setError("");
    api<LinkFamily>(`/api/sites/${siteId}/graph?family=${encodeURIComponent(family)}`).then(setDetail).catch((cause) => setError(errorMessage(cause)));
  }, [siteId, family]);

  const back = (
    <button type="button" className="link-back" onClick={() => onOpen(null)}>
      <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
      All page types
    </button>
  );
  if (error) return <>{back}<p className="empty-state">{error}</p></>;
  if (!detail) return <>{back}<p className="empty-state">Opening {familyLabel(family)}…</p></>;

  const linksIn = detail.from.reduce((sum, row) => sum + row.links, 0);
  const linksOut = detail.to.reduce((sum, row) => sum + row.links, 0);
  const coverage = graph.linkCoverage;
  const partial = !graph.orphans && coverage ? `Links are known for ${formatNumber(coverage.recorded)} of ${formatNumber(coverage.pages)} pages, so these counts are partial. Re-crawl every page to complete them.` : null;
  const share = detail.orphans ? detail.orphans.count / Math.max(1, detail.pages) : 0;

  return (
    <div className="link-family">
      <div className="link-family-head">
        {back}
        <h3>{familyLabel(family)} <span className="muted">{formatNumber(detail.pages)} pages</span></h3>
      </div>
      <div className="kpi-grid link-kpis">
        <Kpi label="Links in" value={formatNumber(linksIn)} caption={detail.from.length ? `from ${detail.from.length} other page type${detail.from.length === 1 ? "" : "s"}` : "No other page type links here"} />
        <Kpi label="Links out" value={formatNumber(linksOut)} caption={detail.to.length ? `to ${detail.to.length} other page type${detail.to.length === 1 ? "" : "s"}` : "Links to no other page type"} />
        <Kpi label="Between its own pages" value={formatNumber(detail.within)} caption="links inside this type" />
        {detail.orphans
          ? <Kpi label="Nothing links to" value={formatNumber(detail.orphans.count)} caption={`of ${formatNumber(detail.pages)} pages`} />
          : <Kpi label="Nothing links to" value="—" caption={family === "home" ? "The homepage is the way in" : "Needs every page's links"} />}
      </div>
      {partial && <p className="callout warn link-partial">{partial}</p>}
      <FlowMap detail={detail} families={families} orphanShare={share} onOpen={onOpen} />
      <div className="link-flow-lists">
        <section><h4>Linked from</h4>{detail.from.length ? <FlowList rows={detail.from} /> : <p className="small muted">No other page type links here.</p>}</section>
        <section><h4>Links to</h4>{detail.to.length ? <FlowList rows={detail.to} /> : <p className="small muted">Links to no other page type.</p>}</section>
      </div>
      <div className="link-lists">
        <section>
          <h4>Most linked-to pages</h4>
          {detail.topPages.length ? (
            <table className="table">
              <thead><tr><th>Page</th><th className="num">Links in</th></tr></thead>
              <tbody>{detail.topPages.map((page) => (
                <tr key={page.url}>
                  <td><a className="link-path" href={page.url} target="_blank" rel="noreferrer">{pathOf(page.url)}</a></td>
                  <td className="num">{formatNumber(page.inbound)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="small muted">No served pages of this type.</p>}
        </section>
        <section>
          <h4>Pages nothing links to</h4>
          {!detail.orphans ? <p className="small muted">{family === "home" ? "The homepage is where visitors and Google start, so it needs no links in." : "Shown once every page's links are known. Re-crawl every page to find them."}</p>
            : detail.orphans.count === 0 ? <p className="small muted">Every page of this type has a link from another page.</p>
            : (
              <>
                <ul className="link-orphans">
                  {detail.orphans.examples.map((url) => <li key={url}><a className="link-path" href={url} target="_blank" rel="noreferrer">{pathOf(url)}</a></li>)}
                </ul>
                {detail.orphans.count > detail.orphans.examples.length && <p className="small muted">and {formatNumber(detail.orphans.count - detail.orphans.examples.length)} more. Link them from a related page or a listing.</p>}
              </>
            )}
        </section>
      </div>
    </div>
  );
}

/** Per-type link counts as bars: the flow map's narrow-screen form. */
function FlowList({ rows }: { rows: LinkFamily["from"] }) {
  const max = Math.max(1, ...rows.map((row) => row.links));
  return (
    <ol className="chart-bars">
      {rows.map((row, index) => (
        <li key={row.family}>
          <span className="chart-bar-label">{familyLabel(row.family)}</span>
          <span className="chart-bar-track"><i style={{ width: `${(row.links / max) * 100}%`, ["--i" as string]: index }} /></span>
          <span className="chart-bar-value">{formatNumber(row.links)}</span>
        </li>
      ))}
    </ol>
  );
}

/** Types linking in on the left, the opened type in the middle, types it links to on the right. */
function FlowMap({ detail, families, orphanShare, onOpen }: {
  detail: LinkFamily;
  families: Set<string>;
  orphanShare: number;
  onOpen: (family: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const left = detail.from.slice(0, ROWS);
  const right = detail.to.slice(0, ROWS);
  const rows = Math.max(left.length, right.length, 1);
  const height = rows * ROW_H + 24;
  const cy = height / 2;
  const centre = Math.min(64, 28 + rows * 4);
  const max = Math.max(1, ...left.map((row) => row.links), ...right.map((row) => row.links));
  const rowY = (index: number, count: number) => cy + (index - (count - 1) / 2) * ROW_H;
  const W = 760;
  const L = 250; // left markers
  const R = W - 250; // right markers
  const cx = W / 2;

  const side = (list: LinkFamily["from"], where: "left" | "right") => list.map((row, index) => {
    const y = rowY(index, list.length);
    const x = where === "left" ? L : R;
    const edge = where === "left" ? cx - centre / 2 : cx + centre / 2;
    const bend = (edge + x) / 2;
    // Each line meets the square at its own point, in row order, so they fan instead of knotting.
    const at = cy + (index - (list.length - 1) / 2) * Math.min(8, (centre - 8) / Math.max(1, list.length));
    const d = where === "left" ? `M${x + 5},${y} C${bend},${y} ${bend},${at} ${edge},${at}` : `M${edge},${at} C${bend},${at} ${bend},${y} ${x - 5},${y}`;
    const opens = families.has(row.family);
    const label = `${familyLabel(row.family)}: ${formatNumber(row.links)} links ${where === "left" ? "in" : "out"}`;
    return (
      <g key={`${where}:${row.family}`} className={`flow-row${hover && hover !== `${where}:${row.family}` ? " dim" : ""}${opens ? " opens" : ""}`}
        tabIndex={opens ? 0 : undefined} aria-label={opens ? `Open ${label}` : label}
        onMouseEnter={() => setHover(`${where}:${row.family}`)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(`${where}:${row.family}`)} onBlur={() => setHover(null)}
        {...(opens ? opener(() => onOpen(row.family)) : {})}>
        <path className="flow-line" d={d} strokeWidth={weight(row.links, max, 7)} />
        <rect className="link-square" x={x - 5} y={y - 5} width={10} height={10} />
        <text className="flow-name" x={where === "left" ? x - 12 : x + 12} y={y} textAnchor={where === "left" ? "end" : "start"}>{familyLabel(row.family)}</text>
        <text className="flow-count" x={where === "left" ? x - 12 : x + 12} y={y + 13} textAnchor={where === "left" ? "end" : "start"}>{formatNumber(row.links)}</text>
        <title>{label}</title>
      </g>
    );
  });

  return (
    <svg className="link-flow" viewBox={`0 0 ${W} ${height}`} role="group" aria-label={`${familyLabel(detail.family)}: linked from ${detail.from.length} page types, links to ${detail.to.length}`}>
      <text className="flow-head" x={L} y={12} textAnchor="end">Linked from</text>
      <text className="flow-head" x={R} y={12} textAnchor="start">Links to</text>
      {side(left, "left")}
      {side(right, "right")}
      {!left.length && <text className="flow-empty" x={L} y={cy + 4} textAnchor="end">No other page type links here</text>}
      {!right.length && <text className="flow-empty" x={R} y={cy + 4} textAnchor="start">Links to no other page type</text>}
      <g className="link-node site" transform={`translate(${cx} ${cy})`}>
        <NodeSquare size={centre} orphanShare={orphanShare} />
        <text className="link-name" y={centre / 2 + 15}>{familyLabel(detail.family)}</text>
      </g>
      {detail.from.length > ROWS && <text className="flow-empty" x={L} y={height - 2} textAnchor="end">+{detail.from.length - ROWS} more below</text>}
      {detail.to.length > ROWS && <text className="flow-empty" x={R} y={height - 2} textAnchor="start">+{detail.to.length - ROWS} more below</text>}
    </svg>
  );
}
