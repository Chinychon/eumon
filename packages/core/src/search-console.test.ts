import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GSC_REASONS, gscReason, parseSearchConsoleExport, reasonFromFileName, suggestRedirect, todayStatus } from "./search-console.js";

const csv = (lines: string[]) => `${lines.join("\r\n")}\r\n`;

describe("parseSearchConsoleExport", () => {
  it("reads a reason's URL list: BOM, CRLF, quoted fields, Last crawled as a day", () => {
    const text = `﻿${csv(["URL,Last crawled", '"https://medbay.example/doctors/dr-lee","Oct 6, 2026"', "https://medbay.example/id/doctors/dr-lee,2026-10-05", "https://other.example/x,2026-10-01"])}`;
    const parsed = parseSearchConsoleExport(text, "medbay.example");
    assert.equal(parsed.kind, "urls");
    if (parsed.kind !== "urls") return;
    assert.deepEqual(parsed.urls, [
      { url: "https://medbay.example/doctors/dr-lee", lastCrawled: "2026-10-06" },
      { url: "https://medbay.example/id/doctors/dr-lee", lastCrawled: "2026-10-05" },
    ]);
    assert.equal(parsed.otherHost, 1, "another property's URL is counted, not imported");
  });

  it("finds the URL and date columns by their values when the header is in another language, and www is the same host", () => {
    const parsed = parseSearchConsoleExport(csv(["Laatst gecrawld,URL", "2026-10-05,https://www.medbay.example/doctors/a", ",https://www.medbay.example/doctors/b"]), "medbay.example");
    assert.equal(parsed.kind, "urls");
    if (parsed.kind !== "urls") return;
    assert.deepEqual(parsed.urls, [{ url: "https://www.medbay.example/doctors/a", lastCrawled: "2026-10-05" }, { url: "https://www.medbay.example/doctors/b", lastCrawled: null }]);
  });

  it("reads the overview table with normalised reasons and numeric pages", () => {
    const text = csv(["Reason,Source,Validation,Trend,Pages", 'Discovered - currently not indexed,Google systems,Not Started,,"23,100"', "Excluded by 'noindex' tag,Website,Failed,,468", "Not found (404),Website,Not Started,,6"]);
    const parsed = parseSearchConsoleExport(text, "medbay.example");
    assert.equal(parsed.kind, "table");
    if (parsed.kind !== "table") return;
    assert.deepEqual(parsed.rows.map((row) => [row.reason, row.reasonText, row.source, row.validation, row.pages]), [
      ["discovered", "Discovered - currently not indexed", "Google systems", "Not Started", 23100],
      ["noindex", "Excluded by 'noindex' tag", "Website", "Failed", 468],
      ["not_found", "Not found (404)", "Website", "Not Started", 6],
    ]);
  });

  it("reads the chart as days", () => {
    const parsed = parseSearchConsoleExport(csv(["Date,Indexed,Not indexed", '9/19/2026,"1,774","3,309"', "2026-09-22,1561,24498"]), "medbay.example");
    assert.equal(parsed.kind, "chart");
    if (parsed.kind !== "chart") return;
    assert.deepEqual(parsed.points, [{ day: "2026-09-19", indexed: 1774, notIndexed: 3309 }, { day: "2026-09-22", indexed: 1561, notIndexed: 24498 }]);
  });

  it("says what it could not recognise, and lists nothing from another property", () => {
    const unknown = parseSearchConsoleExport(csv(["a,b", "1,2"]), "medbay.example");
    assert.equal(unknown.kind, "unknown");
    if (unknown.kind === "unknown") assert.match(unknown.why, /URL/);
    const elsewhere = parseSearchConsoleExport(csv(["URL,Last crawled", "https://other.example/a,2026-10-01", "https://other.example/b,2026-10-01"]), "medbay.example");
    assert.equal(elsewhere.kind, "urls");
    if (elsewhere.kind === "urls") assert.deepEqual([elsewhere.urls.length, elsewhere.otherHost], [0, 2]);
  });
});

describe("gscReason", () => {
  it("normalises every reason Search Console writes, and keeps the rest as other", () => {
    const cases: Array<[string, string]> = [
      ["Discovered - currently not indexed", "discovered"], ["Crawled - currently not indexed", "crawled"], ["Excluded by 'noindex' tag", "noindex"],
      ["Duplicate, Google chose different canonical than user", "duplicate_canonical"], ["Alternate page with proper canonical tag", "alternate_canonical"],
      ["Duplicate without user-selected canonical", "duplicate_no_canonical"], ["Page with redirect", "redirect"], ["Not found (404)", "not_found"], ["Soft 404", "soft_404"],
      ["Server error (5xx)", "server_error"], ["Blocked by robots.txt", "blocked_robots"], ["Blocked due to access forbidden (403)", "blocked_access"], ["Indexed", "indexed"], ["Something Google adds next year", "other"],
    ];
    for (const [text, reason] of cases) assert.equal(gscReason(text), reason, text);
    assert.ok(GSC_REASONS.every((entry) => typeof entry.label === "string" && entry.reason), "every reason has a label");
  });
});

describe("reasonFromFileName", () => {
  it("takes the reason from an export's file name when it names one", () => {
    assert.equal(reasonFromFileName("medbay.example-Coverage-Drilldown-2026-10-09 Excluded by 'noindex' tag.zip"), "noindex");
    assert.equal(reasonFromFileName("Discovered - currently not indexed.csv"), "discovered");
    assert.equal(reasonFromFileName("Table.csv"), null);
  });
});

describe("todayStatus", () => {
  it("says what a URL is today from a crawl or live result", () => {
    const url = "https://x.com/a";
    assert.equal(todayStatus({ url, status: 200 }), "indexable");
    assert.equal(todayStatus({ url, status: 200, noindex: true }), "noindex");
    assert.equal(todayStatus({ url, status: 200, finalUrl: "https://x.com/b" }), "redirect");
    assert.equal(todayStatus({ url, status: 200, finalUrl: "https://x.com/a/" }), "indexable", "a trailing slash is the same page");
    assert.equal(todayStatus({ url, status: 404 }), "gone");
    assert.equal(todayStatus({ url, status: 410 }), "gone");
    assert.equal(todayStatus({ url, status: 503 }), "error");
    assert.equal(todayStatus({ url, status: null }), "unchecked");
    assert.equal(todayStatus(null), "unchecked");
  });
});

describe("suggestRedirect", () => {
  const live = ["https://x.com/doctors/dr-catherine-lee-tong-how", "https://x.com/doctors/dr-lee-wong", "https://x.com/hospitals/pantai-hospital-melaka", "https://x.com/doctors/dato-dr-badrul-shah-badaruddin"];
  it("pairs a dead slug with the live page whose slug contains all its words, preferring the closest", () => {
    assert.equal(suggestRedirect("https://x.com/doctors/catherine-lee", live), "https://x.com/doctors/dr-catherine-lee-tong-how");
    assert.equal(suggestRedirect("https://x.com/hospitals/pantai-melaka", live), "https://x.com/hospitals/pantai-hospital-melaka");
    assert.equal(suggestRedirect("https://x.com/doctors/dr-badaruddin", live), "https://x.com/doctors/dato-dr-badrul-shah-badaruddin", "one long word is enough; dr is ignored");
  });
  it("never pairs on a short common word alone, or across page types", () => {
    assert.equal(suggestRedirect("https://x.com/doctors/lee", live), null);
    assert.equal(suggestRedirect("https://x.com/doctors/dr-lee", live), null);
    assert.equal(suggestRedirect("https://x.com/clinics/pantai-melaka", live), null, "another page type");
  });
});
