import { toCode } from "./code.js";
import type { MetadataPlan } from "./edit/metadata.js";

const languagesCode = (languages: Record<string, string>) => `{ ${Object.entries(languages).map(([lang, p]) => `${JSON.stringify(lang)}: ${toCode(p)}`).join(", ")} }`;

export function metadataSnippet(plan: MetadataPlan, dynamic: boolean): string {
  const lines: string[] = [];
  if (plan.title) lines.push(`title: ${toCode(plan.title)},`);
  if (plan.description) lines.push(`description: ${toCode(plan.description)},`);
  const alternates = [plan.canonical ? `canonical: ${toCode(plan.canonical)}` : "", plan.languages ? `languages: ${languagesCode(plan.languages)}` : ""].filter(Boolean);
  if (alternates.length) lines.push(`alternates: { ${alternates.join(", ")} },`);
  return dynamic
    ? `export async function generateMetadata({ params }) {\n  // Load the same data the page uses, then:\n  return {\n${lines.map((l) => `    ${l}`).join("\n")}\n  };\n}`
    : `export const metadata = {\n${lines.map((l) => `  ${l}`).join("\n")}\n};`;
}

export function jsonLdSnippet(dataCode: string): string {
  return `<script\n  type="application/ld+json"\n  dangerouslySetInnerHTML={{ __html: JSON.stringify(${dataCode}).replace(/</g, "\\\\u003c") }}\n/>`;
}

export { languagesCode };
