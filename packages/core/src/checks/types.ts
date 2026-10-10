import type { FindingCategory } from "../types.js";

export type Pillar = "seo" | "ai";
/** Whether a failed instance makes a page unhealthy for the health score. Severity, which ranks the growth plan, is decided per instance by the producer. */
export type CheckClass = "error" | "warning" | "notice";
export type CheckScope = "page" | "family" | "site";
export type CheckSource = "crawl" | "sample" | "render" | "probe" | "repo" | "search" | "connector" | "inventory";
/** What a fix changes; the fix engine and the plan backlog read it. */
export type FixKind = "meta" | "content" | "schema" | "robots" | "redirect" | "links" | "server" | "sitemap" | "none";

export type Check = {
  /** Stable, lower-case, dotted. Never renamed. */
  id: string;
  /** Short name for tables and docs. */
  name: string;
  /** Empty for conversion and data checks: shown, never scored. */
  pillars: Pillar[];
  category: FindingCategory;
  class: CheckClass;
  scope: CheckScope;
  sources: CheckSource[];
  fix: FixKind;
  /** What the check needs that a site may not have, shown as the skip reason in the audit table. */
  requires?: string;
  /** The `CrawlIssue` key that counts it in `getCrawlCoverage`, for per-page crawl checks; the audit table reads its page count there. */
  issue?: string;
  docs: {
    what: string;
    why: string;
    how: string;
    /** How the instance's severity is decided, in words. */
    severity: string;
    /** The docs say it is reported but never scored (llms.txt). */
    unscored?: boolean;
  };
};
