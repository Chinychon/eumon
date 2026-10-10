import { env } from "cloudflare:workers";
import { emailEnabled, passwordEnabled } from "../../src/auth";
import { safeNext } from "../../src/next-path";
import { SignInForm } from "./SignInForm";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const flags = env as unknown as { EMAIL_ENABLED?: string; PASSWORD_SIGNIN?: string; TURNSTILE_SITE_KEY: string };
  return <SignInForm next={safeNext((await searchParams).next)} email={emailEnabled(flags)} password={passwordEnabled(flags)} turnstileSiteKey={flags.TURNSTILE_SITE_KEY} />;
}
