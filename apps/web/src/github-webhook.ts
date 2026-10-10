import { parseHtmlSignals } from "@organic-growth/crawler";
import { findFixByHeadSha, findFixByPr, findSitesByRepo, transitionFix, type D1Like, type FixRecord, type FixStatus } from "@organic-growth/db";
import type { SiteRecord } from "@organic-growth/core";
import { LLMS_MARKER, blockedAiSearchAgents, headProblems, pathOf, stripLocale, type PageHead } from "@organic-growth/fixes";
import type { GitHubOps } from "./fix-github.ts";

export type WebhookDeps = {
  db: D1Like;
  opsFor(site: SiteRecord): Promise<GitHubOps>;
  fetchHtml(url: string): Promise<{ status: number; body: string } | null>;
  now(): Date;
};

const NO_PREVIEW_MS = 30 * 60_000;
/** A merge on GitHub wins over any status but merged and reverted, so a reopened and merged PR is still recorded. */
export const MERGE_FROM: FixStatus[] = ["draft", "ready", "failed", "closed", "rejected"];
/** Statuses whose PR is open on GitHub, so closing it there means it was rejected. */
export const CLOSE_FROM: FixStatus[] = ["draft", "ready", "failed"];
export const CLOSED_ON_GITHUB = "Closed without merging on GitHub.";

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

/** Whether the fetched pages show what the fix targets; returns the failing check, or null. */
function missing(fix: FixRecord, pages: Array<{ url: string; body: string }>, siteName: string): string | null {
  if (fix.kind === "llms-txt") return pages[0]?.body.includes(LLMS_MARKER) ? null : "llms.txt";
  if (fix.kind === "ai-robots") return pages[0] && blockedAiSearchAgents(pages[0].body).length === 0 ? null : "robots.txt";
  if (fix.kind === "head") {
    // The same checks that found the problems, run over the preview: none of the fixed problems may remain.
    const heads: PageHead[] = pages.map(({ url, body }) => {
      const s = parseHtmlSignals(body, url);
      return { url, status: 200, ...(s.title ? { title: s.title } : {}), ...(s.description ? { description: s.description } : {}), ...(s.canonical ? { canonical: s.canonical } : {}), hreflang: s.hreflang, jsonLdTypes: s.jsonLdTypes };
    });
    const multiLocale = new Set(fix.problems.includes("hreflang-missing") ? heads.map((h) => stripLocale(pathOf(h.url) ?? "/").path) : []);
    for (const problems of headProblems(heads, siteName, multiLocale).values()) {
      const left = problems.find((p) => fix.problems.includes(p));
      if (left) return left;
    }
    return null;
  }
  for (const page of pages) {
    const s = parseHtmlSignals(page.body, page.url);
    if (fix.kind === "jsonld" && s.jsonLdCount === 0) return "JSON-LD";
    if (fix.kind === "metadata-base" && !s.canonical) return "canonical";
  }
  return null;
}

/** `siteName` is the site's name, so a title that is only the name still counts as missing on the preview. */
export async function advanceFix(deps: WebhookDeps, ops: GitHubOps, fix: FixRecord, siteName = ""): Promise<"ready" | "failed" | "waiting"> {
  if (!fix.headSha || !fix.prNumber) return "waiting";
  const note = (body: string) => ops.comment(fix.prNumber!, body).catch(() => undefined);
  // Every final write is a compare-and-set on draft, so concurrent events and merges can't be overwritten or double-commented.
  const fail = async (result: string) => {
    if (await transitionFix(deps.db, fix.id, ["draft"], { status: "failed", result })) await note(result);
    return "failed" as const;
  };
  const ready = async (verification: Record<string, unknown>, comment: string) => {
    if (!(await transitionFix(deps.db, fix.id, ["draft"], { status: "ready", verification }))) return "ready" as const;
    if (fix.prNodeId) {
      try {
        await ops.markReady(fix.prNodeId);
      } catch {
        await transitionFix(deps.db, fix.id, ["ready"], { result: "Checks passed, but GitHub wouldn't mark the PR ready for review. Mark it ready by hand." });
        return "ready" as const;
      }
    }
    await note(comment);
    return "ready" as const;
  };

  const state = await ops.checkState(fix.headSha);
  if (state === "failure") return fail("Your CI checks failed on this change, so Eumon left it as a draft.");
  if (state === "pending") return "waiting";

  const preview = await ops.previewUrl(fix.headSha);
  if (preview) {
    const wanted = fix.kind === "llms-txt" ? ["/llms.txt"] : fix.kind === "ai-robots" ? ["/robots.txt"] : fix.urls.slice(0, 3).map((u) => { const x = new URL(u); return x.pathname + x.search; });
    const checked = wanted.map((path) => new URL(path, preview)).filter((u) => u.origin === new URL(preview).origin).map((u) => u.href);
    const pages: Array<{ url: string; body: string }> = [];
    let usable = checked.length > 0;
    for (const url of checked) {
      const res = await deps.fetchHtml(url);
      // Anything but a 200 (locked, missing, rate-limited, erroring or unreachable) counts as no preview; only a page that loads can fail the fix.
      if (!res || res.status !== 200) { usable = false; break; }
      pages.push({ url, body: res.body });
    }
    if (usable) {
      const which = missing(fix, pages, siteName);
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
      if (pr.merged === true) { return (await transitionFix(deps.db, fix.id, MERGE_FROM, { status: "merged" })) ? "merged" : "ignored"; }
      return (await transitionFix(deps.db, fix.id, CLOSE_FROM, { status: "rejected", result: CLOSED_ON_GITHUB })) ? "rejected" : "ignored";
    }
    return "ignored";
  }

  // Only finished signals advance a fix; anything still running is ignored before any GitHub call.
  const done = event === "check_suite" ? obj(payload).action === "completed"
    : event === "check_run" ? obj(payload).action === "completed"
    : event === "status" ? payload.state === "success" || payload.state === "failure"
    : event === "deployment_status" ? ["success", "failure"].includes(String(obj(payload.deployment_status).state))
    : false;
  if (!done) return "ignored";
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
    return advanceFix(deps, await deps.opsFor(site), fix, site.name);
  }
  return "ignored";
}
