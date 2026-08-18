declare module "zmodem.js" {
  export interface FileDetails {
    name: string;
    size: number;
    mtime?: Date | number;
    mode?: number;
    files_remaining?: number;
    bytes_remaining?: number;
  }

  export interface Transfer {
    get_details(): FileDetails;
    get_offset(): number;
    send(data: Uint8Array): void;
    end(data?: Uint8Array): Promise<void>;
  }

  export interface Offer {
    get_details(): FileDetails;
    get_offset(): number;
    on(event: "input", handler: (data: number[] | Uint8Array) => void): this;
    accept(): Promise<Uint8Array[]>;
    skip(): void;
  }

  export interface SessionBase {
    type: "send" | "receive";
    on(event: "session_end", handler: () => void): this;
    abort(): void;
    aborted(): boolean;
  }

  export interface SendSession extends SessionBase {
    type: "send";
    send_offer(details: FileDetails): Promise<Transfer | undefined>;
    close(): Promise<void>;
  }

  export interface ReceiveSession extends SessionBase {
    type: "receive";
    on(event: "session_end", handler: () => void): this;
    on(event: "offer", handler: (offer: Offer) => void): this;
    start(): void;
  }

  export type Session = SendSession | ReceiveSession;

  export interface Detection {
    confirm(): Session;
    deny(): void;
    is_valid(): boolean;
    get_session_role(): "send" | "receive";
  }

  export class Sentry {
    constructor(options: {
      to_terminal(octets: number[]): void;
      sender(octets: number[]): void;
      on_detect(detection: Detection): void;
      on_retract(): void;
    });
    consume(input: ArrayBuffer | Uint8Array | number[]): void;
    get_confirmed_session(): Session | null;
  }
}
