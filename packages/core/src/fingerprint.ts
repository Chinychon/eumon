/*
 * Content fingerprints: a 64-bit simhash of a page's visible text, so two
 * pages can be compared without keeping their bodies. Pages with the same
 * title whose hashes are within a few bits are the same page twice.
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

function fnv1a64(token: string): bigint {
  let hash = FNV_OFFSET;
  for (const char of token) {
    hash ^= BigInt(char.codePointAt(0)!);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash;
}

/** Hashes this close are the same text with a few words changed (a hospital name, a number). */
export const NEAR_DUPLICATE_DISTANCE = 6;

/** Simhash of the text's words and word pairs, 16 hex characters; "" for text without words. */
export function simhash(text: string): string {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (!words.length) return "";
  const tokens = [...words, ...words.slice(1).map((word, index) => `${words[index]} ${word}`)];
  const votes = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit++) votes[bit]! += (hash >> BigInt(bit)) & 1n ? 1 : -1;
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit++) if (votes[bit]! > 0) result |= 1n << BigInt(bit);
  return result.toString(16).padStart(16, "0");
}

/** Bits that differ between two simhashes; 64 when either is missing. */
export function hamming(a: string, b: string): number {
  if (!a || !b) return 64;
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) { x &= x - 1n; count++; }
  return count;
}

export const nearDuplicate = (a: string, b: string, maxDistance = NEAR_DUPLICATE_DISTANCE) => Boolean(a && b) && hamming(a, b) <= maxDistance;
