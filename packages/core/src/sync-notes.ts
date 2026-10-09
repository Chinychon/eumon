/** A sync note that says something went wrong, as the sources write them ("analytics failed: …", "inspection stopped: …", "coverage refused …"). The Dashboard, Setup's sync history and the store all judge notes with this. */
export const isProblemNote = (note: string) => /\b(failed|stopped|refused)\b/i.test(note);
