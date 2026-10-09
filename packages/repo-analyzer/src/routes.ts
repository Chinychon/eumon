import type { RouteInfo } from "./analyze.js";

/**
 * What a route's source says about the HTML it produces. Inferred from code
 * patterns, so every conclusion carries the evidence it was drawn from.
 */
export type RouteInspection = {
  pathPattern: string;
  source: string;
  dynamic: boolean;
  /**
   * `static`: built ahead of time; `isr`: static with revalidation; `ssr`:
   * rendered per request; `on_demand`: a dynamic route rendered (and usually
   * cached) on first request; `client`: rendered in the browser.
   */
  rendering: "static" | "isr" | "ssr" | "on_demand" | "client" | "unknown";
  renderingEvidence?: string;
  /** Main content is fetched in the browser (useEffect, onMounted, SWR, React Query…), so it's missing from the HTML. */
  clientDataFetching?: string;
  /** Where the title and meta tags come from. */
  metadata: "server" | "client" | "inherited" | "none";
  metadataEvidence?: string;
  /** Awaited data requests made one after another before the page can render. */
  sequentialAwaits: number;
  /** List queries without a limit or range, e.g. `supabase.from("doctors").select("*")`. */
  unboundedQueries: string[];
  /** The route pre-builds its dynamic paths (generateStaticParams, getStaticPaths). */
  prebuildsPaths?: boolean;
};

type Context = {
  framework: string;
  router?: string;
  /** Layout sources on the route's path, root first (Next.js App Router). */
  layouts?: string[];
};

const DATA_CALL = /\b(fetch|axios(?:\.\w+)?|\$fetch|supabase(?:\s*\.\s*\w+)*|db\s*\.\s*\w+|prisma\s*\.\s*\w+|getDocs?|sanityClient\s*\.\s*fetch|client\s*\.\s*fetch)\s*\(/;

function firstLine(source: string, pattern: RegExp): string | undefined {
  const index = source.search(pattern);
  if (index < 0) return undefined;
  const line = source.slice(source.lastIndexOf("\n", index) + 1, source.indexOf("\n", index) === -1 ? undefined : source.indexOf("\n", index)).trim();
  return line.slice(0, 160);
}

/** Effects or lifecycle hooks whose body makes a data request. */
function browserFetch(source: string): string | undefined {
  for (const hook of source.matchAll(/\b(useEffect|useLayoutEffect|onMounted|componentDidMount)\s*\(/g)) {
    const body = source.slice(hook.index!, hook.index! + 600);
    if (DATA_CALL.test(body)) return `${hook[1]} → ${firstLine(body, DATA_CALL) ?? "data request"}`;
  }
  const hookLibrary = source.match(/\b(useSWR|useQuery|useInfiniteQuery)\s*\(/);
  if (hookLibrary) return `${hookLibrary[1]}(…)`;
  return undefined;
}

/** Index just past the bracket that closes the one at `open` (`(`/`{`), skipping strings and comments; -1 if unbalanced. */
function matchingBracket(source: string, open: number): number {
  const opener = source[open]!;
  const closer = opener === "(" ? ")" : "}";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const char = source[i]!;
    if (char === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (char === "/" && source[i + 1] === "*") { i = source.indexOf("*/", i + 2) + 1; if (i <= 0) break; continue; }
    if (char === "\"" || char === "'" || char === "`") {
      for (i++; i < source.length && source[i] !== char; i++) if (source[i] === "\\") i++;
      continue;
    }
    if (char === opener) depth++;
    else if (char === closer && --depth === 0) return i + 1;
  }
  return -1;
}

/** The body of the function declared at `index`: past its parameter list, from `{` to the matching `}`. */
function bodyFrom(source: string, index: number): string | undefined {
  const params = source.indexOf("(", index);
  const afterParams = params >= 0 ? matchingBracket(source, params) : -1;
  const open = source.indexOf("{", afterParams >= 0 ? afterParams : index);
  if (open < 0) return undefined;
  const end = matchingBracket(source, open);
  return end > 0 ? source.slice(open, end) : undefined;
}

/**
 * The code that runs before HTML can be sent: getServerSideProps or a
 * loader when present, otherwise the default-exported page component.
 */
function blockingBody(source: string): string | undefined {
  const loader = source.search(/export\s+(?:async\s+)?(?:function|const)\s+(getServerSideProps|getStaticProps|loader|load)\b/);
  if (loader >= 0) return bodyFrom(source, loader);
  const inline = source.search(/export\s+default\s+(?:async\s+)?function\b|export\s+default\s+async\s*\(/);
  if (inline >= 0) return bodyFrom(source, inline);
  const named = source.match(/export\s+default\s+(\w+)\s*;?/)?.[1];
  if (named) {
    const declaration = source.search(new RegExp(`(?:function\\s+${named}\\b|const\\s+${named}\\s*=)`));
    if (declaration >= 0) return bodyFrom(source, declaration);
  }
  return undefined;
}

/** Data requests awaited one after another before the page renders, excluding those batched in Promise.all. */
function countSequentialAwaits(source: string): number {
  const body = blockingBody(source);
  if (!body) return 0;
  const withoutBatches = body.replace(/Promise\.(all|allSettled)\s*\(\s*\[[\s\S]*?\]\s*\)/g, "Promise.all([])");
  return [...withoutBatches.matchAll(/\bawait\s+([\w$.]+)/g)]
    .filter((match) => !/^(Promise|params|searchParams|props|context|headers|cookies)\b/.test(match[1]!))
    .length;
}

/**
 * Database and API list reads with no limit: they get slower as the data
 * grows, and at programmatic-SEO scale they time out or exhaust memory.
 */
export function findUnboundedQueries(source: string): string[] {
  const found: string[] = [];
  const statementAt = (index: number) => {
    const end = source.slice(index).search(/;\s*\n|\n\s*\n|\)\s*\n\s*(?:const|let|return|if|export|}|\/\/)/);
    return source.slice(index, end < 0 ? index + 400 : index + Math.min(end + 1, 600));
  };
  for (const match of source.matchAll(/\.from\(\s*(['"`])([\w.-]+)\1\s*\)\s*\.select\(/g)) {
    const chain = statementAt(match.index!);
    if (!/\.(range|limit|single|maybeSingle|eq|match|in|filter|textSearch|lt|gt|lte|gte|like|ilike)\s*\(/.test(chain) && !/count:\s*['"]exact['"],\s*head:\s*true/.test(chain)) {
      found.push(`${match[2]}: ${chain.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  for (const match of source.matchAll(/\b(\w+)\.findMany\(/g)) {
    const chain = statementAt(match.index!);
    if (!/\b(take|first)\s*:/.test(chain) && !/\bwhere\s*:/.test(chain)) found.push(`${match[1]}: ${chain.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  for (const match of source.matchAll(/\.select\(\s*\)\s*\.from\(\s*(\w+)\s*\)/g)) {
    const chain = statementAt(match.index!);
    if (!/\.(limit|where)\s*\(/.test(chain)) found.push(`${match[1]}: ${chain.replace(/\s+/g, " ").slice(0, 120)}`);
  }
  return found.slice(0, 5);
}

function metadataFor(source: string, context: Context): Pick<RouteInspection, "metadata" | "metadataEvidence"> {
  // Client-side head managers first: a <title> inside <Helmet> is set in the browser.
  const client = source.match(/from\s+['"]react-helmet(?:-async)?['"]|<Helmet\b|document\.title\s*=|from\s+['"]@unhead\/react['"]/);
  if (client) return { metadata: "client", metadataEvidence: firstLine(source, new RegExp(client[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) };
  const server = source.match(/export\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b)|from\s+['"]next\/head['"]|from\s+['"]next-seo['"]|\buseSeoMeta\s*\(|\buseHead\s*\(|<title>|export\s+const\s+(?:meta|head)\s*[:=]/);
  if (server) {
    // useHead/useSeoMeta are server-rendered in Nuxt; in a client-only app they run in the browser.
    const clientOnly = context.framework.startsWith("Vite") && /useHead|useSeoMeta/.test(server[0]);
    return { metadata: clientOnly ? "client" : "server", metadataEvidence: firstLine(source, new RegExp(server[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))) };
  }
  const layout = (context.layouts ?? []).find((entry) => /export\s+(?:const\s+metadata\b|(?:async\s+)?function\s+generateMetadata\b)/.test(entry));
  if (layout) return { metadata: "inherited", metadataEvidence: "metadata defined in a parent layout" };
  return { metadata: "none" };
}

function renderingFor(route: RouteInfo, source: string, context: Context): Pick<RouteInspection, "rendering" | "renderingEvidence" | "prebuildsPaths"> {
  const line = (pattern: RegExp) => firstLine(source, pattern);
  const { framework, router } = context;
  if (framework.startsWith("Vite") || framework.startsWith("Create React App") || framework === "Angular") {
    return { rendering: "client", renderingEvidence: `${framework} renders routes in the browser` };
  }
  if (router === "App Router") {
    const prebuildsPaths = /export\s+(?:async\s+)?function\s+generateStaticParams\b|export\s+const\s+generateStaticParams\b/.test(source);
    const forced = source.match(/export\s+const\s+dynamic\s*=\s*['"](force-dynamic|force-static|error|auto)['"]/);
    if (forced?.[1] === "force-dynamic") return { rendering: "ssr", renderingEvidence: line(/export\s+const\s+dynamic/), prebuildsPaths };
    if (forced?.[1] === "force-static") return { rendering: "static", renderingEvidence: line(/export\s+const\s+dynamic/), prebuildsPaths };
    const revalidate = source.match(/export\s+const\s+revalidate\s*=\s*(\d+|false)/);
    if (revalidate && revalidate[1] === "0") return { rendering: "ssr", renderingEvidence: line(/export\s+const\s+revalidate/), prebuildsPaths };
    if (/\b(cookies|headers|draftMode)\s*\(\s*\)|\bsearchParams\b|\bnoStore\s*\(|cache:\s*['"]no-store['"]/.test(source)) {
      return { rendering: "ssr", renderingEvidence: line(/\b(cookies|headers|draftMode)\s*\(\s*\)|\bsearchParams\b|\bnoStore\s*\(|cache:\s*['"]no-store['"]/), prebuildsPaths };
    }
    if (revalidate && revalidate[1] !== "false") return { rendering: "isr", renderingEvidence: line(/export\s+const\s+revalidate/), prebuildsPaths };
    if (route.dynamic && !prebuildsPaths) return { rendering: "on_demand", renderingEvidence: "dynamic route without generateStaticParams", prebuildsPaths };
    return { rendering: "static", renderingEvidence: prebuildsPaths ? line(/generateStaticParams/) : "no dynamic APIs used", prebuildsPaths };
  }
  if (router === "Pages Router") {
    if (/export\s+(?:async\s+)?(?:function|const)\s+getServerSideProps\b/.test(source)) return { rendering: "ssr", renderingEvidence: line(/getServerSideProps/) };
    const prebuildsPaths = /export\s+(?:async\s+)?(?:function|const)\s+getStaticPaths\b/.test(source);
    if (/export\s+(?:async\s+)?(?:function|const)\s+getStaticProps\b/.test(source)) {
      return /\brevalidate\s*:\s*\d+/.test(source)
        ? { rendering: "isr", renderingEvidence: line(/\brevalidate\s*:/), prebuildsPaths }
        : { rendering: "static", renderingEvidence: line(/getStaticProps/), prebuildsPaths };
    }
    return { rendering: "static", renderingEvidence: "no data-fetching method (the HTML is the component's initial render)" };
  }
  if (framework === "Astro") {
    if (/export\s+const\s+prerender\s*=\s*false/.test(source)) return { rendering: "ssr", renderingEvidence: line(/export\s+const\s+prerender/) };
    return { rendering: "static", renderingEvidence: /getStaticPaths/.test(source) ? line(/getStaticPaths/) : "Astro prerenders pages by default" , prebuildsPaths: /getStaticPaths/.test(source) };
  }
  if (framework === "Nuxt") {
    if (/\b(useFetch|useAsyncData|useLazyFetch)\s*\(/.test(source)) return { rendering: "ssr", renderingEvidence: line(/\b(useFetch|useAsyncData|useLazyFetch)\s*\(/) };
    return { rendering: "ssr", renderingEvidence: "Nuxt renders pages on the server by default" };
  }
  if (framework === "SvelteKit") {
    if (/export\s+const\s+prerender\s*=\s*true/.test(source)) return { rendering: "static", renderingEvidence: line(/export\s+const\s+prerender/) };
    if (/export\s+const\s+ssr\s*=\s*false/.test(source)) return { rendering: "client", renderingEvidence: line(/export\s+const\s+ssr/) };
    return { rendering: "ssr", renderingEvidence: "SvelteKit renders pages on the server by default" };
  }
  return { rendering: "unknown" };
}

/** Reads one route's source for rendering mode, browser-side data, metadata, request waterfalls, and unbounded queries. */
export function inspectRouteSource(route: RouteInfo, source: string, context: Context): RouteInspection {
  const rendering = renderingFor(route, source, context);
  const isClientComponent = /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(source);
  const clientFetch = browserFetch(source);
  // Client components in Next.js are still server-rendered, but data they
  // fetch in an effect arrives after the HTML: the content is missing.
  const clientDataFetching = clientFetch && (isClientComponent || rendering.rendering === "client" || context.framework === "Nuxt" || context.router === "Pages Router")
    ? clientFetch
    : undefined;
  return {
    pathPattern: route.pathPattern,
    source: route.source,
    dynamic: route.dynamic,
    ...rendering,
    ...(clientDataFetching ? { clientDataFetching } : {}),
    ...metadataFor(source, context),
    sequentialAwaits: rendering.rendering === "client" ? 0 : countSequentialAwaits(source),
    unboundedQueries: findUnboundedQueries(source),
  };
}

/**
 * The route family a URL pattern serves (`/[locale]/doctors/:slug` →
 * `doctors`), matching the crawler's grouping of URLs, so code problems can be
 * tied to what the crawl saw on that template.
 */
export function routeFamily(pathPattern: string): string {
  const segments = pathPattern.split("/").filter(Boolean);
  const rest = segments[0] && /^:(locale|lang|language|lng|country|region)\b/i.test(segments[0]) ? segments.slice(1) : segments;
  if (rest.length === 0) return "home";
  if (rest.length === 1) return "page";
  return rest[0]!.toLowerCase();
}
