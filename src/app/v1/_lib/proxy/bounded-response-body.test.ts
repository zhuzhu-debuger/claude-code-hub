import { describe, expect, it, vi } from "vitest";
import { readResponseWithinLimit } from "./bounded-response-body";

function sourceChunks(chunks: string[]) {
  let index = 0;
  const cancel = vi.fn();
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (index === chunks.length) controller.close();
    else controller.enqueue(new TextEncoder().encode(chunks[index++]));
  });
  const stream = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
  return { stream, pull, cancel };
}

describe("readResponseWithinLimit", () => {
  it("materializes complete responses at or below the repair limit", async () => {
    const { stream } = sourceChunks(["ab", "c", "def"]);
    const result = await readResponseWithinLimit(new Response(stream), 6);
    expect(result.complete).toBe(true);
    if (!result.complete) throw new Error("Expected buffered response");
    expect(new TextDecoder().decode(result.bytes)).toBe("abcdef");
    expect(stream.locked).toBe(false);
  });

  it("returns an oversized declared body without starting an upstream read", async () => {
    const { stream, pull } = sourceChunks(["oversized"]);
    const response = new Response(stream, { headers: { "content-length": "9" } });
    const result = await readResponseWithinLimit(response, 4);
    expect(result).toEqual({ complete: false, response });
    expect(pull).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    await response.body?.cancel();
  });

  it.each([undefined, "1", "invalid"])(
    "stops reading oversized chunked responses and preserves bytes (length=%s)",
    async (length) => {
      const { stream, pull } = sourceChunks(["ab", "cde", "fg", "hi"]);
      const headers = new Headers({ "content-type": "application/json", "x-upstream": "yes" });
      if (length !== undefined) headers.set("content-length", length);
      const result = await readResponseWithinLimit(
        new Response(stream, { status: 201, statusText: "Created", headers }),
        4
      );
      expect(result.complete).toBe(false);
      if (result.complete) throw new Error("Expected streaming response");
      await Promise.resolve();
      expect(pull).toHaveBeenCalledTimes(2);
      expect(result.response.status).toBe(201);
      expect(result.response.statusText).toBe("Created");
      expect(result.response.headers.get("x-upstream")).toBe("yes");
      expect(await result.response.text()).toBe("abcdefghi");
      expect(stream.locked).toBe(false);
    }
  );

  it("cancels the sole upstream reader when downstream cancels the prefix", async () => {
    const { stream, cancel, pull } = sourceChunks(["abcde", "unread"]);
    const result = await readResponseWithinLimit(new Response(stream), 4);
    if (result.complete) throw new Error("Expected streaming response");
    const reason = new Error("downstream cancelled");
    await result.response.body?.cancel(reason);
    expect(cancel).toHaveBeenCalledWith(reason);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("releases the source reader after errors during prefix and passthrough reads", async () => {
    for (const failImmediately of [true, false]) {
      let reads = 0;
      const stream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (failImmediately || reads++ > 0) throw new Error("upstream failed");
            controller.enqueue(new Uint8Array(5));
          },
        },
        { highWaterMark: 0 }
      );
      if (failImmediately) {
        await expect(readResponseWithinLimit(new Response(stream), 4)).rejects.toThrow(
          "upstream failed"
        );
      } else {
        const result = await readResponseWithinLimit(new Response(stream), 4);
        if (result.complete) throw new Error("Expected streaming response");
        await expect(result.response.text()).rejects.toThrow("upstream failed");
      }
      expect(stream.locked).toBe(false);
    }
  });

  it("handles a bodyless response", async () => {
    expect(await readResponseWithinLimit(new Response(null, { status: 204 }), 4)).toEqual({
      complete: true,
      bytes: new Uint8Array(0),
    });
  });
});
