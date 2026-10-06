import { createId, severityFromImpact, type ConversionEventName, type Finding } from "@organic-growth/core";
import type { PageInspection } from "@organic-growth/crawler";

type Path = "whatsapp" | "phone" | "email" | "form" | "booking";

/** How each page template lets a visitor become a lead, and whether anything measures it. */
export type ConversionAudit = {
  templates: Array<{ family: string; url: string; paths: Path[]; prices: boolean; tracking: string[] }>;
  /** Analytics and conversion-tracking tools seen on any inspected page. */
  tracking: string[];
  /** Events worth tracking, from the conversion paths the site actually has. */
  suggestedEvents: Array<{ event: ConversionEventName; trigger: string }>;
};

const PATHS: Path[] = ["whatsapp", "phone", "email", "form", "booking"];
const familyLabel = (family: string) => (family === "home" ? "the homepage" : family === "page" ? "top-level pages" : `/${family}/ pages`);

/** Reads conversion paths and tracking from one inspected page per template. */
export function auditConversion(inspections: PageInspection[]): ConversionAudit {
  const served = inspections.filter((page) => page.status < 400 && !page.emptyShell);
  const templates = served.map((page) => ({
    family: page.family,
    url: page.url,
    paths: PATHS.filter((path) => page.conversion[path]),
    prices: page.conversion.prices,
    tracking: page.tracking ?? [],
  }));
  const present = new Set(templates.flatMap((template) => template.paths));
  const suggestedEvents: ConversionAudit["suggestedEvents"] = [
    { event: "page_view", trigger: "Every landing page view, with the page as the landing page of the session" },
    ...(present.has("whatsapp") ? [{ event: "whatsapp_click" as const, trigger: "Clicks on wa.me / WhatsApp links" }] : []),
    ...(present.has("phone") ? [{ event: "phone_click" as const, trigger: "Clicks on tel: links" }] : []),
    ...(present.has("email") ? [{ event: "email_click" as const, trigger: "Clicks on mailto: links" }] : []),
    ...(present.has("form") ? [
      { event: "form_start" as const, trigger: "First interaction with an enquiry form" },
      { event: "form_submit" as const, trigger: "Enquiry form submitted (never the form's contents)" },
    ] : []),
    ...(present.has("booking") ? [{ event: "booking_start" as const, trigger: "Clicks on booking, quote, or appointment calls to action" }] : []),
    { event: "lead_created", trigger: "A conversion becomes a lead in your CRM or inbox (send it with eumonTrack)" },
    { event: "lead_qualified", trigger: "The lead is qualified, so search topics can be judged by lead quality" },
    { event: "customer_created", trigger: "The lead becomes a customer, with revenue if known" },
  ];
  return { templates, tracking: [...new Set(templates.flatMap((template) => template.tracking))], suggestedEvents };
}

/**
 * Landing pages exist to convert: templates with no way to get in touch
 * waste their traffic, and without tracking, leads and revenue from organic
 * search can't be measured or learned from.
 */
export function findingsFromConversion(audit: ConversionAudit, input: { siteId: string; analysisId: string; familySizes: Record<string, number>; repoAnalytics?: string[] }): Finding[] {
  const findings: Array<Pick<Finding, "title" | "summary" | "recommendation" | "evidence" | "organicImpactScore" | "pagesAffected">> = [];
  const without = audit.templates.filter((template) => template.paths.length === 0);
  if (without.length && without.length === audit.templates.length) {
    findings.push({
      title: "Visitors have no obvious way to get in touch",
      summary: `None of the ${audit.templates.length} page templates checked has a WhatsApp link, phone link, enquiry form, or booking call to action in its HTML. Organic visitors who are ready to act have nowhere to go.`,
      recommendation: "Put one clear call to action on every page template — WhatsApp, phone, or a short enquiry form — near the top and again after the main content.",
      evidence: { templates: audit.templates },
      organicImpactScore: 60,
      pagesAffected: without.map((template) => template.url),
    });
  } else {
    for (const template of without.filter((entry) => entry.family !== "page")) {
      const size = input.familySizes[template.family] ?? 1;
      findings.push({
        title: `No call to action on ${familyLabel(template.family)}`,
        summary: `${template.url} has no WhatsApp link, phone link, enquiry form, or booking call to action, while other templates on the site do. ${size > 1 ? `The sitemap lists ~${size.toLocaleString("en")} pages of this type.` : ""}`.trim(),
        recommendation: "Add the site's main call to action to this template, ideally one that names the item on the page (\"Ask about this treatment\").",
        evidence: { template },
        organicImpactScore: Math.min(Math.round(30 + Math.log10(size + 1) * 8), 58),
        pagesAffected: [template.url],
      });
    }
  }
  // A connected repository that installs analytics outranks a miss in the fetched pages.
  if (audit.templates.length && audit.tracking.length === 0 && !input.repoAnalytics?.length) {
    findings.push({
      title: "No analytics or conversion tracking found",
      summary: `None of the ${audit.templates.length} pages checked loads Google Analytics, Tag Manager, PostHog, Plausible, or Eumon's tracker in its HTML or its own scripts. Organic leads, conversion rates, and revenue by landing page can't be measured.`,
      recommendation: "Install Eumon's conversion snippet (Setup → Track conversions): it records WhatsApp, phone, email, and form conversions and credits them to the landing page a visitor arrived on.",
      evidence: { checked: audit.templates.map((template) => template.url) },
      organicImpactScore: 45,
      pagesAffected: [],
    });
  }
  const createdAt = new Date().toISOString();
  return findings.map((finding) => ({
    id: createId("finding"),
    siteId: input.siteId,
    analysisId: input.analysisId,
    category: "conversion" as const,
    severity: severityFromImpact(finding.organicImpactScore),
    ...finding,
    createdAt,
  }));
}
