/** Checks other tools run that Eumon does not, with the reason. Rendered on the Checks docs page. */
export const NOT_RUN: Array<{ name: string; why: string }> = [
  { name: "Text-to-HTML ratio, URL parameters, underscores in URLs, URL length, encoding and doctype, frames and plugins, AMP", why: "No measurable effect on ranking or AI citation in 2026; modern frameworks fail the ratio check by design." },
  { name: "Uncompressed, unminified or uncached JavaScript and CSS, large HTML, too many files", why: "Real-user speed from the Chrome UX Report and the lab score from PageSpeed measure what these approximate." },
  { name: "TLS version, certificate name and expiry, SNI", why: "Not observable from a Workers fetch; browsers and Search Console report them." },
  { name: "Readability and spelling", why: "Language dependent; sites write in Malay, Indonesian, Chinese and English." },
  { name: "FAQPage and HowTo markup as issues", why: "Google removed those rich results (HowTo in 2023, FAQ in May 2026). Question-and-answer structure is checked as content, not markup." },
  { name: "llms.txt as a scored check", why: "No AI engine has confirmed reading it and Google says it neither helps nor harms. It is reported, never scored." },
  { name: "Anchor text quality, nofollow on internal links", why: "Needs anchor text and rel stored per link; a later crawler addition." },
];
