import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageInspection } from "@organic-growth/crawler";
import { auditConversion, findingsFromConversion } from "./conversion.js";

const page = (family: string, conversion: Partial<PageInspection["conversion"]>, tracking: string[] = []): PageInspection => ({
  url: `https://medbay.example/${family}/x`, family, status: 200, textLength: 3000, emptyShell: false, schemaTypes: [], faq: false, tracking,
  conversion: { whatsapp: false, phone: false, email: false, form: false, booking: false, prices: false, ...conversion },
});

describe("conversion audit", () => {
  it("flags templates with no call to action and proposes events for the paths that exist", () => {
    const audit = auditConversion([page("home", { whatsapp: true, form: true }, ["Google Analytics"]), page("doctors", {}), page("procedures", { phone: true })]);
    assert.deepEqual(audit.templates.map((template) => template.paths), [["whatsapp", "form"], [], ["phone"]]);
    assert.deepEqual(audit.suggestedEvents.map((entry) => entry.event).slice(0, 5), ["page_view", "whatsapp_click", "phone_click", "form_start", "form_submit"]);
    const findings = findingsFromConversion(audit, { siteId: "s", analysisId: "a", familySizes: { doctors: 7000 } });
    assert.deepEqual(findings.map((finding) => finding.title), ["No call to action on /doctors/ pages"]);
    assert.ok(findings[0]!.summary.includes("~7,000 pages"));
    assert.equal(findings[0]!.category, "conversion");
  });

  it("reports a site with no way to convert and nothing measuring it", () => {
    const audit = auditConversion([page("home", {}), page("doctors", {}), page("blog", {}, []), { ...page("x", { whatsapp: true }), emptyShell: true }]);
    const titles = findingsFromConversion(audit, { siteId: "s", analysisId: "a", familySizes: {} }).map((finding) => finding.title);
    assert.deepEqual(titles, ["Visitors have no obvious way to get in touch", "No analytics or conversion tracking found"]);
    assert.equal(audit.templates.length, 3, "empty shells are not judged");
  });
});
