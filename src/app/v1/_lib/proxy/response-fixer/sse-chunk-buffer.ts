const LF_BYTE = 0x0a;
const CR_BYTE = 0x0d;
const EMPTY_BYTES = new Uint8Array(0);

/** Incremental SSE line buffer; only unread chunks retain their backing stores. */
export class SseChunkBuffer {
  private readonly chunks: Uint8Array[] = [];
  private head = 0;
  private headOffset = 0;
  private total = 0;
  private processableEnd = 0;
  private pendingCR = false;

  get length(): number {
    return this.total;
  }

  get retainedByteLength(): number {
    const buffers = new Set<ArrayBufferLike>();
    let bytes = 0;
    for (const chunk of this.chunks) {
      if (!buffers.has(chunk.buffer)) {
        buffers.add(chunk.buffer);
        bytes += chunk.buffer.byteLength;
      }
    }
    return bytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const prevTotal = this.total;
    this.chunks.push(chunk);
    this.total += chunk.length;

    // 解决跨 chunk 的 CRLF：如果上一块以 CR 结尾，需要看本块的首字节是否为 LF
    if (this.pendingCR) {
      this.processableEnd = chunk[0] === LF_BYTE ? prevTotal + 1 : prevTotal;
      this.pendingCR = false;
    }

    // 仅扫描新增 chunk，增量维护“可处理末尾”索引，避免每次全量回扫导致 O(n^2)
    for (let i = 0; i < chunk.length; i += 1) {
      const b = chunk[i];
      if (b === LF_BYTE) {
        this.processableEnd = prevTotal + i + 1;
        continue;
      }
      if (b !== CR_BYTE) continue;

      if (i + 1 < chunk.length) {
        if (chunk[i + 1] !== LF_BYTE) {
          this.processableEnd = prevTotal + i + 1;
        }
        continue;
      }

      // chunk 尾部 CR：等待下一块是否为 CRLF
      this.pendingCR = true;
    }
  }

  clear(): void {
    this.chunks.length = 0;
    this.head = 0;
    this.headOffset = 0;
    this.total = 0;
    this.processableEnd = 0;
    this.pendingCR = false;
  }

  flushTo(controller: TransformStreamDefaultController<Uint8Array>): void {
    for (let i = this.head; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i];
      if (i === this.head && this.headOffset > 0) {
        const view = chunk.subarray(this.headOffset);
        if (view.length > 0) controller.enqueue(view);
        continue;
      }
      controller.enqueue(chunk);
    }
    this.clear();
  }

  findProcessableEnd(): number {
    if (this.total === 0) return 0;
    // 保持历史行为：末尾 CR 时不切分，等待下一块确认是否为 CRLF
    if (this.pendingCR) return 0;
    return this.processableEnd;
  }

  take(size: number): Uint8Array {
    if (size <= 0) return new Uint8Array(0);
    if (size > this.total) {
      throw new Error("ChunkBuffer.take size exceeds buffered length");
    }

    const out = new Uint8Array(size);
    let outOffset = 0;

    while (outOffset < size) {
      const chunk = this.chunks[this.head];
      const available = chunk.length - this.headOffset;
      const toCopy = Math.min(available, size - outOffset);
      out.set(chunk.subarray(this.headOffset, this.headOffset + toCopy), outOffset);

      outOffset += toCopy;
      this.headOffset += toCopy;
      this.total -= toCopy;

      if (this.headOffset >= chunk.length) {
        // Compaction may wait, but consumed backing stores must be released now.
        this.chunks[this.head] = EMPTY_BYTES;
        this.head += 1;
        this.headOffset = 0;
      }
    }

    if (this.head > 64) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }

    this.processableEnd = Math.max(0, this.processableEnd - size);
    return out;
  }

  drain(): Uint8Array {
    const out = this.take(this.total);
    this.clear();
    return out;
  }
}
