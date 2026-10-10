/**
 * Countries as Search Console reports them (ISO 3166-1 alpha-3, lower case),
 * with English names and ISO numeric codes: the markets most sites target.
 * Codes outside this list are still accepted and shown as-is. DataForSEO's
 * Google location for a country is 2000 + its numeric code.
 */
export const COUNTRIES: Array<{ code: string; name: string; numeric: number }> = [
  { code: "idn", name: "Indonesia", numeric: 360 }, { code: "mys", name: "Malaysia", numeric: 458 }, { code: "sgp", name: "Singapore", numeric: 702 }, { code: "tha", name: "Thailand", numeric: 764 },
  { code: "vnm", name: "Vietnam", numeric: 704 }, { code: "phl", name: "Philippines", numeric: 608 }, { code: "brn", name: "Brunei", numeric: 96 }, { code: "khm", name: "Cambodia", numeric: 116 },
  { code: "mmr", name: "Myanmar", numeric: 104 }, { code: "lao", name: "Laos", numeric: 418 }, { code: "chn", name: "China", numeric: 156 }, { code: "hkg", name: "Hong Kong", numeric: 344 },
  { code: "twn", name: "Taiwan", numeric: 158 }, { code: "jpn", name: "Japan", numeric: 392 }, { code: "kor", name: "South Korea", numeric: 410 }, { code: "ind", name: "India", numeric: 356 },
  { code: "pak", name: "Pakistan", numeric: 586 }, { code: "bgd", name: "Bangladesh", numeric: 50 }, { code: "lka", name: "Sri Lanka", numeric: 144 }, { code: "npl", name: "Nepal", numeric: 524 },
  { code: "aus", name: "Australia", numeric: 36 }, { code: "nzl", name: "New Zealand", numeric: 554 }, { code: "usa", name: "United States", numeric: 840 }, { code: "can", name: "Canada", numeric: 124 },
  { code: "mex", name: "Mexico", numeric: 484 }, { code: "bra", name: "Brazil", numeric: 76 }, { code: "arg", name: "Argentina", numeric: 32 }, { code: "col", name: "Colombia", numeric: 170 },
  { code: "chl", name: "Chile", numeric: 152 }, { code: "gbr", name: "United Kingdom", numeric: 826 }, { code: "irl", name: "Ireland", numeric: 372 }, { code: "deu", name: "Germany", numeric: 276 },
  { code: "fra", name: "France", numeric: 250 }, { code: "esp", name: "Spain", numeric: 724 }, { code: "ita", name: "Italy", numeric: 380 }, { code: "nld", name: "Netherlands", numeric: 528 },
  { code: "bel", name: "Belgium", numeric: 56 }, { code: "che", name: "Switzerland", numeric: 756 }, { code: "aut", name: "Austria", numeric: 40 }, { code: "swe", name: "Sweden", numeric: 752 },
  { code: "nor", name: "Norway", numeric: 578 }, { code: "dnk", name: "Denmark", numeric: 208 }, { code: "fin", name: "Finland", numeric: 246 }, { code: "pol", name: "Poland", numeric: 616 },
  { code: "prt", name: "Portugal", numeric: 620 }, { code: "tur", name: "Turkey", numeric: 792 }, { code: "rus", name: "Russia", numeric: 643 }, { code: "ukr", name: "Ukraine", numeric: 804 },
  { code: "are", name: "United Arab Emirates", numeric: 784 }, { code: "sau", name: "Saudi Arabia", numeric: 682 }, { code: "qat", name: "Qatar", numeric: 634 }, { code: "kwt", name: "Kuwait", numeric: 414 },
  { code: "omn", name: "Oman", numeric: 512 }, { code: "egy", name: "Egypt", numeric: 818 }, { code: "nga", name: "Nigeria", numeric: 566 }, { code: "ken", name: "Kenya", numeric: 404 },
  { code: "zaf", name: "South Africa", numeric: 710 }, { code: "isr", name: "Israel", numeric: 376 },
];

export function countryName(code: string): string {
  return COUNTRIES.find((country) => country.code === code.toLowerCase())?.name ?? code.toUpperCase();
}

/** ISO 3166-1 numeric code, or null for a country outside the table. */
export function countryNumeric(code: string): number | null {
  return COUNTRIES.find((country) => country.code === code.toLowerCase())?.numeric ?? null;
}

/** ISO 3166-1 alpha-2 for a market (alpha-3), for APIs that take two letters (Perplexity's web search country). */
const ALPHA2: Record<string, string> = {
  idn: "ID", mys: "MY", sgp: "SG", tha: "TH", vnm: "VN", phl: "PH", brn: "BN", khm: "KH", mmr: "MM", lao: "LA", chn: "CN", hkg: "HK", twn: "TW", jpn: "JP", kor: "KR",
  ind: "IN", pak: "PK", bgd: "BD", lka: "LK", npl: "NP", aus: "AU", nzl: "NZ", usa: "US", can: "CA", mex: "MX", bra: "BR", arg: "AR", col: "CO", chl: "CL", gbr: "GB",
  irl: "IE", deu: "DE", fra: "FR", esp: "ES", ita: "IT", nld: "NL", bel: "BE", che: "CH", aut: "AT", swe: "SE", nor: "NO", dnk: "DK", fin: "FI", pol: "PL", prt: "PT",
  tur: "TR", rus: "RU", ukr: "UA", are: "AE", sau: "SA", qat: "QA", kwt: "KW", omn: "OM", egy: "EG", nga: "NG", ken: "KE", zaf: "ZA", isr: "IL",
};
export const countryAlpha2 = (code: string): string | null => ALPHA2[code.toLowerCase()] ?? null;
