import { bindings, defineConfig, defineWorker, exports, type InferEnv } from "cf/config";

export const worker = defineWorker({
    name: "organic-growth",
    entrypoint: "./worker.ts",
    compatibilityDate: "2026-10-05",
    compatibilityFlags: ["nodejs_compat"],
    exports: {
      SiteAnalysisWorkflow: exports.workflow({ name: "site-analysis" }),
      ScrapeWorkflow: exports.workflow({ name: "dataset-scrape" }),
      // Daily sync for every site. Scheduled Workflows need the paid Workers plan, so for now it runs only
      // from "Sync now"; on the paid plan, add `schedules: "15 4 * * *"` back to run it daily at 04:15 UTC.
      SearchSyncWorkflow: exports.workflow({ name: "search-sync" }),
    },
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      DB: bindings.d1({
        id: process.env.CF_D1_DATABASE_ID ?? "591e4045-cbff-4ef4-a894-cbe4ece424ec",
        name: "eumon-prod",
      }),
      AI: bindings.ai(),
      BROWSER: bindings.browser(),
      ANALYSIS_WORKFLOW: bindings.workflow({
        name: "site-analysis",
        worker: "organic-growth",
        exportName: "SiteAnalysisWorkflow",
      }),
      SCRAPE_WORKFLOW: bindings.workflow({
        name: "dataset-scrape",
        worker: "organic-growth",
        exportName: "ScrapeWorkflow",
      }),
      SEARCH_SYNC_WORKFLOW: bindings.workflow({
        name: "search-sync",
        worker: "organic-growth",
        exportName: "SearchSyncWorkflow",
      }),
      GITHUB_APP_ID: bindings.secret(),
      GITHUB_APP_SLUG: bindings.secret(),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
      OAUTH_ENCRYPTION_KEY: bindings.secret(),
      // Optional: real-user speed and lab scores (Google API key with the CrUX and PageSpeed Insights APIs), and authority (Open PageRank).
      GOOGLE_API_KEY: bindings.secret(),
      OPEN_PAGERANK_KEY: bindings.secret(),
      // Language model key: DeepSeek is used first, then Claude, then Workers AI.
      // Every secret declared here must be set before a deploy (Cloudflare has no optional secrets),
      // and local dev loads only declared keys from .dev.vars. ANTHROPIC_API_KEY and LLM_MODEL are
      // left undeclared so they stay optional: set them with `wrangler secret put` in production,
      // and declare them here again to use them in local dev.
      DEEPSEEK_API_KEY: bindings.secret(),
    },
  });

export type AppEnv = InferEnv<typeof worker>;

export default defineConfig({
  worker,
});
