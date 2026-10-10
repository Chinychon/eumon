import type { FixRecord } from "@organic-growth/db";

/** A fix as the browser sees it: without the file contents, which can be large. */
export function fixView({ files: _files, original: _original, ...rest }: FixRecord) {
  return rest;
}
