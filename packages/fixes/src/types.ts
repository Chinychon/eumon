export type FixKind = "metadata-base" | "head" | "jsonld" | "llms-txt" | "ai-robots";

export type HeadProblem =
  | "title-missing" | "title-duplicate" | "title-too-long"
  | "description-missing" | "description-duplicate" | "description-length"
  | "canonical-missing" | "hreflang-missing";

/** What Google received for one crawled URL (from `pages.result_json`). */
export type PageHead = {
  url: string;
  status: number;
  title?: string;
  description?: string;
  canonical?: string;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLdTypes: string[];
  /** The first H1's text, from the crawl's heading outline. */
  heading?: string;
};

/** The parts of the repo analyzer's RouteInspection the engine uses. Patterns use `:param`, e.g. `/procedures/:slug`. */
export type RouteRef = {
  pathPattern: string;
  source: string;
  dynamic: boolean;
  rendering: string;
  metadata: "server" | "client" | "inherited" | "none";
};

export type FixCandidate = {
  kind: FixKind;
  file: string;
  route?: RouteRef;
  problems: HeadProblem[];
  /** Affected URLs, at most 20. */
  urls: string[];
  pageCount: number;
  score: number;
  schemaType?: string;
  /** Locale prefixes seen on the site (e.g. ["id", "zh"]), for hreflang. */
  locales?: string[];
};

export type Edit = { start: number; end: number; text: string };
export type Range = { start: number; end: number };

/** An edit the validator can check, or a skip with a ready-to-paste snippet. `files` holds whole files to write (new component, llms.txt, robots.txt). */
export type EditResult =
  | { ok: true; edits: Edit[]; allowedRanges: Range[]; roots: string[]; files: Record<string, string>; summary: string }
  | { ok: false; reason: string; snippet: string };

export type DetectInput = {
  origin: string;
  siteName: string;
  pages: PageHead[];
  routes: RouteRef[];
  rootLayout?: { path: string; hasMetadataBase: boolean };
  llmsTxt: { exists: boolean; managedByEumon: boolean };
  /** `path` is set only when a static public/robots.txt exists. */
  robots: { path?: string; blocksAiSearch: string[] };
  allowAiSearch: boolean;
  limit?: number;
};
