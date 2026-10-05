# Organic Growth Engine MVP

The pilot supports a single workspace with GitHub App repository access, repository analysis, a bounded public-site crawl with browser rendering, an evidence-based growth plan, optional Google Search Console metrics, owner-selected competitor homepage checks, a small conversion event SDK, and persistent analysis jobs in Cloudflare D1/Workflows. The app is designed to sit behind Cloudflare Access; configure Access for the app hostname before connecting private repositories.

## Local setup

1. Install dependencies from the repository root with `npm install`.
2. Create a GitHub App with callback URL `http://localhost:5173/api/github/callback` and selected repository permissions for Metadata read, Contents read/write, and Pull requests read/write. Write access is used only after an explicit action to open a draft PR.
3. Configure a local D1 database, set `CF_D1_DATABASE_ID`, and apply migrations from `packages/db/migrations`.
4. Set `SESSION_SECRET` to a random value of at least 32 characters.
5. To enable Google Search Console, configure a Google OAuth web client. Add `http://localhost:5173/api/google/callback` as an authorized redirect URI. Enable the Search Console API, then provide `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `OAUTH_ENCRYPTION_KEY`. The encryption key must be base64url for exactly 32 random bytes.
6. Run `npm run dev -w @organic-growth/web`.

The Worker needs D1, Workers AI, Browser Rendering, and the `site-analysis` Workflow binding. Cloudflare deployment also requires a real D1 database ID and the corresponding GitHub/Google secrets. Apply migrations before starting the app.

## Conversion SDK

Build `@organic-growth/sdk`, then initialize it in a website with the site ID and the deployed API base URL:

```ts
import { createOrganicGrowthTracker } from "@organic-growth/sdk";

const tracker = createOrganicGrowthTracker({
  siteId: "site_…",
  endpoint: "https://YOUR-APP-HOST/api/sites",
});

tracker.track("whatsapp_click", { destination: "sales" });
```

The SDK sends event name, destination label, page path (query string removed by the server), and a random anonymous session ID. It does not collect form values or arbitrary properties. Event ingestion only accepts requests from the connected website origin.

## Current boundaries

- Search Console imports a bounded finalized 28-day query/page/country/device sample. Search Console's reporting API can omit rows under its own privacy and data limits.
- Competitor entries are domains supplied by the workspace owner. The current report records one homepage fetch per domain; it does not claim to know competitor rankings, traffic, or full-site architecture.
- Conversion events are stored, but lead qualification and revenue attribution are not yet implemented.
- Automated patches are limited to existing `robots.txt` and sitemap configuration files. The user inspects the generated full-file diff and explicitly opens a draft PR; the app does not merge or deploy it.
- Protect the hosted workspace with Cloudflare Access. The MVP does not implement multi-user membership or tenant roles itself.
