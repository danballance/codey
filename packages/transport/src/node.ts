import { createConnection, type Socket } from "node:net";

import type { DuplexTransport } from "./index.js";

export interface NodeTcpTransportOptions {
  readonly host: string;
  readonly port: number;
  /** Set to zero to leave connection timeout handling to the operating system. */
  readonly connectTimeoutMs?: number;
  readonly noDelay?: boolean;
}

type TransportState =
  | "idle"
  | "connecting"
  | "connected"
  | "closing"
  | "closed";

export class NodeTcpTransport implements DuplexTransport {
  readonly #options: Required<
    Pick<NodeTcpTransportOptions, "host" | "port" | "connectTimeoutMs" | "noDelay">
  >;

  readonly #dataListeners = new Set<(chunk: Uint8Array) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();

  #state: TransportState = "idle";
  #socket: Socket | undefined;
  #connectPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #resolveClose: (() => void) | undefined;
  #terminalError: Error | undefined;
  #didNotifyClose = false;

  constructor(options: NodeTcpTransportOptions) {
    if (options.host.trim().length === 0) {
      throw new TypeError("TCP host must not be empty");
    }
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new RangeError("TCP port must be an integer between 1 and 65535");
    }

    const connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 0) {
      throw new RangeError("TCP connection timeout must be a non-negative number");
    }

    this.#options = {
      host: options.host,
      port: options.port,
      connectTimeoutMs,
      noDelay: options.noDelay ?? true,
    };
  }

  connect(): Promise<void> {
    if (this.#state === "connected") {
      return Promise.resolve();
    }
    if (this.#state === "connecting") {
      return this.#connectPromise!;
    }
    if (this.#state === "closing" || this.#state === "closed") {
      return Promise.reject(new Error("TCP transport is closed"));
    }

    this.#state = "connecting";

    this.#connectPromise = new Promise<void>((resolve, reject) => {
      const socket = createConnection({
        host: this.#options.host,
        port: this.#options.port,
      });
      this.#socket = socket;
      socket.setNoDelay(this.#options.noDelay);

      let connectSettled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const clearConnectTimeout = (): void => {
        if (timeout !== undefined) {
          clearTimeout(timeout);
          timeout = undefined;
        }
      };

      const rejectConnect = (error: Error): void => {
        if (connectSettled) {
          return;
        }
        connectSettled = true;
        clearConnectTimeout();
        reject(error);
      };

      socket.once("connect", () => {
        if (this.#state !== "connecting") {
          rejectConnect(new Error("TCP transport was closed while connecting"));
          return;
        }

        connectSettled = true;
        clearConnectTimeout();
        this.#state = "connected";
        resolve();
      });

      socket.on("data", (chunk) => {
        const data = new Uint8Array(
          chunk.buffer,
          chunk.byteOffset,
          chunk.byteLength,
        );
        for (const listener of this.#dataListeners) {
          listener(data);
        }
      });

      socket.on("error", (error) => {
        this.#terminalError ??= error;
        rejectConnect(error);
      });

      socket.once("close", () => {
        clearConnectTimeout();
        rejectConnect(
          this.#terminalError ??
            new Error("TCP connection closed before it was established"),
        );
        this.#state = "closed";
        this.#notifyClose(this.#terminalError);
        this.#resolveClose?.();
        this.#resolveClose = undefined;
      });

      if (this.#options.connectTimeoutMs > 0) {
        timeout = setTimeout(() => {
          const error = new Error(
            `TCP connection to ${this.#options.host}:${this.#options.port} timed out after ${this.#options.connectTimeoutMs}ms`,
          );
          this.#terminalError = error;
          socket.destroy(error);
        }, this.#options.connectTimeoutMs);
      }
    });

    return this.#connectPromise;
  }

  write(data: Uint8Array): Promise<void> {
    const socket = this.#socket;
    if (this.#state !== "connected" || socket === undefined) {
      return Promise.reject(new Error("TCP transport is not connected"));
    }

    return new Promise<void>((resolve, reject) => {
      socket.write(data, (error?: Error | null) => {
        if (error != null) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  onData(listener: (chunk: Uint8Array) => void): () => void {
    this.#dataListeners.add(listener);
    return () => {
      this.#dataListeners.delete(listener);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  close(): Promise<void> {
    if (this.#state === "closed") {
      return Promise.resolve();
    }
    if (this.#state === "closing") {
      return this.#closePromise!;
    }
    if (this.#state === "idle") {
      this.#state = "closed";
      this.#notifyClose();
      return Promise.resolve();
    }

    this.#state = "closing";
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve;
      this.#socket!.destroy();
    });
    return this.#closePromise;
  }

  #notifyClose(error?: Error): void {
    if (this.#didNotifyClose) {
      return;
    }
    this.#didNotifyClose = true;
    for (const listener of this.#closeListeners) {
      listener(error);
    }
  }
}
