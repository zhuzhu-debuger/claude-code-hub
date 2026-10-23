import { BufferedByteChunks } from "./buffered-byte-chunks";

type BoundedResponseBody =
  | { complete: true; bytes: Uint8Array }
  | { complete: false; response: Response };

/** Buffer a small response for repair, preserving backpressure when it exceeds the limit. */
export async function readResponseWithinLimit(
  response: Response,
  maxBytes: number
): Promise<BoundedResponseBody> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > maxBytes) return { complete: false, response };
  if (!response.body) return { complete: true, bytes: new Uint8Array(0) };

  const reader = response.body.getReader();
  const buffered = new BufferedByteChunks();
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        const bytes = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of buffered.take()) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { complete: true, bytes };
      }

      if (byteLength + value.byteLength > maxBytes) {
        const prefix = buffered.take();
        prefix.push(value);
        let index = 0;
        const stream = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              if (index < prefix.length) {
                const chunk = prefix[index];
                prefix[index++] = new Uint8Array(0);
                controller.enqueue(chunk);
                return;
              }
              try {
                const result = await reader.read();
                if (result.done) {
                  reader.releaseLock();
                  controller.close();
                } else {
                  controller.enqueue(result.value);
                }
              } catch (error) {
                reader.releaseLock();
                controller.error(error);
              }
            },
            cancel(reason) {
              prefix.length = 0;
              // A broken adapter's cancel promise must not retain local ownership.
              void reader.cancel(reason).catch(() => undefined);
              reader.releaseLock();
            },
          },
          { highWaterMark: 0 }
        );
        return {
          complete: false,
          response: new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          }),
        };
      }

      buffered.append(value);
      byteLength += value.byteLength;
    }
  } catch (error) {
    buffered.clear();
    void reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
}
