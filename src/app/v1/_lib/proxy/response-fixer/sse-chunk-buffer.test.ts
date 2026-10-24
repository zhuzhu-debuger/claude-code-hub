import { describe, expect, it } from "vitest";
import { SseChunkBuffer } from "./sse-chunk-buffer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("SseChunkBuffer memory ownership", () => {
  it("releases consumed backing stores throughout a long-lived response", () => {
    const buffer = new SseChunkBuffer();
    for (let index = 0; index < 200; index++) {
      const chunk = new Uint8Array(64 * 1024).fill(0x61);
      chunk[chunk.length - 1] = 0x0a;
      buffer.push(chunk);
      expect(buffer.retainedByteLength).toBe(chunk.byteLength);
      const consumed = buffer.take(buffer.findProcessableEnd());
      expect(Buffer.from(consumed).equals(Buffer.from(chunk))).toBe(true);
      expect(buffer.length).toBe(0);
      expect(buffer.retainedByteLength).toBe(0);
    }
  });

  it("retains only the unread chunk when complete lines precede a partial line", () => {
    const buffer = new SseChunkBuffer();
    buffer.push(encoder.encode("data: first\n"));
    buffer.push(encoder.encode("data: next"));
    expect(decoder.decode(buffer.take(buffer.findProcessableEnd()))).toBe("data: first\n");
    expect(buffer.retainedByteLength).toBe(10);
    buffer.push(encoder.encode("\n"));
    expect(decoder.decode(buffer.drain())).toBe("data: next\n");
    expect(buffer.retainedByteLength).toBe(0);
  });

  it("preserves partial chunk offsets and CRLF split across network chunks", () => {
    const buffer = new SseChunkBuffer();
    buffer.push(encoder.encode("one\ntwo\r"));
    expect(buffer.findProcessableEnd()).toBe(0);
    buffer.push(encoder.encode("\nthree"));
    expect(decoder.decode(buffer.take(buffer.findProcessableEnd()))).toBe("one\ntwo\r\n");
    expect(decoder.decode(buffer.drain())).toBe("three");
    expect(buffer.retainedByteLength).toBe(0);
  });

  it("flushes unread suffixes in order and relinquishes all buffers", () => {
    const buffer = new SseChunkBuffer();
    buffer.push(encoder.encode("one\ntwo"));
    expect(decoder.decode(buffer.take(4))).toBe("one\n");
    buffer.push(encoder.encode("three"));
    const chunks: Uint8Array[] = [];
    buffer.flushTo({
      desiredSize: 0,
      enqueue: (chunk) => {
        if (chunk) chunks.push(chunk);
      },
      error() {},
      terminate() {},
    });
    expect(chunks.map((chunk) => decoder.decode(chunk)).join("")).toBe("twothree");
    expect(buffer.length).toBe(0);
    expect(buffer.retainedByteLength).toBe(0);
  });

  it("handles empty input, isolated CR and invalid take sizes", () => {
    const buffer = new SseChunkBuffer();
    buffer.push(new Uint8Array(0));
    expect(buffer.findProcessableEnd()).toBe(0);
    expect(buffer.take(0)).toHaveLength(0);
    expect(() => buffer.take(1)).toThrow("exceeds buffered length");
    buffer.push(encoder.encode("one\rtwo\r"));
    buffer.push(encoder.encode("three"));
    expect(decoder.decode(buffer.take(buffer.findProcessableEnd()))).toBe("one\rtwo\r");
    buffer.clear();
    expect(buffer.retainedByteLength).toBe(0);
  });
});
