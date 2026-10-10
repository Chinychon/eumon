# Accounts, Workspaces, and Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every dashboard page and API route behind Better Auth accounts with self-serve workspaces (Owner, Member, site-scoped Client), enforce free per-workspace limits, and close the OAuth, pull-request, and outbound-fetch weaknesses from the 2026-10-10 audit.

**Architecture:**
- A gate in `apps/web/worker.ts` runs before vinext. It hands `/api/auth/*` to Better Auth, lets a fixed list of public paths through, and requires a session everywhere else.
- Every route then calls one guard from `apps/web/src/guard.ts`, which checks the viewer's role on the site the route touches. The role rules (`access.ts`) and the workspace queries (`packages/db/src/workspaces.ts`) are pure and tested on Node's SQLite.
- Limits are one conditional upsert per costly action.

**Tech Stack:**
- Cloudflare Workers (Free plan), D1, vinext (Next-style app router), React 19
- `better-auth@1.7.7` with the organization, magic-link, and captcha plugins
- `node:test` for tests

**Spec:** `docs/superpowers/specs/2026-10-10-accounts-and-hardening-design.md`

## Global Constraints

- Work only in the worktree `/home/gabrielchin/Desktop/workstation/eumon-security` (branch `claude/security-hardening`). Never `cd` into two worktrees in parallel shell calls.
- **Workers Free:** a request may use at most 10 ms of CPU, and Email Sending is not available. Magic link, email verification, and password sign-in ship **off** (`EMAIL_ENABLED`, `PASSWORD_SIGNIN`).
- **D1 free daily limits are exhausted.**
  - Never apply migrations remotely and never run anything against the remote database.
  - Test on local SQLite (`openSqliteD1`) and local dev (`npm run dev`, port 5174).
  - Per-request D1 work stays minimal: session cookie cache of 5 min, `updateAge` of 1 day, and usage writes only on costly actions.
- **Migration number:** before writing `0024`, run `git fetch origin && git ls-tree --name-only origin/main packages/db/migrations/ | tail -3`. If `0024` or later already exists on main, use the next free number everywhere this plan says `0024`.
- `better-auth` is pinned to exactly `1.7.7`. Add no other new runtime dependency.
- **Tests:**
  - Web: `cd apps/web && node --test "src/**/*.test.ts"`. Imports use `.ts` extensions, and nothing the test imports may import `cloudflare:workers`.
  - Packages: `npm test -w @organic-growth/<pkg>` (tsc to `dist-test`, `.js` imports).
- **Packages are consumed built:** after changing `packages/*`, run `npm run build:packages` from the worktree root before running web tests.
- **Copy:** user-facing messages are full sentences that say what to do next. Match the existing tone, e.g. `"Site not found."`, `"Sign in to continue."`.
- **Commits:** end every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Styling:** follow `apps/web/DESIGN.md`: square corners, hairline rules, Geist. Reuse `Button`, `Card`, and `Field` from `app/components/ui.tsx`.

## Review Focus

1. **Tokens from before the change.** A logged-out browser holding an old `og_installation` cookie, or a share link minted before the change, must still behave: share links keep working, and the old cookie is ignored. Owned by Task 18, which adds the test.
2. **A route nobody guarded.** A new or missed `route.ts` must fail the build-time test, not ship open. Task 9's `routes-guarded.test.ts` walks every handler.
3. **Existing sites after the migration.** Every pre-existing site must land in `ws_initial`, and the bootstrap owner must see all of them on first Google sign-in. Task 4 tests the migration and Task 7 tests the hook.
4. **Clients reaching write paths via IDs.** A Client must not be able to delete a record or run an analysis by calling the ID-keyed routes directly. Task 6 tests the access matrix per ID kind.
5. **Open redirect through `next`.** `/sign-in?next=//evil.com` or `next=https://evil.com` must land on `/`. Task 14 adds `safeNext` with its test.

---

## Part C: Hardening (independent of accounts)

### Task 1: Trailing-dot hostnames are not public

**Files:**
- Modify: `packages/crawler/src/index.ts:26-40` (`isSafePublicUrl`)
- Test: `packages/crawler/src/crawler.test.ts`

**Interfaces:**
- Produces: `isSafePublicUrl(value: string, expectedOrigin?: string): boolean`. The signature is unchanged; it now refuses `localhost.` and the other trailing-dot local names.

- [ ] **Step 1: Write the failing test.** Add `isSafePublicUrl` to the existing `import { … } from "./index.js";` line of `crawler.test.ts`, and append:

```ts
describe("isSafePublicUrl", () => {
  it("refuses local names written with a trailing dot, and still accepts public ones", () => {
    for (const url of ["http://localhost./", "http://foo.localhost./", "http://metadata.google.internal./", "http://printer.local./"]) {
      assert.equal(isSafePublicUrl(url), false, url);
    }
    assert.equal(isSafePublicUrl("https://example.com./"), true);
    assert.equal(isSafePublicUrl("http://127.0.0.1./"), false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npm test -w @organic-growth/crawler`. Expected: FAIL on `http://localhost./`.

- [ ] **Step 3: Implement.** In `isSafePublicUrl`, change:

```ts
    const host = url.hostname.toLowerCase();
```

to:

```ts
    // "localhost." and "x.internal." name the same hosts as without the dot.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
```

- [ ] **Step 4: Run it and confirm it passes.** Run `npm test -w @organic-growth/crawler`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/crawler/src/index.ts packages/crawler/src/crawler.test.ts
git commit -m "Crawler: refuse local hostnames written with a trailing dot"
```

### Task 2: Supabase pulls only reach Supabase, with a timeout and a size cap

**Files:**
- Create: `apps/web/src/body.ts`, which takes the stream reader out of `server.ts` so tests can import it
- Modify: `apps/web/src/server.ts:17-35` (re-export `readText` from `body.ts`)
- Modify: `apps/web/src/supabase-source.ts:90-102`
- Modify: `apps/web/app/api/datasets/[datasetId]/sources/route.ts:19-28` (validate the Supabase URL)
- Test: `apps/web/src/supabase-source.test.ts`

**Interfaces:**
- Produces:
  - `readText(source: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<string | null>` in `body.ts`
  - `isSupabaseProjectUrl(value: string): boolean`
  - `MAX_PULL_BYTES = 5_000_000`
  - `PULL_TIMEOUT_MS = 15_000`

- [ ] **Step 1: Write the failing tests.** Append inside the existing `describe` of `supabase-source.test.ts`, and add `isSupabaseProjectUrl` and `MAX_PULL_BYTES` to the `./supabase-source.ts` import:

```ts
  it("only pulls from a Supabase project address", async () => {
    assert.equal(isSupabaseProjectUrl("https://abc.supabase.co"), true);
    for (const url of ["http://abc.supabase.co", "https://attacker.tld", "https://abc.supabase.co.evil.tld", "https://abc.supabase.co:8443"]) assert.equal(isSupabaseProjectUrl(url), false, url);
    const db = await site();
    const source = (await getSource(db, "src"))!;
    const { fetchFn, calls } = table(3);
    await assert.rejects(
      runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, { ...source, url: "https://attacker.tld" }, (await getDataset(db, "d"))!, "job"),
      /supabase\.co/,
    );
    assert.equal(calls.length, 0, "nothing was fetched");
  });

  it("gives up on a page larger than the cap, and asks with a timeout", async () => {
    const db = await site();
    let signal: AbortSignal | undefined;
    const huge = "[" + `{"Name":"${"x".repeat(1000)}"},`.repeat(Math.ceil(MAX_PULL_BYTES / 1000)) + `{"Name":"y"}]`;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(huge, { status: 200 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      runSupabasePull({ db, encryptionKey: KEY, fetchFn }, steps().step, (await getSource(db, "src"))!, (await getDataset(db, "d"))!, "job"),
      /more than 5 MB/,
    );
    assert.ok(signal, "the request carried an abort signal");
  });
```

- [ ] **Step 2: Run them and confirm they fail.** Run `cd apps/web && node --test src/supabase-source.test.ts`. Expected: FAIL, because `isSupabaseProjectUrl` is not exported.

- [ ] **Step 3: Move the reader.** Create `apps/web/src/body.ts`:

```ts
/** Reads a body without trusting Content-Length; null when it passes `maxBytes`. Works for requests and responses alike. */
export async function readText(source: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<string | null> {
  const reader = source.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}
```

In `server.ts`, delete the `readText` function body (lines 17-35) and add `export { readText } from "./body";` beside the other imports. `readJson` keeps calling `readText`, so import it too: `import { readText } from "./body";`.

- [ ] **Step 4: Implement the guard in `supabase-source.ts`.** Add near the other constants:

```ts
import { readText } from "./body.ts";

/** One page of rows at most this large; a table that sends more is refused rather than read into memory. */
export const MAX_PULL_BYTES = 5_000_000;
export const PULL_TIMEOUT_MS = 15_000;

/** `https://<project>.supabase.co` and nothing else: the key is only ever sent to Supabase. */
export function isSupabaseProjectUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.port && /^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname);
  } catch {
    return false;
  }
}
```

In `pullPage`, before building `url`:

```ts
  if (!isSupabaseProjectUrl(source.url)) throw new Error("A Supabase source must be a https://<project>.supabase.co address. Remove it and add it again.");
```

Add the timeout signal to the fetch init:

```ts
    response = await (deps.fetchFn ?? fetch)(url, { headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json", Prefer: "count=exact" }, redirect: "error", signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
```

Replace `const rows = (await response.json()) as unknown;` with:

```ts
  const text = await readText(response, MAX_PULL_BYTES);
  if (text === null) throw new Error(`The table sent more than ${MAX_PULL_BYTES / 1_000_000} MB in one page. Pull a narrower view of it.`);
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error("The table answered with something other than rows.");
  }
```

- [ ] **Step 5: Validate at creation.** In `datasets/[datasetId]/sources/route.ts`, inside the `kind === "supabase"` branch, before the source is saved, add the following (import `isSupabaseProjectUrl` from `../../../../../src/supabase-source`):

```ts
    if (!isSupabaseProjectUrl(String(body?.url ?? ""))) return fail("Enter the project URL from Supabase, such as https://abcd1234.supabase.co.");
```

- [ ] **Step 6: Run the tests and confirm they pass.** Run `cd apps/web && node --test src/supabase-source.test.ts`. Expected: PASS, including the existing tests.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/body.ts apps/web/src/server.ts apps/web/src/supabase-source.ts apps/web/src/supabase-source.test.ts "apps/web/app/api/datasets/[datasetId]/sources/route.ts"
git commit -m "Supabase sources: Supabase hosts only, 15 s timeout, 5 MB page cap"
```

### Task 3: Small hardening: beacon variants, CSV formulas, browser sockets, proxy headers, sitemap comment

**Files:**
- Modify: `packages/db/src/page-engine.ts:864-867`
- Modify: `apps/web/app/components/export/workbook.ts:15-16`
- Modify: `apps/web/src/analysis-workflow.ts:221-230`
- Modify: `apps/web/app/api/sites/[siteId]/integration/route.ts:26-29,86-89,99`
- Modify: `packages/crawler/src/index.ts:571-573`
- Test: `packages/db/src/page-engine.test.ts`, `apps/web/app/components/export/workbook.test.ts`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing tests.** In `page-engine.test.ts`, add `insertCtaVariant`, `incrementPageMetric`, and `listCtaVariants` to the `./page-engine.js` import, and append:

```ts
describe("CTA variant counters", () => {
  it("never count a paused variant", async () => {
    const db = openSqliteD1();
    const at = new Date().toISOString();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: at, updatedAt: at });
    await insertCtaVariant(db, { id: "v", siteId: "s", label: "B", copy: "Chat", url: "https://wa.me/1", active: false, impressions: 0, clicks: 0, createdAt: at });
    await incrementPageMetric(db, { siteId: "s", pageId: "p", kind: "cta_clicks", variantId: "v" });
    assert.equal((await listCtaVariants(db, "s"))[0]!.clicks, 0);
  });
});
```

If `incrementPageMetric` with an unknown page id hits a foreign key, insert a generated page first with the helpers the file already uses for pages (search the file for `upsertTemplate(` and `syncTemplatePages(`). Use the `pageId` that results.

In `workbook.test.ts`, append:

```ts
describe("formula guard", () => {
  it("defuses cells that start with a tab or carriage return too", () => {
    // Match toCsv's call shape to the existing tests in this file (it takes a Sheet).
    const rows = toCsv({ name: "x", columns: ["a"], rows: [["\t=1+1"], ["\r=1+1"], ["=1+1"]] }).split("\r\n").slice(1, 4);
    for (const row of rows) assert.match(row, /^"?'/, JSON.stringify(row));
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.** Run `npm test -w @organic-growth/db` and `cd apps/web && node --test app/components/export/workbook.test.ts`. Expected: both FAIL.

- [ ] **Step 3: Implement.**

In `page-engine.ts`:

```ts
    statements.push(db.prepare(`UPDATE cta_variants SET ${counter} = ${counter} + 1 WHERE id = ? AND site_id = ? AND active = 1`)
```

In `workbook.ts`, update the comment and the regex:

```ts
/** Text a spreadsheet would run as a formula (starting =, +, -, @, tab or carriage return) gets a leading apostrophe, which Excel and Sheets show as text. Numbers stay numbers. */
const safeText = (cell: Cell) => (typeof cell === "string" && /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : text(cell));
```

In `analysis-workflow.ts`, right after `await page.setRequestInterception(true);`:

```ts
          // Request interception never sees WebSockets; block them so page scripts can't open sockets to anything.
          const cdp = await page.createCDPSession();
          await cdp.send("Network.enable");
          await cdp.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*"] });
```

In `integration/route.ts`:

- Worker snippet, after `const headers = new Headers(request.headers);`:

```js
    // The visitor's own cookies and credentials stay on your site.
    headers.delete("cookie");
    headers.delete("authorization");
```

- nginx snippet, after `proxy_set_header X-Eumon-Proxy 1;`:

```
    proxy_set_header Cookie "";
    proxy_set_header Authorization "";
```

- Apache snippet, after `RequestHeader set X-Eumon-Proxy "1"`:

```
RequestHeader unset Cookie
RequestHeader unset Authorization
```

In `packages/crawler/src/index.ts:571-572`, correct the comment so it says 25 MB:

```ts
  // Sitemap files may be far larger than a page (Google allows 50 MB); read up to 25 MB, beyond the 2 MB page-response cap.
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm run build:packages && npm test -w @organic-growth/db && (cd apps/web && node --test app/components/export/workbook.test.ts)`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/db/src/page-engine.ts packages/db/src/page-engine.test.ts apps/web/app/components/export apps/web/src/analysis-workflow.ts "apps/web/app/api/sites/[siteId]/integration/route.ts" packages/crawler/src/index.ts
git commit -m "Hardening: paused variants stay uncounted, CSV tab/CR guard, no browser sockets, proxies drop visitor cookies"
```

### Task 4: Security headers, no workers.dev, pinned React

**Files:**
- Create: `apps/web/src/headers.ts`
- Test: `apps/web/src/headers.test.ts`
- Modify: `apps/web/src/public-pages.ts:45` (`html()`)
- Modify: `apps/web/cloudflare.config.ts` (`workersDev: false`, `previewUrls: false`)
- Modify: `apps/web/package.json` (pin `react` and `react-dom`)

**Interfaces:**
- Produces:
  - `withHeaders(response: Response, headers: Record<string, string>): Response`
  - `APP_HEADERS: Record<string, string>`
  - `PAGE_HEADERS: Record<string, string>`
  - Task 10 uses `withHeaders(response, APP_HEADERS)` in `worker.ts`.

- [ ] **Step 0: Ask the user before turning off workers.dev.** Disabling workers.dev takes the app offline if production has no custom domain. Ask: "Is Eumon served on a custom domain in production, not only `*.workers.dev`?" If only workers.dev, skip the `cloudflare.config.ts` change and note it in the PR body.

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/headers.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_HEADERS, PAGE_HEADERS, withHeaders } from "./headers.ts";

describe("security headers", () => {
  it("adds headers to an immutable response without losing its body or status", async () => {
    const original = Response.redirect("https://x.com/", 302);
    const response = withHeaders(original, APP_HEADERS);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://x.com/");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  });

  it("lets landing pages be framed but keeps nosniff and base-uri", () => {
    assert.equal(PAGE_HEADERS["X-Frame-Options"], undefined);
    assert.equal(PAGE_HEADERS["X-Content-Type-Options"], "nosniff");
    assert.match(PAGE_HEADERS["Content-Security-Policy"]!, /base-uri 'none'/);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/headers.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement.** Create `apps/web/src/headers.ts`:

```ts
/*
 * Response headers that limit what a browser does with Eumon's pages.
 * ponytail: no script-src. vinext writes inline RSC payload scripts and the landing-page
 * beacon is inline with per-page config; a script policy needs per-request nonces threaded
 * through both renderers. The renderer's escaping is the XSS defence until then.
 */
export const APP_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};

/** Landing pages may be framed by the customer's own site, so no frame rules. */
export const PAGE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Content-Security-Policy": "base-uri 'none'; object-src 'none'",
};

/** A copy of `response` with `headers` set; responses from fetch or Response.redirect are immutable. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
  return copy;
}
```

In `public-pages.ts`, find `function html(` (line 45). Spread `PAGE_HEADERS` into the headers object it builds (import from `./headers`), keeping its existing `Content-Type` and `Cache-Control`. Example shape:

```ts
headers: { ...PAGE_HEADERS, "Content-Type": "text/html; charset=utf-8", /* existing entries */ }
```

In `cloudflare.config.ts`, inside `defineWorker({ … })` after `compatibilityFlags`:

```ts
    // Serve only on the custom domain: workers.dev and preview URLs would bypass the domain's protections.
    workersDev: false,
    previewUrls: false,
```

In `apps/web/package.json`, replace `"react": "latest"` and `"react-dom": "latest"` with the exact installed versions. Get them with `node -p 'require("react/package.json").version'` run in `apps/web`. Then run `npm audit fix` (without `--force`) at the root, and keep the lockfile changes only if `npm test` still passes.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `cd apps/web && node --test src/headers.test.ts`, then `npm test` at the root. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/headers.ts apps/web/src/headers.test.ts apps/web/src/public-pages.ts apps/web/cloudflare.config.ts apps/web/package.json package-lock.json
git commit -m "Security headers on app and landing pages; no workers.dev or preview URLs; pin React"
```

---

## Part A: Accounts and workspaces

### Task 5: Migration 0024 and workspace queries

**Files:**
- Create: `packages/db/migrations/0024_accounts.sql`
- Create: `packages/db/src/workspaces.ts`
- Test: `packages/db/src/workspaces.test.ts`
- Modify: `packages/db/src/index.ts`. Add `export * from "./workspaces.js";`. In `upsertSite`, write `workspace_id` on insert only. In `mapSite`, map `workspaceId`. Add `siteForUser`, `listSitesForUser`, `countWorkspaceSites`, `setSiteWorkspace`, `getSiteLogToken`, and `setSiteLogToken`.
- Modify: `packages/core/src/types.ts:76-93`. Add `workspaceId?: string` to `SiteRecord`.

**Interfaces:**
- Produces in `@organic-growth/db`:
  - `type WorkspaceRole = "owner" | "member" | "client"`
  - `siteForUser(db, userId, siteId): Promise<{ site: SiteRecord; role: WorkspaceRole } | null>`
  - `listSitesForUser(db, userId, workspaceId): Promise<SiteRecord[]>`
  - `countWorkspaceSites(db, workspaceId): Promise<number>`
  - `setSiteWorkspace(db, siteId, workspaceId): Promise<void>`
  - `getSiteLogToken(db, siteId): Promise<string | null>`
  - `setSiteLogToken(db, siteId, token): Promise<void>`
  - `memberRole(db, workspaceId, userId): Promise<WorkspaceRole | null>`
  - `setUpNewUser(db, user: { id: string; name: string; email: string; emailVerified: boolean }, adminEmails: string[]): Promise<void>`
  - `workspaceForNewSession(db, userId, adminEmails): Promise<string | null>`
  - `grantInvitedSites(db, invitationId, userId): Promise<void>`
  - `addSiteInvites(db, invitationId, siteIds: string[]): Promise<void>`
  - `memberSlotsUsed(db, workspaceId): Promise<number>` (members plus pending invitations)
  - `chargeUsage(db, input: { workspaceId: string; day: string; metric: string; amount: number; limit: number | null }): Promise<boolean>`
  - `getLimitOverrides(db, workspaceId): Promise<Record<string, unknown>>`
  - `setLimitOverrides(db, workspaceId, overrides: Record<string, unknown>): Promise<void>`
  - `listWorkspacesForAdmin(db, day): Promise<Array<{ id: string; name: string; createdAt: string; sites: number; members: number; usage: Record<string, number>; overrides: Record<string, unknown> }>>`
  - `addGithubInstallation(db, workspaceId, installationId): Promise<void>`
  - `listGithubInstallations(db, workspaceId): Promise<string[]>`
  - `INITIAL_WORKSPACE_ID = "ws_initial"`

- [ ] **Step 1: Write the migration.** Create `packages/db/migrations/0024_accounts.sql` (renumber per Global Constraints). The Better Auth DDL below is exactly what `getMigrations()` emits for `better-auth@1.7.7` with these plugins. Its camelCase column names are Better Auth's own, so don't rename them.

```sql
-- Accounts and workspaces (Better Auth 1.7.7: core tables plus the organization plugin;
-- camelCase columns are Better Auth's), client site grants, free-limit overrides and
-- daily usage, GitHub installations per workspace, and a rotatable log token per site.
--
-- `sites.workspace_id` is added, not rebuilt: D1 enforces foreign keys, so dropping
-- `sites` would cascade-delete every child row. The app always sets it.

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);
create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);
create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);
create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);
create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "member_organizationId_idx" on "member" ("organizationId");
create index "member_userId_idx" on "member" ("userId");
create index "invitation_organizationId_idx" on "invitation" ("organizationId");
create index "invitation_email_idx" on "invitation" ("email");

-- The workspace that holds every site from before accounts; BOOTSTRAP_OWNER_EMAIL users own it.
INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('ws_initial', 'Eumon', 'eumon', '2026-10-10T00:00:00.000Z');

ALTER TABLE sites ADD COLUMN workspace_id TEXT REFERENCES "organization" ("id") ON DELETE CASCADE;
UPDATE sites SET workspace_id = 'ws_initial';
CREATE INDEX idx_sites_workspace ON sites (workspace_id);

-- Null: the log endpoint accepts the token derived from SESSION_SECRET, as before. Set by "Rotate".
ALTER TABLE sites ADD COLUMN log_token TEXT;

-- A Client sees only the sites granted here.
CREATE TABLE site_access (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id)
) WITHOUT ROWID;
CREATE INDEX idx_site_access_site ON site_access (site_id);

-- The sites a pending Client invitation grants, copied into site_access on acceptance.
CREATE TABLE site_access_invites (
  invitation_id TEXT NOT NULL REFERENCES "invitation" ("id") ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  PRIMARY KEY (invitation_id, site_id)
) WITHOUT ROWID;

-- Overrides of the free limits in code; a null value means unlimited.
CREATE TABLE workspace_limits (
  workspace_id TEXT PRIMARY KEY REFERENCES "organization" ("id") ON DELETE CASCADE,
  limits_json TEXT NOT NULL
);
INSERT INTO workspace_limits (workspace_id, limits_json) VALUES ('ws_initial',
  '{"sites":null,"analysesPerDay":null,"scrapePagesPerDay":null,"askPerDay":null,"aiRunsPerDay":null,"members":null,"dataForSeo":true,"pullRequests":true,"sheetsExport":true}');

CREATE TABLE workspace_usage (
  workspace_id TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day, metric)
) WITHOUT ROWID;

-- GitHub App installations a workspace proved it owns (replaces the og_installation cookie).
CREATE TABLE workspace_github_installations (
  workspace_id TEXT NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, installation_id)
) WITHOUT ROWID;
INSERT INTO workspace_github_installations (workspace_id, installation_id, created_at)
  SELECT DISTINCT 'ws_initial', github_installation_id, '2026-10-10T00:00:00.000Z' FROM sites WHERE github_installation_id IS NOT NULL;
```

- [ ] **Step 2: Write the failing tests.** Create `packages/db/src/workspaces.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSite, listSitesForUser, setSiteWorkspace, siteForUser, upsertSite } from "./index.js";
import { addSiteInvites, chargeUsage, grantInvitedSites, INITIAL_WORKSPACE_ID, memberRole, memberSlotsUsed, setUpNewUser, workspaceForNewSession } from "./workspaces.js";
import { openSqliteD1 } from "./sqlite.js";
import type { D1Like } from "./d1.js";

const AT = "2026-10-10T00:00:00.000Z";

async function user(db: D1Like, id: string, email: string) {
  await db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`).bind(id, id, email, AT, AT).run();
}
async function member(db: D1Like, workspaceId: string, userId: string, role: string) {
  await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)`).bind(`m_${workspaceId}_${userId}`, workspaceId, userId, role, AT).run();
}
async function workspace(db: D1Like, id: string) {
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(id, id, id, AT).run();
}
async function site(db: D1Like, id: string, workspaceId: string) {
  await upsertSite(db, { id, name: `${id}.com`, baseUrl: `https://${id}.com`, createdAt: AT, updatedAt: AT, workspaceId });
}

describe("site roles", () => {
  it("gives owners and members every workspace site, clients only granted ones, and strangers nothing", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1"); await workspace(db, "w2");
    for (const [id, email] of [["o", "o@x"], ["m", "m@x"], ["c", "c@x"], ["s", "s@x"]] as const) await user(db, id, email);
    await member(db, "w1", "o", "owner"); await member(db, "w1", "m", "member"); await member(db, "w1", "c", "client"); await member(db, "w2", "s", "owner");
    await site(db, "a", "w1"); await site(db, "b", "w1");
    await db.prepare("INSERT INTO site_access (user_id, site_id, created_at) VALUES ('c', 'a', ?)").bind(AT).run();

    assert.equal((await siteForUser(db, "o", "a"))?.role, "owner");
    assert.equal((await siteForUser(db, "m", "b"))?.role, "member");
    assert.equal((await siteForUser(db, "c", "a"))?.role, "client");
    assert.equal(await siteForUser(db, "c", "b"), null, "client without a grant");
    assert.equal(await siteForUser(db, "s", "a"), null, "another workspace's owner");
    assert.equal(await siteForUser(db, "o", "missing"), null);
    assert.deepEqual((await listSitesForUser(db, "c", "w1")).map((s) => s.id), ["a"]);
    assert.deepEqual((await listSitesForUser(db, "m", "w1")).map((s) => s.id).sort(), ["a", "b"]);
  });

  it("keeps a site's workspace when the site is saved again", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1");
    await site(db, "a", "w1");
    await upsertSite(db, { id: "a", name: "renamed", baseUrl: "https://a.com", createdAt: AT, updatedAt: AT });
    assert.equal((await getSite(db, "a"))?.workspaceId, "w1");
    await workspace(db, "w2");
    await setSiteWorkspace(db, "a", "w2");
    assert.equal((await getSite(db, "a"))?.workspaceId, "w2");
  });
});

describe("new users", () => {
  it("gives a new user a workspace of their own, unless an invitation waits for them", async () => {
    const db = openSqliteD1();
    await user(db, "u", "u@x");
    await setUpNewUser(db, { id: "u", name: "Una", email: "u@x", emailVerified: true }, []);
    const workspaceId = await workspaceForNewSession(db, "u", []);
    assert.ok(workspaceId && workspaceId !== INITIAL_WORKSPACE_ID);
    assert.equal(await memberRole(db, workspaceId, "u"), "owner");

    await workspace(db, "w1"); await user(db, "inviter", "i@x");
    await db.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES ('inv', 'w1', 'V@x', 'client', 'pending', ?, ?, 'inviter')`).bind("2099-01-01T00:00:00.000Z", AT).run();
    await user(db, "v", "v@x");
    await setUpNewUser(db, { id: "v", name: "Vee", email: "v@x", emailVerified: true }, []);
    assert.equal(await workspaceForNewSession(db, "v", []), null, "no personal workspace while invited");
  });

  it("makes listed admins owners of the initial workspace, verified emails only", async () => {
    const db = openSqliteD1();
    await user(db, "a", "Boss@x");
    await setUpNewUser(db, { id: "a", name: "A", email: "Boss@x", emailVerified: true }, ["boss@x"]);
    assert.equal(await workspaceForNewSession(db, "a", ["boss@x"]), INITIAL_WORKSPACE_ID);
    assert.equal(await memberRole(db, INITIAL_WORKSPACE_ID, "a"), "owner");
    await user(db, "b", "boss2@x");
    await setUpNewUser(db, { id: "b", name: "B", email: "boss2@x", emailVerified: false }, ["boss2@x"]);
    assert.equal(await memberRole(db, INITIAL_WORKSPACE_ID, "b"), null);
  });

  it("copies an accepted client invitation's sites into the user's access", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1"); await user(db, "i", "i@x"); await user(db, "c", "c@x");
    await site(db, "a", "w1");
    await db.prepare(`INSERT INTO invitation (id, organizationId, email, role, status, expiresAt, createdAt, inviterId) VALUES ('inv', 'w1', 'c@x', 'client', 'pending', ?, ?, 'i')`).bind("2099-01-01T00:00:00.000Z", AT).run();
    await addSiteInvites(db, "inv", ["a"]);
    await member(db, "w1", "c", "client");
    await grantInvitedSites(db, "inv", "c");
    assert.equal((await siteForUser(db, "c", "a"))?.role, "client");
    assert.equal(await memberSlotsUsed(db, "w1"), 2, "the client plus the still-pending invitation row");
  });
});

describe("usage", () => {
  it("charges up to the limit and refuses past it, per day", async () => {
    const db = openSqliteD1();
    await workspace(db, "w1");
    const charge = (amount: number, day = "2026-10-10") => chargeUsage(db, { workspaceId: "w1", day, metric: "askPerDay", amount, limit: 3 });
    assert.equal(await charge(2), true);
    assert.equal(await charge(1), true);
    assert.equal(await charge(1), false);
    assert.equal(await charge(4, "2026-10-11"), false, "more than the limit at once");
    assert.equal(await charge(1, "2026-10-11"), true, "a new day");
    assert.equal(await chargeUsage(db, { workspaceId: "w1", day: "2026-10-10", metric: "askPerDay", amount: 50, limit: null }), true, "unlimited");
  });
});
```

- [ ] **Step 3: Run them and confirm they fail.** Run `npm test -w @organic-growth/db`. Expected: FAIL, because `./workspaces.js` is not found.

- [ ] **Step 4: Implement `SiteRecord.workspaceId` and the site queries.** In `packages/core/src/types.ts`, add this to `SiteRecord` after `reportShareVersion`:

```ts
  /** The workspace that owns the site; access is decided by membership in it. */
  workspaceId?: string;
```

In `packages/db/src/index.ts`:
- In `upsertSite`, add `workspace_id` as the last insert column, add one more `?` to `VALUES`, and bind `site.workspaceId ?? null` last. Do **not** add `workspace_id` to the `ON CONFLICT … DO UPDATE SET` list: a site never moves workspace by being saved.
- In `mapSite`, add `workspaceId: row.workspace_id ? String(row.workspace_id) : undefined,`.
- Add `export * from "./workspaces.js";` with the other re-exports.
- Append:

```ts
export type WorkspaceRole = "owner" | "member" | "client";

/** The site and the user's role on it: owners and members see their workspace's sites; clients only the ones granted to them. */
export async function siteForUser(db: D1Like, userId: string, siteId: string): Promise<{ site: SiteRecord; role: WorkspaceRole } | null> {
  const row = await db.prepare(
    `SELECT s.*, m.role AS member_role,
       EXISTS (SELECT 1 FROM site_access a WHERE a.user_id = m.userId AND a.site_id = s.id) AS granted
     FROM sites s JOIN member m ON m.organizationId = s.workspace_id AND m.userId = ?
     WHERE s.id = ?`,
  ).bind(userId, siteId).first<Record<string, unknown>>();
  if (!row) return null;
  const role = String(row.member_role);
  if (role === "owner" || role === "member") return { site: mapSite(row), role };
  if (role === "client" && Number(row.granted) === 1) return { site: mapSite(row), role: "client" };
  return null;
}

export async function listSitesForUser(db: D1Like, userId: string, workspaceId: string): Promise<SiteRecord[]> {
  const { results } = await db.prepare(
    `SELECT s.* FROM sites s JOIN member m ON m.organizationId = s.workspace_id AND m.userId = ?
     WHERE s.workspace_id = ?
       AND (m.role IN ('owner', 'member') OR EXISTS (SELECT 1 FROM site_access a WHERE a.user_id = m.userId AND a.site_id = s.id))
     ORDER BY s.updated_at DESC`,
  ).bind(userId, workspaceId).all<Record<string, unknown>>();
  return results.map(mapSite);
}

export async function countWorkspaceSites(db: D1Like, workspaceId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sites WHERE workspace_id = ?").bind(workspaceId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function setSiteWorkspace(db: D1Like, siteId: string, workspaceId: string): Promise<void> {
  await db.prepare("UPDATE sites SET workspace_id = ? WHERE id = ?").bind(workspaceId, siteId).run();
}

/** The site's own log token, once rotated; null while the derived token is still the one in use. Never part of SiteRecord, so it never reaches site lists. */
export async function getSiteLogToken(db: D1Like, siteId: string): Promise<string | null> {
  const row = await db.prepare("SELECT log_token FROM sites WHERE id = ?").bind(siteId).first<{ log_token: string | null }>();
  return row?.log_token ?? null;
}

export async function setSiteLogToken(db: D1Like, siteId: string, token: string): Promise<void> {
  await db.prepare("UPDATE sites SET log_token = ? WHERE id = ?").bind(token, siteId).run();
}
```

- [ ] **Step 5: Implement `workspaces.ts`.** Create `packages/db/src/workspaces.ts`:

```ts
import { createId } from "@organic-growth/core";
import { nowIso, type D1Like } from "./d1.js";
import type { WorkspaceRole } from "./index.js";

/*
 * Workspaces are Better Auth organizations; this module reads and writes their
 * tables directly where Eumon needs more than Better Auth's API gives:
 * setting up new users, client site grants, limits, usage, and GitHub installations.
 */

export const INITIAL_WORKSPACE_ID = "ws_initial";

const isAdmin = (email: string, adminEmails: string[]) => adminEmails.includes(email.trim().toLowerCase());

export async function memberRole(db: D1Like, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const row = await db.prepare(`SELECT role FROM member WHERE organizationId = ? AND userId = ?`).bind(workspaceId, userId).first<{ role: string }>();
  return row && ["owner", "member", "client"].includes(row.role) ? row.role as WorkspaceRole : null;
}

async function addMember(db: D1Like, workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await db.prepare(
    `INSERT INTO member (id, organizationId, userId, role, createdAt)
     SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM member WHERE organizationId = ? AND userId = ?)`,
  ).bind(createId("mem"), workspaceId, userId, role, nowIso(), workspaceId, userId).run();
}

/**
 * Runs once when Better Auth creates a user. A listed admin with a verified email
 * joins the initial workspace as owner; anyone else gets a workspace of their own,
 * unless an invitation is waiting for their email (they join that one instead).
 */
export async function setUpNewUser(db: D1Like, user: { id: string; name: string; email: string; emailVerified: boolean }, adminEmails: string[]): Promise<void> {
  if (user.emailVerified && isAdmin(user.email, adminEmails)) {
    await addMember(db, INITIAL_WORKSPACE_ID, user.id, "owner");
    return;
  }
  const invited = await db.prepare(`SELECT 1 AS yes FROM invitation WHERE lower(email) = lower(?) AND status = 'pending' LIMIT 1`).bind(user.email).first();
  if (invited) return;
  const id = createId("ws");
  const name = `${(user.name || user.email.split("@")[0] || "My").trim().slice(0, 60)}'s workspace`;
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)`).bind(id, name, id, nowIso()).run();
  await addMember(db, id, user.id, "owner");
}

/** The workspace a new session opens in: the initial one for admins (joining it if the list grew since sign-up), else the user's first. */
export async function workspaceForNewSession(db: D1Like, userId: string, adminEmails: string[]): Promise<string | null> {
  const user = await db.prepare(`SELECT email, emailVerified FROM "user" WHERE id = ?`).bind(userId).first<{ email: string; emailVerified: number }>();
  if (user && Number(user.emailVerified) === 1 && isAdmin(user.email, adminEmails)) {
    await addMember(db, INITIAL_WORKSPACE_ID, userId, "owner");
    return INITIAL_WORKSPACE_ID;
  }
  const row = await db.prepare(`SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1`).bind(userId).first<{ organizationId: string }>();
  return row?.organizationId ?? null;
}

export async function addSiteInvites(db: D1Like, invitationId: string, siteIds: string[]): Promise<void> {
  for (const siteId of siteIds) {
    await db.prepare(`INSERT OR IGNORE INTO site_access_invites (invitation_id, site_id) VALUES (?, ?)`).bind(invitationId, siteId).run();
  }
}

export async function grantInvitedSites(db: D1Like, invitationId: string, userId: string): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO site_access (user_id, site_id, created_at) SELECT ?, site_id, ? FROM site_access_invites WHERE invitation_id = ?`,
  ).bind(userId, nowIso(), invitationId).run();
}

/** Members (any role) plus invitations still pending: what the members limit counts. */
export async function memberSlotsUsed(db: D1Like, workspaceId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM member WHERE organizationId = ?) + (SELECT COUNT(*) FROM invitation WHERE organizationId = ? AND status = 'pending') AS n`,
  ).bind(workspaceId, workspaceId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * Adds `amount` to today's counter unless that would pass `limit` (null: no limit).
 * One upsert: the conflict branch only updates while the total stays within the limit,
 * and RETURNING yields no row when it doesn't.
 */
export async function chargeUsage(db: D1Like, input: { workspaceId: string; day: string; metric: string; amount: number; limit: number | null }): Promise<boolean> {
  const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
  if (input.amount > limit) return false;
  const row = await db.prepare(
    `INSERT INTO workspace_usage (workspace_id, day, metric, count) VALUES (?, ?, ?, ?)
     ON CONFLICT (workspace_id, day, metric) DO UPDATE SET count = count + excluded.count WHERE count + excluded.count <= ?
     RETURNING count`,
  ).bind(input.workspaceId, input.day, input.metric, input.amount, limit).first<{ count: number }>();
  return Boolean(row);
}

export async function getLimitOverrides(db: D1Like, workspaceId: string): Promise<Record<string, unknown>> {
  const row = await db.prepare(`SELECT limits_json FROM workspace_limits WHERE workspace_id = ?`).bind(workspaceId).first<{ limits_json: string }>();
  return row ? JSON.parse(row.limits_json) as Record<string, unknown> : {};
}

export async function setLimitOverrides(db: D1Like, workspaceId: string, overrides: Record<string, unknown>): Promise<void> {
  await db.prepare(
    `INSERT INTO workspace_limits (workspace_id, limits_json) VALUES (?, ?) ON CONFLICT (workspace_id) DO UPDATE SET limits_json = excluded.limits_json`,
  ).bind(workspaceId, JSON.stringify(overrides)).run();
}

export async function listWorkspacesForAdmin(db: D1Like, day: string): Promise<Array<{ id: string; name: string; createdAt: string; sites: number; members: number; usage: Record<string, number>; overrides: Record<string, unknown> }>> {
  const { results } = await db.prepare(
    `SELECT o.id, o.name, o.createdAt,
       (SELECT COUNT(*) FROM sites s WHERE s.workspace_id = o.id) AS sites,
       (SELECT COUNT(*) FROM member m WHERE m.organizationId = o.id) AS members,
       (SELECT limits_json FROM workspace_limits l WHERE l.workspace_id = o.id) AS limits_json
     FROM organization o ORDER BY o.createdAt DESC`,
  ).all<{ id: string; name: string; createdAt: string; sites: number; members: number; limits_json: string | null }>();
  const { results: usage } = await db.prepare(`SELECT workspace_id, metric, count FROM workspace_usage WHERE day = ?`).bind(day).all<{ workspace_id: string; metric: string; count: number }>();
  return results.map((row) => ({
    id: row.id, name: row.name, createdAt: String(row.createdAt), sites: Number(row.sites), members: Number(row.members),
    usage: Object.fromEntries(usage.filter((u) => u.workspace_id === row.id).map((u) => [u.metric, Number(u.count)])),
    overrides: row.limits_json ? JSON.parse(row.limits_json) as Record<string, unknown> : {},
  }));
}

export async function addGithubInstallation(db: D1Like, workspaceId: string, installationId: string): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO workspace_github_installations (workspace_id, installation_id, created_at) VALUES (?, ?, ?)`).bind(workspaceId, installationId, nowIso()).run();
}

export async function listGithubInstallations(db: D1Like, workspaceId: string): Promise<string[]> {
  const { results } = await db.prepare(`SELECT installation_id FROM workspace_github_installations WHERE workspace_id = ? ORDER BY created_at`).bind(workspaceId).all<{ installation_id: string }>();
  return results.map((row) => row.installation_id);
}
```

Add `"@organic-growth/core"` to `packages/db/package.json` dependencies if it is not already there (it is: `index.ts` imports it).

- [ ] **Step 6: Run the tests and confirm they pass.** Run `npm test -w @organic-growth/db`. Expected: PASS, including every existing db test, now that `0024` is applied by `openSqliteD1`. If an existing test fails because a site now has no workspace, that is expected only for tests that call `siteForUser`; none should.

- [ ] **Step 7: Check that existing sites move.** Run this in the worktree root:

```bash
node -e '
const { DatabaseSync } = require("node:sqlite"); const fs = require("fs");
const db = new DatabaseSync(":memory:"); const dir = "packages/db/migrations/";
const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
for (const f of files.filter(f => f < "0024")) db.exec(fs.readFileSync(dir + f, "utf8"));
db.exec("INSERT INTO sites (id,name,base_url,github_installation_id,created_at,updated_at) VALUES (\"s1\",\"a\",\"https://a.com\",\"77\",\"t\",\"t\")");
for (const f of files.filter(f => f >= "0024")) db.exec(fs.readFileSync(dir + f, "utf8"));
console.log(db.prepare("SELECT workspace_id FROM sites").get(), db.prepare("SELECT * FROM workspace_github_installations").get());'
```

Expected: `{ workspace_id: 'ws_initial' }` and an installation row `77` for `ws_initial`.

- [ ] **Step 8: Commit.**

```bash
git add packages/db packages/core/src/types.ts
git commit -m "Accounts schema (Better Auth + workspaces), site roles, usage and limits storage"
```

### Task 6: Role rules and ID resolvers

**Files:**
- Create: `apps/web/src/access.ts`
- Test: `apps/web/src/access.test.ts`

**Interfaces:**
- Consumes: `siteForUser`, `WorkspaceRole` from `@organic-growth/db`.
- Produces:
  - `type Need = "read" | "write" | "admin"`
  - `allows(role: WorkspaceRole, need: Need): boolean`
  - `type OwnedKind = "analysis" | "change" | "job" | "record" | "dataset" | "source" | "template" | "page"`
  - `resolveSiteId(db: D1Like, kind: OwnedKind, id: string): Promise<string | null>`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/access.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { siteForUser, upsertDataset, upsertSite, upsertRecords, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { allows, resolveSiteId } from "./access.ts";

const AT = "2026-10-10T00:00:00.000Z";

describe("allows", () => {
  it("lets owners do anything, members everything but admin, clients only read", () => {
    const table = { owner: [true, true, true], member: [true, true, false], client: [true, false, false] } as const;
    for (const [role, expected] of Object.entries(table)) {
      assert.deepEqual((["read", "write", "admin"] as const).map((need) => allows(role as "owner", need)), expected, role);
    }
  });
});

describe("resolveSiteId", () => {
  it("finds the owning site for each ID kind, and null for unknown ids", async () => {
    const db: D1Like = openSqliteD1();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT });
    await upsertDataset(db, { id: "d", siteId: "s", name: "Doctors", entityType: "doctor", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT, fields: [{ key: "name", label: "Name", type: "text", required: true }] });
    await upsertRecords(db, { siteId: "s", datasetId: "d" }, [{ key: "a", data: { name: "A" } }]);
    const recordId = (await db.prepare("SELECT id FROM data_records LIMIT 1").first<{ id: string }>())!.id;
    assert.equal(await resolveSiteId(db, "dataset", "d"), "s");
    assert.equal(await resolveSiteId(db, "record", recordId), "s");
    assert.equal(await resolveSiteId(db, "analysis", "nope"), null);
  });

  it("a client's ID-keyed request resolves to a site the client can only read", async () => {
    const db: D1Like = openSqliteD1();
    await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(AT).run();
    await db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('c', 'c', 'c@x', 1, ?, ?)`).bind(AT, AT).run();
    await db.prepare(`INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m', 'w', 'c', 'client', ?)`).bind(AT).run();
    await upsertSite(db, { id: "s", name: "x.com", baseUrl: "https://x.com", createdAt: AT, updatedAt: AT, workspaceId: "w" });
    await db.prepare("INSERT INTO site_access (user_id, site_id, created_at) VALUES ('c', 's', ?)").bind(AT).run();
    await upsertDataset(db, { id: "d", siteId: "s", name: "D", entityType: "x", description: "", keyField: "name", status: "active", pageIdeas: [], createdAt: AT, updatedAt: AT, fields: [{ key: "name", label: "Name", type: "text", required: true }] });
    const found = await siteForUser(db, "c", (await resolveSiteId(db, "dataset", "d"))!);
    assert.equal(found?.role, "client");
    assert.equal(allows(found!.role, "write"), false, "a client can't delete a dataset by its id");
  });
});
```

Check the `upsertRecords` signature first with `grep -n "export async function upsertRecords" -A4 packages/db/src/page-engine.ts`, and adjust the call to match it. The test only needs one `data_records` row.

- [ ] **Step 2: Run it and confirm it fails.** Run `npm run build:packages && cd apps/web && node --test src/access.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement.** Create `apps/web/src/access.ts`:

```ts
import type { D1Like, WorkspaceRole } from "@organic-growth/db";

export type Need = "read" | "write" | "admin";

/** Owners do anything; members everything but workspace administration; clients only read. */
export function allows(role: WorkspaceRole, need: Need): boolean {
  if (role === "owner") return true;
  if (role === "member") return need !== "admin";
  return need === "read";
}

/** Every table a route can name a row of by ID; each carries its site. */
const OWNER_TABLES = {
  analysis: "analyses",
  change: "changes",
  job: "jobs",
  record: "data_records",
  dataset: "datasets",
  source: "data_sources",
  template: "page_templates",
  page: "generated_pages",
} as const;

export type OwnedKind = keyof typeof OWNER_TABLES;

export async function resolveSiteId(db: D1Like, kind: OwnedKind, id: string): Promise<string | null> {
  const row = await db.prepare(`SELECT site_id FROM ${OWNER_TABLES[kind]} WHERE id = ?`).bind(id).first<{ site_id: string }>();
  return row?.site_id ?? null;
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `cd apps/web && node --test src/access.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/access.ts apps/web/src/access.test.ts
git commit -m "Role rules and site resolution for ID-keyed routes"
```

### Task 7: Free limits

**Files:**
- Create: `apps/web/src/limits.ts`
- Test: `apps/web/src/limits.test.ts`

**Interfaces:**
- Consumes: `chargeUsage`, `getLimitOverrides` from `@organic-growth/db`; `SignalKeys` from `./results-sync.ts`.
- Produces:
  - `type Limits = { sites: number | null; analysesPerDay: number | null; scrapePagesPerDay: number | null; askPerDay: number | null; aiRunsPerDay: number | null; members: number | null; dataForSeo: boolean; pullRequests: boolean; sheetsExport: boolean }`
  - `FREE_LIMITS: Limits`
  - `limitsFor(db, workspaceId): Promise<Limits>`
  - `type Metered = "analysesPerDay" | "scrapePagesPerDay" | "askPerDay" | "aiRunsPerDay"`
  - `charge(db, workspaceId, metric: Metered, amount?: number, now?: Date): Promise<string | null>` (null means allowed; a string is the refusal message)
  - `type Feature = "dataForSeo" | "pullRequests" | "sheetsExport"`
  - `featureRefusal(db, workspaceId, feature: Feature): Promise<string | null>`
  - `keysForLimits(keys: SignalKeys, limits: Limits): SignalKeys`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/limits.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INITIAL_WORKSPACE_ID, setLimitOverrides, type D1Like } from "@organic-growth/db";
import { openSqliteD1 } from "@organic-growth/db/sqlite";
import { charge, featureRefusal, FREE_LIMITS, keysForLimits, limitsFor } from "./limits.ts";

const AT = "2026-10-10T00:00:00.000Z";
async function db(): Promise<D1Like> {
  const db = openSqliteD1();
  await db.prepare(`INSERT INTO organization (id, name, slug, createdAt) VALUES ('w', 'w', 'w', ?)`).bind(AT).run();
  return db;
}

describe("limits", () => {
  it("applies the free limits until an override says otherwise", async () => {
    const d = await db();
    assert.deepEqual(await limitsFor(d, "w"), FREE_LIMITS);
    await setLimitOverrides(d, "w", { askPerDay: 100, dataForSeo: true });
    assert.equal((await limitsFor(d, "w")).askPerDay, 100);
    assert.equal((await limitsFor(d, "w")).sites, FREE_LIMITS.sites);
  });

  it("refuses the 21st question of a day with a message, and the initial workspace never", async () => {
    const d = await db();
    const now = new Date(AT);
    for (let i = 0; i < 20; i++) assert.equal(await charge(d, "w", "askPerDay", 1, now), null);
    assert.match((await charge(d, "w", "askPerDay", 1, now))!, /20 .*resets at midnight UTC/);
    for (let i = 0; i < 50; i++) assert.equal(await charge(d, INITIAL_WORKSPACE_ID, "askPerDay", 1, now), null);
  });

  it("keeps paid features off for free workspaces", async () => {
    const d = await db();
    assert.match((await featureRefusal(d, "w", "pullRequests"))!, /pull requests/i);
    assert.equal(await featureRefusal(d, INITIAL_WORKSPACE_ID, "pullRequests"), null);
  });

  it("drops the DataForSEO credentials for a workspace without DataForSEO", () => {
    const keys = { googleApiKey: "g", dataForSeo: { login: "l", password: "p" } };
    assert.equal(keysForLimits(keys, FREE_LIMITS).dataForSeo, undefined);
    assert.equal(keysForLimits(keys, FREE_LIMITS).googleApiKey, "g");
    assert.deepEqual(keysForLimits(keys, { ...FREE_LIMITS, dataForSeo: true }).dataForSeo, keys.dataForSeo);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/limits.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement.** Create `apps/web/src/limits.ts`:

```ts
import { chargeUsage, getLimitOverrides, type D1Like } from "@organic-growth/db";
import type { SignalKeys } from "./results-sync.ts";

/** What a workspace may do. A null number is unlimited. */
export type Limits = {
  sites: number | null;
  analysesPerDay: number | null;
  scrapePagesPerDay: number | null;
  askPerDay: number | null;
  aiRunsPerDay: number | null;
  members: number | null;
  dataForSeo: boolean;
  pullRequests: boolean;
  sheetsExport: boolean;
};

/** Every new workspace starts here; /admin raises a workspace's limits. */
export const FREE_LIMITS: Limits = {
  sites: 1, analysesPerDay: 3, scrapePagesPerDay: 500, askPerDay: 20, aiRunsPerDay: 10, members: 3,
  dataForSeo: false, pullRequests: false, sheetsExport: false,
};

export async function limitsFor(db: D1Like, workspaceId: string): Promise<Limits> {
  return { ...FREE_LIMITS, ...(await getLimitOverrides(db, workspaceId)) as Partial<Limits> };
}

export type Metered = "analysesPerDay" | "scrapePagesPerDay" | "askPerDay" | "aiRunsPerDay";
const METERED_LABEL: Record<Metered, string> = {
  analysesPerDay: "analyses", scrapePagesPerDay: "scraped pages", askPerDay: "questions to Ask Eumon", aiRunsPerDay: "AI writing runs",
};

/** Counts `amount` against today's allowance; null when allowed, else the message to show. */
export async function charge(db: D1Like, workspaceId: string, metric: Metered, amount = 1, now = new Date()): Promise<string | null> {
  const limit = (await limitsFor(db, workspaceId))[metric];
  const ok = await chargeUsage(db, { workspaceId, day: now.toISOString().slice(0, 10), metric, amount, limit });
  return ok ? null : `Your workspace has used today's ${limit} ${METERED_LABEL[metric]}. The allowance resets at midnight UTC.`;
}

export type Feature = "dataForSeo" | "pullRequests" | "sheetsExport";
const FEATURE_LABEL: Record<Feature, string> = { dataForSeo: "keyword data", pullRequests: "pull requests", sheetsExport: "Google Sheets export" };

export async function featureRefusal(db: D1Like, workspaceId: string, feature: Feature): Promise<string | null> {
  return (await limitsFor(db, workspaceId))[feature] ? null : `This workspace's plan doesn't include ${FEATURE_LABEL[feature]} yet.`;
}

/** The sync's API keys for a workspace: DataForSEO only where the workspace may spend it. */
export function keysForLimits(keys: SignalKeys, limits: Limits): SignalKeys {
  return limits.dataForSeo ? keys : { ...keys, dataForSeo: undefined };
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `cd apps/web && node --test src/limits.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/limits.ts apps/web/src/limits.test.ts
git commit -m "Free per-workspace limits with daily usage"
```

### Task 8: Better Auth configuration and PBKDF2 passwords

**Files:**
- Create: `apps/web/src/passwords.ts`, `apps/web/src/passwords.test.ts`
- Create: `apps/web/src/auth.ts`
- Modify: `apps/web/package.json` (`better-auth` pinned to `1.7.7`; it is already installed in the worktree, so check that the entry says exactly `"1.7.7"` and not `^1.7.7`)

**Interfaces:**
- Consumes: `setUpNewUser`, `workspaceForNewSession`, `grantInvitedSites`, `memberSlotsUsed` (Task 5); `limitsFor` (Task 7).
- Produces:
  - `hashPassword(password: string): Promise<string>`
  - `verifyPassword(input: { hash: string; password: string }): Promise<boolean>`
  - `type AuthEnv`
  - `createAuth(env: AuthEnv)`
  - `authFor(env: AuthEnv)` (memoized per isolate)
  - `adminEmails(env: Pick<AuthEnv, "BOOTSTRAP_OWNER_EMAIL">): string[]`
  - `type Auth = ReturnType<typeof createAuth>`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/passwords.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashPassword, verifyPassword } from "./passwords.ts";

describe("passwords", () => {
  it("verifies the right password only, with a fresh salt each time", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.match(hash, /^pbkdf2-sha256\$100000\$/);
    assert.equal(await verifyPassword({ hash, password: "correct horse battery staple" }), true);
    assert.equal(await verifyPassword({ hash, password: "wrong" }), false);
    assert.notEqual(await hashPassword("same"), await hashPassword("same"));
    assert.equal(await verifyPassword({ hash: "garbage", password: "x" }), false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/passwords.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `passwords.ts`.**

```ts
import { sameSecret } from "@organic-growth/core";

/*
 * Password hashing with WebCrypto PBKDF2-SHA256 at 100,000 iterations (the most Workers
 * allows). Better Auth's default scrypt runs in JavaScript and is far slower on Workers.
 * Even this exceeds the Free plan's 10 ms CPU limit, which is why password sign-in ships
 * off (PASSWORD_SIGNIN) until the paid plan.
 */
const ITERATIONS = 100_000;
const encoder = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const [scheme, iterations, salt, expected] = hash.split("$");
  if (scheme !== "pbkdf2-sha256" || !iterations || !salt || !expected) return false;
  try {
    return sameSecret(b64(await derive(password, unb64(salt), Number(iterations))), expected);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `cd apps/web && node --test src/passwords.test.ts`. Expected: PASS.

- [ ] **Step 5: Implement `auth.ts`.** This file must not import `cloudflare:workers`: `worker.ts` passes `env` in. The `AuthEnv` type is spelled out so this file is independent of `cloudflare.config.ts`.

```ts
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { captcha, magicLink, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { grantInvitedSites, memberSlotsUsed, setUpNewUser, workspaceForNewSession, type D1Like } from "@organic-growth/db";
import { limitsFor } from "./limits.ts";
import { hashPassword, verifyPassword } from "./passwords.ts";

export type AuthEnv = {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  BOOTSTRAP_OWNER_EMAIL: string;
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  EMAIL_ENABLED?: string;
  PASSWORD_SIGNIN?: string;
};

export const adminEmails = (env: Pick<AuthEnv, "BOOTSTRAP_OWNER_EMAIL">) =>
  (env.BOOTSTRAP_OWNER_EMAIL ?? "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);

export const emailEnabled = (env: Pick<AuthEnv, "EMAIL_ENABLED">) => env.EMAIL_ENABLED === "true";
/** Password sign-up needs email verification, so it is only on when email is. */
export const passwordEnabled = (env: Pick<AuthEnv, "EMAIL_ENABLED" | "PASSWORD_SIGNIN">) => emailEnabled(env) && env.PASSWORD_SIGNIN === "true";

/** Sends through Cloudflare Email Service when enabled (Workers Paid); otherwise writes the message to the log, which is how local dev reads links. */
async function deliver(env: AuthEnv, to: string, subject: string, text: string): Promise<void> {
  if (!emailEnabled(env) || !env.EMAIL || !env.EMAIL_FROM) {
    console.log(`[email to ${to}] ${subject}\n${text}`);
    return;
  }
  await env.EMAIL.send({ from: env.EMAIL_FROM, to, subject, text });
}

/** Clients read only: no organization, member, or invitation permissions. */
const ac = createAccessControl(defaultStatements);
const roles = {
  owner: ac.newRole(ownerAc.statements),
  member: ac.newRole(memberAc.statements),
  client: ac.newRole({}),
};

export function createAuth(env: AuthEnv) {
  const db = env.DB as unknown as D1Like;
  const admins = adminEmails(env);
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: passwordEnabled(env),
      requireEmailVerification: true,
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: async ({ user, url }) => deliver(env, user.email, "Reset your Eumon password", `Choose a new password here: ${url}`),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => deliver(env, user.email, "Confirm your email for Eumon", `Confirm your email here: ${url}`),
    },
    socialProviders: { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      // D1 is on the free plan: re-check the session in D1 at most every 5 minutes, and extend it at most daily.
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    databaseHooks: {
      user: { create: { after: async (user) => { await setUpNewUser(db, user, admins); } } },
      session: {
        create: {
          before: async (session) => ({ data: { ...session, activeOrganizationId: await workspaceForNewSession(db, session.userId, admins) } }),
        },
      },
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "owner",
        // One workspace per user, so free limits can't be multiplied.
        organizationLimit: 1,
        sendInvitationEmail: async ({ email, id, organization: workspace }, request) => {
          const origin = request ? new URL(request.url).origin : "";
          await deliver(env, email, `Join ${workspace.name} on Eumon`, `Accept the invitation here: ${origin}/invite/${id}`);
        },
        organizationHooks: {
          beforeCreateInvitation: async ({ invitation }) => {
            const limit = (await limitsFor(db, invitation.organizationId)).members;
            if (limit !== null && (await memberSlotsUsed(db, invitation.organizationId)) >= limit) {
              throw new APIError("FORBIDDEN", { message: `This workspace has room for ${limit} people. Remove someone first, or ask for more.` });
            }
          },
          afterAcceptInvitation: async ({ invitation, user }) => {
            await grantInvitedSites(db, invitation.id, user.id);
          },
        },
      }),
      ...(emailEnabled(env) ? [magicLink({ sendMagicLink: async ({ email, url }) => deliver(env, email, "Your Eumon sign-in link", `Sign in here: ${url}`) })] : []),
      captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: { env: AuthEnv; auth: Auth } | null = null;
/** One Better Auth instance per isolate (env is the same object for an isolate's lifetime). */
export function authFor(env: AuthEnv): Auth {
  if (cached?.env !== env) cached = { env, auth: createAuth(env) };
  return cached.auth;
}
```

- [ ] **Step 6: Typecheck against the installed Better Auth.** Run `cd apps/web && npx tsc --noEmit -p . 2>&1 | grep -E "src/(auth|passwords)\.ts" | head -20`. Fix errors by checking the signatures under `node_modules/better-auth/dist`:
  - `grep -rn "sendInvitationEmail" node_modules/better-auth/dist/plugins/organization/*.d.mts`
  - `grep -rn "cloudflare-turnstile" node_modules/better-auth/dist/plugins/captcha/*.d.mts`
  - If `ac.newRole({})` is rejected, use `ac.newRole({ organization: [], member: [], invitation: [] })`.
  - If the `SendEmail` type's `send` takes a builder rather than an object, follow `node_modules/@cloudflare/workers-types` (`grep -n "interface SendEmail" -A12`).

  Expected: no errors in these two files. Errors elsewhere predate this work and are unchanged.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/auth.ts apps/web/src/passwords.ts apps/web/src/passwords.test.ts apps/web/package.json package-lock.json
git commit -m "Better Auth: Google, flagged magic link and passwords (PBKDF2), workspaces with client role"
```

### Task 9: Route guards and the guarded-routes test

**Files:**
- Create: `apps/web/src/guard.ts`
- Create: `apps/web/src/routes-guarded.test.ts`

**Interfaces:**
- Consumes: `authFor`, `adminEmails` (Task 8); `allows`, `resolveSiteId`, `Need`, `OwnedKind` (Task 6); `siteForUser`, `memberRole` (Task 5).
- Produces:
  - `type Viewer = { userId: string; email: string; emailVerified: boolean; workspaceId: string | null }`
  - `viewer(request): Promise<Viewer | null>`
  - `requireViewer(request): Promise<Viewer | Response>`
  - `requireSite(request, siteId, need: Need): Promise<{ viewer: Viewer; site: SiteRecord; role: WorkspaceRole } | Response>`
  - `requireOwned(request, kind: OwnedKind, id, need): Promise<{ viewer: Viewer; site: SiteRecord; role: WorkspaceRole } | Response>`
  - `requireWorkspace(request, need: Need): Promise<{ viewer: Viewer & { workspaceId: string }; role: WorkspaceRole } | Response>`
  - `requirePlatformAdmin(request): Promise<Viewer | Response>`

- [ ] **Step 1: Write the test.** It fails now, and later tasks make it pass. Create `apps/web/src/routes-guarded.test.ts`:

```ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

/** Routes the gate leaves public; each authenticates its own way (a token, a signed link, OAuth state). */
const PUBLIC = new Set(["sites/[siteId]/events/route.ts", "r/[token]/route.ts", "logs/[siteId]/route.ts"]);
const GUARD = /\brequire(Site|Owned|Workspace|Viewer|PlatformAdmin)\(/;
const root = new URL("../app/api/", import.meta.url).pathname;

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === "route.ts" ? [path] : [];
  });
}

describe("every API handler checks who is asking", () => {
  for (const file of routes(root)) {
    const name = relative(root, file);
    if (PUBLIC.has(name)) continue;
    it(name, () => {
      const handlers = readFileSync(file, "utf8").split(/(?=export async function (?:GET|POST|PUT|PATCH|DELETE)\b)/).slice(1);
      assert.ok(handlers.length, "exports a handler");
      for (const handler of handlers) assert.match(handler, GUARD, handler.slice(0, 60));
    });
  }
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/routes-guarded.test.ts`. Expected: FAIL on almost every route. Tasks 11-13 and 17-19 turn it green.

- [ ] **Step 3: Implement `guard.ts`.**

```ts
import { env } from "cloudflare:workers";
import type { SiteRecord } from "@organic-growth/core";
import { memberRole, siteForUser, type WorkspaceRole } from "@organic-growth/db";
import { allows, resolveSiteId, type Need, type OwnedKind } from "./access";
import { adminEmails, authFor } from "./auth";
import { fail } from "./server";

/*
 * Who is asking, and may they? Every API route calls one of these first.
 * The session comes from Better Auth's signed cookie cache, so most calls read nothing from D1.
 */

export type Viewer = { userId: string; email: string; emailVerified: boolean; workspaceId: string | null };
type SiteAccess = { viewer: Viewer; site: SiteRecord; role: WorkspaceRole };

export async function viewer(request: Request): Promise<Viewer | null> {
  const session = await authFor(env).api.getSession({ headers: request.headers });
  if (!session) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    workspaceId: (session.session as { activeOrganizationId?: string | null }).activeOrganizationId ?? null,
  };
}

export async function requireViewer(request: Request): Promise<Viewer | Response> {
  return (await viewer(request)) ?? fail("Sign in to continue.", 401);
}

/** A site the viewer can't see answers 404, the same as a missing one. */
export async function requireSite(request: Request, siteId: string, need: Need): Promise<SiteAccess | Response> {
  const who = await viewer(request);
  if (!who) return fail("Sign in to continue.", 401);
  const found = await siteForUser(env.DB, who.userId, siteId);
  if (!found) return fail("Site not found.", 404);
  if (!allows(found.role, need)) return fail("Your role in this workspace can't make this change.", 403);
  return { viewer: who, site: found.site, role: found.role };
}

export async function requireOwned(request: Request, kind: OwnedKind, id: string, need: Need): Promise<SiteAccess | Response> {
  const siteId = await resolveSiteId(env.DB, kind, id);
  if (!siteId) return fail("Not found.", 404);
  return requireSite(request, siteId, need);
}

/** The viewer's active workspace and their role in it. */
export async function requireWorkspace(request: Request, need: Need): Promise<{ viewer: Viewer & { workspaceId: string }; role: WorkspaceRole } | Response> {
  const who = await viewer(request);
  if (!who) return fail("Sign in to continue.", 401);
  if (!who.workspaceId) return fail("Choose a workspace first.", 409);
  const role = await memberRole(env.DB, who.workspaceId, who.userId);
  if (!role) return fail("You're no longer a member of this workspace. Sign in again.", 403);
  if (!allows(role, need)) return fail("Your role in this workspace can't make this change.", 403);
  return { viewer: { ...who, workspaceId: who.workspaceId }, role };
}

/** People listed in BOOTSTRAP_OWNER_EMAIL with a verified email: the /admin page. */
export async function requirePlatformAdmin(request: Request): Promise<Viewer | Response> {
  const who = await viewer(request);
  if (!who) return fail("Sign in to continue.", 401);
  if (!who.emailVerified || !adminEmails(env).includes(who.email.toLowerCase())) return fail("Not found.", 404);
  return who;
}
```

- [ ] **Step 4: Commit.** The guard test stays red until the routes are converted; that's intended.

```bash
git add apps/web/src/guard.ts apps/web/src/routes-guarded.test.ts
git commit -m "Route guards, and a test that every API handler uses one"
```

### Task 10: The gate in worker.ts, auth endpoints, configuration

**Files:**
- Create: `apps/web/src/gate.ts`, `apps/web/src/gate.test.ts`
- Modify: `apps/web/worker.ts`
- Modify: `apps/web/cloudflare.config.ts` (secrets and bindings)
- Modify: `apps/web/.dev.vars.example`

**Interfaces:**
- Consumes: `authFor` (Task 8); `withHeaders`, `APP_HEADERS` (Task 4).
- Produces:
  - `isPublicPath(path: string): boolean`
  - `gate(request: Request, signedIn: boolean): Response | null`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/gate.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gate, isPublicPath } from "./gate.ts";

const req = (path: string, init: RequestInit = {}) => new Request(`https://app.eumon.test${path}`, init);

describe("gate", () => {
  it("lets public paths through without a session", () => {
    for (const path of ["/p/site_1/doctors/tan", "/api/sites/site_1/events", "/r/abc", "/api/r/abc", "/api/logs/site_1", "/api/auth/sign-in/social", "/sign-in", "/invite/inv_1", "/manifest.json", "/sw.js", "/sw-register.js", "/assets/app.js", "/icon-192.png"]) {
      assert.equal(isPublicPath(path), true, path);
      assert.equal(gate(req(path, { method: path.startsWith("/api/") ? "POST" : "GET", headers: { origin: "https://elsewhere.test" } }), false), null, path);
    }
  });

  it("keeps everything else behind sign-in", async () => {
    for (const path of ["/", "/admin", "/api/sites", "/api/sites/site_1/events/recent", "/api/sites/site_1/events/summary", "/api/dev/demo-site"]) assert.equal(isPublicPath(path), false, path);
    const api = gate(req("/api/sites"), false)!;
    assert.equal(api.status, 401);
    assert.match((await api.json() as { error: string }).error, /Sign in/);
    const page = gate(req("/?view=setup"), false)!;
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "https://app.eumon.test/sign-in?next=%2F%3Fview%3Dsetup");
    assert.equal(gate(req("/api/sites"), true), null);
  });

  it("refuses cross-site writes from signed-in browsers", () => {
    assert.equal(gate(req("/api/sites", { method: "POST", headers: { origin: "https://evil.test" } }), true)?.status, 403);
    assert.equal(gate(req("/api/sites", { method: "POST" }), true)?.status, 403, "no Origin on a write");
    assert.equal(gate(req("/api/sites", { method: "POST", headers: { origin: "https://app.eumon.test" } }), true), null);
    assert.equal(gate(req("/api/sites", { method: "GET", headers: { origin: "https://evil.test" } }), true), null, "reads are not writes");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/gate.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `gate.ts`.**

```ts
/*
 * The first check on every request, before any route runs: public paths pass,
 * everything else needs a signed-in session, and signed-in writes must come from
 * Eumon's own pages. A route someone forgets to guard is still not public.
 */

const PUBLIC: RegExp[] = [
  /^\/p\//, // landing pages, their sitemap, and the analytics beacon
  /^\/api\/sites\/[^/]+\/events$/, // conversion events from customer sites
  /^\/r\//, /^\/api\/r\//, // client Results links (signed, revocable tokens)
  /^\/api\/logs\//, // log ingest (per-site token)
  /^\/api\/auth\//, // Better Auth's own endpoints
  /^\/sign-in(\/|$|\.)/, /^\/invite\//,
  /^\/(manifest\.json|sw\.js|sw-register\.js|favicon\.ico|robots\.txt)$/, /^\/icon-[\w-]+\.png$/, /^\/assets\//,
];

export const isPublicPath = (path: string) => PUBLIC.some((pattern) => pattern.test(path));

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function gate(request: Request, signedIn: boolean): Response | null {
  const url = new URL(request.url);
  if (isPublicPath(url.pathname)) return null;
  if (!signedIn) {
    if (url.pathname.startsWith("/api/")) return Response.json({ error: "Sign in to continue." }, { status: 401, headers: { "Cache-Control": "no-store" } });
    return Response.redirect(`${url.origin}/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`, 303);
  }
  // The session cookie rides along on cross-site requests; only Eumon's own pages may write.
  if (url.pathname.startsWith("/api/") && !SAFE_METHODS.has(request.method) && request.headers.get("origin") !== url.origin) {
    return Response.json({ error: "This request didn't come from Eumon, so it was refused." }, { status: 403 });
  }
  return null;
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `cd apps/web && node --test src/gate.test.ts`. Expected: PASS.

- [ ] **Step 5: Wire `worker.ts`.** Replace the default export:

```ts
import handler from "vinext/server/fetch-handler";
import type { AppEnv } from "./cloudflare.config";
import { authFor } from "./src/auth.js";
import { gate, isPublicPath } from "./src/gate.js";
import { APP_HEADERS, withHeaders } from "./src/headers.js";
import { startDailySyncs } from "./src/sync-steps.js";

export * from "vinext/server/fetch-handler";
export { SiteAnalysisWorkflow } from "./src/analysis-workflow.js";
export { ScrapeWorkflow } from "./src/scrape-workflow.js";
export { SearchSyncWorkflow } from "./src/search-sync-workflow.js";

const app = (typeof handler === "function" ? { fetch: handler } : handler) as ExportedHandler<AppEnv>;

export default {
  ...app,
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      // Attempts (sign-in, sign-up, magic link) are rate limited per address; reading the session is not.
      if (request.method !== "GET") {
        const { success } = await env.AUTH_RATE_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "local" });
        if (!success) return Response.json({ error: "Too many attempts. Wait a minute, then try again." }, { status: 429 });
      }
      return withHeaders(await authFor(env).handler(request), APP_HEADERS);
    }
    const signedIn = isPublicPath(url.pathname) ? false : Boolean(await authFor(env).api.getSession({ headers: request.headers }));
    const refused = gate(request, signedIn);
    if (refused) return withHeaders(refused, APP_HEADERS);
    const response = await app.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    // Landing pages set their own headers (they may be framed by the customer's site).
    return url.pathname.startsWith("/p/") ? response : withHeaders(response, APP_HEADERS);
  },
  /** The daily Results sync (the cron trigger in cloudflare.config.ts): one workflow instance per site, named after the day, so a second firing creates none. */
  scheduled(controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) {
    ctx.waitUntil(startDailySyncs(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<AppEnv>;
```

`authFor(env)` takes `AuthEnv`. `AppEnv` must satisfy it, so add the bindings in the next step. If TypeScript still objects about `D1Database` vs the inferred binding type, pass `env as unknown as AuthEnv`.

- [ ] **Step 6: Declare configuration.** In `cloudflare.config.ts` `env`, after `DEEPSEEK_API_KEY`:

```ts
      // Accounts (Better Auth). BOOTSTRAP_OWNER_EMAIL: comma-separated owners of the initial workspace and /admin.
      BETTER_AUTH_SECRET: bindings.secret(),
      BOOTSTRAP_OWNER_EMAIL: bindings.secret(),
      TURNSTILE_SITE_KEY: bindings.secret(),
      TURNSTILE_SECRET_KEY: bindings.secret(),
      // The GitHub App's OAuth client: the install callback proves the installer owns the installation.
      GITHUB_APP_CLIENT_ID: bindings.secret(),
      GITHUB_APP_CLIENT_SECRET: bindings.secret(),
      // Sign-in, verification and invitation email. Sending to any address needs Workers Paid; until
      // EMAIL_ENABLED is "true", messages are written to the log instead.
      EMAIL: bindings.sendEmail(),
      // Sign-in attempts per address: 10 a minute.
      AUTH_RATE_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: 10, period: 60 } }),
```

Leave `EMAIL_ENABLED`, `PASSWORD_SIGNIN`, and `EMAIL_FROM` undeclared, following the same note the file gives for `ANTHROPIC_API_KEY`. Undeclared vars are optional. Read them as `(env as { EMAIL_ENABLED?: string }).EMAIL_ENABLED`, which `AuthEnv` already types as optional.

Append to `.dev.vars.example`:

```
# Accounts. At least 32 random characters; not the same as SESSION_SECRET.
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
# Owners of the workspace holding the pre-accounts sites, and of /admin. Comma-separated.
BOOTSTRAP_OWNER_EMAIL=you@example.com
# Cloudflare Turnstile test keys (always pass) for local dev; real keys from the Turnstile dashboard in production.
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
# The GitHub App's Client ID and a client secret (GitHub App settings → General).
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
# Optional, off until Workers Paid: email sign-in and verification, and password sign-in (needs email).
# EMAIL_ENABLED=true
# EMAIL_FROM=no-reply@your-domain
# PASSWORD_SIGNIN=true
```

Copy the new keys into the worktree's `apps/web/.dev.vars`. If it is missing, copy it from the main checkout: `cp ../eumon-growth-engine/apps/web/.dev.vars apps/web/.dev.vars`. Generate the secret with `openssl rand -base64 33`. Set `BOOTSTRAP_OWNER_EMAIL=chin.gabriel@gmail.com`.

- [ ] **Step 7: Apply migrations locally and smoke-test.** Run `cd apps/web && npm run db:migrate:local`. This is the **local** database only and never `db:migrate:remote`. Start `npm run dev`. Then:
  - `curl -s -o /dev/null -w "%{http_code}\n" localhost:5174/api/sites` → `401`.
  - `curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" localhost:5174/` → `303 …/sign-in?next=%2F`.
  - `curl -s localhost:5174/api/auth/ok` → `{"ok":true}`.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/gate.ts apps/web/src/gate.test.ts apps/web/worker.ts apps/web/cloudflare.config.ts apps/web/.dev.vars.example
git commit -m "Gate every request: public paths, session required elsewhere, same-origin writes"
```

### Task 11: Guard the site-keyed routes

**Files:** every `apps/web/app/api/sites/[siteId]/**/route.ts` except `events/route.ts` (public), plus `apps/web/app/api/sites/[siteId]/route.ts`.

**Interfaces:**
- Consumes: `requireSite` (Task 9); `charge`, `featureRefusal` (Task 7).

**The transformation, applied to each handler:** take the `request` parameter (rename `_request` to `request`), and replace the route's own site lookup:

```ts
  const { siteId } = await context.params;
  const site = await getSite(env.DB, siteId);
  if (!site) return fail("Site not found.", 404);
```

with:

```ts
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "read"); // the level from the table below
  if (access instanceof Response) return access;
  const { site } = access;
```

Import with `import { requireSite } from "<relative>/src/guard";`, using the same relative depth as the file's existing `src/server` import. Drop `getSite` from the import if it becomes unused. Handlers with no site lookup today (threads, leads/[leadId]) still get the three guard lines; their existing `siteId`-scoped db calls stay.

| Route (under `sites/[siteId]/`) | Method → level |
|---|---|
| `route.ts` | DELETE → admin |
| `analyses` | GET → read; POST → write, then `charge(env.DB, site.workspaceId!, "analysesPerDay")` |
| `assistant` | POST → write, then `charge(…, "askPerDay")` |
| `assistant/threads` | GET → write |
| `assistant/threads/[threadId]` | GET, DELETE → write |
| `competitors` | GET → read; PUT → write |
| `connectors` | GET → write (it returns the log token) |
| `cta-variants` | GET → read; POST → write |
| `cta-variants/[variantId]` | PATCH → write |
| `datasets` | GET → read; POST → write |
| `events/recent`, `events/summary` | GET → read |
| `export/sheets` | POST → write, then `featureRefusal(…, "sheetsExport")` |
| `ga4/properties`, `gsc/properties` | GET, POST → write |
| `gsc/connect` | GET → write (Task 19 rewrites the rest) |
| `graph`, `history`, `index-coverage`, `performance`, `results`, `search-console`, `sync-runs`, `templates` | GET → read |
| `integration` | GET, POST → write |
| `leads` | GET → read; POST → write |
| `leads/[leadId]` | PATCH → write |
| `markets` | GET → read; PUT → write |
| `results/sync` | GET → read; POST → write |
| `scope` | GET, POST → write; POST also `charge(…, "aiRunsPerDay")` |
| `search-console/check`, `search-console/import`, `search-sync` | POST → write |
| `settings` | GET, PUT → write |
| `share` | POST, DELETE → write |

**Charging:** put the charge directly after the guard and before any work, so a refused request costs nothing:

```ts
  const refusal = await charge(env.DB, site.workspaceId!, "askPerDay");
  if (refusal) return fail(refusal, 429);
```

For features use `featureRefusal(...)` and return it with `fail(refusal, 403)`. Every site created after the migration has a `workspaceId`; the `!` is safe because `siteForUser` only finds sites through a workspace join.

- [ ] **Step 1: Convert the routes in the table.** Work directory by directory. After each directory, run `cd apps/web && npx tsc --noEmit -p . 2>&1 | grep "app/api/sites/\[siteId\]" | head` and fix what it reports.
- [ ] **Step 2: Run the guarded-routes test for this subtree.** Run `cd apps/web && node --test src/routes-guarded.test.ts 2>&1 | grep -E "^not ok|sites/\[siteId\]" | head -40`. Expected: no `not ok` lines for `sites/[siteId]/…`.
- [ ] **Step 3: Run the whole web suite.** Run `cd apps/web && node --test "src/**/*.test.ts" "app/**/*.test.ts"`. Expected: everything passes except `routes-guarded` failures outside `sites/[siteId]`.
- [ ] **Step 4: Commit.**

```bash
git add "apps/web/app/api/sites/[siteId]"
git commit -m "Guard every site route by role; meter analyses, Ask, scoping; Sheets export by plan"
```

### Task 12: Guard the ID-keyed routes

**Files:** `apps/web/app/api/{analyses,changes,datasets,jobs,pages,records,sources,templates}/**/route.ts`

**Interfaces:**
- Consumes: `requireOwned` (Task 9); `charge`, `featureRefusal` (Task 7).

**The transformation:** at the top of each handler, before the existing lookup:

```ts
  const { datasetId } = await context.params;
  const access = await requireOwned(request, "dataset", datasetId, "write");
  if (access instanceof Response) return access;
```

Keep the route's own row lookup (`getDataset` and the like): it still needs the row. Use `access.site` wherever the route currently calls `getSite`.

| Route | Kind | Method → level |
|---|---|---|
| `analyses/[analysisId]` | analysis | GET → read |
| `analyses/[analysisId]/progress` | analysis | GET → read |
| `analyses/[analysisId]/cancel` | analysis | POST → write |
| `analyses/[analysisId]/changes` | analysis | GET → read; POST → write, then `charge(…, "aiRunsPerDay")` |
| `changes/[changeId]/pull-request` | change | POST → write, then `featureRefusal(…, "pullRequests")` (Task 20 changes the rest) |
| `datasets/[datasetId]` | dataset | PATCH → write; DELETE → write |
| `datasets/[datasetId]/dedupe`, `records/import`, `sources`, `templates` | dataset | POST → write |
| `datasets/[datasetId]/inventory`, `potential`, `records` | dataset | GET → read |
| `datasets/[datasetId]/scrape` | dataset | POST → write, then charge `scrapePagesPerDay` with the sum of `maxPages` of the sources it will start (see below) |
| `jobs/[jobId]` | job | GET → read |
| `pages/[pageId]` | page | PATCH → write |
| `pages/[pageId]/snippets` | page | POST → write, then `charge(…, "aiRunsPerDay")` |
| `records/[recordId]` | record | DELETE → write |
| `sources/[sourceId]` | source | PATCH, DELETE → write |
| `sources/[sourceId]/preview` | source | POST → write, then `charge(…, "aiRunsPerDay")` |
| `templates/[templateId]` | template | GET → read; PATCH, DELETE → write |
| `templates/[templateId]/generate` | template | POST → write, then `charge(…, "aiRunsPerDay")` |
| `templates/[templateId]/publish` | template | POST → write |
| `templates/[templateId]/pages` | template | GET → read |

**The scrape charge:** in `datasets/[datasetId]/scrape/route.ts`, find where the route has the list of sources it will start; read the file for the variable name. Then insert:

```ts
  const pages = sources.reduce((sum, source) => sum + source.maxPages, 0);
  const refusal = await charge(env.DB, access.site.workspaceId!, "scrapePagesPerDay", pages);
  if (refusal) return fail(refusal, 429);
```

- [ ] **Step 1: Convert the routes in the table.** After each directory, typecheck as in Task 11.
- [ ] **Step 2: Run the guarded-routes test.** Run `cd apps/web && node --test src/routes-guarded.test.ts 2>&1 | grep "^not ok"`. Expected: only `sites/route.ts`, `dev/demo-site`, `github/*`, and `google/callback` remain.
- [ ] **Step 3: Commit.**

```bash
git add apps/web/app/api/analyses apps/web/app/api/changes apps/web/app/api/datasets apps/web/app/api/jobs apps/web/app/api/pages apps/web/app/api/records apps/web/app/api/sources apps/web/app/api/templates
git commit -m "Guard ID-keyed routes through the owning site; meter scraping and AI runs"
```

### Task 13: Workspace-scoped site list, site creation, demo site, sync limits, /api/me

**Files:**
- Modify: `apps/web/app/api/sites/route.ts`
- Modify: `apps/web/app/api/dev/demo-site/route.ts`
- Modify: `apps/web/src/sync-steps.ts:70-91`
- Create: `apps/web/app/api/me/route.ts`

**Interfaces:**
- Consumes: `requireWorkspace`, `requireViewer`; `listSitesForUser`, `countWorkspaceSites`, `setSiteWorkspace`, `memberRole`; `limitsFor`, `keysForLimits`; `emailEnabled`, `passwordEnabled`, `adminEmails`.
- Produces: `GET /api/me` → `{ user: { id, email }, workspace: { id, name, role } | null, workspaces: Array<{ id, name, role }>, platformAdmin: boolean }`.

- [ ] **Step 1: `GET /api/sites`.**

```ts
export async function GET(request: Request) {
  const access = await requireWorkspace(request, "read");
  if (access instanceof Response) return access;
  return json({ sites: await listSitesForUser(env.DB, access.viewer.userId, access.viewer.workspaceId) });
}
```

- [ ] **Step 2: `POST /api/sites`.**
  - Start with `const access = await requireWorkspace(request, "write"); if (access instanceof Response) return access;`.
  - Replace `const sites = await listSites(env.DB);` with `const sites = await listSitesForUser(env.DB, access.viewer.userId, access.viewer.workspaceId);`.
  - Before creating a **new** site, in both branches:

```ts
  const limit = (await limitsFor(env.DB, access.viewer.workspaceId)).sites;
  if (!existing && limit !== null && (await countWorkspaceSites(env.DB, access.viewer.workspaceId)) >= limit) {
    return fail(`This workspace can hold ${limit} site${limit === 1 ? "" : "s"}. Remove one first, or ask for more.`, 429);
  }
```

  - Set `workspaceId: access.viewer.workspaceId` on every `SiteRecord` the route builds (both branches).
  - Leave the `installationId` lookup for Task 18.

- [ ] **Step 3: Demo site.** In `dev/demo-site/route.ts`, after the local-only check:

```ts
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const result = await seedDemoSite(env.DB);
  await setSiteWorkspace(env.DB, DEMO_SITE_ID, access.viewer.workspaceId);
  return json(result);
```

Import `DEMO_SITE_ID` from wherever `sync-steps.ts` imports it (check with `grep -n DEMO_SITE_ID apps/web/src/sync-steps.ts`).

- [ ] **Step 4: The sync respects DataForSEO limits.** In `sync-steps.ts`, in `syncSite`, where `deps.keys` is passed to `syncResults`, compute per site:

```ts
    const keys = site.workspaceId ? keysForLimits(deps.keys, await limitsFor(deps.db, site.workspaceId)) : deps.keys;
```

Pass `keys` instead of `deps.keys`. Import `keysForLimits` and `limitsFor` from `./limits.ts`, matching the file's existing import extension style. Run `cd apps/web && node --test src/sync-steps.test.ts`. Expected: PASS, since those sites have no workspace and keep every key.

- [ ] **Step 5: `/api/me`.** Create `apps/web/app/api/me/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { json } from "../../../src/server";
import { adminEmails } from "../../../src/auth";
import { requireViewer } from "../../../src/guard";

/** Who is signed in, their workspaces, and their role in the active one. */
export async function GET(request: Request) {
  const who = await requireViewer(request);
  if (who instanceof Response) return who;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.name, m.role FROM member m JOIN organization o ON o.id = m.organizationId WHERE m.userId = ? ORDER BY m.createdAt`,
  ).bind(who.userId).all<{ id: string; name: string; role: string }>();
  return json({
    user: { id: who.userId, email: who.email },
    workspace: results.find((row) => row.id === who.workspaceId) ?? null,
    workspaces: results,
    platformAdmin: who.emailVerified && adminEmails(env).includes(who.email.toLowerCase()),
  });
}
```

- [ ] **Step 6: Run the tests.** Run `cd apps/web && node --test "src/**/*.test.ts"`. Expected: PASS except `routes-guarded` lines for `github/*` and `google/callback` (Tasks 18-19).
- [ ] **Step 7: Commit.**

```bash
git add apps/web/app/api/sites/route.ts apps/web/app/api/dev apps/web/app/api/me apps/web/src/sync-steps.ts
git commit -m "Sites belong to the active workspace; site limit; demo site joins it; DataForSEO by plan; /api/me"
```

### Task 14: Sign-in and invitation pages, 401 handling, client view

**Files:**
- Create: `apps/web/app/components/auth-client.ts`
- Create: `apps/web/src/next-path.ts`, `apps/web/src/next-path.test.ts`
- Create: `apps/web/app/sign-in/page.tsx`, `apps/web/app/sign-in/SignInForm.tsx`
- Create: `apps/web/app/invite/[id]/page.tsx`
- Modify: `apps/web/app/components/api.ts` (redirect to sign-in on 401)
- Modify: `apps/web/app/page.tsx` (load `/api/me`; workspace name, sign-out, and switcher in the header; hide Home (Ask), Data, and Setup for clients)

**Interfaces:**
- Produces:
  - `safeNext(value: string | null | undefined): string`
  - `authClient` (Better Auth React client with the organization and magic-link client plugins)

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/next-path.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeNext } from "./next-path.ts";

describe("safeNext", () => {
  it("keeps same-site paths and sends everything else home", () => {
    assert.equal(safeNext("/?view=setup"), "/?view=setup");
    assert.equal(safeNext("/invite/inv_1"), "/invite/inv_1");
    for (const bad of [null, "", "//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "evil"]) assert.equal(safeNext(bad), "/", String(bad));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/next-path.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `next-path.ts`.**

```ts
/** Where to go after signing in: a path on this site, never another origin (`//x`, `/\x`, or a scheme). */
export function safeNext(value: string | null | undefined): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/";
}
```

Run `cd apps/web && node --test src/next-path.test.ts`. Expected: PASS.

- [ ] **Step 4: Auth client.** Create `apps/web/app/components/auth-client.ts`:

```ts
import { createAuthClient } from "better-auth/react";
import { magicLinkClient, organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({ plugins: [organizationClient(), magicLinkClient()] });
```

- [ ] **Step 5: Sign-in page.** Create `apps/web/app/sign-in/page.tsx`. It is a server component, which reads the flags and the public Turnstile key from `env`:

```tsx
import { env } from "cloudflare:workers";
import { emailEnabled, passwordEnabled } from "../../src/auth";
import { safeNext } from "../../src/next-path";
import { SignInForm } from "./SignInForm";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const flags = env as unknown as { EMAIL_ENABLED?: string; PASSWORD_SIGNIN?: string; TURNSTILE_SITE_KEY: string };
  return <SignInForm next={safeNext((await searchParams).next)} email={emailEnabled(flags)} password={passwordEnabled(flags)} turnstileSiteKey={flags.TURNSTILE_SITE_KEY} />;
}
```

Create `apps/web/app/sign-in/SignInForm.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "../components/auth-client";
import { BrandMark } from "../components/pixel";
import { Button, Field } from "../components/ui";

declare global {
  interface Window { turnstile?: { render(el: HTMLElement, options: { sitekey: string; callback(token: string): void }): string } }
}

/** Turnstile guards the email and password endpoints (Better Auth's captcha plugin reads x-captcha-response). */
function useTurnstile(siteKey: string, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState("");
  useEffect(() => {
    if (!active || !ref.current) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = () => ref.current && window.turnstile?.render(ref.current, { sitekey: siteKey, callback: setToken });
    document.head.appendChild(script);
    return () => script.remove();
  }, [siteKey, active]);
  return { ref, token };
}

export function SignInForm({ next, email: emailOn, password: passwordOn, turnstileSiteKey }: { next: string; email: boolean; password: boolean; turnstileSiteKey: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const turnstile = useTurnstile(turnstileSiteKey, emailOn || passwordOn);
  const captcha = { headers: { "x-captcha-response": turnstile.token } };

  async function run(label: string, action: () => Promise<{ error?: { message?: string } | null }>) {
    setBusy(label); setError(""); setMessage("");
    const result = await action().catch((caught: unknown) => ({ error: { message: caught instanceof Error ? caught.message : String(caught) } }));
    setBusy("");
    if (result?.error) setError(result.error.message ?? "That didn't work. Try again.");
    return !result?.error;
  }

  return (
    <main className="signin">
      <BrandMark />
      <h1>Sign in to Eumon</h1>
      <Button busy={busy === "google"} onClick={() => run("google", () => authClient.signIn.social({ provider: "google", callbackURL: next }))}>Continue with Google</Button>
      {emailOn && (
        <form onSubmit={async (event) => {
          event.preventDefault();
          if (await run("link", () => authClient.signIn.magicLink({ email, callbackURL: next, fetchOptions: captcha }))) setMessage(`We sent a sign-in link to ${email}.`);
        }}>
          <Field label="Email"><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></Field>
          {!passwordOn && <Button variant="secondary" busy={busy === "link"} disabled={!turnstile.token}>Email me a sign-in link</Button>}
          {passwordOn && (
            <>
              <Field label="Password"><input type="password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={creating ? "new-password" : "current-password"} /></Field>
              <Button variant="secondary" busy={busy === "password"} disabled={!turnstile.token} onClick={async (event) => {
                event.preventDefault();
                const ok = await run("password", () => creating
                  ? authClient.signUp.email({ email, password, name: email.split("@")[0]!, callbackURL: next, fetchOptions: captcha })
                  : authClient.signIn.email({ email, password, callbackURL: next, fetchOptions: captcha }));
                if (ok && creating) setMessage(`Confirm your email: we sent a link to ${email}.`);
                if (ok && !creating) window.location.assign(next);
              }}>{creating ? "Create account" : "Sign in with password"}</Button>
              <Button variant="ghost" small onClick={(event) => { event.preventDefault(); setCreating(!creating); }}>{creating ? "I have an account" : "Create an account"}</Button>
            </>
          )}
          <div ref={turnstile.ref} />
        </form>
      )}
      {message && <p className="notice">{message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
```

In `app/globals.css`, add a `.signin` block: a centred column with a `max-width` of 360px, the same spacing tokens the file uses for `.card`, and square corners. Check `DESIGN.md` for the tokens. Reuse existing `.notice` and `.error` classes if they exist (`grep -n "\.notice\|\.error" app/globals.css`); otherwise add minimal ones in the same style.

- [ ] **Step 6: Invitation page.** Create `apps/web/app/invite/[id]/page.tsx`:

```tsx
"use client";

import { use, useState } from "react";
import { authClient } from "../../components/auth-client";
import { Button } from "../../components/ui";

export default function Invite({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const session = authClient.useSession();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (session.isPending) return null;
  if (!session.data) {
    return (
      <main className="signin">
        <h1>You're invited to Eumon</h1>
        <p>Sign in with the email address the invitation was sent to, then come back to this link.</p>
        <a className="button" href={`/sign-in?next=${encodeURIComponent(`/invite/${id}`)}`}>Sign in</a>
      </main>
    );
  }
  return (
    <main className="signin">
      <h1>Join the workspace</h1>
      <p>Signed in as {session.data.user.email}.</p>
      <Button busy={busy} onClick={async () => {
        setBusy(true); setError("");
        const accepted = await authClient.organization.acceptInvitation({ invitationId: id });
        if (accepted.error) { setBusy(false); setError(accepted.error.message ?? "This invitation can't be accepted. Ask for a new one."); return; }
        await authClient.organization.setActive({ organizationId: accepted.data!.invitation.organizationId });
        window.location.assign("/");
      }}>Accept invitation</Button>
      {error && <p className="error" role="alert">{error}</p>}
    </main>
  );
}
```

- [ ] **Step 7: 401 sends the browser to sign-in.** In `app/components/api.ts`, inside `if (!response.ok) {`, before building the error:

```ts
    if (response.status === 401 && typeof window !== "undefined") {
      window.location.assign(`/sign-in?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
```

- [ ] **Step 8: The dashboard knows who is signed in.** In `app/page.tsx`:
  - Add `const [me, setMe] = useState<Me | null>(null);` with this type:

```ts
type Me = { user: { id: string; email: string }; workspace: { id: string; name: string; role: "owner" | "member" | "client" } | null; workspaces: Array<{ id: string; name: string; role: string }>; platformAdmin: boolean };
```

  - Load it alongside the sites: `api<Me>("/api/me").then(setMe)`.
  - Filter `NAV` for clients: `const nav = me?.workspace?.role === "client" ? NAV.filter((item) => ["overview", "pages", "performance"].includes(item.view)) : NAV;`. Render `nav` instead of `NAV`. If a client's saved `view` is not in `nav`, `setView("overview")`.
  - In the header (find where `ThemeToggle` renders):
    - Show the workspace name.
    - When `me.workspaces.length > 1`, add a `<select>` that calls `authClient.organization.setActive({ organizationId })` then `window.location.reload()`.
    - Add an `/admin` link when `me.platformAdmin`.
    - Add a "Sign out" `Button variant="ghost" small` that calls `authClient.signOut()` and then `window.location.assign("/sign-in")`.

- [ ] **Step 9: Manual check on local dev.** Run `npm run dev` with the Google OAuth client's redirect URI `http://localhost:5174/api/auth/callback/google` registered in Google Cloud; ask the user to add it if it is missing.
  1. `/` redirects to `/sign-in?next=%2F`.
  2. "Continue with Google" signs in as the bootstrap email, and the dashboard lists every pre-existing site.
  3. A different Google account signs in to an empty workspace of its own.

- [ ] **Step 10: Commit.**

```bash
git add apps/web/app/sign-in apps/web/app/invite apps/web/app/components/auth-client.ts apps/web/app/components/api.ts apps/web/app/page.tsx apps/web/app/globals.css apps/web/src/next-path.ts apps/web/src/next-path.test.ts
git commit -m "Sign-in and invitation pages; dashboard shows the workspace, hides write views from clients"
```

### Task 15: Members panel and client invitations

**Files:**
- Create: `apps/web/app/api/workspace/invitations/route.ts`
- Create: `apps/web/app/components/MembersPanel.tsx`
- Modify: `apps/web/app/components/SetupView.tsx` (render `<MembersPanel site={site} />` first)

**Interfaces:**
- Consumes: `requireWorkspace`; `authFor`; `addSiteInvites`, `listSitesForUser`.
- Produces: `POST /api/workspace/invitations { email, role: "member" | "client", siteIds?: string[] }` → `{ invitationId, link }`.

- [ ] **Step 1: Invitation endpoint.** Create `apps/web/app/api/workspace/invitations/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { addSiteInvites, listSitesForUser } from "@organic-growth/db";
import { authFor } from "../../../../src/auth";
import { requireWorkspace } from "../../../../src/guard";
import { fail, json, readJson } from "../../../../src/server";

/**
 * Invites someone to the active workspace (owners only). A Client invitation names
 * the sites it grants. The link is returned so it can be shared by hand while email is off.
 */
export async function POST(request: Request) {
  const access = await requireWorkspace(request, "admin");
  if (access instanceof Response) return access;
  const body = await readJson<{ email?: unknown; role?: unknown; siteIds?: unknown }>(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail("Enter the email address to invite.");
  const role = body?.role === "client" ? "client" : body?.role === "member" ? "member" : null;
  if (!role) return fail("Choose Member or Client.");
  const own = new Set((await listSitesForUser(env.DB, access.viewer.userId, access.viewer.workspaceId)).map((site) => site.id));
  const siteIds = Array.isArray(body?.siteIds) ? body.siteIds.filter((id): id is string => typeof id === "string" && own.has(id)) : [];
  if (role === "client" && !siteIds.length) return fail("Choose at least one site the client can see.");
  try {
    const invitation = await authFor(env).api.createInvitation({ body: { email, role, organizationId: access.viewer.workspaceId }, headers: request.headers });
    if (role === "client") await addSiteInvites(env.DB, invitation.id, siteIds);
    return json({ invitationId: invitation.id, link: `${new URL(request.url).origin}/invite/${invitation.id}` }, 201);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Could not create the invitation.", 400);
  }
}
```

If `createInvitation` rejects the custom `client` role's type, cast the role argument with `role as "member"`; Better Auth validates roles at runtime against `roles`.

- [ ] **Step 2: Members panel.** Create `apps/web/app/components/MembersPanel.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import type { SiteRecord } from "@organic-growth/core";
import { api, errorMessage } from "./api";
import { authClient } from "./auth-client";
import { Button, Card, Field } from "./ui";

type Org = { members: Array<{ id: string; role: string; user: { email: string; name: string } }>; invitations: Array<{ id: string; email: string; role: string | null; status: string }> };

/** Who is in the workspace, and inviting more (owners). Links are shown to copy while invitation email is off. */
export function MembersPanel({ site, sites, canInvite }: { site: SiteRecord; sites: SiteRecord[]; canInvite: boolean }) {
  const [org, setOrg] = useState<Org | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "client">("client");
  const [siteIds, setSiteIds] = useState<string[]>([site.id]);
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => authClient.organization.getFullOrganization().then((result) => setOrg((result.data as unknown as Org) ?? null));
  useEffect(() => { void load(); }, []);

  return (
    <Card title="People" subtitle="Members manage every site. Clients see only the sites you choose, read-only.">
      <ul className="rows">
        {org?.members.map((member) => (
          <li key={member.id}>
            <span>{member.user.email}</span> <span className="muted">{member.role}</span>
            {canInvite && member.role !== "owner" && (
              <Button variant="ghost" small onClick={async () => { await authClient.organization.removeMember({ memberIdOrEmail: member.id }); await load(); }}>Remove</Button>
            )}
          </li>
        ))}
        {org?.invitations.filter((invitation) => invitation.status === "pending").map((invitation) => (
          <li key={invitation.id}><span>{invitation.email}</span> <span className="muted">invited ({invitation.role})</span></li>
        ))}
      </ul>
      {canInvite && (
        <form onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true); setError(""); setLink("");
          try {
            const result = await api<{ link: string }>("/api/workspace/invitations", { method: "POST", json: { email, role, siteIds } });
            setLink(result.link); setEmail(""); await load();
          } catch (caught) {
            setError(errorMessage(caught));
          } finally {
            setBusy(false);
          }
        }}>
          <Field label="Email"><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label="Role">
            <select value={role} onChange={(event) => setRole(event.target.value as "member" | "client")}>
              <option value="client">Client (read-only, chosen sites)</option>
              <option value="member">Member (every site)</option>
            </select>
          </Field>
          {role === "client" && (
            <Field label="Sites">
              <div>{sites.map((option) => (
                <label key={option.id}><input type="checkbox" checked={siteIds.includes(option.id)} onChange={(event) => setSiteIds(event.target.checked ? [...siteIds, option.id] : siteIds.filter((id) => id !== option.id))} /> {option.name}</label>
              ))}</div>
            </Field>
          )}
          <Button busy={busy}>Invite</Button>
        </form>
      )}
      {link && <p className="notice">Send them this link: <code>{link}</code> <Button variant="ghost" small onClick={() => navigator.clipboard.writeText(link)}>Copy</Button></p>}
      {error && <p className="error" role="alert">{error}</p>}
    </Card>
  );
}
```

`SetupView` receives only `site`, so pass what the panel needs through from `page.tsx`:
- Add `sites: SiteRecord[]` and `role: string` props to `SetupView`.
- Render `<MembersPanel site={site} sites={sites} canInvite={role === "owner"} />` at the top.
- In `page.tsx`, pass `sites={sites ?? []} role={me?.workspace?.role ?? "member"}` where `SetupView` is rendered.
- If `.rows` and `.muted` classes don't exist (`grep -n "\.rows\|\.muted" app/globals.css`), use the list markup that `ConnectionsView.tsx` already uses.

- [ ] **Step 3: Check the route test still passes.** Run `cd apps/web && node --test src/routes-guarded.test.ts 2>&1 | grep workspace`. Expected: `ok … workspace/invitations/route.ts`.
- [ ] **Step 4: Manual check.**
  1. As the bootstrap owner, invite a second Google account as Client to one site, and copy the link.
  2. In a private window, sign in as that account and open the link. Accept: the dashboard shows only that site, with only Dashboard, Landing pages, and Page results in the rail.
  3. `curl` a write as that client (copy its cookie) and confirm it gets 403: `curl -b "<cookie>" -H "Origin: http://localhost:5174" -X DELETE localhost:5174/api/sites/<id>`.
- [ ] **Step 5: Commit.**

```bash
git add apps/web/app/api/workspace apps/web/app/components/MembersPanel.tsx apps/web/app/components/SetupView.tsx apps/web/app/page.tsx apps/web/app/globals.css
git commit -m "People panel: invite members and site-scoped clients by link"
```

### Task 16: Admin page

**Files:**
- Create: `apps/web/app/api/admin/workspaces/route.ts`
- Create: `apps/web/app/api/admin/workspaces/[workspaceId]/limits/route.ts`
- Create: `apps/web/app/admin/page.tsx`

**Interfaces:**
- Consumes: `requirePlatformAdmin`; `listWorkspacesForAdmin`, `setLimitOverrides`; `FREE_LIMITS`, `Limits`.

- [ ] **Step 1: Endpoints.**

`apps/web/app/api/admin/workspaces/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { listWorkspacesForAdmin } from "@organic-growth/db";
import { requirePlatformAdmin } from "../../../../src/guard";
import { FREE_LIMITS } from "../../../../src/limits";
import { json } from "../../../../src/server";

export async function GET(request: Request) {
  const admin = await requirePlatformAdmin(request);
  if (admin instanceof Response) return admin;
  return json({ defaults: FREE_LIMITS, workspaces: await listWorkspacesForAdmin(env.DB, new Date().toISOString().slice(0, 10)) });
}
```

`apps/web/app/api/admin/workspaces/[workspaceId]/limits/route.ts`:

```ts
import { env } from "cloudflare:workers";
import { setLimitOverrides } from "@organic-growth/db";
import { requirePlatformAdmin } from "../../../../../../src/guard";
import { FREE_LIMITS, type Limits } from "../../../../../../src/limits";
import { fail, json, readJson } from "../../../../../../src/server";

/** Replaces a workspace's overrides. Numbers: a non-negative integer or null (unlimited); features: true or false. Unknown keys are dropped. */
export async function PUT(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const admin = await requirePlatformAdmin(request);
  if (admin instanceof Response) return admin;
  const { workspaceId } = await context.params;
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return fail("Send the limits as JSON.");
  const overrides: Partial<Limits> = {};
  for (const [key, standard] of Object.entries(FREE_LIMITS) as Array<[keyof Limits, Limits[keyof Limits]]>) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof standard === "boolean" ? typeof value !== "boolean" : !(value === null || (Number.isInteger(value) && (value as number) >= 0))) {
      return fail(`${key} must be ${typeof standard === "boolean" ? "true or false" : "a whole number or null"}.`);
    }
    (overrides as Record<string, unknown>)[key] = value;
  }
  await setLimitOverrides(env.DB, workspaceId, overrides);
  return json({ workspaceId, overrides });
}
```

- [ ] **Step 2: Page.** Create `apps/web/app/admin/page.tsx`, a client component.
  - Fetch `/api/admin/workspaces`. If it answers 404, show "Not found."
  - Render a table with one row per workspace: name, sites, members, and today's usage per metric shown as `used / limit`, where the limit is the override or the default.
  - Each workspace has an "Edit limits" form: number inputs, where an empty value means unlimited and is sent as `null`, plus checkboxes for the three features. It `PUT`s to `/api/admin/workspaces/<id>/limits`.
  - Use `Card`, `Field`, and `Button` from `../components/ui`, and `api` and `errorMessage` from `../components/api`.

```tsx
"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../components/api";
import { Button, Card, Field } from "../components/ui";

type Limits = Record<string, number | boolean | null>;
type Row = { id: string; name: string; sites: number; members: number; usage: Record<string, number>; overrides: Limits };
const METERED = ["analysesPerDay", "scrapePagesPerDay", "askPerDay", "aiRunsPerDay"];
const NUMBERS = ["sites", "members", ...METERED];
const FEATURES = ["dataForSeo", "pullRequests", "sheetsExport"];

export default function Admin() {
  const [data, setData] = useState<{ defaults: Limits; workspaces: Row[] } | null>(null);
  const [error, setError] = useState("");
  const load = () => api<{ defaults: Limits; workspaces: Row[] }>("/api/admin/workspaces").then(setData, (caught) => setError(errorMessage(caught)));
  useEffect(() => { void load(); }, []);
  if (error) return <main className="admin"><p className="error">{error}</p></main>;
  if (!data) return null;
  return (
    <main className="admin">
      <h1>Workspaces</h1>
      {data.workspaces.map((row) => <WorkspaceLimits key={row.id} row={row} defaults={data.defaults} onSaved={load} />)}
    </main>
  );
}

function WorkspaceLimits({ row, defaults, onSaved }: { row: Row; defaults: Limits; onSaved: () => void }) {
  const effective = { ...defaults, ...row.overrides };
  const [draft, setDraft] = useState<Limits>(effective);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Card title={row.name} subtitle={`${row.sites} sites · ${row.members} people · today: ${METERED.map((m) => `${m} ${row.usage[m] ?? 0}/${effective[m] ?? "∞"}`).join(", ")}`}>
      <form onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError("");
        try { await api(`/api/admin/workspaces/${row.id}/limits`, { method: "PUT", json: draft }); onSaved(); }
        catch (caught) { setError(errorMessage(caught)); }
        finally { setBusy(false); }
      }}>
        {NUMBERS.map((key) => (
          <Field key={key} label={key} hint="Empty: unlimited">
            <input type="number" min={0} value={draft[key] === null ? "" : String(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: event.target.value === "" ? null : Number(event.target.value) })} />
          </Field>
        ))}
        {FEATURES.map((key) => (
          <label key={key}><input type="checkbox" checked={Boolean(draft[key])} onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })} /> {key}</label>
        ))}
        <Button busy={busy}>Save limits</Button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </Card>
  );
}
```

- [ ] **Step 3: Check the route test still passes.** Run `cd apps/web && node --test src/routes-guarded.test.ts 2>&1 | grep admin`. Expected: `ok` lines for both admin routes.
- [ ] **Step 4: Manual check.** As the bootstrap owner, open `/admin`, raise `askPerDay` for another workspace, and confirm that the 21st question in that workspace now succeeds. As a non-admin, `/admin` shows "Not found."
- [ ] **Step 5: Commit.**

```bash
git add apps/web/app/api/admin apps/web/app/admin
git commit -m "Admin page: every workspace's usage, and its limits"
```

### Task 17: Per-site log token

**Files:**
- Modify: `apps/web/src/crawl-logs.ts:12-24`
- Modify: `apps/web/app/api/logs/[siteId]/route.ts`
- Modify: `apps/web/app/api/sites/[siteId]/connectors/route.ts` (GET returns the stored token; new POST rotates it)
- Modify: `apps/web/app/components/ConnectorSetup.tsx` (Rotate button)
- Test: `apps/web/src/crawl-logs.test.ts` (create it if it is missing)

**Interfaces:**
- Consumes: `getSiteLogToken`, `setSiteLogToken`.
- Produces: `tokenMatches(request, secret, siteId, stored: string | null): Promise<boolean>`

- [ ] **Step 1: Write the failing test.** In `apps/web/src/crawl-logs.test.ts` (create it, or append):

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { logToken, tokenMatches } from "./crawl-logs.ts";

const secret = "s".repeat(40);
const delivery = (token: string) => new Request("https://eumon.test/api/logs/site", { method: "POST", headers: { authorization: `Bearer ${token}` } });

describe("log token", () => {
  it("accepts the derived token until the site has its own, then only its own", async () => {
    const derived = await logToken(secret, "site");
    assert.equal(await tokenMatches(delivery(derived), secret, "site", null), true);
    assert.equal(await tokenMatches(delivery(derived), secret, "site", "f".repeat(64)), false, "rotated: the old token stops");
    assert.equal(await tokenMatches(delivery("f".repeat(64)), secret, "site", "f".repeat(64)), true);
    assert.equal(await tokenMatches(delivery("wrong"), secret, "site", null), false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/crawl-logs.test.ts`. Expected: FAIL, because a rotated token is not honoured.

- [ ] **Step 3: Implement.** In `crawl-logs.ts`:

```ts
/** A site's original log token, derived from the server secret; used until the site rotates to a stored one. */
export const logToken = (secret: string, siteId: string) => derivedKey(secret, `logs:${siteId}`);

export async function tokenMatches(request: Request, secret: string, siteId: string, stored: string | null): Promise<boolean> {
  const presented = presentedToken(request);
  return Boolean(presented) && sameSecret(presented!, stored ?? await logToken(secret, siteId));
}
```

In `logs/[siteId]/route.ts`, pass `await getSiteLogToken(env.DB, siteId)` as the fourth argument.

In `connectors/route.ts`:
- GET: `token: (await getSiteLogToken(env.DB, siteId)) ?? await logToken(keys.indexNowSecret, siteId),`.
- Add a handler:

```ts
/** Replaces the site's log token: the old one stops working at once, so update the log shipper after. */
export async function POST(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await setSiteLogToken(env.DB, siteId, token);
  return json({ token });
}
```

In `ConnectorSetup.tsx`, near line 77 where `logs.token` is used, render where the token is displayed (grep `logs.token` in the JSX):

```tsx
<Button variant="ghost" small onClick={async () => {
  if (!window.confirm("Rotate the log token? Log shipping stops until you paste the new token into it.")) return;
  const { token } = await api<{ token: string }>(`/api/sites/${site.id}/connectors`, { method: "POST" });
  setLogs({ ...logs, token });
}}>Rotate token</Button>
```

Adapt `setLogs` and `site` to the component's actual state names. If the token lives in a parent's data, call the parent's reload function instead.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `cd apps/web && node --test src/crawl-logs.test.ts src/routes-guarded.test.ts`. Expected: crawl-logs passes, and `connectors/route.ts` is `ok`.
- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/crawl-logs.ts apps/web/src/crawl-logs.test.ts "apps/web/app/api/logs/[siteId]/route.ts" "apps/web/app/api/sites/[siteId]/connectors/route.ts" apps/web/app/components/ConnectorSetup.tsx
git commit -m "Per-site log tokens that rotate on their own"
```

---

## Part B: OAuth and pull-request safety

### Task 18: GitHub installations are verified and belong to a workspace

**Files:**
- Create: `apps/web/src/github-install.ts`, `apps/web/src/github-install.test.ts`
- Modify: `apps/web/app/api/github/install/route.ts`, `apps/web/app/api/github/callback/route.ts`, `apps/web/app/api/github/repositories/route.ts`, `apps/web/app/api/sites/route.ts` (repository branch)

**Interfaces:**
- Consumes: `requireWorkspace`; `addGithubInstallation`, `listGithubInstallations`.
- Produces:
  - `ownsInstallation(fetchFn: typeof fetch, input: { clientId: string; clientSecret: string; code: string; installationId: string }): Promise<boolean>`
  - `workspaceRepositories(appId, privateKey, installationIds: string[]): Promise<Array<GitHubRepository & { installationId: string }>>`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/github-install.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownsInstallation } from "./github-install.ts";

function github(installations: number[]) {
  const calls: string[] = [];
  const fetchFn = (async (url: string) => {
    calls.push(String(url));
    if (String(url).startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "user-token" });
    if (String(url) === "https://api.github.com/user/installations?per_page=100") return Response.json({ installations: installations.map((id) => ({ id })) });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("ownsInstallation", () => {
  it("accepts an installation the user can reach, and nothing else", async () => {
    const input = { clientId: "c", clientSecret: "s", code: "code" };
    assert.equal(await ownsInstallation(github([5, 7]).fetchFn, { ...input, installationId: "7" }), true);
    assert.equal(await ownsInstallation(github([5]).fetchFn, { ...input, installationId: "7" }), false, "someone else's installation id");
  });

  it("refuses when GitHub gives no user token (user authorization is off)", async () => {
    const fetchFn = (async () => Response.json({ error: "bad_verification_code" })) as unknown as typeof fetch;
    assert.equal(await ownsInstallation(fetchFn, { clientId: "c", clientSecret: "s", code: "x", installationId: "7" }), false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/github-install.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `github-install.ts`.**

```ts
import { createInstallationToken, listInstallationRepositories, type GitHubRepository } from "@organic-growth/repo-analyzer";

/**
 * An installation id in the install callback's query string proves nothing: anyone can type one.
 * With "Request user authorization (OAuth) during installation" on, GitHub also sends a `code`;
 * the user token it buys lists the installations that user can reach.
 */
export async function ownsInstallation(fetchFn: typeof fetch, input: { clientId: string; clientSecret: string; code: string; installationId: string }): Promise<boolean> {
  const exchange = await fetchFn("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: input.clientId, client_secret: input.clientSecret, code: input.code }),
  });
  const token = exchange.ok ? ((await exchange.json()) as { access_token?: string }).access_token : undefined;
  if (!token) return false;
  const response = await fetchFn("https://api.github.com/user/installations?per_page=100", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Eumon" },
  });
  if (!response.ok) return false;
  const { installations } = (await response.json()) as { installations?: Array<{ id: number }> };
  return Boolean(installations?.some((installation) => String(installation.id) === input.installationId));
}

/** Every repository across a workspace's installations, each tagged with the installation that reaches it. */
export async function workspaceRepositories(appId: string, privateKey: string, installationIds: string[]): Promise<Array<GitHubRepository & { installationId: string }>> {
  const lists = await Promise.all(installationIds.map(async (installationId) => {
    const token = await createInstallationToken(appId, privateKey, installationId);
    return (await listInstallationRepositories(token)).map((repository) => ({ ...repository, installationId }));
  }));
  return lists.flat();
}
```

Check that `GitHubRepository` is exported from `@organic-growth/repo-analyzer`'s index (`grep -n github-app packages/repo-analyzer/src/index.ts`). Re-export it if it isn't.

- [ ] **Step 4: Run it and confirm it passes.** Run `cd apps/web && node --test src/github-install.test.ts`. Expected: PASS.

- [ ] **Step 5: Routes.**

`github/install/route.ts`: start with `const access = await requireWorkspace(request, "write"); if (access instanceof Response) return access;`. The rest is unchanged.

`github/callback/route.ts`: replace the success branch, keeping the state-cookie check:

```ts
export async function GET(request: Request) {
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  // … existing state, installationId, secure, expected, destination, headers …
  const code = current.searchParams.get("code");
  const clearState = `og_github_state=; HttpOnly${secure}; SameSite=Lax; Path=/api/github/callback; Max-Age=0`;
  // The old signed-installation cookie is no longer read; expire it.
  const clearInstallation = `og_installation=; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=0`;
  const refuse = (reason: string) => {
    destination.searchParams.set("github_error", reason);
    headers.set("Location", destination.toString());
    headers.append("Set-Cookie", clearState);
    return new Response(null, { status: 303, headers });
  };
  if (!state || !expected || state !== expected || !installationId || !/^\d+$/.test(installationId)) return refuse("installation_invalid");
  if (!code) return refuse("authorization_missing");
  if (!(await ownsInstallation(fetch, { clientId: env.GITHUB_APP_CLIENT_ID, clientSecret: env.GITHUB_APP_CLIENT_SECRET, code, installationId }))) return refuse("installation_not_yours");
  await addGithubInstallation(env.DB, access.viewer.workspaceId, installationId);
  destination.searchParams.set("github", "connected");
  destination.searchParams.set("view", "connections");
  headers.set("Location", destination.toString());
  headers.append("Set-Cookie", clearState);
  headers.append("Set-Cookie", clearInstallation);
  return new Response(null, { status: 303, headers });
}
```

Where `page.tsx` or `ConnectionsView.tsx` turns `github_error` codes into messages (`grep -rn github_error apps/web/app`), add:
- `authorization_missing`: "Turn on "Request user authorization (OAuth) during installation" in the GitHub App's settings, then install again."
- `installation_not_yours`: "That GitHub installation isn't one your GitHub account can manage."

`github/repositories/route.ts`:

```ts
export async function GET(request: Request) {
  const access = await requireWorkspace(request, "write");
  if (access instanceof Response) return access;
  const installations = await listGithubInstallations(env.DB, access.viewer.workspaceId);
  if (!installations.length) return Response.json({ error: "Install the GitHub App for this workspace first." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const repositories = await workspaceRepositories(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installations);
    return Response.json({ repositories: repositories.map(({ id, name, full_name, default_branch, owner, private: isPrivate }) => ({
      id, name, fullName: full_name, defaultBranch: default_branch, owner: owner.login, isPrivate,
    })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not read installed repositories." }, { status: 502 });
  }
}
```

`sites/route.ts`, repository branch: delete `installationCookie`. Replace the cookie-based lookup with:

```ts
  const installations = await listGithubInstallations(env.DB, access.viewer.workspaceId);
  if (!installations.length) return fail("Install the GitHub App for this workspace before connecting a repository.", 401);
  try {
    const repository = (await workspaceRepositories(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, installations)).find((item) => item.id === body.repositoryId);
    if (!repository) return fail("That repository is not available to this workspace's GitHub installations.", 403);
    const installationId = repository.installationId;
    // … the rest as before, building the SiteRecord with githubInstallationId: installationId and workspaceId …
```

Also: `existing` must only match sites in this workspace. It already does, because `sites` is now `listSitesForUser(...)` from Task 13.

- [ ] **Step 6: Test that an old cookie does nothing (Review Focus 1).** Append to `github-install.test.ts`:

```ts
import { readFileSync } from "node:fs";
it("no route reads the old og_installation cookie", () => {
  for (const file of ["../app/api/github/repositories/route.ts", "../app/api/sites/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /og_installation=/, file);
  }
});
```

Share links keep working: `src/share.test.ts` is unchanged and still passes.

- [ ] **Step 7: Run the tests.** Run `cd apps/web && node --test src/github-install.test.ts src/share.test.ts src/routes-guarded.test.ts`. Expected: PASS except `google/callback` (Task 19).
- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/github-install.ts apps/web/src/github-install.test.ts apps/web/app/api/github apps/web/app/api/sites/route.ts apps/web/app packages/repo-analyzer/src/index.ts
git commit -m "GitHub: prove the installer owns the installation; installations belong to a workspace"
```

### Task 19: Google connect is bound to the browser and the user

**Files:**
- Create: `apps/web/src/google-state.ts`, `apps/web/src/google-state.test.ts`
- Modify: `apps/web/app/api/sites/[siteId]/gsc/connect/route.ts`, `apps/web/app/api/google/callback/route.ts`

**Interfaces:**
- Produces:
  - `type GoogleState = { siteId: string; nonce: string; userId: string }`
  - `googleStateProblem(state: Partial<GoogleState> | null, cookieNonce: string | null, viewerId: string | null): string | null`
  - `GOOGLE_NONCE_COOKIE = "og_google_nonce"`

- [ ] **Step 1: Write the failing test.** Create `apps/web/src/google-state.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { googleStateProblem } from "./google-state.ts";

describe("googleStateProblem", () => {
  const state = { siteId: "s", nonce: "n1", userId: "u" };
  it("accepts the browser and user that started the connection", () => assert.equal(googleStateProblem(state, "n1", "u"), null));
  it("refuses a link opened in another browser", () => assert.ok(googleStateProblem(state, null, "u")));
  it("refuses a mismatched nonce", () => assert.ok(googleStateProblem(state, "n2", "u")));
  it("refuses another signed-in user", () => assert.ok(googleStateProblem(state, "n1", "someone-else")));
  it("refuses a missing or unsigned state", () => {
    assert.ok(googleStateProblem(null, "n1", "u"));
    assert.ok(googleStateProblem({ siteId: "s" }, "n1", "u"));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `cd apps/web && node --test src/google-state.test.ts`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `google-state.ts`.**

```ts
import { sameSecret } from "@organic-growth/core";

export type GoogleState = { siteId: string; nonce: string; userId: string };
export const GOOGLE_NONCE_COOKIE = "og_google_nonce";

/**
 * The OAuth state is signed, but a signature only proves Eumon made it. The nonce cookie
 * proves this browser started the flow, and the user id that the same person is finishing it,
 * so nobody can send a victim a link that stores the victim's Google account on their site.
 */
export function googleStateProblem(state: Partial<GoogleState> | null, cookieNonce: string | null, viewerId: string | null): string | null {
  if (!state?.siteId || !state.nonce || !state.userId) return "The Google connection link is invalid or expired.";
  if (!cookieNonce || !sameSecret(cookieNonce, state.nonce)) return "Start the Google connection again from Eumon in this browser.";
  if (!viewerId || viewerId !== state.userId) return "Sign in as the person who started the Google connection.";
  return null;
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run `cd apps/web && node --test src/google-state.test.ts`. Expected: PASS.

- [ ] **Step 5: Routes.** Replace `gsc/connect/route.ts` with:

```ts
import { env } from "cloudflare:workers";
import { createId, signToken } from "@organic-growth/core";
import { GOOGLE_NONCE_COOKIE } from "../../../../../../src/google-state";
import { ANALYTICS_SCOPE, DRIVE_FILE_SCOPE, SEARCH_CONSOLE_SCOPE } from "../../../../../../src/gsc-auth";
import { requireSite } from "../../../../../../src/guard";

export async function GET(request: Request, context: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await context.params;
  const access = await requireSite(request, siteId, "write");
  if (access instanceof Response) return access;
  const callback = new URL("/api/google/callback", request.url).toString();
  const nonce = createId("oauth");
  const state = await signToken({ siteId, nonce, userId: access.viewer.userId }, 10 * 60_000, env.SESSION_SECRET);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: "code",
    scope: `${SEARCH_CONSOLE_SCOPE} ${ANALYTICS_SCOPE} ${DRIVE_FILE_SCOPE}`, access_type: "offline", prompt: "consent", state,
  }).toString();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, { status: 302, headers: {
    Location: url.toString(), "Cache-Control": "no-store",
    "Set-Cookie": `${GOOGLE_NONCE_COOKIE}=${nonce}; HttpOnly${secure}; SameSite=Lax; Path=/api/google/callback; Max-Age=600`,
  } });
}
```

In `google/callback/route.ts`, replace the first four lines of `GET` (the state check) with:

```ts
  const url = new URL(request.url);
  const state = await verifyToken<GoogleState>(url.searchParams.get("state") ?? "", env.SESSION_SECRET);
  const cookieNonce = request.headers.get("Cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${GOOGLE_NONCE_COOKIE}=`))?.slice(GOOGLE_NONCE_COOKIE.length + 1) ?? null;
  const who = await viewer(request);
  const problem = googleStateProblem(state, cookieNonce, who?.userId ?? null);
  if (problem || url.searchParams.has("error")) return Response.redirect(new URL("/?gsc=error", url.origin), 303);
  const access = await requireSite(request, state!.siteId, "write");
  if (access instanceof Response) return Response.redirect(new URL("/?gsc=error", url.origin), 303);
  const siteId = access.site.id;
```

The rest is unchanged. Import `viewer` and `requireSite` from `../../../../src/guard`, and `googleStateProblem`, `GOOGLE_NONCE_COOKIE`, and `GoogleState` from `../../../../src/google-state`.

- [ ] **Step 6: Run the tests.** Run `cd apps/web && node --test src/google-state.test.ts src/routes-guarded.test.ts`. Expected: PASS. **Every** route is now guarded, so `routes-guarded` is fully green.
- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/google-state.ts apps/web/src/google-state.test.ts "apps/web/app/api/sites/[siteId]/gsc/connect/route.ts" apps/web/app/api/google/callback/route.ts
git commit -m "Google connect: nonce cookie and user bound into the state"
```

### Task 20: Pull requests change only robots.txt, and only plain robots.txt

**Files:**
- Modify: `packages/agents/src/change-generator.ts:5-12,39-42`
- Modify: `apps/web/app/api/changes/[changeId]/pull-request/route.ts:14-17`
- Test: `packages/agents/src/change-generator.test.ts` (new)

**Interfaces:**
- Produces:
  - `SAFE_SEO_CONFIG_PATHS = new Set(["public/robots.txt"])`
  - `isPlainRobotsTxt(content: string): boolean`

- [ ] **Step 1: Write the failing test.** Create `packages/agents/src/change-generator.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPlainRobotsTxt, SAFE_SEO_CONFIG_PATHS } from "./change-generator.js";

describe("pull request allowlist", () => {
  it("only proposes changes to the static robots.txt", () => {
    assert.deepEqual([...SAFE_SEO_CONFIG_PATHS], ["public/robots.txt"]);
  });

  it("accepts only robots.txt directives and comments", () => {
    assert.equal(isPlainRobotsTxt("# Eumon\nUser-agent: *\nDisallow: /admin\nAllow: /\n\nSitemap: https://x.com/sitemap.xml\n"), true);
    assert.equal(isPlainRobotsTxt("User-agent: *\nimport fs from 'fs'\n"), false);
    assert.equal(isPlainRobotsTxt("<script>alert(1)</script>"), false);
    assert.equal(isPlainRobotsTxt("Crawl-delay: 10\nHost: x.com"), true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npm test -w @organic-growth/agents`. Expected: FAIL, because `isPlainRobotsTxt` is not exported.

- [ ] **Step 3: Implement.** In `change-generator.ts`:

```ts
/**
 * Repository files Eumon may propose changes to: the static robots.txt only. `app/robots.ts`
 * and `app/sitemap.ts` were allowed once, but they are code that runs at build time,
 * including preview builds of a draft PR, so model-written content must never reach them.
 */
export const SAFE_SEO_CONFIG_PATHS: ReadonlySet<string> = new Set(["public/robots.txt"]);

/** Every line a comment, blank, or a robots.txt directive: nothing that could run anywhere. */
export function isPlainRobotsTxt(content: string): boolean {
  return content.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line) || /^\s*(user-agent|allow|disallow|sitemap|crawl-delay|host)\s*:[^<>`]*$/i.test(line));
}
```

In `generateSafeTechnicalChange`, extend the content check:

```ts
  if (!safeCandidates.some((file) => file.path === parsed.path) || typeof parsed.content !== "string" || parsed.content.length > MAX_SAFE_FILE_LENGTH || !isPlainRobotsTxt(parsed.content)) return null;
```

Export `isPlainRobotsTxt` from `packages/agents/src/index.ts` if that file lists exports explicitly; check it with `grep -n change-generator packages/agents/src/index.ts`.

In `pull-request/route.ts`, extend the stored-change check, which still runs before opening the PR:

```ts
  if (!Object.keys(files).length || Object.keys(files).some((path) => !SAFE_SEO_CONFIG_PATHS.has(path)) || Object.values(files).some((content) => typeof content !== "string" || content.length > MAX_SAFE_FILE_LENGTH || !isPlainRobotsTxt(content))) {
```

Import `isPlainRobotsTxt` from `@organic-growth/agents`.

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm run build:packages && npm test -w @organic-growth/agents`. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add packages/agents/src/change-generator.ts packages/agents/src/change-generator.test.ts packages/agents/src/index.ts "apps/web/app/api/changes/[changeId]/pull-request/route.ts"
git commit -m "Pull requests: static robots.txt only, with plain directives only"
```

---

## Finish

### Task 21: Docs, full verification

**Files:**
- Modify: `apps/web/README.md` ("Access control" and "Current boundaries")
- Modify: `README.md` (environment table: the new secrets)

- [ ] **Step 1: README.** Replace the "Access control" section of `apps/web/README.md` with:
  - **Accounts:** sign-in with Google. Magic link and password are behind `EMAIL_ENABLED` and `PASSWORD_SIGNIN`, which need Workers Paid.
  - **Workspaces and roles:** Owner, Member, Client.
  - **Public paths:** the same list as `src/gate.ts`.
  - **Free limits:** the table, and that `/admin` raises them.
  - **Bootstrap owner:** what `BOOTSTRAP_OWNER_EMAIL` does.
  - **Manual setup:**
    - the Google redirect URI `/api/auth/callback/google`;
    - the GitHub App's "Request user authorization (OAuth) during installation" setting, plus its Client ID and secret;
    - Turnstile keys;
    - the custom domain, since workers.dev is off.

  Remove "One workspace; no multi-user membership or roles" from "Current boundaries". In the root `README.md` environment table, add `BETTER_AUTH_SECRET`, `BOOTSTRAP_OWNER_EMAIL`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `GITHUB_APP_CLIENT_ID`, and `GITHUB_APP_CLIENT_SECRET`.

- [ ] **Step 2: Full verification.** From the worktree root, run `npm test`, then `cd apps/web && node --test "src/**/*.test.ts" "app/**/*.test.ts" && npm run typecheck`. Expected: all green, with typecheck errors no worse than on `origin/main`. Compare with `git stash; npm run typecheck; git stash pop` if unsure.

- [ ] **Step 3: End-to-end on local dev.** Run `npm run dev` on port 5174 against the local D1, and check:
  1. Signed out: `/` goes to sign-in, `/api/sites` is 401, `/p/<site>/…` still renders, and `POST /api/sites/<id>/events` from a customer origin is still accepted.
  2. The bootstrap owner sees every old site, `/admin` works, and a cross-origin `curl -X DELETE` is 403.
  3. A new Google user lands in their own empty workspace. The second site is refused with the site-limit message, and the 4th analysis of the day is refused.
  4. The client flow from Task 15 still works.
  5. GitHub install with user authorization connects; a hand-typed `installation_id` is refused.

- [ ] **Step 4: Commit.**

```bash
git add README.md apps/web/README.md
git commit -m "Docs: accounts, roles, limits, and the setup they need"
```

- [ ] **Step 5: Hand off.** Do not push or open the PR without the user's go-ahead. Report:
  - migration `0024` is not applied remotely;
  - the deploy needs the new secrets set first;
  - the GitHub App setting and the Google redirect URI are manual steps;
  - the workers.dev answer from Task 4.
