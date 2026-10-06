const LOCALE_SEGMENT = /^[a-z]{2}(?:[-_][a-z]{2,4})?$/i;
const COMMON_LOCALES = new Set([
  "ar", "bn", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fil", "fr", "he", "hi", "hu", "id", "it", "ja",
  "ko", "ms", "nl", "no", "pl", "pt", "ro", "ru", "sv", "th", "tl", "tr", "uk", "ur", "vi", "zh",
]);

function pathSegments(url: string): string[] {
  return new URL(url).pathname.split("/").filter(Boolean);
}

function localePrefix(segments: string[]): string | null {
  const first = segments[0];
  if (!first || !LOCALE_SEGMENT.test(first)) return null;
  return COMMON_LOCALES.has(first.slice(0, 2).toLowerCase()) ? first.toLowerCase() : null;
}

/**
 * Groups a URL by its route family: the first path segment after any locale
 * prefix (`/en/doctors/jane` → `doctors`). Detail pages are what usually
 * matter for indexing, so single-segment paths are grouped as `page`.
 */
export function classifyUrlType(url: string): string {
  const segments = pathSegments(url);
  const rest = localePrefix(segments) ? segments.slice(1) : segments;
  if (rest.length === 0) return "home";
  if (rest.length === 1) return "page";
  return rest[0]!.toLowerCase().slice(0, 40);
}

/** Locale from a `/xx/` or `/xx-yy/` path prefix; `default` when unprefixed. */
export function classifyLanguage(url: string): string {
  return localePrefix(pathSegments(url)) ?? "default";
}

const siteHost = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");

/**
 * True when two URLs belong to the same website, treating `www.` and
 * http/https variants as one site (sites routinely redirect between them).
 */
export function isSameSite(url: string, reference: string): boolean {
  try {
    return siteHost(new URL(url).hostname) === siteHost(new URL(reference).hostname);
  } catch {
    return false;
  }
}

/** True when `href` (resolved against `pageUrl`) names the same document, ignoring query and fragment. */
export function sameDocument(href: string, pageUrl: string): boolean {
  try {
    const target = new URL(href, pageUrl);
    const page = new URL(pageUrl);
    return target.origin + target.pathname === page.origin + page.pathname;
  } catch {
    return false;
  }
}
