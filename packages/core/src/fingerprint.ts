/*
 * Content fingerprints: a 64-bit simhash of a page's main text, so two pages
 * can be compared without keeping their bodies. Pages with the same title
 * whose hashes are within a few bits are the same page twice. Two 32-bit
 * FNV-1a hashes per token keep it to integer arithmetic.
 */

/** Hashes this close are the same text with a few words changed (a hospital name, a number). Sound from about 150 words up; shorter texts miss more. */
export const NEAR_DUPLICATE_DISTANCE = 6;
/** Words hashed per text: enough for any page's main content, bounded for the crawler's time. */
const MAX_WORDS = 1000;

function fnv32(token: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < token.length; index++) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const hex8 = (value: number) => (value >>> 0).toString(16).padStart(8, "0");

/** Simhash of the text's words and word pairs, 16 hex characters; "" for text without words. */
export function simhash(text: string): string {
  const words = (text.toLowerCase().match(/[\p{L}\p{M}\p{N}]{3,}/gu) ?? []).slice(0, MAX_WORDS);
  if (!words.length) return "";
  const tokens = [...words, ...words.slice(1).map((word, index) => `${words[index]} ${word}`)];
  const votes = new Int32Array(64);
  for (const token of tokens) {
    const lo = fnv32(token, 0x811c9dc5);
    const hi = fnv32(token, 0x9747b28c);
    for (let bit = 0; bit < 32; bit++) {
      votes[bit] += (lo >>> bit) & 1 ? 1 : -1;
      votes[32 + bit] += (hi >>> bit) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let bit = 0; bit < 32; bit++) {
    if (votes[bit]! > 0) lo |= 1 << bit;
    if (votes[32 + bit]! > 0) hi |= 1 << bit;
  }
  return hex8(hi) + hex8(lo);
}

/** The two 32-bit halves of a hash, parsed once for many comparisons; null for a missing hash. */
export function hashBits(hash: string): [number, number] | null {
  return hash.length === 16 ? [parseInt(hash.slice(0, 8), 16) >>> 0, parseInt(hash.slice(8), 16) >>> 0] : null;
}

function popcount(value: number): number {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** Bits that differ between two parsed hashes. */
export const hammingBits = (a: [number, number], b: [number, number]) => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1]);

/** Bits that differ between two simhashes; 64 when either is missing. */
export function hamming(a: string, b: string): number {
  const left = hashBits(a);
  const right = hashBits(b);
  return left && right ? hammingBits(left, right) : 64;
}

export const nearDuplicate = (a: string, b: string, maxDistance = NEAR_DUPLICATE_DISTANCE) => Boolean(a && b) && hamming(a, b) <= maxDistance;
