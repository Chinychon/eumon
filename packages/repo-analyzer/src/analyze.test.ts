import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { analyzeRepository, routeSourceCandidates, type RepoSnapshot } from "./analyze.js";
import { createGitHubApiClient } from "./github.js";
import { routeFamily } from "./routes.js";

const snapshot = (packageJson: Record<string, unknown>, files: Record<string, string>, extraPaths: string[] = []): RepoSnapshot => ({
  packageJson,
  treePaths: [...Object.keys(files), ...extraPaths],
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
});

describe("Next.js App Router inspection", () => {
  const repo = analyzeRepository(snapshot({ dependencies: { next: "15.0.0", react: "19", "@supabase/supabase-js": "2" } }, {
    "app/layout.tsx": `export const metadata = { title: "Medbay" };\nexport default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    "app/doctors/[slug]/page.tsx": `import { supabase } from "@/lib/supabase";
export async function generateStaticParams() {
  const { data } = await supabase.from("doctors").select("slug");
  return data.map((row) => ({ slug: row.slug }));
}
export async function generateMetadata({ params }) {
  const { data } = await supabase.from("doctors").select("*").eq("slug", params.slug).single();
  return { title: data.name };
}
export default async function Doctor({ params }) {
  const doctor = await getDoctor(params.slug);
  const hospital = await getHospital(doctor.hospitalId);
  const reviews = await getReviews(doctor.id);
  const related = await getRelated(doctor.specialty);
  return <main><h1>{doctor.name}</h1></main>;
}`,
    "app/procedures/[slug]/page.tsx": `"use client";
import { useEffect, useState } from "react";
export default function Procedure({ params }) {
  const [procedure, setProcedure] = useState(null);
  useEffect(() => {
    fetch("/api/procedures/" + params.slug).then((r) => r.json()).then(setProcedure);
  }, [params.slug]);
  return <main>{procedure ? <h1>{procedure.name}</h1> : null}</main>;
}`,
    "app/sitemap.ts": `import { supabase } from "@/lib/supabase";
export default async function sitemap() {
  const { data } = await supabase.from("doctors").select("slug, updated_at");
  return data.map((row) => ({ url: "https://medbay.example/doctors/" + row.slug }));
}`,
  }));
  const route = (pattern: string) => repo.routeInspections.find((entry) => entry.pathPattern === pattern)!;

  it("detects the stack", () => {
    assert.equal(repo.fingerprint.framework, "Next.js");
    assert.equal(repo.fingerprint.router, "App Router");
    assert.equal(repo.fingerprint.database, "Supabase");
    assert.deepEqual(repo.routes.map((entry) => entry.pathPattern).sort(), ["/doctors/:slug", "/procedures/:slug"]);
  });

  it("reads rendering, metadata, and request waterfalls per route", () => {
    const doctor = route("/doctors/:slug");
    assert.equal(doctor.rendering, "static");
    assert.equal(doctor.prebuildsPaths, true);
    assert.equal(doctor.metadata, "server");
    assert.equal(doctor.clientDataFetching, undefined);
    assert.ok(doctor.sequentialAwaits >= 4, `found ${doctor.sequentialAwaits}`);
  });

  it("flags templates whose content is fetched in the browser", () => {
    const procedure = route("/procedures/:slug");
    assert.equal(procedure.rendering, "on_demand");
    assert.ok(procedure.clientDataFetching?.startsWith("useEffect → fetch("), procedure.clientDataFetching ?? "none");
    assert.equal(procedure.metadata, "inherited", "only the root layout's generic title applies");
  });

  it("flags a sitemap built from one unbounded query", () => {
    assert.equal(repo.sitemapCode?.source, "app/sitemap.ts");
    assert.equal(repo.sitemapCode?.splitsSitemaps, false);
    assert.equal(repo.sitemapCode?.unboundedQueries.length, 1);
    assert.ok(repo.sitemapCode?.unboundedQueries[0]?.startsWith("doctors:"));
  });
});

describe("Vite + React single-page app inspection", () => {
  const repo = analyzeRepository(snapshot({ dependencies: { react: "18", "react-dom": "18", "react-router-dom": "6", "react-helmet-async": "2", "@supabase/supabase-js": "2" }, devDependencies: { vite: "5" } }, {
    "src/App.tsx": `import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import ClinicPage from "./pages/ClinicPage";
export default function App() {
  return <BrowserRouter><Routes>
    <Route path="/" element={<Index />} />
    <Route path="/clinics/:id" element={<ClinicPage />} />
  </Routes></BrowserRouter>;
}`,
    "src/pages/ClinicPage.tsx": `import { Helmet } from "react-helmet-async";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
export default function ClinicPage() {
  const [clinic, setClinic] = useState(null);
  useEffect(() => { supabase.from("clinics").select("*").then(({ data }) => setClinic(data)); }, []);
  return <><Helmet><title>{clinic?.name}</title></Helmet><h1>{clinic?.name}</h1></>;
}`,
  }, ["src/pages/Index.tsx", "vite.config.ts"]));

  it("resolves each route to its page component and reads it", () => {
    assert.equal(repo.fingerprint.framework, "Vite + React");
    assert.equal(repo.fingerprint.rendering, "CSR SPA");
    const clinic = repo.routeInspections.find((entry) => entry.pathPattern === "/clinics/:id")!;
    assert.equal(clinic.source, "src/pages/ClinicPage.tsx");
    assert.equal(clinic.rendering, "client");
    assert.ok(clinic.clientDataFetching?.includes("supabase"), clinic.clientDataFetching ?? "none");
    assert.equal(clinic.metadata, "client");
    assert.deepEqual(clinic.unboundedQueries.map((query) => query.split(":")[0]), ["clinics"]);
  });
});

describe("routeSourceCandidates", () => {
  it("reads dynamic templates first and skips API routes and build output", () => {
    const candidates = routeSourceCandidates([
      "app/page.tsx", "app/about/page.tsx", "app/doctors/[slug]/page.tsx", "app/layout.tsx", "app/api/x/route.ts",
      ".next/server/app/page.js", "app/sitemap.ts", "src/components/Button.tsx",
    ]);
    assert.ok(candidates.indexOf("app/doctors/[slug]/page.tsx") < candidates.indexOf("app/about/page.tsx"));
    assert.ok(candidates.includes("app/sitemap.ts") && candidates.includes("app/layout.tsx"));
    assert.equal(candidates.some((path) => path.includes("api/") || path.startsWith(".next") || path.includes("components")), false);
  });
});

describe("routeFamily", () => {
  it("matches the crawler's grouping, ignoring locale parameters", () => {
    assert.equal(routeFamily("/:locale/doctors/:slug"), "doctors");
    assert.equal(routeFamily("/doctors"), "page");
    assert.equal(routeFamily("/"), "home");
  });
});

describe("GitHub file contents", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("decodes base64 content as UTF-8", async () => {
    const text = "Dokter spesialis jantung — 心脏科医生";
    globalThis.fetch = (async () => Response.json({ encoding: "base64", content: Buffer.from(text).toString("base64") })) as typeof fetch;
    assert.equal(await createGitHubApiClient("token").getFileContent("o", "r", "app/page.tsx"), text);
  });
});
