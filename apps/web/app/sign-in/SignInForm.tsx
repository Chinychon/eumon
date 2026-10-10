"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "../components/auth-client";
import { BrandMark } from "../components/pixel";
import { Button, Field } from "../components/ui";

declare global {
  interface Window { turnstile?: { render(el: HTMLElement, options: { sitekey: string; callback(token: string): void }): string; reset(id?: string): void } }
}

/** Turnstile guards the email and password endpoints (Better Auth's captcha plugin reads x-captcha-response). */
function useTurnstile(siteKey: string, active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState("");
  const widget = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active || !ref.current) return;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.onload = () => ref.current && (widget.current = window.turnstile?.render(ref.current, { sitekey: siteKey, callback: setToken }));
    document.head.appendChild(script);
    return () => { script.remove(); };
  }, [siteKey, active]);
  /** Tokens are single-use: call after every attempt. */
  const reset = () => { setToken(""); window.turnstile?.reset(widget.current); };
  return { ref, token, reset };
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
    if (label !== "google") turnstile.reset();
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
          {!passwordOn && <Button type="submit" variant="secondary" busy={busy === "link"} disabled={!turnstile.token}>Email me a sign-in link</Button>}
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
      {message && <p className="callout">{message}</p>}
      {error && <p className="callout error" role="alert">{error}</p>}
    </main>
  );
}
