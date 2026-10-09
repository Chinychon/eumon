/**
 * Countries as Search Console reports them (ISO 3166-1 alpha-3, lower case),
 * with English names: the markets most sites target. Codes outside this list
 * are still accepted and shown as-is.
 */
export const COUNTRIES: Array<{ code: string; name: string }> = [
  { code: "idn", name: "Indonesia" }, { code: "mys", name: "Malaysia" }, { code: "sgp", name: "Singapore" }, { code: "tha", name: "Thailand" },
  { code: "vnm", name: "Vietnam" }, { code: "phl", name: "Philippines" }, { code: "brn", name: "Brunei" }, { code: "khm", name: "Cambodia" },
  { code: "mmr", name: "Myanmar" }, { code: "lao", name: "Laos" }, { code: "chn", name: "China" }, { code: "hkg", name: "Hong Kong" },
  { code: "twn", name: "Taiwan" }, { code: "jpn", name: "Japan" }, { code: "kor", name: "South Korea" }, { code: "ind", name: "India" },
  { code: "pak", name: "Pakistan" }, { code: "bgd", name: "Bangladesh" }, { code: "lka", name: "Sri Lanka" }, { code: "npl", name: "Nepal" },
  { code: "aus", name: "Australia" }, { code: "nzl", name: "New Zealand" }, { code: "usa", name: "United States" }, { code: "can", name: "Canada" },
  { code: "mex", name: "Mexico" }, { code: "bra", name: "Brazil" }, { code: "arg", name: "Argentina" }, { code: "col", name: "Colombia" },
  { code: "chl", name: "Chile" }, { code: "gbr", name: "United Kingdom" }, { code: "irl", name: "Ireland" }, { code: "deu", name: "Germany" },
  { code: "fra", name: "France" }, { code: "esp", name: "Spain" }, { code: "ita", name: "Italy" }, { code: "nld", name: "Netherlands" },
  { code: "bel", name: "Belgium" }, { code: "che", name: "Switzerland" }, { code: "aut", name: "Austria" }, { code: "swe", name: "Sweden" },
  { code: "nor", name: "Norway" }, { code: "dnk", name: "Denmark" }, { code: "fin", name: "Finland" }, { code: "pol", name: "Poland" },
  { code: "prt", name: "Portugal" }, { code: "tur", name: "Turkey" }, { code: "rus", name: "Russia" }, { code: "ukr", name: "Ukraine" },
  { code: "are", name: "United Arab Emirates" }, { code: "sau", name: "Saudi Arabia" }, { code: "qat", name: "Qatar" }, { code: "kwt", name: "Kuwait" },
  { code: "omn", name: "Oman" }, { code: "egy", name: "Egypt" }, { code: "nga", name: "Nigeria" }, { code: "ken", name: "Kenya" },
  { code: "zaf", name: "South Africa" }, { code: "isr", name: "Israel" },
];

export function countryName(code: string): string {
  return COUNTRIES.find((country) => country.code === code.toLowerCase())?.name ?? code.toUpperCase();
}
