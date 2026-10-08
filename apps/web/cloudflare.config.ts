import { bindings, defineConfig, defineWorker, exports, type InferEnv } from "cf/config";

export const worker = defineWorker({
    name: "organic-growth",
    entrypoint: "./worker.ts",
    compatibilityDate: "2026-10-05",
    compatibilityFlags: ["nodejs_compat"],
    exports: {
      SiteAnalysisWorkflow: exports.workflow({ name: "site-analysis" }),
      ScrapeWorkflow: exports.workflow({ name: "dataset-scrape" }),
      // Daily Search Console import for generated pages (closes the measurement loop).
      SearchSyncWorkflow: exports.workflow({ name: "search-sync", schedules: "15 4 * * *" }),
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
      // Optional language model keys, used in this order: DeepSeek, Claude, then Workers AI.
      DEEPSEEK_API_KEY: bindings.secret(),
      ANTHROPIC_API_KEY: bindings.secret(),
      // Optional model override for the active provider, e.g. "deepseek-v4-pro".
      LLM_MODEL: bindings.secret(),
    },
  });

export type AppEnv = InferEnv<typeof worker>;

export default defineConfig({
  worker,
});
