import { createLlm, type JsonLlm } from "@organic-growth/ai";
import type { SiteRecord } from "@organic-growth/core";
import { defaultFetcher } from "@organic-growth/crawler";
import { getAnalysisJob, getFixSettings, getSite, listPageHeads, listTopQueries, type D1Like } from "@organic-growth/db";
import { blockedAiSearchAgents, detect, LLMS_MARKER, ROOT_LAYOUTS, type FixCandidate, type RouteRef } from "@organic-growth/fixes";
import type { AppEnv } from "../cloudflare.config";
import { fixRepoFor } from "./fix-github.ts";
import { checkMergedFixes, openStagedFixes, stageCandidates, type FixDeps } from "./fix-run.ts";
import { featureRefusal } from "./limits.ts";
import { settingsFor } from "./server.ts";

export const FIX_AI_CALLS = 30;
const PER_STEP = 3;

export type FixStep = { do<T>(name: string, fn: () => Promise<T>): Promise<T> };

export async function fetchHtml(url: string): Promise<{ status: number; body: string } | null> {
  try {
    const response = await defaultFetcher(url, { userAgent: "EumonBot/1.0 (+fix verification)" });
    return { status: response.status, body: response.status === 200 ? response.body : "" };
  } catch { return null; }
}

type Report = { repo?: { fingerprint?: { framework?: string; router?: string }; routeInspections?: RouteRef[]; sensitivePaths?: string[] } };

const APP_PAGE = /(^|\/)app\/(.+\/)?page\.[jt]sx?$/;

async function depsFor(env: AppEnv, site: SiteRecord, calls: number): Promise<FixDeps & { pr: Awaited<ReturnType<typeof fixRepoFor>>["pr"] }> {
  const { repo, pr } = await fixRepoFor(env, site);
  let llm: JsonLlm | null = null;
  try { llm = createLlm(env); } catch { llm = null; }
  return { db: env.DB as D1Like, repo, pr, llm, budget: { calls }, fetchPage: fetchHtml, now: () => new Date() };
}

/** A file that can't be read (too large, a directory, a GitHub error) counts as unknown. */
const readOrNull = (repo: { getFile(path: string): Promise<{ content: string; sha: string } | null> }, path: string) =>
  repo.getFile(path).then((file) => ({ file }), () => null);

export async function runFixSteps(env: AppEnv, step: FixStep, siteId: string, analysisId: string): Promise<void> {
  const db = env.DB as D1Like;
  const site = await getSite(db, siteId);
  if (!site?.githubInstallationId || !site.githubOwner || !site.githubRepo || !site.workspaceId) return;
  // A workspace without pull requests spends no AI or GitHub calls and writes no rows.
  if (await featureRefusal(db, site.workspaceId, "pullRequests")) return;
  const report = (await getAnalysisJob(db, analysisId))?.report as Report | undefined;
  const fingerprint = report?.repo?.fingerprint;
  if (fingerprint?.framework !== "Next.js" || fingerprint.router !== "App Router") return;
  const sensitivePaths = report?.repo?.sensitivePaths ?? [];
  const routes = (report?.repo?.routeInspections ?? []).filter((r) => APP_PAGE.test(r.source));

  const prepared = await step.do("fixes-prepare", async () => {
    const { repo } = await fixRepoFor(env, site);
    const settings = await settingsFor(site);
    const fixSettings = await getFixSettings(db, siteId);
    const layoutPath = ROOT_LAYOUTS.find((p) => repo.treePaths.includes(p));
    const layout = layoutPath ? await readOrNull(repo, layoutPath) : null;
    const llms = repo.treePaths.includes("public/llms.txt") ? await readOrNull(repo, "public/llms.txt") : null;
    const robots = repo.treePaths.includes("public/robots.txt") ? await readOrNull(repo, "public/robots.txt") : null;
    const pages = await listPageHeads(db, analysisId);
    const origin = settings.publicOrigin || site.baseUrl;
    const siteName = settings.siteName || site.name;
    const candidates = detect({
      origin, siteName, pages, routes,
      rootLayout: layoutPath && layout ? { path: layoutPath, hasMetadataBase: /metadataBase/.test(layout.file?.content ?? "") } : undefined,
      // An unreadable llms.txt is treated as someone else's file, so it is never proposed.
      llmsTxt: llms === null && repo.treePaths.includes("public/llms.txt")
        ? { exists: true, managedByEumon: false }
        : { exists: Boolean(llms?.file), managedByEumon: Boolean(llms?.file?.content.includes(LLMS_MARKER)) },
      robots: robots?.file ? { path: "public/robots.txt", blocksAiSearch: blockedAiSearchAgents(robots.file.content) } : { blocksAiSearch: [] },
      allowAiSearch: fixSettings.allowAiSearch,
    });
    const queries = (await listTopQueries(db, siteId, 50)).map((q) => q.query);
    return { candidates, queries, origin, siteName, language: settings.language || "en" };
  });

  let calls = FIX_AI_CALLS;
  for (let i = 0; i < prepared.candidates.length; i += PER_STEP) {
    const batch: FixCandidate[] = prepared.candidates.slice(i, i + PER_STEP);
    calls = await step.do(`fixes-stage-${i / PER_STEP}`, async () => {
      const deps = await depsFor(env, site, calls);
      const pages = await listPageHeads(db, analysisId);
      await stageCandidates(deps, { siteId, analysisId, origin: prepared.origin, siteName: prepared.siteName, language: prepared.language, queries: prepared.queries, candidates: batch, pages, sensitivePaths, routes });
      return deps.budget.calls;
    });
  }

  await step.do("fixes-check-merged", async () => {
    const deps = await depsFor(env, site, 0);
    return checkMergedFixes(deps, deps.pr, { siteId, pages: await listPageHeads(db, analysisId) });
  });

  const { autopilot, budget } = await getFixSettings(db, siteId);
  if (!autopilot) return;
  await step.do("fixes-open", async () => {
    const deps = await depsFor(env, site, 0);
    return openStagedFixes(deps, deps.pr, { siteId, origin: prepared.origin, budget });
  });
}
