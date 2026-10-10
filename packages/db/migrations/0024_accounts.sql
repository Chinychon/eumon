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

-- No ON DELETE CASCADE here: deleting a workspace that still has sites must fail, not wipe their data (0019 cascades from sites).
ALTER TABLE sites ADD COLUMN workspace_id TEXT REFERENCES "organization" ("id");
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
