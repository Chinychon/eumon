import { env } from "cloudflare:workers";
import { createSignedInstallationCookie } from "@organic-growth/repo-analyzer";

function cookie(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export async function GET(request: Request) {
  const current = new URL(request.url);
  const state = current.searchParams.get("state");
  const installationId = current.searchParams.get("installation_id");
  const secure = current.protocol === "https:" ? "; Secure" : "";
  const expected = cookie(request, "og_github_state");
  const destination = new URL("/", current.origin);
  const headers = new Headers({ Location: destination.toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", `og_github_state=; HttpOnly${secure}; SameSite=Lax; Path=/api/github/callback; Max-Age=0`);

  if (!state || !expected || state !== expected || !installationId || !/^\d+$/.test(installationId)) {
    destination.searchParams.set("github_error", "installation_invalid");
    headers.set("Location", destination.toString());
    return new Response(null, { status: 303, headers });
  }

  try {
    const signed = await createSignedInstallationCookie(installationId, env.SESSION_SECRET);
    headers.append("Set-Cookie", `og_installation=${signed}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=604800`);
    destination.searchParams.set("github", "connected");
    headers.set("Location", destination.toString());
    return new Response(null, { status: 303, headers });
  } catch {
    destination.searchParams.set("github_error", "installation_failed");
    headers.set("Location", destination.toString());
    return new Response(null, { status: 303, headers });
  }
}
