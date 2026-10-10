/** Google shows about 600 px of title, roughly 60 characters; under 30 wastes the space. */
export const TITLE_LENGTH = { min: 30, max: 60 };
/** Google cuts descriptions at about 160 characters. */
export const DESCRIPTION_MAX = 160;
/** Under this many words of main content a detail page has too little to rank or be cited. */
export const THIN_WORDS = 150;
/** 75% of pages cited in AI answers were updated within 12 months (Seer, 2026). */
export const AI_FRESHNESS_DAYS = 365;
/** A lead paragraph longer than this is not a summary an assistant can lift. */
export const LEAD_WORDS_MAX = 120;
/** Pages more than this many clicks from the homepage are crawled last and least. */
export const LINK_DEPTH = 3;
