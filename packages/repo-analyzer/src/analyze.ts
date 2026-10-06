import type { FrameworkFingerprint } from "@organic-growth/core";
import { findUnboundedQueries, inspectRouteSource, type RouteInspection } from "./routes.js";

export interface RepoFile {
  path: string;
  content?: string;
}

export interface RepoSnapshot {
  files: RepoFile[];
  packageJson?: Record<string, unknown>;
  treePaths: string[];
}

export interface RouteInfo {
  pathPattern: string;
  source: string;
  dynamic: boolean;
}

export interface RepoAnalysisResult {
  fingerprint: FrameworkFingerprint;
  routes: RouteInfo[];
  /** Per-route rendering, data fetching, metadata, and query findings, for routes whose source was read. */
  routeInspections: RouteInspection[];
  /** How the sitemap is generated in code, when it is. */
  sitemapCode?: { source: string; unboundedQueries: string[]; splitsSitemaps: boolean };
  seoModules: string[];
  sitemapScripts: string[];
  workerFiles: string[];
  sensitivePaths: string[];
  notes: string[];
}

const SENSITIVE_PATTERNS = [
  /(^|\/)\.env/,
  /secrets?\./i,
  /credentials/i,
  /(^|\/)auth\//i,
  /payment/i,
  /(^|\/)(migrations|prisma\/migrations|supabase\/migrations)\//i,
];

type Deps = Record<string, string>;
const has = (deps: Deps, ...names: string[]) => names.some((name) => Boolean(deps[name]));

/** Source files that define routes or their SEO behaviour, most informative first. */
export function routeSourceCandidates(treePaths: string[]): string[] {
  const code = /\.(t|j)sx?$|\.(astro|vue|svelte)$/;
  const isDynamic = (path: string) => /\[|\$|\(/.test(path);
  const routes = treePaths.filter((path) =>
    !/(^|\/)(node_modules|\.next|dist|build|test|tests|__tests__)\//.test(path) && code.test(path) && (
      /(^|\/)app\/(.*\/)?page\.(t|j)sx?$/.test(path)
      || /^(src\/)?pages\/(?!api\/|_).+/.test(path)
      || /^src\/routes\/(.*\/)?\+page(\.server)?\.(svelte|ts|js)$/.test(path)
      || /^app\/routes\/[^/]+\.(t|j)sx?$/.test(path)
    ));
  const layouts = treePaths.filter((path) => /(^|\/)app\/(.*\/)?layout\.(t|j)sx?$/.test(path)).sort((a, b) => a.length - b.length).slice(0, 8);
  const spaEntries = treePaths.filter((path) => /^src\/(App|main|router|routes|AppRoutes)\.(t|j)sx?$/.test(path) || /^src\/app\/routes\.(t|j)sx?$/.test(path));
  const sitemaps = treePaths.filter((path) => /(^|\/)app\/(.*\/)?(sitemap|robots)\.(t|j)s$|(^|\/)(scripts\/)?[\w-]*sitemap[\w-]*\.(m?js|ts)$/.test(path)).slice(0, 4);
  const ordered = [...routes.filter(isDynamic), ...routes.filter((path) => !isDynamic(path))].slice(0, 45);
  return [...new Set([...spaEntries, ...sitemaps, ...layouts, ...ordered])];
}

function detectStack(paths: string[], deps: Deps) {
  const isVite = has(deps, "vite") || paths.some((path) => /^vite\.config\./.test(path));
  const appRouter = paths.some((path) => /^(src\/)?app\/(.*\/)?page\.(t|j)sx?$/.test(path));
  const hasReactRouter = has(deps, "react-router", "react-router-dom");
  const prerendered = has(deps, "vite-react-ssg", "vite-plugin-ssr", "vike", "react-snap", "@prerenderer/rollup-plugin", "vite-plugin-prerender", "vite-ssg");

  let framework = "unknown";
  let router: string | undefined;
  let rendering = "unknown";
  if (has(deps, "next") || (appRouter && !has(deps, "astro", "nuxt", "@sveltejs/kit"))) {
    framework = "Next.js";
    router = appRouter ? "App Router" : "Pages Router";
    rendering = "SSR / SSG / RSC";
  } else if (has(deps, "astro")) {
    framework = "Astro";
    router = "File-based (src/pages)";
    rendering = "SSG / SSR (per astro.config output)";
  } else if (has(deps, "nuxt", "nuxt3")) {
    framework = "Nuxt";
    router = "File-based (pages)";
    rendering = "SSR / SSG (universal)";
  } else if (has(deps, "@sveltejs/kit")) {
    framework = "SvelteKit";
    router = "File-based (src/routes)";
    rendering = "SSR / SSG";
  } else if (has(deps, "@remix-run/react", "@react-router/dev")) {
    framework = "Remix / React Router framework";
    router = "File-based (app/routes)";
    rendering = "SSR";
  } else if (has(deps, "gatsby")) {
    framework = "Gatsby";
    router = "File-based (src/pages)";
    rendering = "SSG";
  } else if (has(deps, "@angular/core")) {
    framework = "Angular";
    rendering = has(deps, "@angular/ssr", "@nguniversal/express-engine") ? "SSR" : "CSR SPA";
  } else if (isVite && has(deps, "react", "react-dom")) {
    framework = "Vite + React";
    router = hasReactRouter ? "React Router" : undefined;
    rendering = prerendered ? "Prerendered SPA" : "CSR SPA";
  } else if (isVite && has(deps, "vue")) {
    framework = "Vite + Vue";
    rendering = "CSR SPA";
  } else if (has(deps, "react-scripts")) {
    framework = "Create React App";
    router = hasReactRouter ? "React Router" : undefined;
    rendering = "CSR SPA";
  }

  const cms = has(deps, "next-sanity", "@sanity/client", "sanity") ? "Sanity"
    : has(deps, "contentful") ? "Contentful"
      : has(deps, "@strapi/strapi", "@strapi/client") ? "Strapi"
        : has(deps, "payload") ? "Payload"
          : has(deps, "@storyblok/react", "@storyblok/js", "storyblok-js-client") ? "Storyblok"
            : has(deps, "@prismicio/client") ? "Prismic"
              : has(deps, "@tinacms/cli", "tinacms") ? "Tina"
                : paths.some((path) => /(^|\/)admin\/config\.ya?ml$/.test(path) || /decap|netlify-cms/.test(path)) || has(deps, "decap-cms-app", "netlify-cms-app") ? "Decap CMS"
                  : has(deps, "contentlayer", "next-contentlayer", "@content-collections/core") ? "Contentlayer"
                    : "none";
  const database = has(deps, "@supabase/supabase-js", "@supabase/ssr") ? "Supabase"
    : has(deps, "@prisma/client", "prisma") ? "Prisma"
      : has(deps, "drizzle-orm") ? "Drizzle"
        : has(deps, "mongoose", "mongodb") ? "MongoDB"
          : has(deps, "firebase", "firebase-admin") ? "Firebase"
            : has(deps, "@planetscale/database", "@neondatabase/serverless", "pg", "mysql2") ? "SQL"
              : undefined;
  const analytics = [
    has(deps, "posthog-js", "posthog-node") && "PostHog",
    (has(deps, "@next/third-parties", "react-ga4", "vue-gtag", "gtag") || paths.some((path) => /gtag|google-analytics/i.test(path))) && "GA4",
    has(deps, "@vercel/analytics") && "Vercel Analytics",
    has(deps, "next-plausible", "plausible-tracker") && "Plausible",
    has(deps, "@umami/node") && "Umami",
    has(deps, "mixpanel-browser") && "Mixpanel",
  ].filter((entry): entry is string => Boolean(entry));
  const deployment = paths.some((path) => /^wrangler\.(toml|jsonc?)$/.test(path)) ? "Cloudflare Workers"
    : paths.includes("vercel.json") || has(deps, "vercel", "@vercel/analytics", "@vercel/speed-insights") ? "Vercel"
      : paths.includes("netlify.toml") || paths.includes("public/_redirects") ? "Netlify"
        : paths.includes("fly.toml") ? "Fly.io"
          : paths.includes("render.yaml") ? "Render"
            : paths.includes("amplify.yml") ? "AWS Amplify"
              : paths.includes("Dockerfile") ? "Docker"
                : undefined;
  const contentSource = cms !== "none" ? `${cms}` : database ? `database (${database})` : paths.some((path) => /\.mdx?$/.test(path) && /(content|posts|blog)\//.test(path)) ? "Markdown/MDX files" : undefined;
  return { framework, router, rendering, cms, database, analytics, deployment, contentSource, isVite, hasReactRouter, prerendered };
}

export function analyzeRepository(snapshot: RepoSnapshot): RepoAnalysisResult {
  const paths = snapshot.treePaths.map((p) => p.replace(/^\.\//, ""));
  const pkg = snapshot.packageJson ?? readJson(snapshot, "package.json");
  const deps: Deps = {
    ...((pkg?.dependencies as Deps) ?? {}),
    ...((pkg?.devDependencies as Deps) ?? {}),
  };
  const stack = detectStack(paths, deps);
  const seoModules = paths.filter((p) => /(^|\/)seo\/|jsonld|json-ld|structured-?data|(^|\/)(metadata|head|seo)\.(t|j)sx?$/i.test(p)).slice(0, 20);
  const sitemapScripts = paths.filter((p) => /sitemap/i.test(p) && /\.(m?js|ts|xml)$/.test(p)).slice(0, 10);
  const workerFiles = paths.filter((p) => /^(worker|functions|edge)\//.test(p) || /_worker\.js$|middleware\.(t|j)s$/.test(p)).slice(0, 10);

  const language = paths.some((p) => p.endsWith(".ts") || p.endsWith(".tsx")) ? "TypeScript" : "JavaScript";
  const packageManager = paths.includes("pnpm-lock.yaml") ? "pnpm"
    : paths.includes("yarn.lock") ? "yarn"
      : paths.includes("bun.lockb") || paths.includes("bun.lock") ? "bun"
        : "npm";

  const routes = extractRoutes(snapshot, stack.framework, stack.router);
  const source = (path: string) => snapshot.files.find((file) => file.path === path)?.content;
  const routeInspections: RouteInspection[] = [];
  for (const route of routes) {
    let content = source(route.source);
    if (content === undefined) continue;
    if (stack.framework === "SvelteKit") {
      // A SvelteKit route's data loading and render options live beside the page.
      const dir = route.source.replace(/[^/]+$/, "");
      content = [content, source(`${dir}+page.ts`), source(`${dir}+page.server.ts`), source(`${dir}+page.js`)].filter(Boolean).join("\n");
    }
    const layouts = stack.router === "App Router" ? layoutChain(route.source).map(source).filter((entry): entry is string => Boolean(entry)) : [];
    routeInspections.push(inspectRouteSource(route, content, { framework: stack.framework, router: stack.router, layouts }));
  }
  const sitemapFile = snapshot.files.find((file) => file.content && /(^|\/)app\/(.*\/)?sitemap\.(t|j)s$|sitemap[\w-]*\.(m?js|ts)$/.test(file.path));
  const sitemapCode = sitemapFile?.content
    ? { source: sitemapFile.path, unboundedQueries: findUnboundedQueries(sitemapFile.content), splitsSitemaps: /generateSitemaps|sitemapindex|sitemap-index|SitemapIndex/.test(sitemapFile.content) }
    : undefined;

  const fingerprint: FrameworkFingerprint = {
    framework: stack.framework,
    language,
    packageManager,
    router: stack.router,
    rendering: stack.rendering,
    deployment: stack.deployment,
    cms: stack.cms,
    database: stack.database,
    analytics: stack.analytics,
    seoTooling: [
      has(deps, "next-seo") && "next-seo",
      has(deps, "next-sitemap") && "next-sitemap",
      has(deps, "react-helmet", "react-helmet-async") && "react-helmet",
      has(deps, "@astrojs/sitemap") && "@astrojs/sitemap",
      has(deps, "@nuxtjs/seo", "@nuxtjs/sitemap") && "Nuxt SEO",
      seoModules.length > 0 && "custom SEO modules",
    ].filter((entry): entry is string => Boolean(entry)),
    contentSource: stack.contentSource,
    hasSitemap: paths.includes("public/sitemap.xml") || sitemapScripts.length > 0 || has(deps, "next-sitemap", "@astrojs/sitemap", "@nuxtjs/sitemap"),
    hasRobots: paths.includes("public/robots.txt") || paths.includes("robots.txt") || paths.some((p) => /(^|\/)app\/robots\.(t|j)s$/.test(p)),
    hasStructuredData: seoModules.some((p) => /json-?ld|structured/i.test(p)) || snapshot.files.some((file) => /application\/ld\+json|"@context"\s*:\s*["']https?:\/\/schema\.org/.test(file.content ?? "")),
    details: {
      vite: stack.isVite,
      reactRouter: stack.hasReactRouter,
      prerendered: stack.prerendered,
      seoModuleCount: seoModules.length,
      routeCount: routes.length,
      inspectedRoutes: routeInspections.length,
      dependencyNames: Object.keys(deps).slice(0, 40),
    },
  };

  const notes: string[] = [];
  if (stack.rendering === "CSR SPA") notes.push(`${stack.framework} renders in the browser: crawlers receive an empty HTML shell unless pages are prerendered or served by an edge worker.`);
  if (stack.isVite && workerFiles.length) notes.push("A single-page app with an edge worker: check whether the worker injects page-specific HTML for entity routes.");
  if (sitemapScripts.length) notes.push(`Sitemap generation: ${sitemapScripts.slice(0, 3).join(", ")}`);

  return {
    fingerprint,
    routes,
    routeInspections,
    ...(sitemapCode ? { sitemapCode } : {}),
    seoModules,
    sitemapScripts,
    workerFiles,
    sensitivePaths: paths.filter((p) => SENSITIVE_PATTERNS.some((re) => re.test(p))),
    notes,
  };
}

/** `app/[locale]/doctors/[slug]/page.tsx` → its layouts from the root down. */
function layoutChain(pagePath: string): string[] {
  const dir = pagePath.replace(/page\.(t|j)sx?$/, "");
  const root = dir.slice(0, dir.indexOf("app/") + 4);
  const parts = dir.slice(root.length).split("/").filter(Boolean);
  return Array.from({ length: parts.length + 1 }, (_, depth) => [`${root}${parts.slice(0, depth).map((part) => `${part}/`).join("")}layout.tsx`, `${root}${parts.slice(0, depth).map((part) => `${part}/`).join("")}layout.js`]).flat();
}

function readJson(snapshot: RepoSnapshot, path: string): Record<string, unknown> | undefined {
  const file = snapshot.files.find((f) => f.path === path);
  if (!file?.content) return undefined;
  try {
    return JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractRoutes(snapshot: RepoSnapshot, framework: string, router?: string): RouteInfo[] {
  const tree = snapshot.treePaths;
  if (router === "React Router" || (framework === "Vite + React" && !router)) {
    // Routes are declared in code; the page component is the source worth reading.
    const entries = snapshot.files.filter((file) => file.content && /^src\/(App|main|router|routes|AppRoutes)\.(t|j)sx?$|^src\/app\/routes\.(t|j)sx?$/.test(file.path));
    const routes = entries.flatMap((file) => parseReactRouterRoutes(file.content!, file.path, tree));
    return [...new Map(routes.map((route) => [route.pathPattern, route])).values()];
  }
  if (router === "App Router") {
    return tree
      .filter((p) => /(?:^|\/)app\/(?:.*\/)?page\.(t|j)sx?$/.test(p))
      .map((p) => ({ pathPattern: appRouterPathToPattern(p), source: p, dynamic: p.includes("[") }));
  }
  if (router === "File-based (src/routes)") {
    return tree
      .filter((p) => /^src\/routes\/(.*\/)?\+page\.svelte$/.test(p))
      .map((p) => {
        const pattern = "/" + p.replace(/^src\/routes\//, "").replace(/\/?\+page\.svelte$/, "").split("/").filter((seg) => seg && !seg.startsWith("(")).map((seg) => seg.replace(/^\[(?:\.\.\.)?(.+?)\]$/, ":$1")).join("/");
        return { pathPattern: pattern === "/" ? "/" : pattern, source: p, dynamic: p.includes("[") };
      });
  }
  if (router === "File-based (app/routes)") {
    // Flat routes: `doctors.$slug.tsx` → /doctors/:slug; `_index.tsx` → /.
    return tree
      .filter((p) => /^app\/routes\/[^/]+\.(t|j)sx?$/.test(p))
      .map((p) => {
        const name = p.replace(/^app\/routes\//, "").replace(/\.(t|j)sx?$/, "");
        const segments = name.split(".").filter((seg) => seg !== "_index" && !seg.startsWith("_")).map((seg) => (seg.startsWith("$") ? `:${seg.slice(1) || "splat"}` : seg.replace(/_$/, "")));
        return { pathPattern: `/${segments.join("/")}`, source: p, dynamic: name.includes("$") };
      });
  }
  if (router?.startsWith("File-based") || router === "Pages Router") {
    const root = router === "File-based (src/pages)" ? "src/pages/" : router === "File-based (pages)" ? "pages/" : null;
    return tree
      .filter((p) => (root ? p.startsWith(root) : /^(src\/)?pages\//.test(p)))
      .filter((p) => /\.(astro|vue|md|mdx|tsx?|jsx?)$/.test(p) && !/\/(_|api\/)/.test(p))
      .map((p) => ({ pathPattern: fileRouteToPattern(p), source: p, dynamic: p.includes("[") }));
  }
  return [];
}

/**
 * Routes declared with React Router (`{ path: "/x" }` objects or `<Route
 * path>` elements). With the repository tree, a `<Route element={<Page />}>`
 * points at the imported page component's file.
 */
export function parseReactRouterRoutes(source: string, filePath: string, treePaths: string[] = []): RouteInfo[] {
  const imports = new Map<string, string>();
  for (const match of source.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]|(\w+)\s*=\s*(?:React\.)?lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    imports.set((match[1] ?? match[3])!, (match[2] ?? match[4])!);
  }
  const resolve = (component: string | undefined): string => {
    const specifier = component ? imports.get(component) : undefined;
    if (!specifier) return filePath;
    const base = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : specifier.startsWith(".") ? joinPath(filePath.replace(/[^/]+$/, ""), specifier) : null;
    if (!base) return filePath;
    const candidates = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"].map((suffix) => `${base}${suffix}`);
    return candidates.find((candidate) => treePaths.includes(candidate)) ?? filePath;
  };
  const routes: RouteInfo[] = [];
  const add = (pathPattern: string, component?: string) => {
    if (routes.some((route) => route.pathPattern === pathPattern)) return;
    routes.push({ pathPattern, source: resolve(component), dynamic: pathPattern.includes(":") || pathPattern.includes("*") });
  };
  for (const match of source.matchAll(/<Route\b([^>]*?)\/?>/g)) {
    const attrs = match[1]!;
    const path = attrs.match(/\bpath=\{?\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (path) add(path, attrs.match(/element=\{\s*<\s*(\w+)/)?.[1] ?? attrs.match(/component=\{\s*(\w+)/)?.[1]);
  }
  for (const match of source.matchAll(/\bpath:\s*["'`]([^"'`]+)["'`]([^}]{0,200})/g)) {
    add(match[1]!, match[2]!.match(/(?:element:\s*<\s*|Component:\s*)(\w+)/)?.[1]);
  }
  return routes;
}

function joinPath(dir: string, relative: string): string {
  const parts = `${dir}${relative}`.split("/");
  const output: string[] = [];
  for (const part of parts) {
    if (part === "..") output.pop();
    else if (part && part !== ".") output.push(part);
  }
  return output.join("/");
}

function appRouterPathToPattern(filePath: string): string {
  const relative = filePath.replace(/^.*?app\//, "").replace(/\/?page\.(t|j)sx?$/, "");
  if (!relative) return "/";
  const pattern = relative
    .split("/")
    .filter((seg) => seg && !seg.startsWith("(") && !seg.startsWith("@"))
    .map((seg) => seg.replace(/^\[\[?(?:\.\.\.)?(.+?)\]?\]$/, ":$1"))
    .join("/");
  return `/${pattern}`;
}

/** `src/pages/blog/[slug].astro` → `/blog/:slug`; `pages/index.vue` → `/`. */
function fileRouteToPattern(filePath: string): string {
  const relative = filePath
    .replace(/^(src\/)?pages\//, "")
    .replace(/\.(astro|vue|md|mdx|tsx?|jsx?)$/, "")
    .replace(/(^|\/)index$/, "");
  if (!relative) return "/";
  return "/" + relative
    .split("/")
    .map((seg) => seg.replace(/^\[(?:\.\.\.)?(.+)\]$/, ":$1"))
    .join("/");
}
