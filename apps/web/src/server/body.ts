import "./server-only";

/**
 * Reads a request body as UTF-8 text, at most `maxBytes` bytes (eighth review, minor 8a). A
 * Content-Length above the cap is refused before anything is read; otherwise the body is read as
 * a stream and the read stops (the stream is cancelled) as soon as it passes the cap, whatever
 * Content-Length claimed. Returns null when the body is too large.
 */
export async function readCappedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}
