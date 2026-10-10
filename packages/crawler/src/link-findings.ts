import { CHECKS, finding, organicImpactScore, type Finding, type LinkGraphIssues } from "@organic-growth/core";

const n = (value: number) => value.toLocaleString("en");

/** Broken internal links, orphans, single-link pages and deep pages, from the crawl's link map. */
export function findingsFromLinkGraph(input: { siteId: string; analysisId: string; linkGraph: LinkGraphIssues | undefined }): Finding[] {
  const graph = input.linkGraph;
  if (!graph) return [];
  const base = { siteId: input.siteId, analysisId: input.analysisId };
  const out: Finding[] = [];
  const broken = graph.brokenLinks;
  if (broken && broken.links > 0) {
    out.push(finding(CHECKS["links.broken_internal"]!, {
      ...base,
      impact: Math.min(organicImpactScore({ category: "internal_links", pagesAffected: broken.sources, isBlockingCrawl: broken.links >= 100 }), 75),
      title: `${n(broken.links)} internal ${broken.links === 1 ? "link points" : "links point"} at pages that fail`,
      summary: `${n(broken.links)} ${broken.links === 1 ? "link" : "links"} on ${n(broken.sources)} ${broken.sources === 1 ? "page leads" : "pages lead"} to URLs that answer an error or could not be fetched. Most linked: ${broken.targets.slice(0, 3).map((target) => `${target.path || "/"} (${target.status || "failed"}, from ${n(target.from)} ${target.from === 1 ? "page" : "pages"})`).join(", ")}.`,
      evidence: { links: broken.links, sources: broken.sources, targets: broken.targets },
    }));
  }
  if (graph.orphans && graph.orphans.count > 0) {
    out.push(finding(CHECKS["links.orphan"]!, {
      ...base,
      impact: Math.min(organicImpactScore({ category: "internal_links", pagesAffected: graph.orphans.count }), 60),
      title: `${n(graph.orphans.count)} ${graph.orphans.count === 1 ? "page has" : "pages have"} no internal links pointing at ${graph.orphans.count === 1 ? "it" : "them"}`,
      summary: `${n(graph.orphans.count)} sitemap ${graph.orphans.count === 1 ? "URL is" : "URLs are"} linked from no other crawled page. Only the sitemap tells Google they exist, so they are crawled less and rank lower.`,
      evidence: { orphans: graph.orphans.count, examples: graph.orphans.examples }, pagesAffected: graph.orphans.examples,
    }));
  }
  if (graph.singleInbound && graph.singleInbound.count > 0) {
    out.push(finding(CHECKS["links.single_inbound"]!, {
      ...base, impact: 12,
      title: `${n(graph.singleInbound.count)} ${graph.singleInbound.count === 1 ? "page has" : "pages have"} only one internal link`,
      summary: `${n(graph.singleInbound.count)} ${graph.singleInbound.count === 1 ? "page is" : "pages are"} reachable through a single link; one broken link makes each an orphan.`,
      evidence: { pages: graph.singleInbound.count, examples: graph.singleInbound.examples }, pagesAffected: graph.singleInbound.examples,
    }));
  }
  if (graph.depth && graph.depth.deep > 0 && !graph.depth.skipped) {
    out.push(finding(CHECKS["links.depth"]!, {
      ...base, impact: 14,
      title: `${n(graph.depth.deep)} ${graph.depth.deep === 1 ? "page is" : "pages are"} more than three clicks from the homepage`,
      summary: `${n(graph.depth.deep)} linked ${graph.depth.deep === 1 ? "page needs" : "pages need"} four or more clicks from the homepage. Crawlers reach deep pages last and least.`,
      evidence: { deep: graph.depth.deep, examples: graph.depth.examples }, pagesAffected: graph.depth.examples,
    }));
  }
  return out;
}
