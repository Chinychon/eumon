import { bindings, defineConfig, defineWorker, exports, type InferEnv } from "cf/config";

export const worker = defineWorker({
    name: "organic-growth",
    entrypoint: "./worker.ts",
    compatibilityDate: "2026-10-05",
    compatibilityFlags: ["nodejs_compat"],
    exports: {
      SiteAnalysisWorkflow: exports.workflow({ name: "site-analysis" }),
    },
    assets: { notFoundHandling: "none" },
    env: {
      ASSETS: bindings.assets(),
      IMAGES: bindings.images(),
      DB: bindings.d1({
        id: process.env.CF_D1_DATABASE_ID ?? "00000000-0000-4000-8000-000000000001",
        name: "organic-growth",
      }),
      AI: bindings.ai(),
      BROWSER: bindings.browser(),
      ANALYSIS_WORKFLOW: bindings.workflow({
        name: "site-analysis",
        worker: "organic-growth",
        exportName: "SiteAnalysisWorkflow",
      }),
      GITHUB_APP_ID: bindings.secret(),
      GITHUB_APP_SLUG: bindings.text(process.env.GITHUB_APP_SLUG ?? "organic-growth-engine"),
      GITHUB_APP_PRIVATE_KEY: bindings.secret(),
      SESSION_SECRET: bindings.secret(),
      GOOGLE_CLIENT_ID: bindings.secret(),
      GOOGLE_CLIENT_SECRET: bindings.secret(),
      OAUTH_ENCRYPTION_KEY: bindings.secret(),
    },
  });

export type AppEnv = InferEnv<typeof worker>;

export default defineConfig({
  worker,
});
