/** Reads a body without trusting Content-Length; null when it passes `maxBytes`. Works for requests and responses alike. */
export async function readText(source: { body: ReadableStream<Uint8Array> | null }, maxBytes: number): Promise<string | null> {
  const reader = source.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}
