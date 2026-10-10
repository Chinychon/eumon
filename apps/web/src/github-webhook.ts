import { parseHtmlSignals } from "@organic-growth/crawler";
import { findFixByHeadSha, findFixByPr, findSitesByRepo, updateFix, type D1Like, type FixRecord } from "@organic-growth/db";
import type { SiteRecord } from "@organic-growth/core";
import { LLMS_MARKER, blockedAiSearchAgents } from "@organic-growth/fixes";
import type { GitHubOps } from "./fix-github.ts";

export type WebhookDeps = {
  db: D1Like;
  opsFor(site: SiteRecord): Promise<GitHubOps>;
  fetchHtml(url: string): Promise<{ status: number; body: string } | null>;
  now(): Date;
};

const NO_PREVIEW_MS = 30 * 60_000;

export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** Whether the fetched page shows what the fix targets; returns the failing check, or null. */
function missing(fix: FixRecord, pages: Array<{ url: string; body: string }>): string | null {
  if (fix.kind === "llms-txt") return pages[0]?.body.includes(LLMS_MARKER) ? null : "llms.txt";
  if (fix.kind === "ai-robots") return pages[0] && blockedAiSearchAgents(pages[0].body).length === 0 ? null : "robots.txt";
  for (const page of pages) {
    const s = parseHtmlSignals(page.body, page.url);
    if (fix.kind === "jsonld") { if (s.jsonLdCount === 0) return "JSON-LD"; continue; }
    if (fix.kind === "metadata-base") { if (!s.canonical) return "canonical"; continue; }
    const host = new URL(fix.urls[0] ?? page.url).hostname.replace(/^www\./, "").split(".")[0]?.toLowerCase();
    for (const p of fix.problems) {
      if (p.startsWith("title-") && (!s.title || s.title.trim().toLowerCase() === host)) return "title";
      if (p.startsWith("description-") && !(s.description && s.description.length >= 70 && s.description.length <= 170)) return "description";
      if (p === "canonical-missing" && !s.canonical) return "canonical";
      if (p === "hreflang-missing" && s.hreflang.length === 0) return "hreflang";
    }
  }
  return null;
}

export async function advanceFix(deps: WebhookDeps, ops: GitHubOps, fix: FixRecord): Promise<"ready" | "failed" | "waiting"> {
  if (!fix.headSha || !fix.prNumber) return "waiting";
  const note = (body: string) => ops.comment(fix.prNumber!, body).catch(() => undefined);
  const fail = async (result: string) => {
    await updateFix(deps.db, fix.id, { status: "failed", result });
    await note(result);
    return "failed" as const;
  };
  const ready = async (verification: Record<string, unknown>, comment: string) => {
    if (fix.prNodeId) await ops.markReady(fix.prNodeId);
    await updateFix(deps.db, fix.id, { status: "ready", verification });
    await note(comment);
    return "ready" as const;
  };

  const state = await ops.checkState(fix.headSha);
  if (state === "failure") return fail("Your CI checks failed on this change, so Eumon left it as a draft.");
  if (state === "pending") return "waiting";

  const preview = await ops.previewUrl(fix.headSha);
  if (preview) {
    const wanted = fix.kind === "llms-txt" ? ["/llms.txt"] : fix.kind === "ai-robots" ? ["/robots.txt"] : fix.urls.slice(0, 3).map((u) => { const x = new URL(u); return x.pathname + x.search; });
    const checked = wanted.map((path) => new URL(path, preview).href);
    const pages: Array<{ url: string; body: string }> = [];
    let locked = false;
    for (const url of checked) {
      const res = await deps.fetchHtml(url);
      if (res?.status === 401 || res?.status === 403) { locked = true; break; }
      pages.push({ url, body: res?.body ?? "" });
    }
    if (!locked) {
      const which = missing(fix, pages);
      if (which) return fail(`The preview deploy doesn't show the change in its HTML (${which}).`);
      return ready({ preview, checked, at: deps.now().toISOString() }, "Checks passed and the preview shows the change. Ready for your review.");
    }
  }
  if (deps.now().getTime() - new Date(fix.updatedAt).getTime() >= NO_PREVIEW_MS) {
    return ready({ buildOnly: true }, "Checks passed. No preview deploy was found, so only the build was verified.");
  }
  return "waiting";
}

export async function handleGitHubEvent(deps: WebhookDeps, event: string, payload: Obj): Promise<string> {
  const repo = obj(payload.repository);
  const owner = obj(repo.owner).login;
  const name = repo.name;
  if (typeof owner !== "string" || typeof name !== "string") return "ignored";
  const sites = await findSitesByRepo(deps.db, owner, name);

  if (event === "pull_request") {
    const pr = obj(payload.pull_request);
    if (payload.action !== "closed" || typeof pr.number !== "number") return "ignored";
    for (const site of sites) {
      const fix = await findFixByPr(deps.db, site.id, pr.number);
      if (!fix) continue;
      if (pr.merged === true) { await updateFix(deps.db, fix.id, { status: "merged" }); return "merged"; }
      if (fix.status === "draft" || fix.status === "ready") {
        await updateFix(deps.db, fix.id, { status: "rejected", result: "Closed without merging on GitHub." });
        return "rejected";
      }
      return "ignored";
    }
    return "ignored";
  }

  const sha = event === "check_suite" ? obj(payload.check_suite).head_sha
    : event === "check_run" ? obj(payload.check_run).head_sha
    : event === "status" ? payload.sha
    : event === "deployment_status" ? obj(obj(payload.deployment_status).deployment).sha ?? obj(payload.deployment).sha
    : undefined;
  if (typeof sha !== "string" || !sha) return "ignored";
  for (const site of sites) {
    const fix = await findFixByHeadSha(deps.db, sha, site.id);
    if (!fix) continue;
    if (fix.status !== "draft") return "ignored";
    return advanceFix(deps, await deps.opsFor(site), fix);
  }
  return "ignored";
}
