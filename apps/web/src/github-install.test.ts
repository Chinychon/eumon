import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

it("no route reads the old og_installation cookie", () => {
  for (const file of ["../app/api/github/repositories/route.ts", "../app/api/sites/route.ts"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /og_installation=/, file);
  }
});
