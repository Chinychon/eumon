import { FIX_PROMPT_VERSION, writeFixText, type FixSample } from "@organic-growth/agents";
import type { JsonLlm } from "@organic-growth/ai";
import { createId } from "@organic-growth/core";
import { parseHtmlSignals, visibleText } from "@organic-growth/crawler";
import { countOpenFixes, hasLiveFix, listFixes, stageFix, updateFix, type D1Like, type FixRecord } from "@organic-growth/db";
import {
  blockedAiSearchAgents, buildLlmsTxt, componentPath, editAiRobots, editJsonLd, editLlmsTxt, editMetadata, editMetadataBase, findMetadata, findPage,
  JSON_LD_COMPONENT, jsonLdCode, jsonLdSnippet, memberPaths, metadataSnippet, parseModule, pathOf, routeForPath, stripLocale, urlTemplate, validateEdit, validateFile,
  type AstNode, type Edit, type EditResult, type FixCandidate, type MetadataPlan, type PageHead, type Range, type RouteRef,
} from "@organic-growth/fixes";

export type FixRepo = { owner: string; name: string; branch: string; treePaths: string[]; getFile(path: string): Promise<{ content: string; sha: string } | null> };
export type FixDeps = { db: D1Like; repo: FixRepo; fetchPage(url: string): Promise<{ status: number; body: string } | null>; llm: JsonLlm | null; budget: { calls: number }; now(): Date };
/** `routes` (the analyzer's routes) name llms.txt sections; without it, the candidates' routes are used. */
export type StageInput = {
  siteId: string; analysisId: string; origin: string; siteName: string; language: string; queries: string[];
  candidates: FixCandidate[]; pages: PageHead[]; sensitivePaths: string[]; routes?: RouteRef[];
};
export type PrOps = { createPr(input: { branch: string; title: string; body: string; files: Record<string, string> }): Promise<{ number: number; url: string; nodeId: string; headSha: string }> };

/** What one candidate became; the loop adds the shared fields. */
type Outcome = Pick<FixRecord, "title" | "reason"> & Partial<Pick<FixRecord, "status" | "files" | "original" | "fileSha" | "snippet" | "beforeSnippet" | "afterSnippet" | "promptSha" | "warnings" | "result">>;
type Ctx = { deps: FixDeps; input: StageInput; c: FixCandidate };

const sentence = (reason: string, snippet: string) => /^[A-Z].*\.$/.test(reason)
  ? reason
  : `Eumon didn't open a pull request because ${reason}.${snippet ? " Copy the snippet to make the change by hand." : " Eumon will check again on the next run."}`;
const skip = (title: string, reason: string, snippet = ""): Outcome => ({ title, reason: title, status: "skipped", snippet, result: sentence(reason, snippet) });
const rootsOf = (paths: string[]) => [...new Set(paths.map((p) => p.split(".")[0]!))];

/** The allowed ranges' text before and after the edits. */
function snippets(before: string, after: string, edits: Edit[], ranges: Range[]) {
  const was: string[] = [], now: string[] = [];
  for (const r of ranges) {
    let start = r.start, end = r.end;
    for (const e of edits) {
      const delta = e.text.length - (e.end - e.start);
      if (e.start >= r.start && e.end <= r.end) end += delta;
      else if (e.end <= r.start) { start += delta; end += delta; }
    }
    was.push(before.slice(r.start, r.end).trim());
    now.push(after.slice(start, end).trim());
  }
  return { beforeSnippet: was.filter(Boolean).join("\n…\n") || "(none)", afterSnippet: now.filter(Boolean).join("\n…\n") };
}

/** Validates an edit result (the main file plus any whole files) and turns it into a staged outcome. */
function staged(ctx: Ctx, title: string, file: { path: string; content: string | null; sha: string }, result: EditResult, roots: string[]): Outcome {
  if (!result.ok) return skip(title, result.reason, result.snippet);
  const files: Record<string, string> = {};
  let before = "(none)", after = "";
  if (result.edits.length && file.content !== null) {
    const checked = validateEdit({ filePath: file.path, before: file.content, edits: result.edits, allowedRanges: result.allowedRanges, roots, sensitivePaths: ctx.input.sensitivePaths });
    if (!checked.ok) return skip(title, checked.reason);
    files[file.path] = checked.after;
    ({ beforeSnippet: before, afterSnippet: after } = snippets(file.content, checked.after, result.edits, result.allowedRanges));
  }
  for (const [path, content] of Object.entries(result.files)) {
    const checked = validateFile(path, content, ctx.input.sensitivePaths);
    if (!checked.ok) return skip(title, checked.reason);
    files[path] = content;
  }
  if (!result.edits.length) {
    before = file.content?.slice(0, 2000) || "(none)";
    after = Object.values(result.files)[0]?.slice(0, 2000) ?? "";
  }
  return {
    title, reason: result.summary, status: "staged", files, original: file.content === null ? {} : { [file.path]: file.content },
    fileSha: file.sha, beforeSnippet: before, afterSnippet: after,
  };
}

async function samplesFor(deps: FixDeps, urls: string[]): Promise<FixSample[]> {
  const pages = await Promise.all(urls.slice(0, 3).map(async (url) => ({ url, page: await deps.fetchPage(url).catch(() => null) })));
  return pages.filter(({ page }) => page?.status === 200).map(({ url, page }) => {
    const signals = parseHtmlSignals(page!.body, url);
    const h1 = signals.headingOutline.find((h) => h.startsWith("h1:"))?.slice(3);
    return { url, ...(signals.title ? { title: signals.title } : {}), ...(signals.description ? { description: signals.description } : {}), ...(h1 ? { h1 } : {}), text: visibleText(page!.body).slice(0, 600) };
  });
}

function parsed(source: string): AstNode | null {
  try { return parseModule(source); } catch { return null; }
}

const HEAD_LABELS: Array<[string, string]> = [["title", "titles"], ["description", "descriptions"], ["canonical", "canonical URLs"], ["hreflang", "hreflang tags"]];
const listOf = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0] ?? "head tags");
const headTitle = (keys: string[], route: string) => `Set ${listOf(HEAD_LABELS.filter(([k]) => keys.some((x) => x.startsWith(k))).map(([, label]) => label))} on ${route}`;

async function stageHead(ctx: Ctx): Promise<Outcome> {
  const { deps, input, c } = ctx;
  const route = c.route!;
  const title = headTitle(c.problems, route.pathPattern);
  const file = await deps.repo.getFile(c.file);
  if (!file) return skip(title, "the file isn't on the default branch");
  const program = parsed(file.content);
  if (!program) return skip(title, "the file doesn't parse");
  const site = findMetadata(program);
  const names = site.kind === "object" || site.kind === "function" ? site.names : [];
  const paths = memberPaths(program, names);
  const tpl = urlTemplate(route.pathPattern, names, file.content);
  const plan: MetadataPlan = {};
  if (c.problems.includes("canonical-missing") && tpl) plan.canonical = tpl;
  if (c.problems.includes("hreflang-missing") && tpl) {
    plan.languages = { "x-default": tpl, [input.language]: tpl, ...Object.fromEntries((c.locales ?? []).map((l) => [l, `/${l}${tpl}`])) };
  }
  const wantsTitle = c.problems.some((p) => p.startsWith("title-")), wantsDescription = c.problems.some((p) => p.startsWith("description-"));
  const placeholder = { ...plan, ...(wantsTitle ? { title: `Page title | ${input.siteName}` } : {}), ...(wantsDescription ? { description: "One or two sentences on what this page offers." } : {}) };
  if (site.kind === "unsupported") return skip(title, site.reason, metadataSnippet(placeholder, route.dynamic));

  let aiReason: string | null = null, warnings: string[] = [], promptSha: string | undefined;
  if (wantsTitle || wantsDescription) {
    if (!deps.llm) aiReason = "No AI is set up to write the title and description, so they're offered as a snippet instead.";
    else if (deps.budget.calls <= 0) aiReason = "The AI budget for this analysis is used up, so the title and description are offered as a snippet instead.";
    else {
      const samples = await samplesFor(deps, c.urls);
      const written = await writeFixText(deps.llm, { kind: "head", siteName: input.siteName, language: input.language, problems: c.problems, paths, dynamic: route.dynamic, samples, queries: input.queries }, deps.budget);
      if (!written.ok) aiReason = written.reason;
      else {
        const { text } = written;
        const q = text.titleQualifier ? ` ${text.titleQualifier}` : "";
        if (wantsTitle && text.titleSubject) plan.title = route.dynamic ? `{${text.titleSubject}}${q} | ${input.siteName}` : `${text.titleSubject}${q} | ${input.siteName}`;
        if (wantsDescription && text.description) plan.description = text.description;
        warnings = written.warnings;
        promptSha = FIX_PROMPT_VERSION;
      }
    }
  }
  if (!Object.keys(plan).length) return skip(title, aiReason ?? "there's nothing to change", metadataSnippet(placeholder, route.dynamic));
  if (aiReason) warnings = [...warnings, aiReason];
  const out = staged(ctx, headTitle(Object.keys(plan).map((k) => (k === "languages" ? "hreflang" : k)), route.pathPattern), { path: c.file, ...file }, editMetadata(file.content, plan, route.dynamic), rootsOf(paths));
  return out.status === "staged" ? { ...out, warnings, ...(promptSha ? { promptSha } : {}) } : out;
}

async function stageMetadataBase(ctx: Ctx): Promise<Outcome> {
  const title = "Set metadataBase in the root layout";
  const file = await ctx.deps.repo.getFile(ctx.c.file);
  if (!file) return skip(title, "the file isn't on the default branch");
  const result = editMetadataBase(file.content, ctx.input.origin);
  return staged(ctx, title, { path: ctx.c.file, ...file }, result, result.ok ? result.roots : []);
}

async function stageJsonLd(ctx: Ctx): Promise<Outcome> {
  const { deps, input, c } = ctx;
  const route = c.route!;
  const schemaType = c.schemaType ?? "WebPage";
  const title = `Add ${schemaType} structured data to ${route.pathPattern}`;
  const { treePaths } = deps.repo;
  if (!treePaths.includes("tsconfig.json")) return skip(title, "the site doesn't use TypeScript, so Eumon can't add its .tsx component");
  // The listed tree can be truncated, so ask for the component itself.
  const component = componentPath(treePaths);
  const existing = await deps.repo.getFile(component);
  if (existing && existing.content !== JSON_LD_COMPONENT) return skip(title, `${component} already exists with other content, so Eumon won't overwrite it`);
  const tree = existing ? [...treePaths, component] : treePaths.filter((p) => p !== component);
  const file = await deps.repo.getFile(c.file);
  if (!file) return skip(title, "the file isn't on the default branch");
  const program = parsed(file.content);
  if (!program) return skip(title, "the file doesn't parse");
  const page = findPage(program);
  if (page.kind === "unsupported") return skip(title, page.reason);
  const paths = memberPaths(program, page.names);
  const url = urlTemplate(route.pathPattern, page.names, file.content);
  if (url === null) return skip(title, "a route parameter isn't available inside the page component");
  const manual = jsonLdSnippet(jsonLdCode({ schemaType, fields: [{ field: "name", path: "page.name" }], url, origin: input.origin }));
  if (!deps.llm) return skip(title, "No AI is set up to map the page's data to structured data, so the markup is offered as a snippet instead.", manual);
  if (deps.budget.calls <= 0) return skip(title, "The AI budget for this analysis is used up, so the markup is offered as a snippet instead.", manual);
  const samples = await samplesFor(deps, c.urls);
  const written = await writeFixText(deps.llm, { kind: "jsonld", siteName: input.siteName, language: input.language, problems: c.problems, paths, dynamic: route.dynamic, schemaType, samples, queries: input.queries }, deps.budget);
  if (!written.ok) return skip(title, written.reason, manual);
  const out = staged(ctx, title, { path: c.file, ...file }, editJsonLd(c.file, file.content, { schemaType, fields: written.text.schema, url, origin: input.origin }, tree), rootsOf(paths));
  return out.status === "staged" ? { ...out, warnings: written.warnings, promptSha: FIX_PROMPT_VERSION } : out;
}

const titleCase = (segment: string) => segment.split(/[-_]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");

async function stageLlms(ctx: Ctx): Promise<Outcome> {
  const { deps, input, c } = ctx;
  const existing = await deps.repo.getFile(c.file);
  const title = existing ? "Refresh llms.txt" : "Add llms.txt";
  const routes = input.routes ?? input.candidates.flatMap((x) => (x.route ? [x.route] : []));
  const home = input.pages.find((p) => pathOf(p.url) === "/");
  const pages = input.pages.filter((p) => p.status === 200 && p.title).map((p) => {
    const path = pathOf(p.url) ?? "/";
    const route = routeForPath(path, routes) ?? routeForPath(stripLocale(path).path, routes);
    const segment = route?.pathPattern.split("/").find((s) => s && !s.startsWith(":"));
    return { url: p.url, title: p.title, ...(p.description ? { description: p.description } : {}), section: segment ? titleCase(segment) : "Pages" };
  });
  const content = buildLlmsTxt({ siteName: input.siteName, summary: home?.description ?? `${input.siteName}: ${input.origin}`, pages });
  return staged(ctx, title, { path: c.file, content: existing?.content ?? null, sha: existing?.sha ?? "new" }, editLlmsTxt(existing?.content ?? null, content), []);
}

async function stageRobots(ctx: Ctx): Promise<Outcome> {
  const title = "Let AI search crawlers read the site";
  const file = await ctx.deps.repo.getFile(ctx.c.file);
  if (!file) return skip(title, "robots.txt isn't on the default branch");
  return staged(ctx, title, { path: ctx.c.file, ...file }, editAiRobots(file.content, blockedAiSearchAgents(file.content)), []);
}

const STAGERS = { head: stageHead, "metadata-base": stageMetadataBase, jsonld: stageJsonLd, "llms-txt": stageLlms, "ai-robots": stageRobots };

export async function stageCandidates(deps: FixDeps, input: StageInput): Promise<{ staged: number; skipped: number }> {
  const counts = { staged: 0, skipped: 0 };
  for (const c of input.candidates) {
    const route = c.route?.pathPattern ?? c.file;
    try {
      if (await hasLiveFix(deps.db, input.siteId, route, c.kind)) continue;
      let outcome: Outcome;
      try {
        outcome = await STAGERS[c.kind]({ deps, input, c });
      } catch (error) {
        outcome = { title: `Fix ${c.kind} on ${route}`, reason: `Fix ${c.kind} on ${route}`, status: "skipped", result: `Eumon couldn't prepare this fix: ${messageOf(error)}. It will try again on the next run.` };
      }
      const at = deps.now().toISOString();
      await stageFix(deps.db, {
        id: createId("fix"), siteId: input.siteId, analysisId: input.analysisId, kind: c.kind, route, filePath: c.file,
        files: {}, original: {}, warnings: [], status: "skipped", ...outcome, urls: c.urls, problems: c.problems, score: c.score, createdAt: at, updatedAt: at,
      });
      counts[outcome.status === "staged" ? "staged" : "skipped"]++;
    } catch (error) {
      console.error(`fix-run: couldn't save the ${c.kind} fix for ${route}`, error);
    }
  }
  return counts;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\.$/, "");
const CHANGED = "The file changed after the analysis; Eumon will check it again on the next run.";

/** True when the main file's SHA moved, or a file the fix adds now exists with other content. */
async function changedSince(repo: FixRepo, fix: FixRecord): Promise<boolean> {
  const fresh = await repo.getFile(fix.filePath);
  if (fresh ? fresh.sha !== fix.fileSha : fix.fileSha !== "new") return true;
  for (const [path, content] of Object.entries(fix.files)) {
    if (path === fix.filePath) continue;
    const now = await repo.getFile(path);
    if (now && now.content !== content) return true;
  }
  return false;
}

const slug = (route: string) => route.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "root";

export async function openStagedFixes(deps: FixDeps, pr: PrOps, input: { siteId: string; origin: string; budget: number; onlyId?: string; max?: number }): Promise<number> {
  const max = input.max ?? 3;
  const limit = Math.min(input.budget - (await countOpenFixes(deps.db, input.siteId)), max);
  // Fixes closed as changed cost GitHub calls too, so the number examined is capped as well as the number opened.
  const fixes = (await listFixes(deps.db, input.siteId, ["staged"])).filter((f) => !input.onlyId || f.id === input.onlyId).slice(0, max * 2);
  let opened = 0;
  for (const fix of fixes) {
    if (opened >= limit) break;
    try {
      const changed = await changedSince(deps.repo, fix).catch((error: unknown) => new Error(messageOf(error)));
      if (changed) {
        const result = changed instanceof Error ? `Eumon couldn't read the files from GitHub (${changed.message}); it will check them again on the next run.` : CHANGED;
        await updateFix(deps.db, fix.id, { status: "closed", result });
        continue;
      }
      const branch = `eumon/${fix.kind}-${slug(fix.route)}-${fix.id.slice(-6)}`;
      try {
        const made = await pr.createPr({ branch, title: fix.title, body: fixPrBody(fix, input.origin), files: fix.files });
        await updateFix(deps.db, fix.id, { status: "draft", prNumber: made.number, prUrl: made.url, branch, headSha: made.headSha, prNodeId: made.nodeId });
        opened++;
      } catch (error) {
        await updateFix(deps.db, fix.id, { status: "failed", result: `Eumon couldn't open the pull request: ${messageOf(error)}. It will prepare the fix again on the next run.` });
      }
    } catch (error) {
      console.error(`fix-run: couldn't open fix ${fix.id}`, error);
    }
  }
  return opened;
}

const fenced = (text: string) => {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}\n${text}\n${fence}`;
};

export function fixPrBody(fix: FixRecord, origin: string): string {
  const host = new URL(origin).host;
  const pages = fix.urls.length
    ? `It affects ${fix.urls.length}${fix.urls.length >= 20 ? " or more" : ""} page${fix.urls.length === 1 ? "" : "s"} on ${host}, for example:\n\n${fix.urls.slice(0, 5).map((u) => `- ${u}`).join("\n")}`
    : `It applies to the whole of ${host}.`;
  return [
    "## What this fixes", fix.reason, pages,
    "## Before", fenced(fix.beforeSnippet ?? "(none)"),
    "## After", fenced(fix.afterSnippet ?? ""),
    "Eumon will mark this ready after your checks pass and the change shows up on the preview deploy.",
    "To undo after merging, revert this PR's single commit.",
    "---", "Opened by Eumon's fix engine.",
  ].join("\n\n");
}

export async function checkMergedFixes(deps: FixDeps, pr: PrOps, input: { siteId: string; pages: PageHead[] }): Promise<number> {
  const byUrl = new Map(input.pages.map((p) => [p.url, p]));
  let reverted = 0;
  for (const fix of await listFixes(deps.db, input.siteId, ["merged"])) {
    if (fix.verification) continue;
    try {
      const seen = fix.urls.flatMap((u) => byUrl.get(u) ?? []);
      // Page-level fixes wait for a recrawl that includes their pages.
      if ((fix.kind === "head" || fix.kind === "jsonld") && !seen.length) continue;
      const checkedAt = deps.now().toISOString();
      const errors = seen.filter((p) => p.status >= 400);
      const untitled = seen.filter((p) => !p.title?.trim()).length;
      const what = errors.length
        ? `${errors.length} of its page${errors.length === 1 ? "" : "s"} returning errors (${errors[0]!.url} returned ${errors[0]!.status})`
        : fix.kind === "head" && fix.problems.some((p) => p.startsWith("title-")) && untitled * 2 > seen.length
          ? `${untitled} of its ${seen.length} pages without a title`
          : null;
      if (!what) {
        await updateFix(deps.db, fix.id, { verification: { recrawl: "ok", pages: seen.length, checkedAt } });
        continue;
      }
      const paths = Object.keys(fix.original);
      const current = await Promise.all(paths.map(async (path) => (await deps.repo.getFile(path))?.content));
      if (!paths.length || paths.some((path, i) => current[i] !== fix.files[path])) {
        await updateFix(deps.db, fix.id, {
          verification: { recrawl: "broken", revert: "manual", checkedAt },
          result: `The recrawl found ${what} after this fix, but the file has changed since, so Eumon didn't open a revert. Use GitHub's Revert button on the merged PR.`,
        });
        continue;
      }
      const added = Object.keys(fix.files).filter((path) => !(path in fix.original));
      const body = `Eumon's recrawl after this fix found ${what}. This restores the previous version.${added.length ? ` Files the fix added (${added.join(", ")}) are left in place; nothing uses them after this revert, so you can delete them.` : ""}`;
      try {
        const made = await pr.createPr({ branch: `eumon/revert-${fix.id.slice(-6)}-${deps.now().getTime().toString(36)}`, title: `Revert: ${fix.title}`, body, files: fix.original });
        await updateFix(deps.db, fix.id, { status: "reverted", result: `Eumon's recrawl found ${what}, so it opened a pull request to undo this fix: ${made.url}. Merge it to restore the previous version.` });
        reverted++;
      } catch (error) {
        await updateFix(deps.db, fix.id, {
          verification: { recrawl: "broken", revert: "failed", checkedAt },
          result: `The recrawl found ${what} after this fix, but Eumon couldn't open a revert pull request (${messageOf(error)}). Use GitHub's Revert button on the merged PR.`,
        });
      }
    } catch (error) {
      console.error(`fix-run: couldn't check merged fix ${fix.id}`, error);
    }
  }
  return reverted;
}
