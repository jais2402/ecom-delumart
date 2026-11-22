import { describe, expect, it } from "vitest";
import { readCappedText } from "./body";

const enc = new TextEncoder();

/** A request whose body is an endless stream of `chunk`, counting how many bytes were pulled. */
function endless(chunk: Uint8Array, headers: Record<string, string> = {}) {
  const seen = { bytes: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        seen.bytes += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  ); // nothing is pulled until someone reads
  const request = new Request("https://app.test/api/v1/events", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { request, seen };
}

describe("readCappedText (eighth review, minor 8a)", () => {
  it("refuses by Content-Length before reading anything", async () => {
    const { request, seen } = endless(enc.encode("x".repeat(64)), { "content-length": "5000" });
    expect(await readCappedText(request, 1024)).toBeNull();
    expect(seen.bytes).toBe(0);
  });

  it("stops reading an unannounced body as soon as it passes the cap, and cancels the stream", async () => {
    const { request, seen } = endless(enc.encode("y".repeat(100)));
    expect(await readCappedText(request, 1024)).toBeNull();
    expect(seen.cancelled).toBe(true);
    // at most one chunk beyond the cap was pulled (plus the stream's own read-ahead)
    expect(seen.bytes).toBeLessThanOrEqual(1024 + 300);
  });

  it("a lying Content-Length does not lift the cap", async () => {
    const { request, seen } = endless(enc.encode("z".repeat(100)), { "content-length": "10" });
    expect(await readCappedText(request, 1024)).toBeNull();
    expect(seen.cancelled).toBe(true);
  });

  it("returns a body within the cap, decoding UTF-8 split across chunks", async () => {
    const bytes = enc.encode('{"city":"मुंबई"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
        controller.close();
      },
    });
    const request = new Request("https://app.test/", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(await readCappedText(request, 1024)).toBe('{"city":"मुंबई"}');
    expect(await readCappedText(new Request("https://app.test/", { method: "POST" }), 10)).toBe("");
    // exactly at the cap is accepted
    expect(
      await readCappedText(new Request("https://app.test/", { method: "POST", body: "a".repeat(10) }), 10),
    ).toBe("a".repeat(10));
    expect(
      await readCappedText(new Request("https://app.test/", { method: "POST", body: "a".repeat(11) }), 10),
    ).toBeNull();
  });
});
