# Accounts, workspaces, and security hardening

**Status:** designed 2026-10-10 after a whole-codebase security audit; branch `claude/security-hardening`.

**Goal:** nobody reaches the dashboard, its API, or anyone else's sites without signing in and being allowed to; the public paths (landing pages, conversion events, client links, log ingest) keep working; the OAuth, pull-request, and outbound-fetch weaknesses the audit found are closed.

**Why now:** the app has no authentication. The README relies on Cloudflare Access in front of the hostname, but the Worker's `*.workers.dev` and preview URLs are not disabled, so the same Worker is reachable without Access. Anyone who reaches it can list every site, delete sites, open pull requests, spend LLM/DataForSEO/Browser Rendering budget, and export to Sheets.

**Constraints:**
- Production stays on **Workers Free** (the user's choice): 10 ms CPU per request, and **Email Sending is not available** (Cloudflare Email Service only sends to arbitrary recipients on Workers Paid).
- **D1 free-tier daily limits are already exhausted** (2026-10-10). Every design choice minimises D1 reads and writes per request. Testing is local; migration `0024` is committed, not applied remotely.
- Schema changes may be arriving from another branch: re-check `packages/db/migrations` on `origin/main` before numbering the migration.

**Out of scope:** billing and paid tiers; SSO/SAML; two-factor; audit logs; moving to Workers Paid (the design works on Free and gets more capable on Paid by flipping flags).

The work lands as three ordered parts on one branch: **C** (hardening, independent), **A** (accounts), **B** (OAuth and PR safety, which needs A).

---

## A. Accounts and workspaces

### A1. Library: Better Auth on D1

Better Auth (`better-auth@1.7.7`) runs inside the Worker with its tables in the existing D1 database. It accepts the D1 binding directly (`database: env.DB`, through its built-in D1 Kysely dialect). Plugins: `organization` (workspaces, members, invitations, active workspace on the session), `magicLink`, `captcha` (Turnstile), plus `emailAndPassword` and the Google social provider. `worker.ts` passes `/api/auth/*` straight to `auth.handler`, so no route file is needed.

The auth instance is built once per isolate from `cloudflare:workers` `env` (`apps/web/src/auth.ts`), exporting `auth` and `getSession(request)`.

### A2. Sign-in methods and flags

| Method | On Free | Flag |
|---|---|---|
| Google (`openid email profile` only) | **on** | — |
| Magic link | off (needs Email Sending) | `EMAIL_ENABLED` |
| Email + password | off (PBKDF2 exceeds the 10 ms CPU limit) | `PASSWORD_SIGNIN`, and only when `EMAIL_ENABLED` is also on (sign-up needs verification) |
| Email verification on sign-up | off with email; Google emails arrive verified | `EMAIL_ENABLED` |

- **Google sign-in** reuses `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`; redirect URI `/api/auth/callback/google` must be added in Google Cloud. It is separate from the Search Console connection (which keeps its own grant and scopes).
- **Email** goes through Cloudflare Email Service's `send_email` binding (`EMAIL`). In local dev, and whenever `EMAIL_ENABLED` is off, the message body (link included) is written to the console instead. The plan checks whether `cf/config` can declare a `send_email` binding; if not, the binding is added the way the config tool allows raw bindings.
- **Passwords** hash with WebCrypto PBKDF2-SHA256, 100,000 iterations (the Workers maximum), 16-byte salt, via Better Auth's custom `password.hash`/`verify`. Never scrypt in JS.
- **Sign-up** is open. Turnstile guards sign-up, magic-link requests, and password sign-in (`TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`). With email off, an email/password or magic-link account cannot exist, so every live account has a provider-verified email.

### A3. Sessions, kept cheap on D1

- Cookie: HttpOnly, Secure (on HTTPS), SameSite=Lax, 30 days.
- `session.cookieCache` with a 5-minute max age: most requests read no D1 rows.
- `session.updateAge` of one day: an active user writes about one row a day.
- `BETTER_AUTH_SECRET` (≥ 32 chars) signs sessions; it is **not** `SESSION_SECRET`.

### A4. Data model (migration `0024_accounts.sql`)

- Better Auth tables: `user`, `session`, `account`, `verification`, `organization`, `member`, `invitation` (the shapes Better Auth's CLI generates for these plugins, written into the migration by hand).
- `sites.workspace_id TEXT REFERENCES organization(id) ON DELETE CASCADE`, added with `ALTER TABLE … ADD COLUMN` (nullable; the app always sets it) and then set to `ws_initial` for every existing site. The table is **not** rebuilt: D1 enforces foreign keys, so dropping `sites` would cascade-delete every child row.
- `site_access_invites (invitation_id, site_id)`: the sites a pending Client invitation grants; copied into `site_access` when the invitation is accepted.
- `workspace_github_installations (workspace_id, installation_id, created_at)` (part B).
- `organization` row `ws_initial` ("Eumon") is inserted by the migration.
- `site_access (user_id, site_id, created_at, PRIMARY KEY (user_id, site_id))`, both cascading: client grants.
- `workspace_limits (workspace_id PRIMARY KEY, sites, crawl_pages_per_day, ask_per_day, ai_runs_per_day, members, dataforseo, pull_requests, sheets_export)`. No row = the free defaults in code; `ws_initial` gets a row with no limits.
- `workspace_usage (workspace_id, day, metric, count, PRIMARY KEY (workspace_id, day, metric)) WITHOUT ROWID`.
- `sites.log_token TEXT` (see C9).

**Bootstrap owner:** `BOOTSTRAP_OWNER_EMAIL` (comma-separated). After any sign-in, if the user's verified email is listed and they aren't a member of `ws_initial`, a Better Auth `databaseHooks.session.create.after` hook adds them as its owner. Listed users are also **platform admins** (`/admin`).

### A5. Roles

| Role | Scope | Can |
|---|---|---|
| Owner | workspace | everything a Member can, plus invite/remove members and clients, change the workspace, delete it |
| Member | workspace | read and write every site in the workspace; create sites (within limits) |
| Client | listed sites (`site_access`) | read-only: the Results dashboard, pages, leads; no settings, connections, publishing, deletes, PRs, Ask, or exports |

A Client is a Better Auth organization member with the custom role `client` (defined with the plugin's access control so it can't invite or manage anything). One invitation flow serves both kinds of user: a Client invitation also writes its sites to `site_access_invites`, and the `afterAcceptInvitation` hook copies them into `site_access`. Each user may create one workspace (`organizationLimit: 1`), so free limits can't be multiplied by creating more workspaces. A new user gets a personal workspace at sign-up unless a pending invitation is waiting for their email.

Share links (`/r/*`) keep working unchanged for no-login viewing.

### A6. Enforcement, two layers

**Layer 1: the gate in `worker.ts`.** Before vinext sees a request:
- **Public** (passes through): `/p/*`, `/api/sites/*/events`, `/r/*`, `/api/r/*`, `/api/logs/*` (token-checked), `/api/auth/*`, `/sign-in`, `/invite/*`, static assets, `manifest.json`, `sw.js`, `sw-register.js`.
- **Everything else** needs a session: `/api/*` → `401 {error}`, pages → `303 /sign-in?next=…`.
- **CSRF:** any non-GET/HEAD `/api/*` request (outside `/api/auth/*`, which Better Auth checks itself, and the public endpoints) whose `Origin` isn't the request's own origin → 403.
- The session is attached for routes to read (`getSession(request)` is cached per request).

The gate is a pure function `gate(request, session): Response | null` in `apps/web/src/gate.ts`, so the path table is unit-tested.

**Layer 2: authorization in routes.** One helper in `apps/web/src/access.ts`:

```ts
requireAccess(request, siteId, need: "read" | "write" | "admin"): Promise<Access | Response>
```

It returns `{ user, site, role }` or a 403/404 `Response`. A site the user can't see answers 404, the same as a missing site. Routes keyed by another ID resolve the site first with one resolver per kind:

| ID | Resolves via |
|---|---|
| analysisId | `analyses.site_id` |
| changeId | change → analysis → site |
| datasetId | `datasets.site_id` |
| recordId | `data_records.site_id` |
| sourceId | source → dataset → site |
| templateId | template → dataset → site |
| pageId | `generated_pages.site_id` |
| jobId | the job's site |

Per route, the required level: `GET` routes are `read` unless they expose secrets or connections (`connectors`, `integration`, `gsc/properties`, `ga4/properties`, `share` → `write`); every POST/PUT/PATCH/DELETE is `write`; `DELETE /api/sites/:id` is `admin`; minting and revoking a share link is `write` (Members share Results with clients). The plan carries the full route table; a test asserts every `route.ts` calls the guard or is on the public list.

**Workspace-scoped routes:**
- `GET /api/sites` returns the active workspace's sites, plus any sites a Client was granted.
- `POST /api/sites` creates the site in the active workspace and requires Member or Owner. It no longer reuses another workspace's site with the same origin: the same origin may exist in two workspaces.
- `POST /api/dev/demo-site` (local only) seeds into the caller's workspace.

**Background work** (cron, workflows) runs inside the Worker, never through the gate, and is unchanged except for the limit checks below.

### A7. Free limits

Defaults for a workspace with no `workspace_limits` row:

| Limit | Default | Checked at |
|---|---|---|
| Sites | 1 | `POST /api/sites` (count) |
| Analyses per day | 3 | `POST /api/sites/:id/analyses` |
| Scrape pages per day | 500 | `POST /api/datasets/:id/scrape`, charged the sum of the started sources' `maxPages` |
| Ask questions per day | 20 | `POST /api/sites/:id/assistant` |
| AI generation runs per day | 10 | template generate, snippets, scope, source preview |
| Members + clients | 3 | invitations |
| DataForSEO | off | the sync skips DataForSEO sources for the workspace |
| Pull requests, Sheets export | off | the routes answer 403 with the reason |

- Usage is one upsert per costly action (`workspace_usage`), never per page view or beacon.
- A refused action answers `429 {error, limit}` and the UI shows the message.
- `/admin` (platform admins only) lists workspaces with their sites, members, and today's usage, and edits `workspace_limits`.

### A8. UI

Pages `/sign-in` (one page for signing in and signing up: Google creates the account on first use, and the password form has a sign-up toggle), `/invite/[id]`, and `/admin`, plus a workspace switcher and members panel (Setup → Members: invite by email, with a copy-paste link while email is off; roles; client site grants). Styling follows `apps/web/DESIGN.md`: square corners, hairline rules, Geist. Buttons for flagged-off methods are not rendered. Client users see the dashboard with write controls hidden; the API refuses them regardless.

---

## B. OAuth and pull-request safety

### B1. GitHub installations are verified and belong to a workspace

- The GitHub App setting "Request user authorization (OAuth) during installation" is turned on (manual step).
- `/api/github/callback` keeps its state-cookie check. It then exchanges `code` for a user token, calls `GET /user/installations`, and accepts `installation_id` only if it is listed.
- The installation is stored in `workspace_github_installations (workspace_id, installation_id, created_at)`. This replaces the `og_installation` cookie, which is deleted. Migration `0024` adds the table.
- `GET /api/github/repositories` and `POST /api/sites` with a `repositoryId` use only the active workspace's installations.

### B2. Google connect is bound to the browser and the user

- `/api/sites/:id/gsc/connect` requires `write` on the site. It puts a random nonce in an HttpOnly, SameSite=Lax cookie scoped to `/api/google/callback`, and signs `{siteId, nonce, userId}` into `state`.
- The callback requires that the cookie nonce equals the state nonce, that the session user is the state's `userId`, and that the user still has `write` on the site.

### B3. Pull requests change only `public/robots.txt`

- `SAFE_SEO_CONFIG_PATHS` becomes `{"public/robots.txt"}`. The model's output must not contain `<`, backticks, or `import`/`export`; anything else is rejected rather than committed.
- Opening a PR requires `write` and the workspace's `pull_requests` limit to be on.

---

## C. Hardening (independent of A)

1. **No workers.dev or preview URLs:** `cloudflare.config.ts` sets them off. The plan confirms the option names `cf/config` uses.
2. **Trailing dots:** `isSafePublicUrl` strips one trailing dot from the hostname before its checks, so `localhost.`, `x.internal.`, and `printer.local.` are refused.
3. **Supabase pull:** `https:` only, host must end `.supabase.co`, `AbortSignal.timeout(15_000)`, body read through a 5 MB capped reader.
4. **Sitemap cap:** stays 25 MB (Google allows 50 MB sitemaps, so a 10 MB cap would break real sites); the comment that says 10 MB is corrected.
5. **Browser render:** WebSocket connections, which request interception never sees, are blocked through CDP `Network.setBlockedURLs` (`ws://*`, `wss://*`). Third-party subresources stay allowed, because client-rendered pages need their CDNs and APIs to render.
6. **Beacon variants:** the variant counter update also requires `active = 1` (it was already limited to the site's own variants).
7. **CSV formulas:** the guard regex becomes `/^[=+\-@\t\r]/`.
8. **Security headers:**
   - Dashboard responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'`.
   - `/p/*` HTML: `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Content-Security-Policy: base-uri 'none'; object-src 'none'`. Frame embedding stays allowed there, since customers' proxies may need it.
   - **Ceiling:** neither CSP restricts `script-src`. vinext writes inline RSC payload scripts and the landing-page beacon is an inline script with per-page config, so a script policy needs per-request nonces threaded through both renderers. The renderer's escaping (audited clean) stays the XSS defence; a nonce-based `script-src` is the upgrade.
9. **Per-site log token:** `sites.log_token` is nullable. While it is null, `tokenMatches` accepts the existing `SESSION_SECRET`-derived token, so configured log drains keep working. "Rotate" in Connectors stores a random 32-byte token; from then on only the stored token is accepted.
10. **Proxy snippets** (Worker, nginx, Apache) stop forwarding `Cookie` and `Authorization`.
11. **Dependencies:** pin `react`/`react-dom` to the installed versions; apply non-breaking `npm audit fix`.

---

## New configuration

| Name | Kind | Needed |
|---|---|---|
| `BETTER_AUTH_SECRET` | secret | yes |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | secret | yes (the GitHub App's OAuth credentials, for B1) |
| `AUTH_RATE_LIMIT` | `rateLimit` binding | yes (10 requests / 60 s per IP on `/api/auth/*`) |
| `BOOTSTRAP_OWNER_EMAIL` | secret | yes |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | secret | yes |
| `EMAIL` | `send_email` binding | yes (declared; sends only once on Paid) |
| `EMAIL_ENABLED`, `PASSWORD_SIGNIN` | var | no (off when unset) |
| Google redirect URI `/api/auth/callback/google` | Google Cloud console | yes |
| GitHub App "Request user authorization during installation" | GitHub App settings | yes |

Every declared secret must exist before a deploy (Cloudflare has no optional secrets).

## Testing

Each test uses the repo's `*.test.ts` pattern with the SQLite helper in `packages/db/src/sqlite.ts`:

- `gate.test.ts`: every public path passes without a session; protected API and page paths answer 401 and 303; the Origin check refuses cross-site writes and allows same-origin ones.
- `access.test.ts`: the role × level matrix (Owner, Member, Client granted, Client not granted, other workspace, no session) for each ID kind's resolver; a foreign site answers 404.
- `routes-guarded.test.ts`: walks `apps/web/app/api/**/route.ts` and fails if a non-public route never calls `requireAccess` (or a workspace-level guard).
- `limits.test.ts`: each limit refuses at its threshold and counts once per action; `ws_initial` is unlimited.
- `github-install.test.ts`: an installation not in `/user/installations` (mocked) is refused; a listed one is stored for the workspace.
- `google-state.test.ts`: a missing or mismatched nonce cookie is refused, as are a different user and lost write access.
- Hardening: trailing-dot hosts, the Supabase host/timeout/cap, the beacon variant check, the CSV regex, the PR path set and content check, the log token.
- Manual on local dev (port 5174): Google sign-up, then a new workspace and one site; the limit refusal; inviting a client by link; the client's read-only view; the bootstrap owner seeing the existing sites.
