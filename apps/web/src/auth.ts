import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { captcha, magicLink, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { grantInvitedSites, memberSlotsUsed, revokeWorkspaceSiteAccess, setUpNewUser, workspaceForNewSession, type D1Like } from "@organic-growth/db";
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
    socialProviders: { google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // The same OAuth client also grants Search Console; keep sign-in tokens sign-in scoped.
        includeGrantedScopes: false,
      },
    },
    account: { encryptOAuthTokens: true },
    // On Cloudflare the real client IP is cf-connecting-ip (used for captcha remoteIP and session records).
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
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
        // Deleting a workspace must be a deliberate, built feature; the API must not let an owner wipe one.
        disableOrganizationDeletion: true,
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
          afterRemoveMember: async ({ member, organization: workspace }) => {
            await revokeWorkspaceSiteAccess(db, workspace.id, member.userId);
          },
        },
      }),
      ...(emailEnabled(env) ? [magicLink({ sendMagicLink: async ({ email, url }) => deliver(env, email, "Your Eumon sign-in link", `Sign in here: ${url}`) })] : []),
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: env.TURNSTILE_SECRET_KEY,
        // Defaults plus magic link (which also creates accounts) and verification email.
        endpoints: ["/sign-up/email", "/sign-in/email", "/sign-in/magic-link", "/request-password-reset", "/send-verification-email"],
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let cached: Auth | undefined;
/** One Better Auth instance per isolate, whatever env object a caller holds (env is fixed for an isolate's lifetime). */
export function authFor(env: AuthEnv): Auth {
  return (cached ??= createAuth(env));
}
