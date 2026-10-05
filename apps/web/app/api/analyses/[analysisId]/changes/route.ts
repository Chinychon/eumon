import { env } from "cloudflare:workers";
import { createId, type Finding } from "@organic-growth/core";
import { getAnalysisJob, getSite, insertChange, listChanges, type D1Like } from "@organic-growth/db";
import { generateSafeTechnicalChange } from "@organic-growth/agents";
import { createGitHubApiClient, createInstallationToken, type GitHubContentsClient } from "@organic-growth/repo-analyzer";

const allowedPaths = new Set(["public/robots.txt", "app/robots.ts", "src/app/robots.ts", "app/sitemap.ts", "src/app/sitemap.ts"]);

export async function GET(_request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  const job = await getAnalysisJob(env.DB as D1Like, analysisId);
  if (!job) return Response.json({ error: "Analysis not found." }, { status: 404 });
  const changes = (await listChanges(env.DB as D1Like, job.siteId)).filter((change) => change.analysisId === analysisId);
  return Response.json({ changes }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ analysisId: string }> }) {
  const { analysisId } = await context.params;
  const job = await getAnalysisJob(env.DB as D1Like, analysisId);
  if (!job || job.status !== "completed") return Response.json({ error: "A completed analysis is required." }, { status: 404 });
  let body: { findingId?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "Choose a finding to address." }, { status: 400 }); }
  const report = job.report as { findings?: Array<{ id: string; category: string; title: string; summary: string; evidence: Record<string, unknown>; pagesAffected?: string[] }> } | undefined;
  const finding = report?.findings?.find((entry) => entry.id === body.findingId);
  if (!finding || !["sitemap", "indexing"].includes(finding.category)) return Response.json({ error: "Only observed sitemap and indexing findings are eligible for automated configuration proposals." }, { status: 400 });
  const site = await getSite(env.DB as D1Like, job.siteId);
  if (!site?.githubInstallationId || !site.githubOwner || !site.githubRepo) return Response.json({ error: "The repository connection is missing." }, { status: 400 });
  try {
    const token = await createInstallationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, site.githubInstallationId);
    const client = createGitHubApiClient(token);
    const tree = await client.getTreePaths(site.githubOwner, site.githubRepo, site.defaultBranch ?? "main");
    const candidates: Array<{ path: string; content: string }> = [];
    for (const path of tree.filter((entry) => allowedPaths.has(entry))) {
      const content = await client.getFileContent(site.githubOwner, site.githubRepo, path, site.defaultBranch ?? "main");
      if (content !== null) candidates.push({ path, content });
    }
    const generated = await generateSafeTechnicalChange(env.AI, { ...finding, category: finding.category as Finding["category"] }, candidates);
    if (!generated) return Response.json({ error: "The available evidence and repository files do not support a safe automated change." }, { status: 422 });
    const id = createId("change");
    const oldContent = candidates.find((file) => file.path === generated.path)!.content;
    const patch = `File: ${generated.path}\n\n--- Current content\n${oldContent}\n\n+++ Proposed content\n${generated.content}`;
    const change = {
      id, siteId: job.siteId, analysisId, findingId: finding.id, title: generated.title,
      reason: generated.reason, evidence: { finding, files: { [generated.path]: generated.content }, oldFiles: { [generated.path]: oldContent } },
      filesChanged: [generated.path], pagesAffected: finding.pagesAffected ?? [], patch,
      status: "proposed" as const, author: "organic-growth-ai", aiModel: "@cf/google/gemma-4-26b-a4b-it", createdAt: new Date().toISOString(),
    };
    await insertChange(env.DB as D1Like, change);
    return Response.json({ change }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not generate a reviewable change." }, { status: 502 });
  }
}
