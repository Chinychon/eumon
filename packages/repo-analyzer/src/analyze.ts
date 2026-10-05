import type { FrameworkFingerprint } from "@organic-growth/core";

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
  seoModules: string[];
  sitemapScripts: string[];
  workerFiles: string[];
  sensitivePaths: string[];
  notes: string[];
}

const SENSITIVE_PATTERNS = [
  /^\.env/,
  /secrets?\./i,
  /credentials/i,
  /auth\//i,
  /payment/i,
  /supabase\/migrations/i,
];

export function analyzeRepository(snapshot: RepoSnapshot): RepoAnalysisResult {
  const paths = snapshot.treePaths.map((p) => p.replace(/^\.\//, ""));
  const pkg = snapshot.packageJson ?? readJson(snapshot, "package.json");
  const deps = {
    ...((pkg?.dependencies as Record<string, string>) ?? {}),
    ...((pkg?.devDependencies as Record<string, string>) ?? {}),
  };

  const isVite = paths.some((p) => p === "vite.config.ts" || p === "vite.config.js");
  const isNext =
    Boolean(deps.next) ||
    (!deps.astro && !deps.nuxt && !deps.nuxt3 &&
      paths.some((p) => /^(src\/)?app\/(.*\/)?page\.(t|j)sx?$/.test(p) || /^next\.config\./.test(p)));
  const hasReactRouter =
    Boolean(deps["react-router"] || deps["react-router-dom"]) ||
    paths.some((p) => p.includes("routes.tsx") || p.includes("routes.ts"));
  const hasWrangler = paths.some(
    (p) => p === "wrangler.jsonc" || p === "wrangler.toml",
  );
  const hasSupabase =
    Boolean(deps["@supabase/supabase-js"]) ||
    paths.some((p) => p.includes("supabase"));
  const hasDecap = paths.some(
    (p) => p.includes("admin/config.yml") || p.includes("decap"),
  );
  const analytics: string[] = [];
  if (deps["posthog-js"] || paths.some((p) => p.includes("posthog"))) {
    analytics.push("PostHog");
  }
  if (
    paths.some((p) => p.includes("analytics.ts")) ||
    Boolean(deps["gtag"] || deps["@next/third-parties"])
  ) {
    analytics.push("GA4");
  }

  const seoModules = paths.filter(
    (p) =>
      p.includes("/seo/") ||
      p.endsWith("usePageMeta.ts") ||
      p.includes("jsonLd") ||
      p.includes("sitemap"),
  );
  const sitemapScripts = paths.filter(
    (p) => p.includes("generate-sitemap") || p.includes("sitemap"),
  );
  const workerFiles = paths.filter(
    (p) => p.startsWith("worker/") || p.includes("spa-fallback"),
  );

  let framework = "unknown";
  let router: string | undefined;
  let rendering = "unknown";

  if (isVite && hasReactRouter) {
    framework = "Vite + React";
    router = "React Router";
    rendering = workerFiles.length
      ? "SPA + edge HTML / selective prerender"
      : "CSR SPA";
  } else if (isNext) {
    framework = deps.next ? `Next.js` : "Next.js-like";
    router = paths.some((p) => /^(src\/)?app\/(.*\/)?page\.(t|j)sx?$/.test(p))
      ? "App Router"
      : "Pages Router";
    rendering = "SSR / SSG / RSC";
  } else if (deps.astro) {
    framework = "Astro";
    router = "File-based (src/pages)";
    rendering = paths.some((p) => /^astro\.config\./.test(p)) ? "SSG / SSR (per astro.config output)" : "SSG";
  } else if (deps.nuxt || deps["nuxt3"]) {
    framework = "Nuxt";
    router = "File-based (pages)";
    rendering = "SSR / SSG (universal)";
  }

  const language = paths.some((p) => p.endsWith(".ts") || p.endsWith(".tsx"))
    ? "TypeScript"
    : "JavaScript";

  const packageManager = paths.includes("pnpm-lock.yaml")
    ? "pnpm"
    : paths.includes("yarn.lock")
      ? "yarn"
      : paths.includes("bun.lockb")
        ? "bun"
        : "npm";

  const routes = extractRoutes(snapshot, router);

  const fingerprint: FrameworkFingerprint = {
    framework,
    language,
    packageManager,
    router,
    rendering,
    deployment: hasWrangler
      ? "Cloudflare Workers"
      : paths.includes("vercel.json") || Boolean(deps.vercel)
        ? "Vercel"
        : paths.includes("netlify.toml") || paths.includes("public/_redirects")
          ? "Netlify"
          : undefined,
    cms: hasDecap ? "Decap CMS" : "none",
    database: hasSupabase ? "Supabase" : undefined,
    analytics,
    seoTooling: seoModules.length ? ["custom SEO modules"] : [],
    contentSource: hasDecap
      ? "Decap blog JSON + database catalog"
      : hasSupabase
        ? "database-driven"
        : undefined,
    hasSitemap:
      paths.includes("public/sitemap.xml") ||
      sitemapScripts.length > 0 ||
      paths.some((p) => p.includes("sitemap")),
    hasRobots: paths.includes("public/robots.txt") || paths.includes("robots.txt"),
    hasStructuredData: paths.some(
      (p) => p.includes("jsonLd") || p.includes("schema") || p.includes("JsonLd"),
    ),
    details: {
      vite: isVite,
      next: isNext,
      reactRouter: hasReactRouter,
      wrangler: hasWrangler,
      supabase: hasSupabase,
      decap: hasDecap,
      seoModuleCount: seoModules.length,
      workerFileCount: workerFiles.length,
      dependencyNames: Object.keys(deps).slice(0, 40),
    },
  };

  const sensitivePaths = paths.filter((p) =>
    SENSITIVE_PATTERNS.some((re) => re.test(p)),
  );

  const notes: string[] = [];
  if (framework.startsWith("Vite") && workerFiles.length) {
    notes.push(
      "Detected Cloudflare SPA fallback / edge entity rendering — prioritize raw vs rendered audits.",
    );
  }
  if (sitemapScripts.length) {
    notes.push(`Sitemap generation scripts: ${sitemapScripts.join(", ")}`);
  }

  return {
    fingerprint,
    routes,
    seoModules,
    sitemapScripts,
    workerFiles,
    sensitivePaths,
    notes,
  };
}

function readJson(
  snapshot: RepoSnapshot,
  path: string,
): Record<string, unknown> | undefined {
  const file = snapshot.files.find((f) => f.path === path || f.path.endsWith(`/${path}`));
  if (!file?.content) return undefined;
  try {
    return JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractRoutes(
  snapshot: RepoSnapshot,
  router?: string,
): RouteInfo[] {
  if (router === "React Router") {
    const routesFile = snapshot.files.find(
      (f) =>
        f.path.endsWith("routes.tsx") ||
        f.path.endsWith("routes.ts") ||
        f.path.includes("app/routes.tsx"),
    );
    if (routesFile?.content) {
      return parseReactRouterRoutes(routesFile.content, routesFile.path);
    }
  }
  if (router?.startsWith("File-based") || router === "Pages Router") {
    const root = router === "File-based (src/pages)" ? "src/pages/" : router === "File-based (pages)" ? "pages/" : null;
    return snapshot.treePaths
      .filter((p) => (root ? p.startsWith(root) : /^(src\/)?pages\//.test(p)))
      .filter((p) => /\.(astro|vue|md|mdx|tsx?|jsx?)$/.test(p) && !/\/(_|api\/)/.test(p))
      .map((p) => ({
        pathPattern: fileRouteToPattern(p),
        source: p,
        dynamic: p.includes("["),
      }));
  }
  if (router === "App Router") {
    return snapshot.treePaths
      .filter((p) => /(?:^|\/)app\/(?:.*\/)?page\.(t|j)sx?$/.test(p))
      .map((p) => ({
        pathPattern: appRouterPathToPattern(p),
        source: p,
        dynamic: p.includes("["),
      }));
  }
  return [];
}

export function parseReactRouterRoutes(
  source: string,
  filePath: string,
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const pathRe = /path:\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;
  while ((match = pathRe.exec(source))) {
    const pathPattern = match[1];
    routes.push({
      pathPattern,
      source: filePath,
      dynamic: pathPattern.includes(":") || pathPattern.includes("*"),
    });
  }
  // Also catch JSX <Route path="...">
  const jsxRe = /<Route[^>]*path=["'`]([^"'`]+)["'`]/g;
  while ((match = jsxRe.exec(source))) {
    const pathPattern = match[1];
    if (!routes.some((r) => r.pathPattern === pathPattern)) {
      routes.push({
        pathPattern,
        source: filePath,
        dynamic: pathPattern.includes(":") || pathPattern.includes("*"),
      });
    }
  }
  return routes;
}

function appRouterPathToPattern(filePath: string): string {
  const relative = filePath.replace(/^.*?app\//, "").replace(/\/page\.(t|j)sx?$/, "").replace(/^page\.(t|j)sx?$/, "");
  if (!relative || relative === "page") return "/";
  return (
    "/" +
    relative
      .split("/")
      .filter((seg) => !seg.startsWith("("))
      .map((seg) => seg.replace(/^\[(?:\.\.\.)?(.+)\]$/, ":$1"))
      .join("/")
  );
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
