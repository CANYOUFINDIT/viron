export interface SshTerminalInputBufferOptions {
  sendText: (data: string) => Promise<void> | void;
  sendBinary: (data: Uint8Array) => Promise<void> | void;
  onError: (error: unknown) => void;
}

type QueuedInput =
  | { type: "text"; data: string }
  | { type: "binary"; data: Uint8Array };

const textEncoder = new TextEncoder();

export class SshTerminalInputBuffer {
  private queue: QueuedInput[] = [];
  private inFlightBytes = 0;
  private pumping = false;
  private scheduled = false;
  private generation = 0;
  private closed = false;

  constructor(private readonly options: SshTerminalInputBufferOptions) {}

  get bufferedBytes(): number {
    let pending = this.inFlightBytes;
    for (const chunk of this.queue) {
      pending += chunkBytes(chunk);
    }
    return pending;
  }

  reset(): void {
    this.generation += 1;
    this.queue = [];
    this.scheduled = false;
    this.closed = false;
  }

  enqueueText(data: string): void {
    if (!data || this.closed) return;
    const last = this.queue.at(-1);
    if (last?.type === "text") last.data += data;
    else this.queue.push({ type: "text", data });
    this.schedule();
  }

  enqueueBinary(data: Uint8Array): void {
    if (!data.byteLength || this.closed) return;
    this.queue.push({ type: "binary", data });
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled || this.pumping) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const generation = this.generation;
    try {
      while (!this.closed && generation === this.generation && this.queue.length) {
        const chunk = this.queue.shift()!;
        const bytes = chunkBytes(chunk);
        this.inFlightBytes += bytes;
        try {
          if (chunk.type === "text") await this.options.sendText(chunk.data);
          else await this.options.sendBinary(chunk.data);
        } finally {
          this.inFlightBytes = Math.max(0, this.inFlightBytes - bytes);
        }
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.queue = [];
      this.options.onError(error);
    } finally {
      this.pumping = false;
      if (!this.closed && this.queue.length) this.schedule();
    }
  }
}

function chunkBytes(chunk: QueuedInput): number {
  return chunk.type === "text" ? textEncoder.encode(chunk.data).byteLength : chunk.data.byteLength;
}
