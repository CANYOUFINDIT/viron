import { currentLocale, localizeMessage, translate as tr } from "./i18n";
import {
  closeDesktopServiceSocket,
  isDesktopApp,
  onDesktopServiceSocketEvent,
  openDesktopServiceSocket,
  sendDesktopServiceSocket,
  type DesktopServiceSocketEvent,
} from "./desktop";
import { webSocketUrl } from "./service-url";
import { connectionQualityByteLength, recordConnectionQualityTraffic } from "./connection-quality-traffic";

export class ServiceSocket {
  static readonly CONNECTING = WebSocket.CONNECTING;
  static readonly OPEN = WebSocket.OPEN;
  static readonly CLOSING = WebSocket.CLOSING;
  static readonly CLOSED = WebSocket.CLOSED;

  readyState: number = ServiceSocket.CONNECTING;
  private currentBinaryType: BinaryType = "blob";
  private native: WebSocket | null = null;
  private desktopId = "";
  private stopDesktopEvents: (() => void) | null = null;
  private closeRequested = false;
  private pendingBytes = 0;
  private desktopBacklog: DesktopServiceSocketEvent[] = [];
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(path: string, params: Record<string, string>) {
    if (isDesktopApp()) void this.openDesktop(path, params);
    else this.openBrowser(path, params);
  }

  get bufferedAmount(): number {
    return this.native?.bufferedAmount ?? this.pendingBytes;
  }

  get binaryType(): BinaryType {
    return this.currentBinaryType;
  }

  set binaryType(value: BinaryType) {
    this.currentBinaryType = value;
    if (this.native) this.native.binaryType = value;
  }

  addEventListener(type: "open", listener: (event: Event) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event | ErrorEvent) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener as (event: Event) => void);
    this.listeners.set(type, listeners);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== ServiceSocket.OPEN) throw new Error(tr("实时通道尚未连接"));
    recordConnectionQualityTraffic("upload", connectionQualityByteLength(data));
    if (this.native) {
      this.native.send(data);
      return;
    }
    const payload = typeof data === "string"
      ? data
      : data instanceof ArrayBuffer
        ? data
        : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload).byteLength : payload.byteLength;
    this.pendingBytes += bytes;
    void sendDesktopServiceSocket(this.desktopId, payload)
      .catch((error) => this.emit("error", new ErrorEvent("error", { message: error instanceof Error ? error.message : tr("实时通道发送失败") })))
      .finally(() => { this.pendingBytes = Math.max(0, this.pendingBytes - bytes); });
  }

  close(): void {
    if (this.readyState >= ServiceSocket.CLOSING) return;
    this.closeRequested = true;
    this.readyState = ServiceSocket.CLOSING;
    if (this.native) this.native.close();
    else if (this.desktopId) void closeDesktopServiceSocket(this.desktopId);
  }

  private openBrowser(path: string, params: Record<string, string>): void {
    const socket = new WebSocket(webSocketUrl(path, { ...params, language: currentLocale() }));
    this.native = socket;
    socket.binaryType = this.currentBinaryType;
    socket.addEventListener("open", () => {
      this.readyState = ServiceSocket.OPEN;
      this.emit("open", new Event("open"));
    });
    socket.addEventListener("message", (event) => {
      recordConnectionQualityTraffic("download", connectionQualityByteLength(event.data));
      this.emit("message", new MessageEvent("message", { data: event.data }));
    });
    socket.addEventListener("error", () => this.emit("error", new Event("error")));
    socket.addEventListener("close", (event) => {
      this.readyState = ServiceSocket.CLOSED;
      this.emit("close", new CloseEvent("close", { code: event.code, reason: event.reason, wasClean: event.wasClean }));
    });
  }

  private async openDesktop(path: string, params: Record<string, string>): Promise<void> {
    this.stopDesktopEvents = onDesktopServiceSocketEvent((event) => this.handleDesktopEvent(event));
    try {
      const opened = await openDesktopServiceSocket(path, params);
      this.desktopId = opened.id;
      const backlog = this.desktopBacklog;
      this.desktopBacklog = [];
      for (const event of backlog) this.handleDesktopEvent(event);
      if (this.closeRequested) void closeDesktopServiceSocket(opened.id);
    } catch (error) {
      this.readyState = ServiceSocket.CLOSED;
      this.stopDesktopEvents?.();
      this.stopDesktopEvents = null;
      this.emit("error", new ErrorEvent("error", { message: error instanceof Error ? error.message : tr("实时通道连接失败") }));
      this.emit("close", new CloseEvent("close", { code: 1006, reason: error instanceof Error ? error.message : tr("实时通道连接失败") }));
    }
  }

  private handleDesktopEvent(event: DesktopServiceSocketEvent): void {
    if (!this.desktopId) {
      this.desktopBacklog.push(event);
      return;
    }
    if (event.socketId !== this.desktopId) return;
    if (event.type === "open") {
      this.readyState = ServiceSocket.OPEN;
      this.emit("open", new Event("open"));
    } else if (event.type === "message") {
      recordConnectionQualityTraffic("download", connectionQualityByteLength(event.data));
      this.emit("message", new MessageEvent("message", { data: event.data }));
    } else if (event.type === "error") {
      this.emit("error", new ErrorEvent("error", { message: localizeMessage(event.message) }));
    } else {
      this.readyState = ServiceSocket.CLOSED;
      this.stopDesktopEvents?.();
      this.stopDesktopEvents = null;
      this.emit("close", new CloseEvent("close", { code: event.code, reason: localizeMessage(event.reason), wasClean: event.code === 1000 }));
    }
  }
}
