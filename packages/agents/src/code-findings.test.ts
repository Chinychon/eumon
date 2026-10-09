import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrawlCoverage } from "@organic-growth/core";
import { analyzeRepository } from "@organic-growth/repo-analyzer";
import { findingsFromCode } from "./code-findings.js";

const repo = analyzeRepository({
  packageJson: { dependencies: { next: "15", react: "19", "@supabase/supabase-js": "2" } },
  treePaths: ["app/layout.tsx", "app/doctors/[slug]/page.tsx", "app/procedures/[slug]/page.tsx", "app/sitemap.ts"],
  files: [
    { path: "app/layout.tsx", content: `export const metadata = { title: "Medbay" };` },
    { path: "app/doctors/[slug]/page.tsx", content: `export const revalidate = 3600;
export async function generateMetadata({ params }) { return { title: params.slug }; }
export default async function Page({ params }) { const d = await getDoctor(params.slug); return <h1>{d.name}</h1>; }` },
    { path: "app/procedures/[slug]/page.tsx", content: `"use client";
import { useEffect, useState } from "react";
export default function Page({ params }) {
  const [p, setP] = useState(null);
  useEffect(() => { fetch("/api/procedures/" + params.slug).then((r) => r.json()).then(setP); }, []);
  return <h1>{p?.name}</h1>;
}` },
    { path: "app/sitemap.ts", content: `export default async function sitemap() {
  const { data } = await supabase.from("doctors").select("slug");
  return data.map((row) => ({ url: "https://medbay.example/doctors/" + row.slug }));
}` },
  ],
});

const coverage: CrawlCoverage = {
  totalUrls: 1050, completedUrls: 1050, failedUrls: 0, pendingUrls: 0, emptyShellUrls: 48, httpErrorUrls: 0, missingTitleUrls: 0,
  families: [
    { family: "doctors", urls: 1000, crawled: 1000, emptyShells: 0, errors: 0, noindex: 0, missingStructuredData: 0 },
    { family: "procedures", urls: 50, crawled: 50, emptyShells: 48, errors: 0, noindex: 0, missingStructuredData: 50 },
  ],
  duplicateTitleGroups: [{ title: "Medbay", count: 48, examples: ["https://medbay.example/procedures/ivf", "https://medbay.example/procedures/lasik"] }],
};

describe("findingsFromCode", () => {
  const findings = findingsFromCode({ siteId: "s", analysisId: "a", repo, coverage, familySizes: { doctors: 1000, procedures: 50 } });
  const find = (prefix: string) => findings.find((finding) => finding.title.startsWith(prefix));

  it("explains empty shells with the code that causes them", () => {
    const finding = find("/procedures/ pages fetch their content in the browser");
    assert.ok(finding, findings.map((entry) => entry.title).join(" | "));
    assert.ok(finding.summary.includes("app/procedures/[slug]/page.tsx"));
    assert.ok(finding.summary.includes("48 of 50 /procedures/ pages returned an empty"), finding.summary);
    assert.ok(["CRITICAL", "HIGH"].includes(finding.severity), finding.severity);
    assert.equal(finding.category, "repository");
  });

  it("ties duplicate titles to a template without its own metadata", () => {
    const finding = find("/procedures/ pages don't get their own title");
    assert.ok(finding?.summary.includes("inherits the same title"), finding?.summary ?? "missing");
    assert.ok(finding?.summary.includes("duplicate titles"));
    assert.equal(find("/doctors/ pages don't get their own title"), undefined, "the doctor template sets its own metadata");
  });

  it("catches Supabase's 1,000-row cap behind a sitemap of exactly 1,000 URLs", () => {
    const finding = find("The sitemap stops at 1,000 /doctors/ pages");
    assert.ok(finding, findings.map((entry) => entry.title).join(" | "));
    assert.equal(finding.severity, "HIGH");
    assert.ok(finding.recommendation?.includes(".range("));
  });
});
